export type FacilitySettingsEntry = {
  locationId?: number;
  systemId: number;
  name: string;
  typeId?: number;
  rigTypeIds: number[];
  services?: Array<{ name: string; state: string }>;
  activities: ActivitiesRequest;
  settingsLastModified?: string;
};

export type FacilitySettingsPayload = {
  lastModified: string;
  facilities: Record<string, FacilitySettingsEntry>;
};

export type FacilityJobType =
  | "standard"
  | "capital"
  | "reprocessing"
  | "reactions"
  | "biochemical"
  | "composite"
  | "hybrid"
  | "invention"
  | "research";

export type FacilityJobTypes = Partial<Record<FacilityJobType, number>>;

export type Facility = {
  id: number | string;
  name: string;
  locationType: "station" | "structure";
  typeId: number;
  systemId: number;
  securityStatus?: number;
  systemCostIndices: Record<string, number>;
  activities: ActivitiesResponse;
  buildTypeGroups: Record<string, unknown>;
  services: Array<{ name: string; state: string }>;
  rigTypeIds: number[];
  settingsLastModified: string;
};

export interface ActivityRequest {
  available: boolean;
  taxRate?: number;
}

export interface ActivitiesRequest {
  reprocessing: ActivityRequest;
  manufacturing: ActivityRequest & {
    standard: ActivityRequest;
    capital: ActivityRequest;
  };
  reactions: ActivityRequest & {
    biochemical: ActivityRequest;
    composite: ActivityRequest;
    hybrid: ActivityRequest;
  };
  meResearch: ActivityRequest;
  teResearch: ActivityRequest;
  invention: ActivityRequest;
  copying: ActivityRequest;
}

export interface ActivityResponse extends ActivityRequest {
  baseYield?: number;
  jobDuration?: number;
  materialConsumption?: number;
  jobCost?: number;
  rawJobDurationMultiplier?: number;
  rawMaterialConsumptionMultiplier?: number;
  rawJobCostMultiplier?: number;
}

export type FacilityActivity = ActivityResponse;

export type FacilityActivityGroup = ActivityResponse & {
  standard?: ActivityResponse;
  capital?: ActivityResponse;
  biochemical?: ActivityResponse;
  composite?: ActivityResponse;
  hybrid?: ActivityResponse;
};

export interface ActivitiesResponse extends ActivitiesRequest {
  reprocessing: ActivityResponse;
  manufacturing: ActivityResponse & {
    standard: ActivityResponse;
    capital: ActivityResponse;
  };
  reactions: ActivityResponse & {
    biochemical: ActivityResponse;
    composite: ActivityResponse;
    hybrid: ActivityResponse;
  };
  meResearch: ActivityResponse;
  teResearch: ActivityResponse;
  invention: ActivityResponse;
  copying: ActivityResponse;
}

export type FacilityResponse = {
  facilities: Facility[];
  settings: FacilitySettingsPayload;
};

export const emptyActivitiesRequest: ActivitiesRequest = {
  reprocessing: { available: true, taxRate: 0 },
  manufacturing: {
    available: true,
    standard: { available: true, taxRate: 0 },
    capital: { available: false, taxRate: 0 },
  },
  reactions: {
    available: true,
    biochemical: { available: true, taxRate: 0 },
    composite: { available: true, taxRate: 0 },
    hybrid: { available: true, taxRate: 0 },
  },
  meResearch: { available: true, taxRate: 0 },
  teResearch: { available: true, taxRate: 0 },
  invention: { available: true, taxRate: 0 },
  copying: { available: true, taxRate: 0 },
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

function normalizeActivity(value: unknown): ActivityRequest | null {
  if (!value || typeof value !== "object") return null;
  const activity = value as Partial<ActivityRequest>;
  if (typeof activity.available !== "boolean") return null;
  if (
    activity.taxRate !== undefined
    && (typeof activity.taxRate !== "number" || !Number.isFinite(activity.taxRate))
  ) return null;
  return {
    available: activity.available,
    ...(activity.taxRate === undefined ? {} : { taxRate: activity.taxRate }),
  };
}

function normalizeActivities(value: unknown): ActivitiesRequest | null {
  if (!value || typeof value !== "object") return null;
  const activities = value as Partial<ActivitiesRequest>;
  const manufacturing = activities.manufacturing;
  const reactions = activities.reactions;
  if (
    !manufacturing
    || !reactions
    || typeof manufacturing !== "object"
    || typeof reactions !== "object"
  ) {
    return null;
  }
  const normalizedManufacturing = {
    available: normalizeActivity(manufacturing)?.available,
    standard: normalizeActivity(manufacturing.standard),
    capital: normalizeActivity(manufacturing.capital),
  };
  const normalizedReactions = {
    available: normalizeActivity(reactions)?.available,
    biochemical: normalizeActivity(reactions.biochemical),
    composite: normalizeActivity(reactions.composite),
    hybrid: normalizeActivity(reactions.hybrid),
  };
  if (
    normalizedManufacturing.available === undefined
    || !normalizedManufacturing.standard
    || !normalizedManufacturing.capital
    || normalizedReactions.available === undefined
    || !normalizedReactions.biochemical
    || !normalizedReactions.composite
    || !normalizedReactions.hybrid
  ) return null;
  const normalized = {
    reprocessing: normalizeActivity(activities.reprocessing),
    manufacturing: normalizedManufacturing,
    reactions: normalizedReactions,
    meResearch: normalizeActivity(activities.meResearch),
    teResearch: normalizeActivity(activities.teResearch),
    invention: normalizeActivity(activities.invention),
    copying: normalizeActivity(activities.copying),
  };
  return Object.values(normalized).every(Boolean) ? (normalized as ActivitiesRequest) : null;
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
  const activities = normalizeActivities(entry.activities);
  if (!activities) return null;
  return {
    ...(Number.isSafeInteger(entry.locationId) ? { locationId: entry.locationId } : {}),
    systemId: entry.systemId as number,
    name: entry.name.trim().replace(/\s+/g, " "),
    ...(Number.isSafeInteger(entry.typeId) ? { typeId: entry.typeId } : {}),
    rigTypeIds,
    ...(Array.isArray(entry.services) ? { services: entry.services } : {}),
    activities,
    ...(typeof entry.settingsLastModified === "string"
      ? { settingsLastModified: entry.settingsLastModified }
      : {}),
  };
}

const facilityJobTypes: FacilityJobType[] = [
  "standard",
  "capital",
  "reprocessing",
  "reactions",
  "biochemical",
  "composite",
  "hybrid",
  "invention",
  "research",
];

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
