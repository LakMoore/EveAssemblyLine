import { Redis } from "@upstash/redis";
import type { CacheSetEntry, ICacheProvider } from "./CacheProvider";

export class UpstashRedisCacheProvider implements ICacheProvider {
  private readonly client: Redis;

  constructor() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        "UpstashRedisCacheProvider requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.",
      );
    }

    this.client = new Redis({ url, token });
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get<string>(key);
    if (raw == null) return null;

    try {
      return JSON.parse(raw) as T;
    }
    catch {
      return null;
    }
  }

  async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    if (keys.length === 0) return [];
    const values = await this.client.mget<(string | null)[]>(...keys);
    return values.map((raw) => {
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      }
      catch {
        return null;
      }
    });
  }

  async set<T>(key: string, value: T, ttlMs?: number | null): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Cache values must be JSON serializable.");

    if (ttlMs != null && ttlMs > 0) {
      await this.client.set(key, serialized, { ex: Math.ceil(ttlMs / 1000) });
      return;
    }

    await this.client.set(key, serialized);
  }

  async setMany(entries: readonly CacheSetEntry[]): Promise<void> {
    const batchSize = 500;
    for (let start = 0; start < entries.length; start += batchSize) {
      const pipeline = this.client.pipeline();
      const batch = entries.slice(start, start + batchSize);
      for (const entry of batch) {
        const serialized = JSON.stringify(entry.value);
        if (serialized === undefined) throw new Error("Cache values must be JSON serializable.");
        if (entry.ttlMs != null && entry.ttlMs > 0) {
          pipeline.set(entry.key, serialized, { ex: Math.ceil(entry.ttlMs / 1000) });
        }
        else {
          pipeline.set(entry.key, serialized);
        }
      }
      await pipeline.exec();
    }
  }

  async getVersion(key: string): Promise<string | null> {
    return this.get<string>(key);
  }

  async delete(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.length > 0) await this.client.del(...keys);
  }

  async *scan(pattern = "*"): AsyncGenerator<string, void, undefined> {
    let cursor = "0";

    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor,
        {
          match: pattern,
          count: 1000,
        },
      );
      for (const key of batch) yield key;
      cursor = nextCursor;
    } while (cursor !== "0");
  }
}
