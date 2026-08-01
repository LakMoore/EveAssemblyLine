import type { ICacheProvider } from "./CacheProvider";
import { InMemoryCacheProvider } from "./InMemoryCacheProvider";
import { UpstashRedisCacheProvider } from "./UpstashRedisCacheProvider";

export function createCacheProvider(): ICacheProvider {
  const provider = process.env.CACHE_PROVIDER ?? "inmemory";

  switch (provider) {
    case "inmemory":
      return new InMemoryCacheProvider();
    case "upstash-redis":
      return new UpstashRedisCacheProvider();
    default:
      console.warn(`Unknown CACHE_PROVIDER="${provider}", falling back to in-memory cache.`);
      return new InMemoryCacheProvider();
  }
}