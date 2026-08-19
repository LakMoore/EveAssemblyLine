import {
  emptyActivitiesRequest,
  emptyFacilitySettings,
  facilitySettingsKey,
  facilitySettingsName,
  normalizeFacilitySettings,
  supportsReactionSettings,
  type FacilityResponse,
  type FacilitySettingsPayload,
} from "./facilities";
import type { KnownStructure } from "./preferences";
import { loadEndpointRecord, saveEndpointResponse } from "@/lib/client/refreshCache";
import { loadClientSession } from "@/lib/client/requestCache";

const localStorageKey = "assembly-line-facilities";

export function loadCachedFacilities(): FacilitySettingsPayload {
  if (typeof window === "undefined") return emptyFacilitySettings;
  try {
    const stored = window.localStorage.getItem(localStorageKey);
    return stored ? normalizeFacilitySettings(JSON.parse(stored)) : emptyFacilitySettings;
  }
  catch {
    return emptyFacilitySettings;
  }
}

function cacheFacilities(payload: FacilitySettingsPayload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localStorageKey, JSON.stringify(payload));
  }
  catch {}
}

export async function fetchFacilities(): Promise<FacilitySettingsPayload> {
  const cached = loadCachedFacilities();
  try {
    if (!(await loadClientSession()).authenticated) return cached;
    const response = await fetch("/api/facilities", { credentials: "same-origin" });
    if (!response.ok) return cached;
    const serverResponse = (await response.json()) as FacilityResponse | FacilitySettingsPayload;
    const serverPayload = normalizeFacilitySettings(
      "settings" in serverResponse ? serverResponse.settings : serverResponse,
    );
    cacheFacilities(serverPayload);
    return serverPayload;
  }
  catch {
    return cached;
  }
}

export async function fetchFacilityResponse(force = false): Promise<FacilityResponse | null> {
  if (!force) {
    const cached = await loadEndpointRecord<FacilityResponse>("facilities");
    if (cached) return cached.data;
  }
  try {
    if (!(await loadClientSession()).authenticated) return null;
    const response = await fetch("/api/facilities", { credentials: "same-origin" });
    if (!response.ok) return null;
    const data = (await response.json()) as FacilityResponse;
    await saveEndpointResponse("facilities", "/api/facilities", data);
    return data;
  }
  catch {
    return null;
  }
}

export function facilitySettingsFromStructures(
  structures: KnownStructure[],
): FacilitySettingsPayload {
  const payload: FacilitySettingsPayload = {
    lastModified: new Date().toISOString(),
    facilities: {},
  };
  for (const structure of structures) {
    const rigTypeIds = structure.rigTypeIds ?? [];
    if (!structure.systemId || rigTypeIds.length === 0) continue;
    const name = facilitySettingsName(structure.systemName, structure.name);
    const reactionsAllowed = supportsReactionSettings(structure.typeId, structure.securityStatus);
    const jobTypes = structure.jobTypes ?? {};
    payload.facilities[facilitySettingsKey(structure.systemId, name)] = {
      locationId: structure.esiStructureId,
      systemId: structure.systemId,
      name,
      typeId: structure.typeId,
      rigTypeIds,
      activities: {
        ...emptyActivitiesRequest,
        reprocessing: {
          available: structure.allowReprocessing !== false,
          taxRate: jobTypes.reprocessing ?? 0,
        },
        manufacturing: {
          available: structure.allowStandardBuilds !== false,
          standard: {
            available: structure.allowStandardBuilds !== false,
            taxRate: jobTypes.standard ?? 0,
          },
          capital: {
            available: structure.allowCapitalBuilds === true,
            taxRate: jobTypes.capital ?? 0,
          },
        },
        reactions: {
          available: reactionsAllowed && structure.allowReactionBuilds !== false,
          biochemical: {
            available:
              reactionsAllowed
              && (structure.allowBiochemicalReactions ?? structure.allowReactionBuilds !== false),
            taxRate: jobTypes.biochemical ?? 0,
          },
          composite: {
            available:
              reactionsAllowed
              && (structure.allowCompositeReactions ?? structure.allowReactionBuilds !== false),
            taxRate: jobTypes.composite ?? 0,
          },
          hybrid: {
            available:
              reactionsAllowed
              && (structure.allowHybridReactions ?? structure.allowReactionBuilds !== false),
            taxRate: jobTypes.hybrid ?? 0,
          },
        },
        meResearch: {
          available: structure.allowResearch !== false,
          taxRate: jobTypes.research ?? 0,
        },
        teResearch: {
          available: structure.allowResearch !== false,
          taxRate: jobTypes.research ?? 0,
        },
        invention: {
          available: structure.allowInvention !== false,
          taxRate: jobTypes.invention ?? 0,
        },
        copying: { available: structure.allowResearch !== false, taxRate: jobTypes.research ?? 0 },
      },
      ...(structure.settingsLastModified === undefined
        ? {}
        : { settingsLastModified: structure.settingsLastModified }),
    };
  }
  return payload;
}

export async function publishFacilities(
  payload: FacilitySettingsPayload,
): Promise<FacilitySettingsPayload> {
  cacheFacilities(payload);
  try {
    if (!(await loadClientSession()).authenticated) return payload;
    const response = await fetch(
      "/api/facilities",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) return payload;
    const responseBody = (await response.json()) as FacilityResponse | FacilitySettingsPayload;
    const merged = normalizeFacilitySettings(
      "settings" in responseBody ? responseBody.settings : responseBody,
    );
    cacheFacilities(merged);
    await saveEndpointResponse("facilities", "/api/facilities", responseBody);
    return merged;
  }
  catch {
    return payload;
  }
}
