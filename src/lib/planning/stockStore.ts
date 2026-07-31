import type { BuildItem } from "./types";

export type StockLocation = {
  systemId: number;
  systemName: string;
  structureId: string | null;
  structureName: string;
};

export type StockItem = Pick<BuildItem, "typeId" | "name" | "quantity"> & {
  volume?: number;
  category?: "bpo" | "bpc" | "reaction" | "item";
  marketCategory?: string;
};

export type StockRecord = StockLocation & {
  items: StockItem[];
};

const databaseName = "assembly-line";
const databaseVersion = 3;
const buildStoreName = "build-lists";
const stockStoreName = "stock";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(buildStoreName))
        database.createObjectStore(buildStoreName);
      if (!database.objectStoreNames.contains(stockStoreName))
        database.createObjectStore(stockStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the browser database."));
  });
}

function locationKey(location: StockLocation) {
  return `${location.systemId}:${location.structureId ?? "system"}`;
}

function isStockRecord(value: unknown): value is StockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.systemId) &&
    typeof record.systemName === "string" &&
    Array.isArray(record.items)
  );
}

export async function loadStock(location: StockLocation) {
  const database = await openDatabase();
  return new Promise<StockRecord | null>((resolve, reject) => {
    const request = database
      .transaction(stockStoreName, "readonly")
      .objectStore(stockStoreName)
      .get(locationKey(location));
    request.onsuccess = () => {
      database.close();
      const value = request.result;
      resolve(isStockRecord(value) ? value : null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Could not load stock."));
    };
  });
}

export async function loadStockRecords() {
  const database = await openDatabase();
  return new Promise<StockRecord[]>((resolve, reject) => {
    const request = database
      .transaction(stockStoreName, "readonly")
      .objectStore(stockStoreName)
      .getAll();
    request.onsuccess = () => {
      database.close();
      resolve(request.result.filter(isStockRecord));
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Could not load stock locations."));
    };
  });
}

export async function saveStock(record: StockRecord) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockStoreName, "readwrite");
    transaction.objectStore(stockStoreName).put(record, locationKey(record));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save stock."));
    };
  });
}

export async function deleteStock(location: StockLocation) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockStoreName, "readwrite");
    transaction.objectStore(stockStoreName).delete(locationKey(location));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not remove stock."));
    };
  });
}

export { locationKey };
