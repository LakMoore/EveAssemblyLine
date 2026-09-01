import type { ClientBuildItem, ClientPlanBucket, PlanBucketLocations } from "./types";
import { buildStoreName, getPlanningDatabase } from "./planningDatabase";

const bucketsKey = "current-buckets";

function isBucketLocations(value: unknown): value is PlanBucketLocations {
  if (!value || typeof value !== "object") return false;
  const locations = value as Record<string, unknown>;
  return [
    locations.stock,
    locations.manufacturing,
    locations.reactions,
    locations.reprocessing,
    locations.copying,
    locations.invention,
  ].every((locationId) => Number.isSafeInteger(locationId) && Number(locationId) > 0);
}

function isClientBuildItem(value: unknown): value is ClientBuildItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === "string"
    && typeof item.categoryName === "string"
    && Number.isSafeInteger(item.typeId)
    && Number.isSafeInteger(item.quantity)
    && Number(item.quantity) > 0
    && typeof item.me === "number"
    && typeof item.te === "number"
    && typeof item.fromCompression === "boolean"
  );
}

function isClientPlanBucket(value: unknown): value is ClientPlanBucket {
  if (!value || typeof value !== "object") return false;
  const bucket = value as Record<string, unknown>;
  return (
    typeof bucket.id === "string"
    && bucket.id.length > 0
    && typeof bucket.name === "string"
    && bucket.name.trim().length > 0
    && isBucketLocations(bucket.locations)
    && Array.isArray(bucket.items)
    && bucket.items.every(isClientBuildItem)
  );
}

/** Loads the saved multi-destination planner buckets, or null when no migration is needed. */
export async function loadPlannerBuckets(): Promise<ClientPlanBucket[] | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<ClientPlanBucket[] | null>((resolve, reject) => {
      const request = database
        .transaction(buildStoreName, "readonly")
        .objectStore(buildStoreName)
        .get(bucketsKey);
      request.onsuccess = () => {
        if (!Array.isArray(request.result)) {
          resolve(null);
          return;
        }
        resolve(request.result.filter(isClientPlanBucket));
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load planner buckets."));
      };
    });
  }
  catch {
    return null;
  }
}

/** Saves the complete planner bucket configuration in the existing browser planning database. */
export async function savePlannerBuckets(buckets: ClientPlanBucket[]): Promise<void> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(buildStoreName, "readwrite");
      transaction.objectStore(buildStoreName).put(buckets, bucketsKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Could not save planner buckets."));
      };
    });
  }
  catch {}
}
