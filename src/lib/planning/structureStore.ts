import type { KnownStructure } from "./preferences";
import { getPlanningDatabase, structureStoreName } from "./planningDatabase";

const structureKey = "known";
const localStorageKey = "assembly-line-known-structures";

function isKnownStructure(value: unknown): value is KnownStructure {
  if (!value || typeof value !== "object") return false;
  const structure = value as Record<string, unknown>;
  return (
    typeof structure.id === "string"
    && Number.isInteger(structure.systemId)
    && typeof structure.systemName === "string"
    && typeof structure.type === "string"
    && typeof structure.size === "string"
    && typeof structure.name === "string"
    && Array.isArray(structure.rigs)
    && structure.rigs.every((rig) => typeof rig === "string")
  );
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
    return loadLocalStructures();
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
      saveLocalStructures(structures);
      return structures;
    }
  }
  catch {}
  return loadLocalStructures();
}

export async function saveStructures(structures: KnownStructure[]) {
  saveLocalStructures(structures);
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(structureStoreName, "readwrite");
      transaction.objectStore(structureStoreName).put(structures, structureKey);
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
