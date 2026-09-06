import type { ClientBuildItem, ClientPlanStockpile, PlanStockpileLocations } from "./types";
import { productionGroupDefinitions } from "./productionGroups";
import { buildStoreName, getPlanningDatabase } from "./planningDatabase";

const stockpilesKey = "current-stockpiles";
const legacyStockpilesKey = "current-buckets";

function isStockpileLocations(value: unknown): value is PlanStockpileLocations {
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

function isGroupAssignments(value: unknown): value is ClientPlanStockpile["groupAssignments"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const validKeys = new Set(productionGroupDefinitions.map((group) => group.key));
  return Object
    .entries(value)
    .every(
      ([key, locationId]) =>
        validKeys.has(key as (typeof productionGroupDefinitions)[number]["key"])
        && Number.isSafeInteger(locationId)
        && Number(locationId) > 0,
    );
}

function isReprocessingEfficiencies(
  value: unknown,
): value is ClientPlanStockpile["reprocessingEfficiencies"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object
    .entries(value)
    .every(
      ([typeId, efficiency]) =>
        /^\d+$/.test(typeId)
        && typeof efficiency === "number"
        && Number.isFinite(efficiency)
        && efficiency >= 0
        && efficiency <= 100,
    );
}

function isClientPlanStockpile(value: unknown): value is ClientPlanStockpile {
  if (!value || typeof value !== "object") return false;
  const stockpile = value as Record<string, unknown>;
  return (
    typeof stockpile.id === "string"
    && stockpile.id.length > 0
    && typeof stockpile.name === "string"
    && stockpile.name.trim().length > 0
    && (
      stockpile.kind === undefined
      || stockpile.kind === "standard"
      || stockpile.kind === "special"
    )
    && isStockpileLocations(stockpile.locations)
    && (stockpile.groupAssignments === undefined || isGroupAssignments(stockpile.groupAssignments))
    && (
      stockpile.reprocessingEfficiencies === undefined
      || isReprocessingEfficiencies(stockpile.reprocessingEfficiencies)
    )
    && Array.isArray(stockpile.items)
    && stockpile.items.every(isClientBuildItem)
  );
}

/** Loads saved planner stockpiles, including the legacy browser storage key. */
export async function loadPlannerStockpiles(): Promise<ClientPlanStockpile[] | null> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise<ClientPlanStockpile[] | null>((resolve, reject) => {
      const store = database.transaction(buildStoreName, "readonly").objectStore(buildStoreName);
      const request = store.get(stockpilesKey);
      request.onsuccess = () => {
        if (Array.isArray(request.result)) {
          resolve(request.result.filter(isClientPlanStockpile));
          return;
        }
        const legacyRequest = database
          .transaction(buildStoreName, "readonly")
          .objectStore(buildStoreName)
          .get(legacyStockpilesKey);
        legacyRequest.onsuccess = () => {
          if (!Array.isArray(legacyRequest.result)) {
            resolve(null);
            return;
          }
          resolve(legacyRequest.result.filter(isClientPlanStockpile));
        };
        legacyRequest.onerror = () => {
          reject(legacyRequest.error ?? new Error("Could not load planner stockpiles."));
        };
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load planner stockpiles."));
      };
    });
  }
  catch {
    return null;
  }
}

/** Saves the complete planner stockpile configuration in the browser planning database. */
export async function savePlannerStockpiles(stockpiles: ClientPlanStockpile[]): Promise<void> {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(buildStoreName, "readwrite");
      transaction.objectStore(buildStoreName).put(stockpiles, stockpilesKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Could not save planner stockpiles."));
      };
    });
  }
  catch {}
}
