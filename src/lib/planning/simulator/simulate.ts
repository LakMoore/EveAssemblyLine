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

/** Posts every physical item lot to its canonical location/type ledger before allocation. */
function sourceAvailabilityTransactions(inventory: SimulatorInventory): SimulationTransaction[] {
  return inventory.itemLots.flatMap((lot) => {
    if (lot.horizon !== "now" || lot.locationId === undefined) {
      return [];
    }
    return [
      {
        id: `availability:${lot.lotId}`,
        kind: "source-availability" as const,
        account: { locationId: lot.locationId, typeId: lot.typeId },
        lotId: lot.lotId,
        quantity: lot.quantity,
        horizon: "now" as const,
      },
    ];
  });
}

/** Returns accounts participating in the requested plan, excluding unrelated source availability. */
function connectedAccountKeys(transactions: readonly SimulationTransaction[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.kind === "source-availability") continue;
    if (transaction.kind === "transfer-commitment") {
      keys.add(simulationAccountKey(transaction.sourceAccount));
      keys.add(simulationAccountKey(transaction.destinationAccount));
      continue;
    }
    keys.add(simulationAccountKey(transaction.account));
    if ("destinationAccount" in transaction && transaction.destinationAccount) {
      keys.add(simulationAccountKey(transaction.destinationAccount));
    }
  }
  return keys;
}

/** Returns physical locations configured for a stockpile or activity-specific facility assignment. */
function configuredLocationIds(request: SimulatorRequestV1): ReadonlySet<number> {
  const locationIds = new Set<number>();
  for (const stockpile of request.stockpiles) {
    for (const locationId of Object.values(stockpile.locations)) locationIds.add(locationId);
    for (const locationId of Object.values(stockpile.groupAssignments ?? {})) {
      locationIds.add(locationId);
    }
  }
  return locationIds;
}

/** De-duplicates journal entries accumulated across mutable allocator phases. */
function uniqueTransactions(
  transactions: readonly SimulationTransaction[],
): SimulationTransaction[] {
  const byId = new Map<string, SimulationTransaction>();
  for (const transaction of transactions) byId.set(transaction.id, transaction);
  return [...byId.values()];
}

/** Sorts canonical material balances into stable location ledgers. */
function ledgerViews(
  balances: ReadonlyMap<string, SimulationMaterialBalance>,
): SimulationLedgerView[] {
  const views = new Map<string, SimulationLedgerView>();
  for (const balance of balances.values()) {
    const ledgerId = `location:${balance.locationId}`;
    const view = views.get(ledgerId) ?? {
      ledgerId,
      locationId: balance.locationId,
      balances: [],
    };
    view.balances.push(balance);
    views.set(ledgerId, view);
  }
  return [...views.values()]
    .map((view) => ({
      ...view,
      balances: view.balances.sort((left, right) => left.typeId - right.typeId),
    }))
    .sort(
      (left, right) =>
        left.locationId - right.locationId || left.ledgerId.localeCompare(right.ledgerId),
    );
}

/** Selects non-empty balances for one direct presentation list. */
function presentationItems(
  ledgers: readonly SimulationLedgerView[],
  connectedKeys: ReadonlySet<string>,
  kind: "plan" | "surplus",
  visibleSurplusLocations: ReadonlySet<number>,
  includeSurplusForAllLocations: boolean,
): SimulationResultV1["lists"]["planItems"] {
  const itemsByLocation = new Map<
    number,
    SimulationResultV1["lists"]["planItems"][number]["items"]
  >();
  for (const ledger of ledgers) {
    const items = ledger.balances.filter((balance) => {
      const connected = connectedKeys.has(
        simulationAccountKey({ locationId: balance.locationId, typeId: balance.typeId }),
      );
      if (kind === "plan") {
        return (
          connected
          && (
            balance.requiredNow > 0
            || balance.reserved > 0
            || balance.availableNow > 0
            || balance.availableFromHauling > 0
            || balance.availableFromProduction > 0
            || balance.availableFromCopying > 0
            || balance.availableFromInvention > 0
            || balance.availableFromReprocessing > 0
            || balance.transferredOut > 0
          )
        );
      }
      return (
        !connected
        && balance.surplus > 0
        && (includeSurplusForAllLocations || visibleSurplusLocations.has(balance.locationId))
      );
    });
    if (items.length === 0) continue;
    const locationItems = itemsByLocation.get(ledger.locationId) ?? [];
    locationItems.push(...items);
    itemsByLocation.set(ledger.locationId, locationItems);
  }
  return [...itemsByLocation.entries()]
    .map(([locationId, items]) => ({
      locationId,
      items: items.sort((left, right) => left.typeId - right.typeId),
    }))
    .sort((left, right) => left.locationId - right.locationId);
}

/** Builds the presentation lists from settled domain facts. */
function assembleLists(
  request: SimulatorRequestV1,
  industry: IndustrySimulationResult,
  schedules: SimulationScheduleResult,
  reprocessing: ReturnType<typeof settleReprocessing>,
  buying: ReturnType<typeof settleBuying>,
  ledgers: readonly SimulationLedgerView[],
  connectedKeys: ReadonlySet<string>,
  warnings: SimulationWarning[],
): SimulationResultV1["lists"] {
  return {
    warnings,
    planItems: presentationItems(
      ledgers,
      connectedKeys,
      "plan",
      configuredLocationIds(request),
      request.simulation.includeSurplusForAllLocations,
    ),
    surplusItems: presentationItems(
      ledgers,
      connectedKeys,
      "surplus",
      configuredLocationIds(request),
      request.simulation.includeSurplusForAllLocations,
    ),
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
    ...sourceAvailabilityTransactions(inventory),
  ]);
  const names = new Map(
    [...context.types].map(([typeId]) => [typeId, typeName(context, request, typeId)]),
  );
  const volumes = new Map(
    [...context.types].map(([typeId, type]) => [typeId, type.packagedVolume ?? type.volume ?? 0]),
  );
  const projection = projectSimulationLedger(inventory.itemLots, transactions, names, volumes);
  const ledgers = ledgerViews(projection.balances);
  const connectedKeys = connectedAccountKeys(transactions);
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
  const lists = assembleLists(
    request,
    industry,
    schedules,
    reprocessing,
    buying,
    ledgers,
    connectedKeys,
    warnings,
  );
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
