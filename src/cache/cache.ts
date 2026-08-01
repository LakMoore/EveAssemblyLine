import type { ICacheProvider } from "./CacheProvider";
import { createCacheProvider } from "./createCacheProvider";

export const cache: ICacheProvider = createCacheProvider();