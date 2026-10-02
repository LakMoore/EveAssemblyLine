import type { KnownStructure } from "./preferences";
import { getPlanningDatabase, structureStoreName } from "./planningDatabase";

const structureKey = "known";
const localStorageKey = "assembly-line-known-structures";

function isKnownStructure(value: unknown): value is KnownStructure {
  if (!value || typeof value !== "object") return false;
  const structure = value as Record<string, unknown>;
  return (
    typeof structure.id === "string"
    && (
      structure.plannerLocationId === undefined
      || (
        Number.isSafeInteger(structure.plannerLocationId)
        && Number(structure.plannerLocationId) < 0
      )
    )
    && Number.isInteger(structure.systemId)
    && typeof structure.systemName === "string"
    && typeof structure.type === "string"
    && Number.isSafeInteger(structure.typeId)
    && Number(structure.typeId) > 0
    && typeof structure.size === "string"
    && typeof structure.name === "string"
    && Array.isArray(structure.rigTypeIds)
    && structure.rigTypeIds.every((typeId) => Number.isSafeInteger(typeId) && typeId > 0)
  );
}

/** Assigns stable negative planner IDs to local structures without an ESI structure ID. */
export function assignPlannerLocationIds(structures: KnownStructure[]): KnownStructure[] {
  const usedIds = new Set<number>();
  const nextStructures = structures.map((structure) => ({ ...structure }));

  for (const structure of nextStructures) {
    const locationId = structure.plannerLocationId;
    if (
      structure.esiStructureId === undefined
      && locationId !== undefined
      && Number.isSafeInteger(locationId)
      && locationId < 0
      && !usedIds.has(locationId)
    ) {
      usedIds.add(locationId);
    }
    else {
      delete structure.plannerLocationId;
    }
  }

  let nextId = -1;
  for (const structure of nextStructures) {
    if (structure.esiStructureId !== undefined || structure.plannerLocationId !== undefined) {
      continue;
    }
    while (usedIds.has(nextId)) nextId -= 1;
    structure.plannerLocationId = nextId;
    usedIds.add(nextId);
    nextId -= 1;
  }

  return nextStructures;
}

function loadLocalStructures() {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(localStorageKey);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter(isKnownStructure) : [];
  }
  catch {
    return [];
  }
}

function saveLocalStructures(structures: KnownStructure[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(localStorageKey, JSON.stringify(structures));
}

export async function loadStructures() {
  if (typeof window !== "undefined" && window.localStorage.getItem(localStorageKey) !== null) {
    const storedStructures = loadLocalStructures();
    const structures = assignPlannerLocationIds(storedStructures);
    if (JSON.stringify(structures) !== JSON.stringify(storedStructures)) {
      void saveStructures(structures);
    }
    return structures;
  }
  try {
    const database = await getPlanningDatabase();
    const structures = await new Promise<KnownStructure[]>((resolve, reject) => {
      const request = database
        .transaction(structureStoreName, "readonly")
        .objectStore(structureStoreName)
        .get(structureKey);
      request.onsuccess = () => {
        resolve(Array.isArray(request.result) ? request.result.filter(isKnownStructure) : []);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load known structures."));
      };
    });
    if (structures.length > 0) {
      const normalizedStructures = assignPlannerLocationIds(structures);
      saveLocalStructures(normalizedStructures);
      if (JSON.stringify(normalizedStructures) !== JSON.stringify(structures)) {
        void saveStructures(normalizedStructures);
      }
      return normalizedStructures;
    }
  }
  catch {}
  const storedStructures = loadLocalStructures();
  const structures = assignPlannerLocationIds(storedStructures);
  if (JSON.stringify(structures) !== JSON.stringify(storedStructures)) {
    void saveStructures(structures);
  }
  return structures;
}

export async function saveStructures(structures: KnownStructure[]) {
  const normalizedStructures = assignPlannerLocationIds(structures);
  saveLocalStructures(normalizedStructures);
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(structureStoreName, "readwrite");
      transaction.objectStore(structureStoreName).put(normalizedStructures, structureKey);
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Could not save known structures."));
      };
    });
  }
  catch {}
}
