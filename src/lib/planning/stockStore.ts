import type { BlueprintPrint, BuildItem } from "./types";
import { getPlanningDatabase, stockMetadataStoreName, stockStoreName } from "./planningDatabase";

const stockSnapshotKey = "last-refresh";

export type StockLocation = {
  systemId: number;
  systemName: string;
  structureId: string | null;
  structureName: string;
};

export type StockItem = Pick<BuildItem, "typeId" | "name" | "quantity"> & {
  locationId?: number;
  rootLocationId?: number;
  source?: "marketOrder";
  marketOrderQuantity?: number;
  isPackaged?: boolean;
  type?: "bpo" | "bpc";
  me?: number;
  te?: number;
  blueprintPrints?: BlueprintPrint[];
  assembledVolume?: number;
  packagedVolume?: number;
  techLevel?: number;
  category?: "blueprint" | "bp" | "bpo" | "bpc" | "reaction" | "item";
  marketCategory?: string;
  inBuild?: boolean;
  inProduction?: boolean;
  inBuildQuantity?: number;
  inUse?: boolean;
  jobId?: number;
  installerId?: number;
  facilityId?: number;
  outputLocationId?: number;
  blueprintId?: number;
  blueprintTypeId?: number;
  blueprintIsOriginal?: boolean;
  blueprintRunsAtInstall?: number;
  licensedRuns?: number;
  installedRuns?: number;
  blueprintRunsUsed?: number;
  blueprintRunsRemaining?: number;
  activityName?: string;
  jobRuns?: number;
  endDate?: string;
};

export type StockRecord = StockLocation & {
  source?: "esi" | "marketOrder";
  items: StockItem[];
};

function locationKey(location: StockLocation) {
  return `${location.systemId}:${location.structureId ?? "system"}`;
}

function isStockRecord(value: unknown): value is StockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.systemId)
    && typeof record.systemName === "string"
    && Array.isArray(record.items)
  );
}

export async function loadStock(location: StockLocation) {
  const database = await getPlanningDatabase();
  return new Promise<StockRecord | null>((resolve, reject) => {
    const request = database
      .transaction(stockStoreName, "readonly")
      .objectStore(stockStoreName)
      .get(locationKey(location));
    request.onsuccess = () => {
      const value = request.result;
      resolve(isStockRecord(value) ? value : null);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not load stock."));
    };
  });
}

export async function loadStockRecords() {
  const database = await getPlanningDatabase();
  return new Promise<StockRecord[]>((resolve, reject) => {
    const request = database
      .transaction(stockStoreName, "readonly")
      .objectStore(stockStoreName)
      .getAll();
    request.onsuccess = () => {
      resolve(request.result.filter(isStockRecord));
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not load stock locations."));
    };
  });
}

export async function saveStock(record: StockRecord) {
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockStoreName, "readwrite");
    transaction.objectStore(stockStoreName).put(record, locationKey(record));
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not save stock."));
    };
  });
}

export async function replaceEsiStock(records: StockRecord[]) {
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockStoreName, "readwrite");
    const store = transaction.objectStore(stockStoreName);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const record of request.result.filter(isStockRecord)) {
        if (record.source === "esi") store.delete(locationKey(record));
      }
      for (const record of records) store.put({ ...record, source: "esi" }, locationKey(record));
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not replace cached ESI stock."));
    };
    transaction.oncomplete = () => {
      void saveStockSnapshotTime();
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not replace cached ESI stock."));
    };
  });
}

export async function loadStockSnapshotTime() {
  const database = await getPlanningDatabase();
  return new Promise<number | null>((resolve, reject) => {
    const request = database
      .transaction(stockMetadataStoreName, "readonly")
      .objectStore(stockMetadataStoreName)
      .get(stockSnapshotKey);
    request.onsuccess = () => resolve(typeof request.result === "number" ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("Could not load stock metadata."));
  });
}

async function saveStockSnapshotTime() {
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockMetadataStoreName, "readwrite");
    transaction.objectStore(stockMetadataStoreName).put(Date.now(), stockSnapshotKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save stock metadata."));
  });
}

export async function deleteStock(location: StockLocation) {
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockStoreName, "readwrite");
    transaction.objectStore(stockStoreName).delete(locationKey(location));
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not remove stock."));
    };
  });
}

export { locationKey };
