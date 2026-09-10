import type { PlanResponse } from "./types";
import { getPlanningDatabase, plannerPreferencesStoreName } from "./planningDatabase";

const planResponseKey = "latest-plan-response";

export function isPlanResponse(value: unknown): value is PlanResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (
    typeof result.metadata !== "object"
    || result.metadata === null
    || typeof (result.metadata as Record<string, unknown>).generatedAt !== "string"
    || typeof result.lists !== "object"
    || result.lists === null
  ) return false;
  const lists = result.lists as Record<string, unknown>;
  const hasAllLists =
    [
      "materialsToBuy",
      "bpcToCopy",
      "bpoToBuy",
      "inventionJobs",
      "reactionJobs",
      "manufacturingJobs",
      "reprocessingJobs",
      "skillsRequired",
      "haulingTasks",
    ].every((key) => Array.isArray(lists[key])) && lists.planItems !== undefined;
  if (!hasAllLists) return false;
  const internalContextKeys = [
    "context",
    "stockpileId",
    "stockpileName",
    "buildLocationId",
    "stockLocationId",
    "activityLocationId",
  ];
  const validLocationBuckets = (value: unknown) =>
    Array.isArray(value)
    && value.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const bucket = entry as Record<string, unknown>;
      return (
        (bucket.locationId === undefined || Number.isInteger(bucket.locationId))
        && Array.isArray(bucket.items)
        && !internalContextKeys.some((key) => key in bucket)
        && bucket.items.every(
          (item) =>
            item
            && typeof item === "object"
            && !Array.isArray(item)
            && !internalContextKeys.some((key) => key in (item as Record<string, unknown>)),
        )
      );
    });
  const validBucketLists = [
    lists.bpcToCopy,
    lists.inventionJobs,
    lists.reactionJobs,
    lists.manufacturingJobs,
    lists.reprocessingJobs,
  ].every(validLocationBuckets);
  const validPlanRows = (value: unknown) =>
    Array.isArray(value)
    && value.every(
      (item: unknown) =>
        item
        && typeof item === "object"
        && !Array.isArray(item)
        && !internalContextKeys.some((key) => key in (item as Record<string, unknown>)),
    );
  const validPlanItems =
    lists.planItems
    && typeof lists.planItems === "object"
    && !Array.isArray(lists.planItems)
    && validPlanRows((lists.planItems as Record<string, unknown>).all)
    && validLocationBuckets((lists.planItems as Record<string, unknown>).byActivityLocation);
  if (!validBucketLists) return false;
  const validMaterialItem = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const material = entry as Record<string, unknown>;
    return (
      Number.isInteger(material.typeId)
      && typeof material.typeName === "string"
      && Number.isFinite(material.unitVolume)
      && Number.isFinite(material.neededQuantity)
    );
  };
  const validMarketBuckets = (value: unknown[], validateItem: (entry: unknown) => boolean) =>
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const bucket = entry as Record<string, unknown>;
      return (
        typeof bucket.assemblyLineGroup === "string"
        && Array.isArray(bucket.items)
        && bucket.items.every(validateItem)
      );
    });
  const validMaterialRows = validMarketBuckets(
    lists.materialsToBuy as unknown[],
    validMaterialItem,
  );
  const validBpoItem = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const blueprint = entry as Record<string, unknown>;
    return Number.isInteger(blueprint.bpoCount) && Number.isInteger(blueprint.bposInUse);
  };
  const validBpoRows = validMarketBuckets(
    lists.bpoToBuy as unknown[],
    (entry) => validMaterialItem(entry) && validBpoItem(entry),
  );
  const validBpcRows =
    validLocationBuckets(lists.bpcToCopy)
    && (lists.bpcToCopy as Array<{ items: unknown[] }>).every((bucket) =>
      bucket.items.every((entry) => validMaterialItem(entry) && validBpoItem(entry)),
    );
  const validHaulBuckets = (lists.haulingTasks as unknown[]).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const bucket = entry as Record<string, unknown>;
    if (
      !Number.isInteger(bucket.fromLocationId)
      || !Number.isInteger(bucket.toLocationId)
      || !Array.isArray(bucket.items)
      || (
        bucket.ownerType !== undefined
        && bucket.ownerType !== "character"
        && bucket.ownerType !== "corporation"
      )
      || (bucket.ownerId !== undefined && !Number.isInteger(bucket.ownerId))
      || "context" in bucket
    ) return false;
    return bucket.items.every((item) => {
      if (!item || typeof item !== "object") return false;
      const haulItem = item as Record<string, unknown>;
      return (
        Number.isInteger(haulItem.typeId)
        && typeof haulItem.typeName === "string"
        && Number.isFinite(haulItem.unitVolume)
        && Number.isFinite(haulItem.neededQuantity)
      );
    });
  });
  return (
    Boolean(validPlanItems) && validMaterialRows && validBpoRows && validBpcRows && validHaulBuckets
  );
}

/** Loads the latest calculated planner result from IndexedDB. */
export async function loadPlanResponse(): Promise<PlanResponse | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<PlanResponse | null>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(planResponseKey);
      request.onsuccess = () => resolve(isPlanResponse(request.result) ? request.result : null);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load the latest plan result."));
    });
  }
  catch {
    return null;
  }
}

/** Saves the latest calculated planner result in the browser planning database. */
export async function savePlanResponse(plan: PlanResponse): Promise<void> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      transaction.objectStore(plannerPreferencesStoreName).put(plan, planResponseKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save the latest plan result."));
    });
  }
  catch {}
}
