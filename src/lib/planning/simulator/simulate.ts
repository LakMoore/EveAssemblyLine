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
  SimulationHaulTask,
  SimulationMaterialBalance,
  SimulationLedgerView,
  SimulationCopyJob,
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationResultV1,
  SimulationResultWithDiagnostics,
  SimulationWarning,
  SimulationRequestV1,
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
function inputHash(request: SimulationRequestV1): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}

/** Resolves a localized SDE type name with a stable fallback. */
function typeName(
  context: SimulationContext,
  request: SimulationRequestV1,
  typeId: number,
): string {
  const names = context.types.get(typeId)?.name;
  return names?.[request.language ?? "en"] ?? names?.en ?? `Type ${typeId}`;
}

/**
 * Combines allocator lot transfers into one source/type/owner haul requirement.
 *
 * @param tasks - Exact lot-level transfers produced during allocation.
 * @returns Stable presentation tasks with the job demands that compose each total.
 */
export function aggregateHaulingTasks(tasks: readonly SimulationHaulTask[]): SimulationHaulTask[] {
  const groupedTasks = new Map<string, SimulationHaulTask>();
  for (const task of tasks) {
    const key = [task.fromLocationId, task.typeId, task.ownerType ?? "", task.ownerId ?? ""].join(
      ":",
    );
    const existingTask = groupedTasks.get(key);
    if (!existingTask) {
      groupedTasks.set(key, { ...task, demands: [...task.demands] });
      continue;
    }
    existingTask.quantity += task.quantity;
    existingTask.demands.push(...task.demands);
  }
  return [...groupedTasks.values()]
    .map((task) => ({
      ...task,
      demands: task.demands.sort(
        (left, right) =>
          (left.jobId ?? "").localeCompare(right.jobId ?? "") || left.quantity - right.quantity,
      ),
    }))
    .sort(
      (left, right) =>
        left.fromLocationId - right.fromLocationId
        || left.typeId - right.typeId
        || (left.ownerType ?? "").localeCompare(right.ownerType ?? "")
        || (left.ownerId ?? 0) - (right.ownerId ?? 0),
    );
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
function configuredLocationIds(request: SimulationRequestV1): ReadonlySet<number> {
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

type SimulationInputJob = SimulationIndustryJob | SimulationInventionJob | SimulationCopyJob;

/** Adds settled Buy-tab quantities to the job inputs that require them. */
function annotatePurchaseQuantities<T extends SimulationInputJob>(
  jobs: readonly T[],
  purchases: SimulationResultV1["lists"]["materialsToBuy"],
): T[] {
  const quantitiesByJobAndType = new Map<string, number>();
  for (const purchase of purchases) {
    for (const destination of purchase.destinations) {
      if (!destination.demandingJobId) continue;
      const key = `${destination.demandingJobId}:${purchase.typeId}`;
      quantitiesByJobAndType.set(
        key,
        (quantitiesByJobAndType.get(key) ?? 0) + destination.quantity,
      );
    }
  }
  return jobs.map((job) => ({
    ...job,
    inputs: job.inputs.map((input) => {
      const purchaseQuantity = quantitiesByJobAndType.get(`${job.jobId}:${input.typeId}`);
      return purchaseQuantity && purchaseQuantity > 0 ? { ...input, purchaseQuantity } : input;
    }),
  }));
}

/** Builds the presentation lists from settled domain facts. */
function assembleLists(
  request: SimulationRequestV1,
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
    haulingTasks: aggregateHaulingTasks(industry.allocator.haulingTasks),
    skillsRequired: industry.skillsRequired,
  };
}

/** Executes one deterministic, cached-SDE-only industry simulation. */
export async function simulateIndustry(
  request: SimulationRequestV1,
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
  const annotatedSchedules: SimulationScheduleResult = {
    ...schedules,
    manufacturingJobs: annotatePurchaseQuantities(schedules.manufacturingJobs, buying.materials),
    reactionJobs: annotatePurchaseQuantities(schedules.reactionJobs, buying.materials),
    inventionJobs: annotatePurchaseQuantities(schedules.inventionJobs, buying.materials),
    copyJobs: annotatePurchaseQuantities(schedules.copyJobs, buying.materials),
  };
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
    annotatedSchedules,
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
