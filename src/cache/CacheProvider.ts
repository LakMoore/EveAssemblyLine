export type CacheEntry<T> = {
  value: T;
  ttlMs?: number | null;
  createdAtMs: number;
};

export type CacheSetEntry = {
  key: string;
  value: unknown;
  ttlMs?: number | null;
};

export interface ICacheProvider {
  get<T>(key: string): Promise<T | null>;
  getMany<T>(keys: readonly string[]): Promise<Array<T | null>>;
  set<T>(key: string, value: T, ttlMs?: number | null): Promise<void>;
  setMany(entries: readonly CacheSetEntry[]): Promise<void>;
  getVersion(key: string): Promise<string | null>;
  delete(key: string | string[]): Promise<void>;
  /** Enumerate keys matching a Redis-style glob pattern. */
  scan(pattern?: string): AsyncGenerator<string, void, undefined>;
  clear?(): Promise<void>;
}
