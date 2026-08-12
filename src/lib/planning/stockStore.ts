import type { BlueprintPrint, BuildItem } from "./types";
import { getPlanningDatabase, stockStoreName } from "./planningDatabase";

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
    Number.isInteger(record.systemId) &&
    typeof record.systemName === "string" &&
    Array.isArray(record.items)
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
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not replace cached ESI stock."));
    };
  });
}

export async function replaceMarketOrderStock(items: StockItem[]) {
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stockStoreName, "readwrite");
    const store = transaction.objectStore(stockStoreName);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result.filter(isStockRecord);
      const marketOrderQuantities = new Map<number, number>();
      for (const item of items) {
        marketOrderQuantities.set(
          item.typeId,
          (marketOrderQuantities.get(item.typeId) ?? 0) + item.quantity,
        );
      }
      for (const record of records) {
        if (record.source === "marketOrder") store.delete(locationKey(record));
        else {
          store.put({
            ...record,
            items: record.items.map((item) => ({
              ...item,
              marketOrderQuantity: marketOrderQuantities.get(item.typeId),
            })),
          }, locationKey(record));
        }
      }
      if (items.length > 0) {
        store.put({
          systemId: 0,
          systemName: "Market orders",
          structureId: "market-orders",
          structureName: "Market sell orders",
          source: "marketOrder",
          items: items.map((item) => ({ ...item, source: "marketOrder" as const })),
        }, "0:market-orders");
      }
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not replace cached market orders."));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not replace cached market orders."));
    };
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
