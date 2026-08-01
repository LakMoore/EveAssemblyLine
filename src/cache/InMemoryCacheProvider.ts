import type { CacheEntry, CacheSetEntry, ICacheProvider } from "./CacheProvider";

export class InMemoryCacheProvider implements ICacheProvider {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    if (entry.ttlMs != null && entry.ttlMs > 0 && Date.now() - entry.createdAtMs >= entry.ttlMs) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map((key) => this.get<T>(key)));
  }

  async set<T>(key: string, value: T, ttlMs?: number | null): Promise<void> {
    this.store.set(key, {
      value,
      ttlMs: ttlMs ?? null,
      createdAtMs: Date.now(),
    });
  }

  async setMany(entries: readonly CacheSetEntry[]): Promise<void> {
    for (const entry of entries) await this.set(entry.key, entry.value, entry.ttlMs);
  }

  async getVersion(key: string): Promise<string | null> {
    return this.get<string>(key);
  }

  async delete(key: string | string[]): Promise<void> {
    if (Array.isArray(key)) {
      for (const entryKey of key) this.store.delete(entryKey);
      return;
    }

    this.store.delete(key);
  }

  async *scan(pattern = "*"): AsyncGenerator<string, void, undefined> {
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

  async clear(): Promise<void> {
    this.store.clear();
  }
}
