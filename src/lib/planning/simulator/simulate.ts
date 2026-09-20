import { createHash } from "node:crypto";
import { settleBuying } from "./buying";
import { loadSimulationContext, type SimulationContext } from "./context";
import { buildDependencyGraph, type DependencyGraph } from "./dependencyGraph";
import { simulateIndustryDemand, type IndustrySimulationResult } from "./industrySimulation";
import {
  projectSimulationLedger,
  simulationAccountKey,
  type SimulationLedgerAccount,
  type SimulationTransaction,
} from "./ledger";
import { settleReprocessing } from "./reprocessing";
import { scheduleSimulationJobs, type SimulationScheduleResult } from "./scheduler";
import { normalizeSimulatorInventory, type SimulatorInventory } from "./sourceLots";
import type {
  SimulationMaterialBalance,
  SimulationResultV1,
  SimulationWarning,
  SimulatorActivity,
  SimulatorRequestV1,
} from "./types";

const ledgerActivities = [
  "manufacturing",
  "reaction",
  "reprocessing",
  "invention",
  "copying",
] as const satisfies readonly SimulatorActivity[];

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

/** Returns the configured activity location for a stockpile. */
function activityLocation(
  stockpile: SimulatorRequestV1["stockpiles"][number],
  activity: SimulatorActivity,
): number {
  if (activity === "manufacturing") return stockpile.locations.manufacturing;
  if (activity === "reaction") return stockpile.locations.reactions;
  if (activity === "reprocessing") return stockpile.locations.reprocessing;
  if (activity === "invention") return stockpile.locations.invention;
  return stockpile.locations.copying;
}

/** Adds zero-valued accounts for every graph type at every relevant activity location. */
function graphPrimingTransactions(
  request: SimulatorRequestV1,
  graph: DependencyGraph,
): SimulationTransaction[] {
  const typeIds = [...graph.reachableTypeIds].sort((left, right) => left - right);
  const transactions = new Map<string, SimulationTransaction>();
  for (const stockpile of request.stockpiles) {
    for (const activity of ledgerActivities) {
      const locationId = activityLocation(stockpile, activity);
      for (const typeId of typeIds) {
        const account: SimulationLedgerAccount = { activity, locationId, typeId };
        transactions.set(
          simulationAccountKey(account),
          {
            id: `prime:${activity}:${locationId}:${typeId}`,
            kind: "prime-account",
            account,
            quantity: 0,
          },
        );
      }
    }
  }
  return [...transactions.values()];
}

/** Exposes each relevant unreserved physical lot to exactly one ledger account. */
function sourceAvailabilityTransactions(
  request: SimulatorRequestV1,
  graph: DependencyGraph,
  inventory: SimulatorInventory,
  industry: IndustrySimulationResult,
): SimulationTransaction[] {
  const canReachAccount = (
    lot: SimulatorInventory["itemLots"][number],
    account: SimulationLedgerAccount,
  ) =>
    lot.locationId === account.locationId
    || !(request.haulExclusions ?? []).some(
      (exclusion) =>
        exclusion.typeId === lot.typeId
        && exclusion.fromLocationId === lot.locationId
        && exclusion.toLocationId === account.locationId
        && (exclusion.ownerType === undefined || exclusion.ownerType === lot.ownerType)
        && (exclusion.ownerId === undefined || exclusion.ownerId === lot.ownerId),
    );
  const demandedAccounts = new Map<number, SimulationLedgerAccount[]>();
  for (const transaction of industry.transactions) {
    if (transaction.kind !== "demand") continue;
    const accounts = demandedAccounts.get(transaction.account.typeId) ?? [];
    if (
      !accounts.some((account) => JSON.stringify(account) === JSON.stringify(transaction.account))
    ) {
      accounts.push(transaction.account);
      demandedAccounts.set(transaction.account.typeId, accounts);
    }
  }
  return inventory.itemLots.flatMap((lot) => {
    const quantity = industry.allocator.remainingItemQuantity(lot.lotId);
    if (
      quantity <= 0
      || lot.horizon !== "now"
      || lot.locationId === undefined
      || !graph.reachableTypeIds.has(lot.typeId)
    ) {
      return [];
    }
    const lotLocationId = lot.locationId;
    const accounts = [...(demandedAccounts.get(lot.typeId) ?? [])]
      .filter((account) => canReachAccount(lot, account))
      .sort(
        (left, right) =>
          Number(right.locationId === lotLocationId) - Number(left.locationId === lotLocationId)
          || left.activity.localeCompare(right.activity),
      );
    const localFallback = request.stockpiles
      .flatMap((stockpile) =>
        ledgerActivities
          .filter((activity) => activityLocation(stockpile, activity) === lotLocationId)
          .map((activity) => ({
            activity,
            locationId: lotLocationId,
            typeId: lot.typeId,
          })),
      )
      .sort((left, right) => left.activity.localeCompare(right.activity))
      .at(0);
    const account = accounts.at(0) ?? localFallback;
    if (!account) return [];
    return [
      {
        id: `availability:${lot.lotId}`,
        kind: "source-availability" as const,
        account,
        lotId: lot.lotId,
        quantity,
        horizon:
          account.locationId === lotLocationId ? ("now" as const) : ("after-hauling" as const),
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
): SimulationResultV1["ledgers"] {
  const views = new Map<string, SimulationResultV1["ledgers"][number]>();
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

/** Builds the presentation lists from settled domain facts. */
function assembleLists(
  industry: IndustrySimulationResult,
  schedules: SimulationScheduleResult,
  reprocessing: ReturnType<typeof settleReprocessing>,
  buying: ReturnType<typeof settleBuying>,
  balances: ReadonlyMap<string, SimulationMaterialBalance>,
  warnings: SimulationWarning[],
): SimulationResultV1["lists"] {
  const planItems = [...balances.values()].filter(
    (balance) => balance.required > 0 || balance.unreserved > 0 || balance.surplus > 0,
  );
  return {
    warnings,
    planItems,
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
export async function simulateIndustry(request: SimulatorRequestV1): Promise<SimulationResultV1> {
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
    ...graphPrimingTransactions(request, graph),
    ...industry.transactions,
    ...industry.allocator.transactions,
    ...reprocessing.transactions,
    ...buying.transactions,
    ...sourceAvailabilityTransactions(request, graph, inventory, industry),
  ]);
  const names = new Map(
    [...context.types].map(([typeId]) => [typeId, typeName(context, request, typeId)]),
  );
  const volumes = new Map(
    [...context.types].map(([typeId, type]) => [typeId, type.packagedVolume ?? type.volume ?? 0]),
  );
  const projection = projectSimulationLedger(inventory.itemLots, transactions, names, volumes);
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
    industry,
    schedules,
    reprocessing,
    buying,
    projection.balances,
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
    ledgers: ledgerViews(transactions, projection.balances),
  };
}
