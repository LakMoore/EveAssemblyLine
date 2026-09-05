/** Removes the solar-system prefix ESI includes in structure names. */
export function normalizeLocationName(systemName: string | undefined, name: string) {
  const trimmedName = name.trim().replace(/\s+/g, " ");
  if (!systemName) return trimmedName;
  const prefix = `${systemName.trim().replace(/\s+/g, " ")} - `;
  return trimmedName.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? trimmedName.slice(prefix.length).trim()
    : trimmedName;
}

/** Returns one canonical display name for a structure, including its solar system. */
export function formatLocationName(systemName: string | undefined, name: string) {
  const normalizedName = normalizeLocationName(systemName, name);
  if (!systemName) return normalizedName;
  return `${systemName.trim().replace(/\s+/g, " ")} - ${normalizedName}`;
}
