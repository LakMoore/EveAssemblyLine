import type { PlanStockItem } from "@/lib/planning/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import { normalizeLocationName } from "@/lib/reference/locationName";
import { loadEndpointRecord, saveEndpointResponse } from "./refreshCache";

export type ClientSession = {
  authenticated?: boolean;
  characters?: Array<{
    characterId: number;
    characterName: string;
    corporationId?: number;
    hasDirectorRole: boolean;
    allowCorpRefreshOptIn: boolean;
    onDeployment: boolean;
    corporationSupportEnabled?: boolean;
  }>;
};

export type ClientAssetsResponse = {
  assets?: PlanStockItem[];
  locations?: Array<{
    locationId: number;
    name: string;
    locationType: "station" | "structure" | "anchored";
    systemId?: number;
    systemName?: string;
    typeId?: number;
  }>;
  filteredLocationIds?: number[];
  corporationSources?: ClientCorporationSource[];
};

function normalizeClientLocationName(
  name: string,
  kind: "station" | "structure" | "anchored",
  systemName?: string,
) {
  if (/^Location ID \d+$/i.test(name.trim())) {
    return kind === "structure"
      ? "Structure details unavailable"
      : kind === "station"
        ? "Station details unavailable"
        : "Anchored";
  }
  return normalizeLocationName(systemName, name);
}

export function normalizeClientAssetsResponse(data: ClientAssetsResponse): ClientAssetsResponse {
  return {
    ...data,
    locations: data.locations?.map((location) => ({
      ...location,
      name: normalizeClientLocationName(location.name, location.locationType, location.systemName),
    })),
    corporationSources: data.corporationSources?.map((source) => ({
      ...source,
      ...(source.rootLocation?.name
        ? {
            rootLocation: {
              ...source.rootLocation,
              name: normalizeClientLocationName(
                source.rootLocation.name,
                source.rootLocation.kind === "solar_system" ? "anchored" : source.rootLocation.kind,
                source.rootLocation.systemName,
              ),
            },
          }
        : {}),
    })),
  };
}

/** Applies corporation source selections before stock is sent to the planning service. */
export function filterClientAssetsForPlanning(data: ClientAssetsResponse): ClientAssetsResponse {
  const selectedSources = new Set(
    (data.corporationSources ?? [])
      .filter((source) => source.selected)
      .map((source) => `${source.corporationId}:${source.rootLocationId}:${source.locationFlag}`),
  );
  const selectedContainers = new Set(
    (data.corporationSources ?? []).flatMap((source) =>
      source.containers
        .filter((container) => container.selected)
        .map((container) => container.itemId),
    ),
  );
  const selectedSourceLocations = new Set(
    (data.corporationSources ?? [])
      .filter((source) => source.selected)
      .map((source) => `${source.corporationId}:${source.rootLocationId}`),
  );
  return {
    ...data,
    assets: (data.assets ?? []).filter((item) => {
      if (item.ownerType !== "corporation") return true;
      const source = item.corporationSource;
      if (!source) {
        return Boolean(
          item.inBuild
            && item.jobId !== undefined
            && item.ownerId !== undefined
            && item.rootLocationId !== undefined
            && selectedSourceLocations.has(`${item.ownerId}:${item.rootLocationId}`),
        );
      }
      const sourceKey = `${item.ownerId}:${source.rootLocationId}:${source.locationFlag}`;
      return (
        source.containerItemIds.some((itemId) => selectedContainers.has(itemId))
        || (
          (source.locationFlag === ""
            ? selectedSourceLocations.has(`${item.ownerId}:${source.rootLocationId}`)
            : selectedSources.has(sourceKey))
          && source.containerItemIds.length === 0
        )
      );
    }),
  };
}

export type ClientCorporationSource = {
  corporationId: number;
  rootLocationId: number;
  locationFlag: string;
  label: string;
  rootLocation?: {
    locationId: number;
    kind: "station" | "structure" | "solar_system";
    name?: string;
    systemName?: string;
    typeId?: number;
    systemId?: number;
    regionId?: number;
    resolved: boolean;
  };
  canTake: boolean;
  canQuery: boolean;
  selected: boolean;
  containers: Array<{
    itemId: number;
    name?: string;
    locationId: number;
    rootLocationId: number;
    selected: boolean;
  }>;
};

export function groupClientAssetsByLocation(data: ClientAssetsResponse) {
  return (data.locations ?? []).map((location) => ({
    ...location,
    items: (data.assets ?? []).filter(
      (item) =>
        item.rootLocationId === location.locationId
        || item.sourceLocationId === location.locationId,
    ),
  }));
}

export type ClientShipsResponse = {
  assets?: Array<{
    itemId: number;
    typeId: number;
    name?: string;
    quantity: number;
    locationId: number;
    locationType: string;
    locationFlag: string;
    isSingleton: boolean;
    isAmmo?: boolean;
    ownerType: "character" | "corporation";
    ownerId: number;
    rootLocation?: {
      locationId: number;
      kind: "station" | "structure" | "solar_system";
      name?: string;
      typeId?: number;
      systemId?: number;
      regionId?: number;
      resolved: boolean;
    };
  }>;
  ships?: Array<{
    itemId: number;
    typeId: number;
    name?: string;
    systemId?: number;
    systemName?: string;
    isInSpace?: boolean;
    pilotId?: number;
    pilotName?: string;
    locationName?: string;
  }>;
  types?: Array<{ typeId: number; name: string }>;
};

export type ClientJobsResponse = {
  characters?: Array<{
    characterId: number;
    characterName: string;
    slots: Record<string, number>;
    availableSlots: Record<string, number>;
  }>;
  jobs?: Array<{
    jobId: number;
    characterId: number;
    ownerId: number;
    characterName: string;
    ownerType: "character" | "corporation";
    activity: string;
    status: string;
    runs: number;
    outputQuantity: number;
    outputRunsPerCopy?: number;
    usesBpo?: boolean;
    startDate: string;
    endDate: string;
    facilityId: number;
    outputLocationId: number;
    outputLocationName: string;
    blueprintTypeId: number;
    blueprintTypeName?: string;
    productTypeId?: number;
    productTypeName?: string;
  }>;
};

export type ClientCharacter = {
  characterId: number;
  characterName: string;
  onDeployment: boolean;
  corporationId?: number;
  allianceId?: number;
  corporationName?: string;
  corporationRoles: string[];
  rolesAtBase: string[];
  rolesAtHq: string[];
  rolesAtOther: string[];
  hasDirectorRole: boolean;
  allowCorpRefreshOptIn: boolean;
  canManageCorpRefreshOptIn?: boolean;
  corpRefreshOptInEnabled?: boolean;
  hasAccountantRole: boolean;
  hasTraderRole: boolean;
  corporationSupportEnabled?: boolean;
};

export type ClientCorporationSettings = {
  corporationId: number;
  supportEnabled: boolean;
  directHangars: Array<{
    rootLocationId: number;
    locationFlag: string;
  }>;
  containerItemIds: number[];
};

export type ClientCharacterStatus = {
  characterId: number;
  assets?: ClientEndpointStatus;
  skills?: ClientEndpointStatus & {
    body?: Array<{ skillId: number; activeSkillLevel: number }> | null;
  };
  location?: ClientEndpointStatus;
  ship?: ClientEndpointStatus;
  clones?: ClientEndpointStatus;
  blueprints?: ClientEndpointStatus;
  jobs?: ClientEndpointStatus;
  orders?: ClientEndpointStatus;
  corporations?: Array<{
    corporationId: number;
    assets?: ClientEndpointStatus;
    blueprints?: ClientEndpointStatus;
    structures?: ClientEndpointStatus;
    jobs?: ClientEndpointStatus;
    orders?: ClientEndpointStatus;
  }>;
};

export type ClientEndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
  hasBody: boolean;
  lastModified?: string;
  lastUpdated?: string;
  expires?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
};

let sessionRequest: Promise<ClientSession> | undefined;
const assetsRequests = new Map<string, Promise<ClientAssetsResponse>>();
const assetsResponses = new Map<string, ClientAssetsResponse>();
let shipsRequest: Promise<ClientShipsResponse> | undefined;
let shipsResponse: ClientShipsResponse | undefined;
let jobsRequest: Promise<ClientJobsResponse> | undefined;
let jobsResponse: ClientJobsResponse | undefined;
let charactersRequest: Promise<ClientCharacter[]> | undefined;
let charactersResponse: ClientCharacter[] | undefined;
let corpStatusRequest: Promise<ClientCharacter[]> | undefined;
let corpStatusResponse: ClientCharacter[] | undefined;
let corporationSettingsRequest: Promise<ClientCorporationSettings[]> | undefined;
let corporationSettingsResponse: ClientCorporationSettings[] | undefined;
let stateStatusRequest: Promise<{ characters?: ClientCharacterStatus[] }> | undefined;
let stateStatusResponse: { characters?: ClientCharacterStatus[] } | undefined;
let stateStatusGeneration = 0;

function loadJson<T>(
  url: string,
  endpointKey: string,
  pending: Promise<T> | undefined,
  setPending: (value: Promise<T> | undefined) => void,
  shouldSave = () => true,
) {
  if (pending) return pending;
  const request = fetch(url, { cache: "no-store" })
    .then(async (response) => {
      const data = (await response.json()) as T;
      if (!response.ok) throw new Error(`Could not load ${url}.`);
      if (shouldSave()) await saveEndpointResponse(endpointKey, url, data);
      return data;
    })
    .catch((error) => {
      setPending(undefined);
      throw error;
    });
  setPending(request);
  return request;
}

export function loadClientSession() {
  sessionRequest
    ??= fetch("/api/auth/session")
      .then((response) => response.json() as Promise<ClientSession>)
      .catch((error) => {
        sessionRequest = undefined;
        throw error;
      });
  return sessionRequest;
}

export function loadClientAssets(language: SdeLanguage, reload = false) {
  const key = language;
  const pending = assetsRequests.get(key);
  if (pending) return pending;
  const cached = assetsResponses.get(key);
  if (!reload && cached) return Promise.resolve(cached);

  const query = new URLSearchParams({ language });
  const loadCachedStock = !reload
    ? loadEndpointRecord<ClientAssetsResponse>("state/assets").then((record) => {
        if (!record) return null;
        try {
          const cachedLanguage = new URL(record.url, window.location.origin).searchParams.get(
            "language",
          );
          if (cachedLanguage !== language) return null;
        }
        catch {
          return null;
        }
        const data = normalizeClientAssetsResponse(record.data);
        assetsResponses.set(key, data);
        return data;
      })
    : Promise.resolve(null);
  const request = loadCachedStock
    .then((cachedStock) => {
      if (cachedStock) return cachedStock;
      return fetch(
        `/api/state/assets?${query.toString()}`,
        {
          cache: "no-store",
        },
      ).then(async (response) => {
        const data = normalizeClientAssetsResponse((await response.json()) as ClientAssetsResponse);
        if (!response.ok) throw new Error("Could not load assets.");
        await saveEndpointResponse("state/assets", `/api/state/assets?${query.toString()}`, data);
        assetsResponses.set(key, data);
        return data;
      });
    })
    .finally(() => assetsRequests.delete(key));
  assetsRequests.set(key, request);
  return request;
}

export function clearClientAssetsCache(language: SdeLanguage) {
  assetsResponses.delete(language);
}

export function loadClientShips(reload = false) {
  if (!reload && shipsResponse) return Promise.resolve(shipsResponse);
  shipsRequest
    ??= fetch("/api/state/ships", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as ClientShipsResponse;
        if (!response.ok) throw new Error("Could not load ships.");
        await saveEndpointResponse("state/ships", "/api/state/ships", data);
        shipsResponse = data;
        return data;
      })
      .finally(() => {
        shipsRequest = undefined;
      });
  return shipsRequest;
}

export function loadClientJobs(reload = false) {
  if (!reload && jobsResponse) return Promise.resolve(jobsResponse);
  jobsRequest
    ??= fetch("/api/state/jobs", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as ClientJobsResponse;
        if (!response.ok) throw new Error("Could not load industry jobs.");
        await saveEndpointResponse("state/jobs", "/api/state/jobs", data);
        jobsResponse = data;
        return data;
      })
      .finally(() => {
        jobsRequest = undefined;
      });
  return jobsRequest;
}

export function loadClientCharacters(reload = false) {
  if (reload) {
    charactersRequest = undefined;
    charactersResponse = undefined;
  }
  if (charactersResponse) return Promise.resolve(charactersResponse);
  charactersRequest = loadJson(
    "/api/characters",
    "characters",
    charactersRequest,
    (value) => {
      charactersRequest = value;
    },
  ).then((data) => {
    charactersResponse = data;
    return data;
  });
  return charactersRequest;
}

export function loadClientCorpStatus(reload = false) {
  if (reload) {
    corpStatusRequest = undefined;
    corpStatusResponse = undefined;
  }
  if (corpStatusResponse) return Promise.resolve(corpStatusResponse);
  corpStatusRequest = loadJson(
    "/api/auth/corp/status",
    "auth/corp/status",
    corpStatusRequest,
    (value) => {
      corpStatusRequest = value;
    },
  ).then((data) => {
    corpStatusResponse = data;
    return data;
  });
  return corpStatusRequest;
}

export function loadClientCorporationSettings(reload = false) {
  if (reload) {
    corporationSettingsRequest = undefined;
    corporationSettingsResponse = undefined;
  }
  if (corporationSettingsResponse) return Promise.resolve(corporationSettingsResponse);
  corporationSettingsRequest
    ??= fetch("/api/auth/corp/settings", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { settings?: ClientCorporationSettings[] };
        if (!response.ok) throw new Error("Could not load corporation settings.");
        corporationSettingsResponse = data.settings ?? [];
        return corporationSettingsResponse;
      })
      .finally(() => {
        corporationSettingsRequest = undefined;
      });
  return corporationSettingsRequest;
}

export async function saveClientCorporationSettings(settings: ClientCorporationSettings) {
  const response = await fetch(
    "/api/auth/corp/settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    },
  );
  const data = (await response.json()) as {
    settings?: ClientCorporationSettings;
    error?: string;
  };
  if (!response.ok || !data.settings) {
    throw new Error(data.error ?? "Could not save corporation settings.");
  }
  corporationSettingsResponse = [
    ...(corporationSettingsResponse ?? []).filter(
      (entry) => entry.corporationId !== data.settings!.corporationId,
    ),
    data.settings,
  ];
  return data.settings;
}

export function loadClientStateStatus(reload = false) {
  if (reload) {
    stateStatusGeneration += 1;
    stateStatusRequest = undefined;
    stateStatusResponse = undefined;
  }
  if (!reload && stateStatusResponse) return Promise.resolve(stateStatusResponse);
  const requestGeneration = stateStatusGeneration;
  stateStatusRequest = loadJson(
    "/api/state/status",
    "state/status",
    stateStatusRequest,
    (value) => {
      if (requestGeneration === stateStatusGeneration) stateStatusRequest = value;
    },
    () => requestGeneration === stateStatusGeneration,
  ).then((data) => {
    if (requestGeneration === stateStatusGeneration) stateStatusResponse = data;
    return data;
  });
  return stateStatusRequest;
}

export function invalidateClientCharacterData() {
  sessionRequest = undefined;
  charactersResponse = undefined;
  corpStatusResponse = undefined;
  corporationSettingsResponse = undefined;
  corporationSettingsRequest = undefined;
  stateStatusResponse = undefined;
  stateStatusRequest = undefined;
  stateStatusGeneration += 1;
  jobsRequest = undefined;
  jobsResponse = undefined;
}
