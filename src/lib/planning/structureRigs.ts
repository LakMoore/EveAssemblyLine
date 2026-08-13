export type StructureRigsEntry = {
  systemId: number;
  name: string;
  rigTypeIds: number[];
};

export type StructureRigsPayload = {
  lastModified: string;
  // Keyed by system ID and normalized structure name so user-added structures stay addressable.
  structures: Record<string, StructureRigsEntry>;
};

export const emptyStructureRigs: StructureRigsPayload = { lastModified: "", structures: {} };

export function structureRigsKey(systemId: number, name: string) {
  return `${systemId}:${name.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
}

/** ESI reports structures as "System - Name" while local structures store the bare name. */
export function structureRigsName(systemName: string | undefined, name: string) {
  const prefix = systemName ? `${systemName} - ` : "";
  return prefix && name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? name.slice(prefix.length).trim()
    : name.trim();
}

function normalizeEntry(value: unknown): StructureRigsEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<StructureRigsEntry>;
  if (!Number.isInteger(entry.systemId) || (entry.systemId as number) <= 0) return null;
  if (typeof entry.name !== "string" || entry.name.trim() === "") return null;
  if (!Array.isArray(entry.rigTypeIds) || entry.rigTypeIds.length === 0) return null;
  // Zero marks an empty rig slot, so it is kept to preserve slot positions and allow clearing rigs.
  const rigTypeIds = entry.rigTypeIds.filter(
    (rigTypeId): rigTypeId is number => Number.isInteger(rigTypeId) && rigTypeId >= 0,
  );
  if (rigTypeIds.length === 0) return null;
  return {
    systemId: entry.systemId as number,
    name: entry.name.trim().replace(/\s+/g, " "),
    rigTypeIds,
  };
}

export function normalizeStructureRigs(value: unknown): StructureRigsPayload {
  if (!value || typeof value !== "object") return emptyStructureRigs;
  const payload = value as Partial<StructureRigsPayload>;
  const lastModified =
    typeof payload.lastModified === "string" && !Number.isNaN(Date.parse(payload.lastModified))
      ? payload.lastModified
      : "";
  const structures: Record<string, StructureRigsEntry> = {};
  if (payload.structures && typeof payload.structures === "object") {
    for (const candidate of Object.values(payload.structures)) {
      const entry = normalizeEntry(candidate);
      if (entry) structures[structureRigsKey(entry.systemId, entry.name)] = entry;
    }
  }
  return { lastModified, structures };
}

function isNewer(left: string, right: string) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime)) return false;
  if (Number.isNaN(rightTime)) return true;
  return leftTime > rightTime;
}

/** Merges two rig maps; `lastModified` decides which side wins for keys present in both. */
export function mergeStructureRigs(
  left: StructureRigsPayload,
  right: StructureRigsPayload,
): StructureRigsPayload {
  const rightWins = isNewer(right.lastModified, left.lastModified);
  const [older, newer] = rightWins ? [left, right] : [right, left];
  return {
    lastModified: newer.lastModified || older.lastModified,
    structures: { ...older.structures, ...newer.structures },
  };
}
