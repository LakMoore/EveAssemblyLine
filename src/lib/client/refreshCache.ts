import { endpointCacheStoreName, getPlanningDatabase } from "@/lib/planning/planningDatabase";

const refreshTimestampKey = "last-refresh";

export type ClientEndpointRecord<T = unknown> = {
  key: string;
  url: string;
  data: T;
  scope?: string;
  etag?: string;
  generation?: {
    epoch: string;
    value: number;
  };
  returnedAt: string;
  refreshAt: string | null;
};

export const refreshDependentEndpoints = {
  welcome: [],
  public: [],
  planner: ["owner-assets", "owner-jobs", "compress/options"],
  appraise: [],
  signals: ["owner-assets"],
  compress: ["owner-assets", "compress/options"],
  assets: ["owner-assets"],
  jobs: ["owner-jobs"],
  ships: ["owner-ships"],
  structures: ["owner-assets"],
  corpHangars: ["owner-assets"],
  characters: [],
  settings: [],
  imagechecker: [],
} as const satisfies Record<string, readonly string[]>;

function read<T>(storeName: string, key: string) {
  return getPlanningDatabase().then(
    (database) =>
      new Promise<T | undefined>((resolve, reject) => {
        const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read endpoint cache."));
      }),
  );
}

export function loadLastRefreshAt() {
  return read<string>(endpointCacheStoreName, refreshTimestampKey).then((value) => value ?? null);
}

export function saveLastRefreshAt(refreshAt: string) {
  return getPlanningDatabase().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(endpointCacheStoreName, "readwrite");
        transaction.objectStore(endpointCacheStoreName).put(refreshAt, refreshTimestampKey);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not save refresh timestamp."));
      }),
  );
}

export function loadEndpointRecord<T>(key: string) {
  return read<ClientEndpointRecord<T>>(endpointCacheStoreName, `endpoint:${key}`).then(
    (value) => value ?? null,
  );
}

export async function saveEndpointResponse<T>(
  key: string,
  url: string,
  data: T,
  etag?: string,
  scope?: string,
  generation?: { epoch: string; value: number },
) {
  const returnedAt = new Date().toISOString();
  const refreshAt = await loadLastRefreshAt();
  const record: ClientEndpointRecord<T> = {
    key,
    url,
    data,
    ...(scope ? { scope } : {}),
    ...(etag ? { etag } : {}),
    ...(generation === undefined ? {} : { generation }),
    returnedAt,
    refreshAt,
  };
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(endpointCacheStoreName, "readwrite");
    const store = transaction.objectStore(endpointCacheStoreName);
    const existingRequest = store.get(`endpoint:${key}`);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as ClientEndpointRecord | undefined;
      if (
        generation !== undefined
        && existing?.generation?.epoch === generation.epoch
        && existing.generation.value > generation.value
      ) {
        return;
      }
      store.put(record, `endpoint:${key}`);
    };
    existingRequest.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save endpoint response."));
  });
}

export async function endpointNeedsRefresh(key: string, refreshAt: string | null) {
  if (!refreshAt) return false;
  const record = await loadEndpointRecord(key);
  return !record || Date.parse(record.returnedAt) < Date.parse(refreshAt);
}
