import type { HaulPatch } from "./types";
import { getPlanningDatabase, haulPatchesStoreName } from "./planningDatabase";

function isHaulPatch(value: unknown): value is HaulPatch {
  if (!value || typeof value !== "object") return false;
  const patch = value as Record<string, unknown>;
  return (
    typeof patch.key === "string"
    && Number.isInteger(patch.itemTypeId)
    && (patch.name === undefined || typeof patch.name === "string")
    && typeof patch.quantity === "number"
    && Number.isFinite(patch.quantity)
    && patch.quantity > 0
    && (
      patch.volume === undefined
      || (typeof patch.volume === "number" && Number.isFinite(patch.volume))
    )
    && Number.isInteger(patch.fromLocationId)
    && Number.isInteger(patch.toLocationId)
    && (patch.ownerType === "character" || patch.ownerType === "corporation")
    && Number.isInteger(patch.ownerId)
    && (patch.assetsLastModified === undefined || typeof patch.assetsLastModified === "string")
  );
}

/** Loads persisted owner-aware stock movement patches from IndexedDB. */
export async function loadHaulPatches(): Promise<HaulPatch[]> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<HaulPatch[]>((resolve, reject) => {
      const request = database
        .transaction(haulPatchesStoreName, "readonly")
        .objectStore(haulPatchesStoreName)
        .getAll();
      request.onsuccess = () => resolve(request.result.filter(isHaulPatch));
      request.onerror = () => reject(request.error ?? new Error("Could not load haul patches."));
    });
  }
  catch {
    return [];
  }
}

/** Replaces all persisted stock movement patches in one IndexedDB transaction. */
export async function saveHaulPatches(patches: HaulPatch[]): Promise<void> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(haulPatchesStoreName, "readwrite");
      const store = transaction.objectStore(haulPatchesStoreName);
      const request = store.clear();
      request.onsuccess = () => {
        for (const patch of patches) store.put(patch, patch.key);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not clear haul patches."));
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save haul patches."));
    });
  }
  catch {}
}
