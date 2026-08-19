import { plannerPreferencesStoreName, getPlanningDatabase } from "./planningDatabase";
import { locationsStorageKey, type PlannerLocations } from "./preferences";

const locationsKey = "locations";

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
