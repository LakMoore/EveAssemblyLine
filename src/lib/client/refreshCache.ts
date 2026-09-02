import { endpointCacheStoreName, getPlanningDatabase } from "@/lib/planning/planningDatabase";

const refreshTimestampKey = "last-refresh";

export type ClientEndpointRecord<T = unknown> = {
  key: string;
  url: string;
  data: T;
  returnedAt: string;
  refreshAt: string | null;
};

export const refreshDependentEndpoints = {
  welcome: [],
  planner: ["state/assets", "state/jobs", "facilities"],
  appraise: [],
  signals: ["state/assets"],
  compress: ["state/assets", "state/status", "facilities", "compress/options"],
  assets: ["state/assets"],
  jobs: ["state/jobs"],
  ships: ["state/ships"],
  structures: ["state/assets", "facilities"],
  characters: ["state/status", "characters", "auth/corp/status", "state/assets"],
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

export async function saveEndpointResponse<T>(key: string, url: string, data: T) {
  const returnedAt = new Date().toISOString();
  const refreshAt = await loadLastRefreshAt();
  const record: ClientEndpointRecord<T> = { key, url, data, returnedAt, refreshAt };
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(endpointCacheStoreName, "readwrite");
    transaction.objectStore(endpointCacheStoreName).put(record, `endpoint:${key}`);
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
