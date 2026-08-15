import type { PlanStockItem } from "@/lib/planning/types";
import type { SdeLanguage } from "@/lib/reference/languages";

export type ClientSession = {
  authenticated?: boolean;
  characters?: Array<{
    characterId: number;
    characterName: string;
    hasDirectorRole: boolean;
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
  }>;
  types?: Array<{ typeId: number; name: string }>;
};

export type ClientJobsResponse = {
  characters?: Array<{
    characterId: number;
    characterName: string;
    slots: Record<string, number>;
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
  blueprints?: ClientEndpointStatus;
  jobs?: ClientEndpointStatus;
  orders?: ClientEndpointStatus;
  corporations?: Array<{
    corporationId: number;
    assets?: ClientEndpointStatus;
    blueprints?: ClientEndpointStatus;
    jobs?: ClientEndpointStatus;
    orders?: ClientEndpointStatus;
  }>;
};

export type ClientEndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
  hasBody: boolean;
  lastUpdated?: string;
  lastModified?: string;
  expires?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
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
  pending: Promise<T> | undefined,
  setPending: (value: Promise<T> | undefined) => void,
) {
  if (pending) return pending;
  const request = fetch(url, { cache: "no-store" })
    .then(async (response) => {
      const data = (await response.json()) as T;
      if (!response.ok) throw new Error(`Could not load ${url}.`);
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

export function loadClientStock(language: SdeLanguage, force = false) {
  const key = language;
  const pending = stockRequests.get(key);
  if (pending) return pending;
  const cached = stockResponses.get(key);
  if (!force && cached) return Promise.resolve(cached);

  const query = new URLSearchParams({ language });
  const request = fetch(
    `/api/state/stock?${query.toString()}`,
    {
      cache: "no-store",
    },
  )
    .then(async (response) => {
      const data = (await response.json()) as ClientStockResponse;
      if (!response.ok) throw new Error("Could not load stock.");
      stockResponses.set(key, data);
      return data;
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

export function loadClientShips(force = false) {
  if (!force && shipsResponse) return Promise.resolve(shipsResponse);
  shipsRequest
    ??= fetch("/api/state/ships", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as ClientShipsResponse;
        if (!response.ok) throw new Error("Could not load ships.");
        shipsResponse = data;
        return data;
      })
      .finally(() => {
        shipsRequest = undefined;
      });
  return shipsRequest;
}

export function loadClientJobs(force = false) {
  if (!force && jobsResponse) return Promise.resolve(jobsResponse);
  jobsRequest
    ??= fetch("/api/state/jobs", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as ClientJobsResponse;
        if (!response.ok) throw new Error("Could not load industry jobs.");
        jobsResponse = data;
        return data;
      })
      .finally(() => {
        jobsRequest = undefined;
      });
  return jobsRequest;
}

export function loadClientCharacters() {
  if (charactersResponse) return Promise.resolve(charactersResponse);
  charactersRequest = loadJson(
    "/api/characters",
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

export function loadClientCorpStatus() {
  if (corpStatusResponse) return Promise.resolve(corpStatusResponse);
  corpStatusRequest = loadJson(
    "/api/auth/corp/status",
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

export function loadClientStateStatus(force = false) {
  if (force) stateStatusRequest = undefined;
  if (!force && stateStatusResponse) return Promise.resolve(stateStatusResponse);
  stateStatusRequest = loadJson(
    "/api/state/status",
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
  charactersResponse = undefined;
  corpStatusResponse = undefined;
  stateStatusResponse = undefined;
}
