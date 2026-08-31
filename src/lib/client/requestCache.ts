import type { PlanStockItem } from "@/lib/planning/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import { loadEndpointRecord, saveEndpointResponse } from "./refreshCache";

export type ClientSession = {
  authenticated?: boolean;
  characters?: Array<{
    characterId: number;
    characterName: string;
    hasDirectorRole: boolean;
    onDeployment: boolean;
  }>;
};

export type ClientStockResponse = {
  workingStock?: PlanStockItem[];
  locations?: Array<{
    locationId: number;
    name: string;
    locationType: "station" | "structure" | "anchored";
    systemId?: number;
    systemName?: string;
    typeId?: number;
  }>;
  filteredLocationIds?: number[];
};

export function groupClientStockByLocation(data: ClientStockResponse) {
  return (data.locations ?? []).map((location) => ({
    ...location,
    items: (data.workingStock ?? []).filter(
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
  corporationName?: string;
  corporationRoles: string[];
  hasDirectorRole: boolean;
  hasAccountantRole: boolean;
  hasTraderRole: boolean;
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
const stockRequests = new Map<string, Promise<ClientStockResponse>>();
const stockResponses = new Map<string, ClientStockResponse>();
let shipsRequest: Promise<ClientShipsResponse> | undefined;
let shipsResponse: ClientShipsResponse | undefined;
let jobsRequest: Promise<ClientJobsResponse> | undefined;
let jobsResponse: ClientJobsResponse | undefined;
let charactersRequest: Promise<ClientCharacter[]> | undefined;
let charactersResponse: ClientCharacter[] | undefined;
let corpStatusRequest: Promise<ClientCharacter[]> | undefined;
let corpStatusResponse: ClientCharacter[] | undefined;
let stateStatusRequest: Promise<{ characters?: ClientCharacterStatus[] }> | undefined;
let stateStatusResponse: { characters?: ClientCharacterStatus[] } | undefined;

function loadJson<T>(
  url: string,
  endpointKey: string,
  pending: Promise<T> | undefined,
  setPending: (value: Promise<T> | undefined) => void,
) {
  if (pending) return pending;
  const request = fetch(url, { cache: "no-store" })
    .then(async (response) => {
      const data = (await response.json()) as T;
      if (!response.ok) throw new Error(`Could not load ${url}.`);
      await saveEndpointResponse(endpointKey, url, data);
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

export function loadClientStock(language: SdeLanguage, reload = false) {
  const key = language;
  const pending = stockRequests.get(key);
  if (pending) return pending;
  const cached = stockResponses.get(key);
  if (!reload && cached) return Promise.resolve(cached);

  const query = new URLSearchParams({ language });
  const loadCachedStock = !reload
    ? loadEndpointRecord<ClientStockResponse>("state/stock").then((record) => {
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
        stockResponses.set(key, record.data);
        return record.data;
      })
    : Promise.resolve(null);
  const request = loadCachedStock
    .then((cachedStock) => {
      if (cachedStock) return cachedStock;
      return fetch(
        `/api/state/stock?${query.toString()}`,
        {
          cache: "no-store",
        },
      ).then(async (response) => {
        const data = (await response.json()) as ClientStockResponse;
        if (!response.ok) throw new Error("Could not load stock.");
        await saveEndpointResponse("state/stock", `/api/state/stock?${query.toString()}`, data);
        stockResponses.set(key, data);
        return data;
      });
    })
    .finally(() => stockRequests.delete(key));
  stockRequests.set(key, request);
  return request;
}

export function clearClientStockCache(language: SdeLanguage) {
  for (const key of stockResponses.keys()) {
    if (key.startsWith(`${language}:`)) stockResponses.set(key, { locations: [] });
  }
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

export function loadClientStateStatus(reload = false) {
  if (reload) stateStatusRequest = undefined;
  if (!reload && stateStatusResponse) return Promise.resolve(stateStatusResponse);
  stateStatusRequest = loadJson(
    "/api/state/status",
    "state/status",
    stateStatusRequest,
    (value) => {
      stateStatusRequest = value;
    },
  ).then((data) => {
    stateStatusResponse = data;
    return data;
  });
  return stateStatusRequest;
}

export function invalidateClientCharacterData() {
  sessionRequest = undefined;
  charactersResponse = undefined;
  corpStatusResponse = undefined;
  stateStatusResponse = undefined;
  jobsRequest = undefined;
  jobsResponse = undefined;
}
