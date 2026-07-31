import type { KnownStructure } from "./preferences";

const databaseName = "assembly-line";
const databaseVersion = 3;
const buildStoreName = "build-lists";
const stockStoreName = "stock";
const structureStoreName = "structures";
const structureKey = "known";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(buildStoreName))
        database.createObjectStore(buildStoreName);
      if (!database.objectStoreNames.contains(stockStoreName))
        database.createObjectStore(stockStoreName);
      if (!database.objectStoreNames.contains(structureStoreName))
        database.createObjectStore(structureStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the browser database."));
  });
}

function isKnownStructure(value: unknown): value is KnownStructure {
  if (!value || typeof value !== "object") return false;
  const structure = value as Record<string, unknown>;
  return (
    typeof structure.id === "string" &&
    Number.isInteger(structure.systemId) &&
    typeof structure.systemName === "string" &&
    typeof structure.type === "string" &&
    typeof structure.size === "string" &&
    typeof structure.name === "string" &&
    Array.isArray(structure.rigs) &&
    structure.rigs.every((rig) => typeof rig === "string")
  );
}

export async function loadStructures() {
  const database = await openDatabase();
  return new Promise<KnownStructure[]>((resolve, reject) => {
    const request = database
      .transaction(structureStoreName, "readonly")
      .objectStore(structureStoreName)
      .get(structureKey);
    request.onsuccess = () => {
      database.close();
      resolve(Array.isArray(request.result) ? request.result.filter(isKnownStructure) : []);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Could not load known structures."));
    };
  });
}

export async function saveStructures(structures: KnownStructure[]) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(structureStoreName, "readwrite");
    transaction.objectStore(structureStoreName).put(structures, structureKey);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save known structures."));
    };
  });
}
