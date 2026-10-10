import type {
  SimulationHaulTask,
  SimulationResultV2,
  SimulationSlot,
  SimulationSlotActivity,
} from "./simulator/types";
import { simulationCalculationVersion } from "./simulator/etag";
import type { PlanHaulExclusion } from "./types";
import { getPlanningDatabase, plannerPreferencesStoreName } from "./planningDatabase";

const simulationResultKey = "latest-simulation-result-v2";
const simulationHaulExclusionsKey = "simulation-haul-exclusions";
const simulationPreservedHaulTasksKey = "simulation-preserved-haul-tasks";

/** Narrows unknown persisted JSON-like values to plain record values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Narrows a persisted quantity to a non-negative finite number. */
function isQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Narrows a persisted EVE ID to a positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Confirms the shared type identity fields used by result rows. */
function hasTypeIdentity(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isPositiveInteger(value.typeId) && typeof value.typeName === "string";
}

/** Validates the stable identity and timing fields for one restored slot. */
function isSimulationSlot(value: unknown): value is SimulationSlot {
  if (!isRecord(value)) return false;
  const slotKey = value.slotKey;
  const characterId = value.characterId;
  const systemId = value.systemId;
  const slotIndex = value.slotIndex;
  const availableAtSeconds = value.availableAtSeconds;
  const installedJobId = value.installedJobId;
  const slotCodeByActivity: Record<SimulationSlotActivity, string> = {
    manufacturing: "M",
    reaction: "R",
    science: "S",
  };
  const slotCode =
    value.activity === "manufacturing"
    || value.activity === "reaction"
    || value.activity === "science"
      ? slotCodeByActivity[value.activity]
      : undefined;
  return (
    slotCode !== undefined
    && typeof slotKey === "string"
    && isPositiveInteger(characterId)
    && isPositiveInteger(systemId)
    && typeof slotIndex === "number"
    && Number.isSafeInteger(slotIndex)
    && slotIndex >= 0
    && typeof availableAtSeconds === "number"
    && Number.isSafeInteger(availableAtSeconds)
    && availableAtSeconds >= 0
    && (installedJobId === undefined || isPositiveInteger(installedJobId))
    && slotKey === `${characterId}:${slotCode}:${slotIndex}`
  );
}

/** Validates that a restored result contains a complete, uniquely keyed slot array. */
function hasSimulationSlots(value: unknown): value is SimulationSlot[] {
  if (!Array.isArray(value)) return false;
  const seenSlotKeys = new Set<string>();
  const seenInstalledJobs = new Set<number>();
  for (const slot of value) {
    if (
      !isSimulationSlot(slot)
      || seenSlotKeys.has(slot.slotKey)
      || (slot.installedJobId !== undefined && seenInstalledJobs.has(slot.installedJobId))
    ) return false;
    seenSlotKeys.add(slot.slotKey);
    if (slot.installedJobId !== undefined) seenInstalledJobs.add(slot.installedJobId);
  }
  return true;
}

/** Validates the durable browser representation of a native simulator result. */
export function isSimulationResultV2(value: unknown): value is SimulationResultV2 {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.lists)) return false;
  const metadata = value.metadata;
  const lists = value.lists;
  const demandActivities = new Set([
    "manufacturing",
    "reaction",
    "copying",
    "invention",
    "reprocessing",
    "stock",
  ]);
  const hasSimulationRows = (rows: unknown, validator: (row: unknown) => boolean) =>
    Array.isArray(rows) && rows.every(validator);
  const hasBalance = (balance: unknown) =>
    hasTypeIdentity(balance)
    && isPositiveInteger(balance.locationId)
    && (balance.quantityKind === "item" || balance.quantityKind === "blueprint-run")
    && [
      "requiredNow",
      "reserved",
      "futureDemand",
      "futureSupply",
      "availableNow",
      "availableFromSellOrders",
      "availableFromHauling",
      "inFlightQuantity",
      "availableFromProduction",
      "availableFromCopying",
      "availableFromInvention",
      "availableFromReprocessing",
      "availableFromMarket",
      "transferredOut",
      "unsatisfied",
      "surplus",
    ].every((key) => isQuantity(balance[key]))
    && (
      balance.activityType === undefined
      || balance.activityType === "manufacturing"
      || balance.activityType === "reaction"
      || balance.activityType === "copying"
      || balance.activityType === "invention"
    )
    && Array.isArray(balance.demandSources)
    && balance.demandSources.every(
      (source) =>
        isRecord(source)
        && typeof source.stockpileId === "string"
        && isPositiveInteger(source.materialTypeId)
        && isPositiveInteger(source.productTypeId)
        && isQuantity(source.productQuantity)
        && isQuantity(source.plannedQuantity)
        && isQuantity(source.requiredNow)
        && isQuantity(source.reserved)
        && source.requiredNow + source.reserved === source.plannedQuantity
        && isPositiveInteger(source.destinationLocationId)
        && demandActivities.has(String(source.activity)),
    );
  const hasPresentationBuckets = (items: unknown) =>
    hasSimulationRows(
      items,
      (bucket) =>
        isRecord(bucket)
        && isPositiveInteger(bucket.locationId)
        && Array.isArray(bucket.items)
        && bucket.items.every(
          (item: unknown) =>
            isRecord(item) && hasBalance(item) && item.locationId === bucket.locationId,
        ),
    );
  const hasReactionFormulaBalances = (items: unknown) =>
    items === undefined
    || (
      Array.isArray(items)
      && items.every(
        (bucket) =>
          isRecord(bucket)
          && isPositiveInteger(bucket.locationId)
          && Array.isArray(bucket.items)
          && bucket.items.every(
            (item) =>
              hasTypeIdentity(item)
              && item.locationId === bucket.locationId
              && ["ownedQuantity", "availableQuantity", "inUseQuantity", "requiredRuns"].every(
                (key) => isQuantity(item[key]),
              )
              && Array.isArray(item.demandSources)
              && item.demandSources.every(
                (source) =>
                  isRecord(source)
                  && typeof source.jobId === "string"
                  && typeof source.stockpileId === "string"
                  && isPositiveInteger(source.productTypeId)
                  && typeof source.productName === "string"
                  && isQuantity(source.runs),
              ),
          ),
      )
    );
  const hasSurplusBalances =
    lists.surplusItems === undefined || hasPresentationBuckets(lists.surplusItems);
  const hasPlanPresentationBalances = hasPresentationBuckets(lists.planItems);
  const hasReactionFormulaPresentation = hasReactionFormulaBalances(lists.reactionFormulas);
  const hasLedgers =
    value.ledgers === undefined
    || (
      Array.isArray(value.ledgers)
      && value.ledgers.every(
        (ledger) =>
          isRecord(ledger)
          && typeof ledger.ledgerId === "string"
          && isPositiveInteger(ledger.locationId)
          && Array.isArray(ledger.balances)
          && ledger.balances.every(hasBalance),
      )
    );
  const hasPurchases = (purchases: unknown) =>
    hasSimulationRows(
      purchases,
      (purchase) =>
        hasTypeIdentity(purchase)
        && isQuantity(purchase.quantity)
        && Array.isArray(purchase.destinations)
        && purchase.destinations.every(
          (destination) =>
            isRecord(destination)
            && typeof destination.stockpileId === "string"
            && isPositiveInteger(destination.locationId)
            && isQuantity(destination.quantity),
        ),
    );
  const hasJobs = (jobs: unknown, validator: (job: Record<string, unknown>) => boolean) =>
    hasSimulationRows(jobs, (job) => isRecord(job) && validator(job));
  const hasReprocessingQuantities = (quantities: unknown) =>
    isRecord(quantities)
    && [
      "totalSourceQuantity",
      "immediateSourceQuantity",
      "afterHaulingSourceQuantity",
      "afterPurchaseSourceQuantity",
    ].every((key) => isQuantity(quantities[key]));
  const hasReprocessingGroups = hasSimulationRows(
    lists.reprocessingJobs,
    (group) =>
      isRecord(group)
      && typeof group.groupKey === "string"
      && isPositiveInteger(group.locationId)
      && isPositiveInteger(group.sourceTypeId)
      && typeof group.sourceTypeName === "string"
      && Array.isArray(group.jobs)
      && group.jobs.every((job) => isRecord(job) && isPositiveInteger(job.depth))
      && hasReprocessingQuantities(group.quantities),
  );
  return (
    (metadata.simulationId === undefined || typeof metadata.simulationId === "string")
    && metadata.simulatorVersion === simulationCalculationVersion
    && metadata.policyVersion === 1
    && typeof metadata.generatedAt === "string"
    && typeof metadata.sdeRevision === "string"
    && typeof metadata.normalizedInputHash === "string"
    && isQuantity(metadata.warningCount)
    && isQuantity(metadata.invariantViolationCount)
    && isQuantity(metadata.unresolvedAssetCount)
    && hasSimulationSlots(value.scheduleSlots)
    && hasSimulationRows(
      lists.warnings,
      (warning) =>
        isRecord(warning)
        && typeof warning.code === "string"
        && typeof warning.message === "string",
    )
    && hasPlanPresentationBalances
    && hasReactionFormulaPresentation
    && hasSurplusBalances
    && hasLedgers
    && hasSimulationRows(
      lists.haulingTasks,
      (task) =>
        hasTypeIdentity(task)
        && typeof task.transferId === "string"
        && isQuantity(task.quantity)
        && isPositiveInteger(task.fromLocationId)
        && isPositiveInteger(task.toLocationId),
    )
    && hasPurchases(lists.materialsToBuy)
    && hasPurchases(lists.bpoToBuy)
    && hasReprocessingGroups
    && hasJobs(
      lists.bpcToCopy,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.depth)
        && isPositiveInteger(job.blueprintTypeId)
        && isQuantity(job.copies)
        && isPositiveInteger(job.locationId),
    )
    && hasJobs(
      lists.inventionJobs,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.depth)
        && isPositiveInteger(job.outputBlueprintTypeId)
        && isQuantity(job.attempts)
        && isPositiveInteger(job.locationId),
    )
    && hasJobs(
      lists.reactionJobs,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.depth)
        && isPositiveInteger(job.productTypeId)
        && typeof job.productName === "string"
        && isQuantity(job.readyNowRuns)
        && isQuantity(job.requiredRuns)
        && Array.isArray(job.inputs)
        && isPositiveInteger(job.locationId),
    )
    && hasJobs(
      lists.manufacturingJobs,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.depth)
        && isPositiveInteger(job.productTypeId)
        && typeof job.productName === "string"
        && isQuantity(job.readyNowRuns)
        && isQuantity(job.requiredRuns)
        && Array.isArray(job.inputs)
        && isPositiveInteger(job.locationId),
    )
    && hasSimulationRows(
      lists.skillsRequired,
      (skill) =>
        isRecord(skill)
        && isPositiveInteger(skill.skillId)
        && typeof skill.name === "string"
        && isPositiveInteger(skill.requiredLevel)
        && Array.isArray(skill.jobIds)
        && skill.jobIds.every((jobId) => typeof jobId === "string"),
    )
  );
}

/** Loads the most recent native simulation result from IndexedDB. */
export async function loadSimulationResult(): Promise<SimulationResultV2 | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<SimulationResultV2 | null>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(simulationResultKey);
      request.onsuccess = () => {
        resolve(isSimulationResultV2(request.result) ? request.result : null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load the latest simulation result."));
      };
    });
  }
  catch {
    return null;
  }
}

function isStoredSimulationHaulExclusion(value: unknown): value is PlanHaulExclusion {
  if (!isRecord(value)) return false;
  const ownerType = value.ownerType;
  const ownerId = value.ownerId;
  return (
    isPositiveInteger(value.typeId)
    && isPositiveInteger(value.fromLocationId)
    && isPositiveInteger(value.toLocationId)
    && (ownerType === undefined || ownerType === "character" || ownerType === "corporation")
    && (ownerId === undefined || isPositiveInteger(ownerId))
    && (ownerType === undefined) === (ownerId === undefined)
  );
}

function isStoredSimulationHaulTask(value: unknown): value is SimulationHaulTask {
  if (!isRecord(value)) return false;
  const ownerType = value.ownerType;
  const ownerId = value.ownerId;
  return (
    typeof value.transferId === "string"
    && typeof value.lotId === "string"
    && isPositiveInteger(value.typeId)
    && typeof value.typeName === "string"
    && (
      value.blueprintKind === undefined
      || value.blueprintKind === "bpo"
      || value.blueprintKind === "bpc"
      || value.blueprintKind === "formula"
    )
    && isQuantity(value.quantity)
    && isQuantity(value.unitVolume)
    && isPositiveInteger(value.fromLocationId)
    && isPositiveInteger(value.toLocationId)
    && (ownerType === undefined || ownerType === "character" || ownerType === "corporation")
    && (ownerId === undefined || isPositiveInteger(ownerId))
    && (ownerType === undefined) === (ownerId === undefined)
    && (
      value.purpose === "industry-input"
      || value.purpose === "completion"
      || value.purpose === "reprocessing-input"
    )
    && Array.isArray(value.demands)
    && value.demands.every(
      (demand) =>
        isRecord(demand)
        && (demand.jobId === undefined || typeof demand.jobId === "string")
        && isQuantity(demand.quantity),
    )
  );
}

/** Loads persisted simulator-only haul route exclusions from IndexedDB. */
export async function loadSimulationHaulExclusions(): Promise<PlanHaulExclusion[]> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<PlanHaulExclusion[]>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(simulationHaulExclusionsKey);
      request.onsuccess = () => {
        const stored = Array.isArray(request.result) ? request.result : [];
        resolve(stored.filter(isStoredSimulationHaulExclusion));
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load simulator haul exclusions."));
      };
    });
  }
  catch {
    return [];
  }
}

/** Loads persisted simulator haul rows needed to display excluded transfers. */
export async function loadSimulationPreservedHaulTasks(): Promise<SimulationHaulTask[]> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<SimulationHaulTask[]>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(simulationPreservedHaulTasksKey);
      request.onsuccess = () => {
        const stored = Array.isArray(request.result) ? request.result : [];
        resolve(stored.filter(isStoredSimulationHaulTask));
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load preserved simulator haul tasks."));
      };
    });
  }
  catch {
    return [];
  }
}

/** Saves the simulator result and its haul exclusions in one browser transaction. */
export async function saveSimulationState(
  result: SimulationResultV2,
  haulExclusions: readonly PlanHaulExclusion[],
  preservedHaulTasks: readonly SimulationHaulTask[],
): Promise<boolean> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      const store = transaction.objectStore(plannerPreferencesStoreName);
      store.put(result, simulationResultKey);
      store.put([...haulExclusions], simulationHaulExclusionsKey);
      store.put([...preservedHaulTasks], simulationPreservedHaulTasksKey);
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Could not save simulator state."));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("Could not save simulator state."));
      };
    });
    return true;
  }
  catch {
    return false;
  }
}
