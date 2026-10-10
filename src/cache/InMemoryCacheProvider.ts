import type { CacheEntry, CacheSetEntry, ICacheProvider } from "./CacheProvider";

export class InMemoryCacheProvider implements ICacheProvider {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return Promise.resolve(null);

    if (entry.ttlMs != null && entry.ttlMs > 0 && Date.now() - entry.createdAtMs >= entry.ttlMs) {
      this.store.delete(key);
      return Promise.resolve(null);
    }

    return Promise.resolve(entry.value);
  }

  async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map((key) => this.get<T>(key)));
  }

  set(key: string, value: unknown, ttlMs?: number | null): Promise<void> {
    this.store.set(
      key,
      {
        value,
        ttlMs: ttlMs ?? null,
        createdAtMs: Date.now(),
      },
    );
    return Promise.resolve();
  }

  async setMany(entries: readonly CacheSetEntry[]): Promise<void> {
    for (const entry of entries) await this.set(entry.key, entry.value, entry.ttlMs);
  }

  async getVersion(key: string): Promise<string | null> {
    return this.get<string>(key);
  }

  delete(key: string | string[]): Promise<void> {
    if (Array.isArray(key)) {
      for (const entryKey of key) this.store.delete(entryKey);
      return Promise.resolve();
    }

    this.store.delete(key);
    return Promise.resolve();
  }

  *scan(pattern = "*"): Generator<string, void, undefined> {
    const matcher = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    for (const key of [...this.store.keys()]) {
      if (matcher.test(key)) yield key;
    }
  }

  clear(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}
