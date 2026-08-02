import { cache } from "../cache";
import { getEsiTtlMs } from "../esiTtl";
import { esiKey } from "../keys";

export type EsiQueryParams = Record<string, string | number | undefined>;
export type EsiCachedResponse<T> = {
  data: T | null;
  headers: Record<string, string>;
  status: number;
};

export function getEsiResponse<T>(path: string, queryParams?: EsiQueryParams): Promise<T | null> {
  return cache.get<T>(esiKey(path, queryParams));
}

export function setEsiResponse<T>(
  path: string,
  data: T,
  cacheControlHeader: string | null,
  queryParams?: EsiQueryParams,
): Promise<void> {
  return cache.set(esiKey(path, queryParams), data, getEsiTtlMs(path, cacheControlHeader));
}

export function getCachedEsiResponse<T>(path: string, queryParams?: EsiQueryParams) {
  return cache.get<EsiCachedResponse<T>>(esiKey(path, queryParams));
}

export function setCachedEsiResponse<T>(
  path: string,
  response: EsiCachedResponse<T>,
  cacheControlHeader: string | null,
  queryParams?: EsiQueryParams,
): Promise<void> {
  return cache.set(esiKey(path, queryParams), response, getEsiTtlMs(path, cacheControlHeader));
}
