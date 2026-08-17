export type FacilitySettingsEntry = {
  locationId?: number;
  systemId: number;
  name: string;
  typeId?: number;
  rigTypeIds: number[];
  services?: Array<{ name: string; state: string }>;
  allowStandardBuilds?: boolean;
  allowCapitalBuilds?: boolean;
  allowReactionBuilds?: boolean;
  allowBiochemicalReactions?: boolean;
  allowCompositeReactions?: boolean;
  allowHybridReactions?: boolean;
  allowInvention?: boolean;
  allowResearch?: boolean;
  standardTaxRate?: number;
  capitalTaxRate?: number;
  reactionTaxRate?: number;
  biochemicalTaxRate?: number;
  compositeTaxRate?: number;
  hybridTaxRate?: number;
  inventionTaxRate?: number;
  researchTaxRate?: number;
  settingsLastModified?: string;
};

export type FacilitySettingsPayload = {
  lastModified: string;
  facilities: Record<string, FacilitySettingsEntry>;
};

export type Facility = {
  id: number;
  name: string;
  locationType: "station" | "structure";
  typeId: number;
  systemId: number;
  securityStatus?: number;
  systemCostIndices: Record<string, number>;
  activities: Record<string, FacilityActivity>;
  buildTypeGroups: Record<string, unknown>;
  services: Array<{ name: string; state: string }>;
  rigTypeIds: number[];
  settingsLastModified: string;
};

export type FacilityActivity = {
  available: boolean;
  baseYield?: number;
  standard?: number | null;
  capital?: number | null;
  reactions?: number | null;
  biochemical?: number | null;
  composite?: number | null;
  hybrid?: number | null;
  invention?: number | null;
  research?: number | null;
  jobDuration?: number;
  materialConsumption?: number;
  jobCost?: number;
  rawJobDurationMultiplier?: number;
  rawMaterialConsumptionMultiplier?: number;
  rawJobCostMultiplier?: number;
};

export type FacilityResponse = {
  facilities: Facility[];
  settings: FacilitySettingsPayload;
};

export const emptyFacilitySettings: FacilitySettingsPayload = { lastModified: "", facilities: {} };

const refineryTypeIds = new Set([35835, 35836]);

export function supportsReactionSettings(
  typeId: number | undefined,
  securityStatus: number | undefined,
) {
  return (
    typeId !== undefined
    && refineryTypeIds.has(typeId)
    && (securityStatus === undefined || securityStatus < 0.5)
  );
}

export function facilitySettingsKey(systemId: number, name: string) {
  return `${systemId}:${name.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
}

/** ESI reports structures as "System - Name" while local structures store the bare name. */
export function facilitySettingsName(systemName: string | undefined, name: string) {
  const prefix = systemName ? `${systemName} - ` : "";
  return prefix && name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? name.slice(prefix.length).trim()
    : name.trim();
}

function normalizeEntry(value: unknown): FacilitySettingsEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<FacilitySettingsEntry>;
  if (!Number.isInteger(entry.systemId) || (entry.systemId as number) <= 0) return null;
  if (typeof entry.name !== "string" || entry.name.trim() === "") return null;
  if (!Array.isArray(entry.rigTypeIds)) return null;
  const rigTypeIds = entry.rigTypeIds.filter(
    (rigTypeId): rigTypeId is number => Number.isInteger(rigTypeId) && rigTypeId >= 0,
  );
  if (rigTypeIds.length === 0) return null;
  return {
    ...(Number.isSafeInteger(entry.locationId) ? { locationId: entry.locationId } : {}),
    systemId: entry.systemId as number,
    name: entry.name.trim().replace(/\s+/g, " "),
    ...(Number.isSafeInteger(entry.typeId) ? { typeId: entry.typeId } : {}),
    rigTypeIds,
    ...(Array.isArray(entry.services) ? { services: entry.services } : {}),
    allowStandardBuilds: entry.allowStandardBuilds !== false,
    allowReactionBuilds: entry.allowReactionBuilds !== false,
    allowBiochemicalReactions:
      entry.allowBiochemicalReactions ?? entry.allowReactionBuilds !== false,
    allowCompositeReactions: entry.allowCompositeReactions ?? entry.allowReactionBuilds !== false,
    allowHybridReactions: entry.allowHybridReactions ?? entry.allowReactionBuilds !== false,
    allowInvention: entry.allowInvention !== false,
    allowResearch: entry.allowResearch !== false,
    ...(typeof entry.allowCapitalBuilds === "boolean"
      ? { allowCapitalBuilds: entry.allowCapitalBuilds }
      : {}),
    ...(typeof entry.standardTaxRate === "number"
      ? { standardTaxRate: entry.standardTaxRate }
      : {}),
    ...(typeof entry.capitalTaxRate === "number" ? { capitalTaxRate: entry.capitalTaxRate } : {}),
    ...(typeof entry.reactionTaxRate === "number"
      ? { reactionTaxRate: entry.reactionTaxRate }
      : {}),
    ...(typeof entry.biochemicalTaxRate === "number"
      ? { biochemicalTaxRate: entry.biochemicalTaxRate }
      : {}),
    ...(typeof entry.compositeTaxRate === "number"
      ? { compositeTaxRate: entry.compositeTaxRate }
      : {}),
    ...(typeof entry.hybridTaxRate === "number" ? { hybridTaxRate: entry.hybridTaxRate } : {}),
    ...(typeof entry.inventionTaxRate === "number"
      ? { inventionTaxRate: entry.inventionTaxRate }
      : {}),
    ...(typeof entry.researchTaxRate === "number"
      ? { researchTaxRate: entry.researchTaxRate }
      : {}),
    ...(typeof entry.settingsLastModified === "string"
      ? { settingsLastModified: entry.settingsLastModified }
      : {}),
  };
}

export function normalizeFacilitySettings(value: unknown): FacilitySettingsPayload {
  if (!value || typeof value !== "object") return emptyFacilitySettings;
  const payload = value as Partial<FacilitySettingsPayload> & {
    structures?: Record<string, unknown>;
  };
  const lastModified =
    typeof payload.lastModified === "string" && !Number.isNaN(Date.parse(payload.lastModified))
      ? payload.lastModified
      : "";
  const facilities: Record<string, FacilitySettingsEntry> = {};
  const candidates = payload.facilities ?? payload.structures;
  if (candidates && typeof candidates === "object" && !Array.isArray(candidates)) {
    for (const candidate of Object.values(candidates)) {
      const entry = normalizeEntry(candidate);
      if (entry) facilities[facilitySettingsKey(entry.systemId, entry.name)] = entry;
    }
  }
  return { lastModified, facilities };
}

function isNewer(left: string, right: string) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime)) return false;
  if (Number.isNaN(rightTime)) return true;
  return leftTime > rightTime;
}

/** Merges facility settings; the newest payload wins for duplicate locations. */
export function mergeFacilitySettings(
  left: FacilitySettingsPayload,
  right: FacilitySettingsPayload,
): FacilitySettingsPayload {
  const rightWins = isNewer(right.lastModified, left.lastModified);
  const [older, newer] = rightWins ? [left, right] : [right, left];
  return {
    lastModified: newer.lastModified || older.lastModified,
    facilities: { ...older.facilities, ...newer.facilities },
  };
}
