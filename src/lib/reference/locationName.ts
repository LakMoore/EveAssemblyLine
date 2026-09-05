/** Removes the solar-system prefix ESI includes in structure names. */
export function normalizeLocationName(systemName: string | undefined, name: string) {
  const trimmedName = name.trim().replace(/\s+/g, " ");
  if (!systemName) return trimmedName;
  const prefix = `${systemName.trim()} - `;
  return trimmedName.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? trimmedName.slice(prefix.length).trim()
    : trimmedName;
}
