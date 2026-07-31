import type { BuildItem } from "./types";

const databaseName = "assembly-line";
const databaseVersion = 3;
const storeName = "build-lists";
const currentListKey = "current";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName))
        request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the browser database."));
  });
}

function isBuildItem(value: unknown): value is BuildItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && Number.isInteger(item.typeId) && Number.isInteger(item.quantity) && Number(item.quantity) > 0;
}

export async function loadBuildList() {
  const database = await openDatabase();
  return new Promise<BuildItem[]>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(currentListKey);
    request.onsuccess = () => {
      database.close();
      resolve(Array.isArray(request.result) ? request.result.filter(isBuildItem).map((item) => ({ ...item, me: typeof item.me === "number" ? item.me : 0, te: typeof item.te === "number" ? item.te : 0 })) : []);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Could not load the build list."));
    };
  });
}

export async function saveBuildList(items: BuildItem[]) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(items, currentListKey);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save the build list."));
    };
  });
}