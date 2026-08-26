import { plannerPreferencesStoreName, getPlanningDatabase } from "./planningDatabase";
import {
  locationsStorageKey,
  settingsStorageKey,
  type PlannerSettings,
  type PlannerLocations,
} from "./preferences";
import type { TypeMetadata } from "@/lib/reference/types";

const locationsKey = "locations";
const buildBlacklistKey = "build-blacklist";
const excludedLocationIdsKey = "excluded-location-ids";

export async function loadPlannerLocations(): Promise<Partial<PlannerLocations> | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(locationsKey);
      request.onsuccess = () => {
        const stored = request.result as Partial<PlannerLocations> | undefined;
        if (stored) {
          resolve(stored);
          return;
        }
        try {
          const legacy = window.localStorage.getItem(locationsStorageKey);
          resolve(legacy ? (JSON.parse(legacy) as Partial<PlannerLocations>) : null);
        }
        catch {
          resolve(null);
        }
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load planner locations."));
    });
  }
  catch {
    return null;
  }
}

export async function savePlannerLocations(locations: PlannerLocations) {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      transaction.objectStore(plannerPreferencesStoreName).put(locations, locationsKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save planner locations."));
    });
  }
  catch {}
}

/** Loads the build blacklist from IndexedDB, migrating the legacy localStorage value if needed. */
export async function loadBuildBlacklist(): Promise<TypeMetadata[] | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(buildBlacklistKey);
      request.onsuccess = () => {
        if (Array.isArray(request.result)) {
          resolve(request.result as TypeMetadata[]);
          return;
        }
        resolve(readLegacyBuildBlacklist());
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load the build blacklist."));
    });
  }
  catch {
    return readLegacyBuildBlacklist();
  }
}

/** Saves the build blacklist in the shared browser planning database. */
export async function saveBuildBlacklist(buildBlacklist: PlannerSettings["buildBlacklist"]) {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      transaction.objectStore(plannerPreferencesStoreName).put(buildBlacklist, buildBlacklistKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save the build blacklist."));
    });
  }
  catch {}
}

/** Loads the planner locations excluded from hauling. */
export async function loadExcludedLocationIds(): Promise<number[]> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(plannerPreferencesStoreName, "readonly")
        .objectStore(plannerPreferencesStoreName)
        .get(excludedLocationIdsKey);
      request.onsuccess = () => {
        const stored = request.result;
        resolve(
          Array.isArray(stored)
            ? stored.filter((locationId): locationId is number => Number.isInteger(locationId))
            : [],
        );
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load excluded planner locations."));
    });
  }
  catch {
    return [];
  }
}

/** Saves the planner locations excluded from hauling. */
export async function saveExcludedLocationIds(locationIds: number[]) {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(plannerPreferencesStoreName, "readwrite");
      transaction.objectStore(plannerPreferencesStoreName).put(locationIds, excludedLocationIdsKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save excluded planner locations."));
    });
  }
  catch {}
}

function readLegacyBuildBlacklist(): TypeMetadata[] | null {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) return null;
    const raw = JSON.parse(stored) as { buildBlacklist?: unknown };
    if (!Array.isArray(raw.buildBlacklist)) return null;
    return raw.buildBlacklist.flatMap((item) => {
      if (typeof item === "number") return [{ typeId: item, name: `Type ${item}` }];
      if (
        item
        && typeof item === "object"
        && Number.isInteger(item.typeId)
        && typeof item.name === "string"
      ) {
        return [item as TypeMetadata];
      }
      return [];
    });
  }
  catch {
    return null;
  }
}
