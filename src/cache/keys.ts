export const SDE_PREFIX = "sde";
export const ESI_PREFIX = "esi";
export const SDE_VERSION_KEY = `${SDE_PREFIX}:version`;

export function sdeKey(namespace: string, id: string | number): string {
  return `${SDE_PREFIX}:${namespace}:${id}`;
}

export function esiKey(
  path: string,
  queryParams?: Record<string, string | number | undefined>,
): string {
  let key = `${ESI_PREFIX}:${path}`;

  if (queryParams && Object.keys(queryParams).length > 0) {
    const sorted = Object
      .entries(queryParams)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    if (sorted) key += `?${sorted}`;
  }

  return key;
}
