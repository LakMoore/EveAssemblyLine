const databaseName = "assembly-line";
const databaseVersion = 6;

export const buildStoreName = "build-lists";
export const stockStoreName = "stock";
export const structureStoreName = "structures";
export const compressSettingsStoreName = "compress-settings";

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [buildStoreName, stockStoreName, structureStoreName, compressSettingsStoreName]) {
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the browser database."));
    request.onblocked = () => reject(new Error("The browser database upgrade is blocked."));
  });
}

export function getPlanningDatabase() {
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}
