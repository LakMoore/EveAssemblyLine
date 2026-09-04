import type { PlanResult } from "./types";
import { getPlanningDatabase, plannerPreferencesStoreName } from "./planningDatabase";

const planResultKey = "latest-plan-result";

function isPlanResult(value: unknown): value is PlanResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.metadata === "object"
    && result.metadata !== null
    && typeof result.lists === "object"
    && result.lists !== null
  );
}

/** Loads the latest calculated planner result from IndexedDB. */
export async function loadPlanResult(): Promise<PlanResult | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<PlanResult | null>((resolve, reject) => {
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
export async function savePlanResult(plan: PlanResult): Promise<void> {
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
