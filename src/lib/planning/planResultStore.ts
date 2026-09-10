import type { PlanResponse } from "./types";
import { getPlanningDatabase, plannerPreferencesStoreName } from "./planningDatabase";

const planResultKey = "latest-plan-result";

export function isPlanResult(value: unknown): value is PlanResponse {
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
  const hasAllLists = [
    "planItems",
    "materialsToBuy",
    "bpcToCopy",
    "bpoToBuy",
    "inventionJobs",
    "reactionJobs",
    "manufacturingJobs",
    "reprocessingJobs",
    "skillsRequired",
    "haulingTasks",
  ].every((key) => Array.isArray(lists[key]));
  if (!hasAllLists) return false;
  const validContext = (value: unknown) => {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const context = value as Record<string, unknown>;
    return (
      (context.stockpileId === undefined || typeof context.stockpileId === "string")
      && (context.stockpileName === undefined || typeof context.stockpileName === "string")
      && (context.buildLocationId === undefined || Number.isInteger(context.buildLocationId))
      && (context.stockLocationId === undefined || Number.isInteger(context.stockLocationId))
    );
  };
  const validContextBuckets = (value: unknown) =>
    Array.isArray(value)
    && value.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const bucket = entry as Record<string, unknown>;
      return (
        validContext(bucket.context)
        && Array.isArray(bucket.items)
        && !["stockpileId", "stockpileName", "buildLocationId", "stockLocationId"].some(
          (key) => key in bucket,
        )
      );
    });
  const validBucketLists = [
    lists.planItems,
    lists.inventionJobs,
    lists.reactionJobs,
    lists.manufacturingJobs,
    lists.reprocessingJobs,
  ].every(validContextBuckets);
  if (!validBucketLists) return false;
  const validMaterialRows = (lists.materialsToBuy as unknown[]).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const material = entry as Record<string, unknown>;
    return (
      Number.isInteger(material.typeId)
      && typeof material.typeName === "string"
      && Number.isInteger(material.typeGroupId)
      && typeof material.typeGroup === "string"
      && Number.isFinite(material.unitVolume)
      && Number.isFinite(material.neededQuantity)
      && Number.isFinite(material.marketBuyOrderQuantity)
    );
  });
  const validBpoRows = (lists.bpoToBuy as unknown[]).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const blueprint = entry as Record<string, unknown>;
    return (
      Number.isInteger(blueprint.typeId)
      && typeof blueprint.typeName === "string"
      && Number.isInteger(blueprint.typeGroupId)
      && typeof blueprint.typeGroup === "string"
      && Number.isFinite(blueprint.unitVolume)
      && Number.isFinite(blueprint.neededQuantity)
      && Number.isFinite(blueprint.marketBuyOrderQuantity)
      && Number.isInteger(blueprint.bpoCount)
      && Number.isInteger(blueprint.bposInUse)
    );
  });
  const validBpcRows = (lists.bpcToCopy as unknown[]).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const blueprint = entry as Record<string, unknown>;
    return (
      Number.isInteger(blueprint.typeId)
      && typeof blueprint.typeName === "string"
      && Number.isInteger(blueprint.typeGroupId)
      && typeof blueprint.typeGroup === "string"
      && Number.isFinite(blueprint.unitVolume)
      && Number.isFinite(blueprint.neededQuantity)
      && Number.isFinite(blueprint.marketBuyOrderQuantity)
      && Number.isInteger(blueprint.bpoCount)
      && Number.isInteger(blueprint.bposInUse)
    );
  });
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
        Number.isInteger(haulItem.itemTypeId)
        && typeof haulItem.name === "string"
        && Number.isFinite(haulItem.quantity)
        && Number.isFinite(haulItem.volume)
      );
    });
  });
  return validMaterialRows && validBpoRows && validBpcRows && validHaulBuckets;
}

/** Loads the latest calculated planner result from IndexedDB. */
export async function loadPlanResult(): Promise<PlanResponse | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<PlanResponse | null>((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(planResultKey);
      request.onsuccess = () => resolve(isPlanResult(request.result) ? request.result : null);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load the latest plan result."));
    });
  }
  catch {
    return null;
  }
}

/** Saves the latest calculated planner result in the browser planning database. */
export async function savePlanResult(plan: PlanResponse): Promise<void> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      transaction.objectStore(plannerPreferencesStoreName).put(plan, planResultKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save the latest plan result."));
    });
  }
  catch {}
}
