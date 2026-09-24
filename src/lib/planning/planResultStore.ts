import type { SimulationHaulTask, SimulationResultV1 } from "./simulator/types";
import type { PlanHaulExclusion, PlanResponse } from "./types";
import { getPlanningDatabase, plannerPreferencesStoreName } from "./planningDatabase";

const planResponseKey = "latest-plan-response";
const simulationResultKey = "latest-simulation-result-v1";
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

/** Narrows archived legacy planner payloads for the admin replay screen only. */
export function isPlanResponse(value: unknown): value is PlanResponse {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.lists)) return false;
  const metadata = value.metadata;
  const lists = value.lists;
  const hasLocationBuckets = (buckets: unknown) =>
    Array.isArray(buckets)
    && buckets.every(
      (bucket) =>
        isRecord(bucket)
        && (bucket.locationId === undefined || isPositiveInteger(bucket.locationId))
        && Array.isArray(bucket.items)
        && bucket.items.every(isRecord),
    );
  const planItems = lists.planItems;
  const hasPlanItems =
    isRecord(planItems)
    && Array.isArray(planItems.all)
    && planItems.all.every(hasTypeIdentity)
    && hasLocationBuckets(planItems.byActivityLocation);
  const hasPurchaseGroups = (groups: unknown) =>
    Array.isArray(groups)
    && groups.every(
      (group) =>
        isRecord(group)
        && typeof group.assemblyLineGroup === "string"
        && Array.isArray(group.items)
        && group.items.every((item) => hasTypeIdentity(item) && isQuantity(item.neededQuantity)),
    );
  const hasHaulBuckets =
    Array.isArray(lists.haulingTasks)
    && lists.haulingTasks.every(
      (bucket) =>
        isRecord(bucket)
        && isPositiveInteger(bucket.fromLocationId)
        && isPositiveInteger(bucket.toLocationId)
        && Array.isArray(bucket.items)
        && bucket.items.every((item) => hasTypeIdentity(item) && isQuantity(item.neededQuantity)),
    );
  return (
    typeof metadata.generatedAt === "string"
    && hasPlanItems
    && hasPurchaseGroups(lists.materialsToBuy)
    && hasPurchaseGroups(lists.bpoToBuy)
    && hasLocationBuckets(lists.bpcToCopy)
    && hasLocationBuckets(lists.inventionJobs)
    && hasLocationBuckets(lists.reactionJobs)
    && hasLocationBuckets(lists.manufacturingJobs)
    && hasLocationBuckets(lists.reprocessingJobs)
    && Array.isArray(lists.skillsRequired)
    && lists.skillsRequired.every(isRecord)
    && hasHaulBuckets
  );
}

/** Loads the most recent legacy calculation result from IndexedDB. */
export async function loadPlanResponse(): Promise<PlanResponse | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<PlanResponse | null>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(planResponseKey);
      request.onsuccess = () => resolve(isPlanResponse(request.result) ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error("Could not load the latest plan."));
    });
  }
  catch {
    return null;
  }
}

/** Saves a legacy calculation result for browser-local restoration. */
export async function savePlanResponse(plan: PlanResponse): Promise<void> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      transaction.objectStore(plannerPreferencesStoreName).put(plan, planResponseKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save the plan."));
    });
  }
  catch {}
}

/** Validates the durable browser representation of a native simulator result. */
export function isSimulationResultV1(value: unknown): value is SimulationResultV1 {
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
    && [
      "requiredNow",
      "reserved",
      "availableNow",
      "availableFromHauling",
      "availableFromProduction",
      "availableFromCopying",
      "availableFromInvention",
      "availableFromReprocessing",
      "availableFromMarket",
      "transferredOut",
      "unsatisfied",
      "surplus",
    ].every((key) => isQuantity(balance[key]))
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
        && bucket.items.every((item) => hasBalance(item) && item.locationId === bucket.locationId),
    );
  const hasSurplusBalances =
    lists.surplusItems === undefined || hasPresentationBuckets(lists.surplusItems);
  const hasPlanPresentationBalances = hasPresentationBuckets(lists.planItems);
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
  return (
    (metadata.simulationId === undefined || typeof metadata.simulationId === "string")
    && metadata.simulatorVersion === 1
    && typeof metadata.generatedAt === "string"
    && typeof metadata.normalizedInputHash === "string"
    && hasSimulationRows(
      lists.warnings,
      (warning) =>
        isRecord(warning)
        && typeof warning.code === "string"
        && typeof warning.message === "string",
    )
    && hasPlanPresentationBalances
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
    && hasJobs(
      lists.reprocessingJobs,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.sourceTypeId)
        && typeof job.sourceTypeName === "string"
        && isQuantity(job.sourceQuantity)
        && isPositiveInteger(job.locationId),
    )
    && hasJobs(
      lists.bpcToCopy,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.blueprintTypeId)
        && isQuantity(job.copies)
        && isPositiveInteger(job.locationId),
    )
    && hasJobs(
      lists.inventionJobs,
      (job) =>
        typeof job.jobId === "string"
        && isPositiveInteger(job.outputBlueprintTypeId)
        && isQuantity(job.attempts)
        && isPositiveInteger(job.locationId),
    )
    && hasJobs(
      lists.reactionJobs,
      (job) =>
        typeof job.jobId === "string"
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
export async function loadSimulationResult(): Promise<SimulationResultV1 | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<SimulationResultV1 | null>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(simulationResultKey);
      request.onsuccess = () =>
        resolve(isSimulationResultV1(request.result) ? request.result : null);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load the latest simulation result."));
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
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load simulator haul exclusions."));
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
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load preserved simulator haul tasks."));
    });
  }
  catch {
    return [];
  }
}

/** Saves the simulator result and its haul exclusions in one browser transaction. */
export async function saveSimulationState(
  result: SimulationResultV1,
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
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save simulator state."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Could not save simulator state."));
    });
    return true;
  }
  catch {
    return false;
  }
}
