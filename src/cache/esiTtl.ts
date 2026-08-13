export function parseCacheControlMaxAge(header: string | null): number | null {
  if (!header) return null;
  const match = header.match(/(?:^|[,;\s])max-age\s*=\s*(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function getEsiTtlMs(
  path: string,
  expiresHeader: string | null,
  cacheControlHeader: string | null,
): number {
  const expiresAt = expiresHeader ? Date.parse(expiresHeader) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return expiresAt - Date.now();
  const maxAge = parseCacheControlMaxAge(cacheControlHeader);
  if (maxAge != null && maxAge > 0) return maxAge * 1000;
  if (path.includes("/assets/names")) return 30 * 60 * 1000;
  if (path.includes("/corporations/") && path.includes("/assets/")) return 60 * 60 * 1000;
  if (path.includes("/corporations/") && path.includes("/industry/jobs")) return 5 * 60 * 1000;
  if (path.includes("/corporations/") && path.includes("/orders")) return 20 * 60 * 1000;
  if (path.includes("/universe/types/")) return 60 * 60 * 1000;
  if (path.includes("/characters/") || path.includes("/corporations/")) return 5 * 60 * 1000;
  return 10 * 60 * 1000;
}
