import { createHash } from "node:crypto";
import { settleBuying } from "./buying";
import { loadSimulationContext, type SimulationContext } from "./context";
import { buildDependencyGraph } from "./dependencyGraph";
import { simulateIndustryDemand, type IndustrySimulationResult } from "./industrySimulation";
import {
  projectSimulationLedger,
  simulationAccountKey,
  type SimulationTransaction,
} from "./ledger";
import { settleReprocessing } from "./reprocessing";
import { scheduleSimulationJobs, type SimulationScheduleResult } from "./scheduler";
import { normalizeSimulatorInventory, type SimulatorInventory } from "./sourceLots";
import type {
  SimulationMaterialBalance,
  SimulationLedgerView,
  SimulationResultV1,
  SimulationResultWithDiagnostics,
  SimulationWarning,
  SimulatorRequestV1,
} from "./types";

/** Converts an input into a recursively key-sorted JSON-compatible value. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object
      .entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
  );
}

/** Creates a stable content hash without retaining request data in the response. */
function inputHash(request: SimulatorRequestV1): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}

/** Resolves a localized SDE type name with a stable fallback. */
function typeName(context: SimulationContext, request: SimulatorRequestV1, typeId: number): string {
  const names = context.types.get(typeId)?.name;
  return names?.[request.language ?? "en"] ?? names?.en ?? `Type ${typeId}`;
}

/** Returns physical locations configured for a stockpile or activity-specific facility assignment. */
function configuredSurplusLocationIds(request: SimulatorRequestV1): ReadonlySet<number> {
  const locationIds = new Set<number>();
  for (const stockpile of request.stockpiles) {
    for (const locationId of Object.values(stockpile.locations)) locationIds.add(locationId);
    for (const locationId of Object.values(stockpile.groupAssignments ?? {})) {
      locationIds.add(locationId);
    }
  }
  return locationIds;
}

/** Posts each unreserved physical item lot to its canonical location surplus ledger. */
function sourceAvailabilityTransactions(
  request: SimulatorRequestV1,
  inventory: SimulatorInventory,
  industry: IndustrySimulationResult,
): SimulationTransaction[] {
  const configuredLocationIds = configuredSurplusLocationIds(request);
  return inventory.itemLots.flatMap((lot) => {
    const quantity = industry.allocator.remainingItemQuantity(lot.lotId);
    if (
      quantity <= 0
      || lot.horizon !== "now"
      || lot.locationId === undefined
      || (
        !request.simulation.includeSurplusForAllLocations
        && !configuredLocationIds.has(lot.locationId)
      )
    ) {
      return [];
    }
    return [
      {
        id: `availability:${lot.lotId}`,
        kind: "source-availability" as const,
        account: { activity: "surplus", locationId: lot.locationId, typeId: lot.typeId },
        lotId: lot.lotId,
        quantity,
        horizon: "now" as const,
      },
    ];
  });
}

/** De-duplicates journal entries accumulated across mutable allocator phases. */
function uniqueTransactions(
  transactions: readonly SimulationTransaction[],
): SimulationTransaction[] {
  const byId = new Map<string, SimulationTransaction>();
  for (const transaction of transactions) byId.set(transaction.id, transaction);
  return [...byId.values()];
}

/** Sorts material balances into stable activity ledgers. */
function ledgerViews(
  transactions: readonly SimulationTransaction[],
  balances: ReadonlyMap<string, SimulationMaterialBalance>,
): SimulationLedgerView[] {
  const views = new Map<string, SimulationLedgerView>();
  for (const transaction of transactions) {
    const ledgerId = `${transaction.account.activity}:${transaction.account.locationId}`;
    const view = views.get(ledgerId) ?? {
      ledgerId,
      activity: transaction.account.activity,
      locationId: transaction.account.locationId,
      balances: [],
    };
    const balanceKey = simulationAccountKey(transaction.account);
    const balance = balances.get(balanceKey);
    if (balance && !view.balances.includes(balance)) view.balances.push(balance);
    views.set(ledgerId, view);
  }
  return [...views.values()]
    .map((view) => ({
      ...view,
      balances: view.balances.sort((left, right) => left.typeId - right.typeId),
    }))
    .sort(
      (left, right) =>
        left.activity.localeCompare(right.activity)
        || left.locationId - right.locationId
        || left.ledgerId.localeCompare(right.ledgerId),
    );
}

/** Selects non-empty balances for one direct presentation list. */
function presentationItems(
  ledgers: readonly SimulationLedgerView[],
  activity: "plan" | "surplus",
): SimulationResultV1["lists"]["planItems"] {
  const itemsByLocation = new Map<
    number,
    SimulationResultV1["lists"]["planItems"][number]["items"]
  >();
  for (const ledger of ledgers) {
    if (activity === "surplus" ? ledger.activity !== "surplus" : ledger.activity === "surplus") {
      continue;
    }
    const items = ledger.balances
      .filter(
        (balance) =>
          balance.required > 0
          || balance.unreserved > 0
          || balance.surplus > 0
          || balance.transferredOut > 0,
      )
      .map((balance) => ({ ...balance, activity: ledger.activity }));
    if (items.length === 0) continue;
    const locationItems = itemsByLocation.get(ledger.locationId) ?? [];
    locationItems.push(...items);
    itemsByLocation.set(ledger.locationId, locationItems);
  }
  return [...itemsByLocation.entries()]
    .map(([locationId, items]) => ({
      locationId,
      items: items.sort(
        (left, right) => left.activity.localeCompare(right.activity) || left.typeId - right.typeId,
      ),
    }))
    .sort((left, right) => left.locationId - right.locationId);
}

/** Builds the presentation lists from settled domain facts. */
function assembleLists(
  industry: IndustrySimulationResult,
  schedules: SimulationScheduleResult,
  reprocessing: ReturnType<typeof settleReprocessing>,
  buying: ReturnType<typeof settleBuying>,
  ledgers: readonly SimulationLedgerView[],
  warnings: SimulationWarning[],
): SimulationResultV1["lists"] {
  return {
    warnings,
    planItems: presentationItems(ledgers, "plan"),
    surplusItems: presentationItems(ledgers, "surplus"),
    materialsToBuy: buying.materials,
    bpoToBuy: buying.blueprints,
    reprocessingJobs: reprocessing.jobs,
    bpcToCopy: schedules.copyJobs,
    inventionJobs: schedules.inventionJobs,
    reactionJobs: schedules.reactionJobs,
    manufacturingJobs: schedules.manufacturingJobs,
    haulingTasks: [...industry.allocator.haulingTasks].sort(
      (left, right) =>
        left.fromLocationId - right.fromLocationId
        || left.toLocationId - right.toLocationId
        || left.typeId - right.typeId,
    ),
    skillsRequired: industry.skillsRequired,
  };
}

/** Executes one deterministic, cached-SDE-only industry simulation. */
export async function simulateIndustry(
  request: SimulatorRequestV1,
): Promise<SimulationResultWithDiagnostics> {
  const startedAt = performance.now();
  const context = await loadSimulationContext();
  const graph = buildDependencyGraph(
    request.stockpiles.flatMap((stockpile) => stockpile.items.map((item) => item.typeId)),
    context,
    {
      buildBlacklist: new Set(request.settings.buildBlacklist),
      buyBlacklist: new Set(request.settings.buyBlacklist),
      maxNodes: request.simulation.policy.maxGraphNodes,
      maxDepth: request.simulation.policy.maxGraphDepth,
    },
  );
  const inventory = await normalizeSimulatorInventory(request, context);
  const industry = simulateIndustryDemand(request, context, inventory, graph);
  const schedules = scheduleSimulationJobs(
    industry.manufacturingJobs,
    industry.reactionJobs,
    industry.inventionJobs,
    industry.copyJobs,
    request.simulation.characters,
  );
  const reprocessing = settleReprocessing(request, context, inventory, industry);
  const buying = settleBuying(request, context, industry, reprocessing.remainingDemands);
  const transactions = uniqueTransactions([
    ...industry.transactions,
    ...industry.allocator.transactions,
    ...reprocessing.transactions,
    ...buying.transactions,
    ...sourceAvailabilityTransactions(request, inventory, industry),
  ]);
  const names = new Map(
    [...context.types].map(([typeId]) => [typeId, typeName(context, request, typeId)]),
  );
  const volumes = new Map(
    [...context.types].map(([typeId, type]) => [typeId, type.packagedVolume ?? type.volume ?? 0]),
  );
  const projection = projectSimulationLedger(inventory.itemLots, transactions, names, volumes);
  const ledgers = ledgerViews(transactions, projection.balances);
  const invariantWarnings: SimulationWarning[] = projection.invariantViolations.map((message) => ({
    code: "invariant-violation",
    message,
  }));
  const warnings = [
    ...industry.warnings,
    ...schedules.warnings,
    ...reprocessing.warnings,
    ...buying.warnings,
    ...invariantWarnings,
  ];
  const lists = assembleLists(industry, schedules, reprocessing, buying, ledgers, warnings);
  return {
    metadata: {
      simulatorVersion: 1,
      policyVersion: 1,
      generatedAt: new Date().toISOString(),
      sdeRevision: context.sdeRevision,
      normalizedInputHash: inputHash(request),
      elapsedMilliseconds: performance.now() - startedAt,
      warningCount: warnings.length,
      invariantViolationCount: projection.invariantViolations.length,
      unresolvedAssetCount: inventory.unresolvedLotCount,
    },
    lists,
    ledgers,
  };
}
