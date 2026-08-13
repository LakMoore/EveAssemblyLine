import type { StockItem } from "@/lib/planning/stockStore";
import type { PlannerSettings } from "@/lib/planning/preferences";
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
  locations?: Array<{
    locationId: number;
    name: string;
    locationType: "station" | "structure" | "anchored";
    systemId?: number;
    systemName?: string;
    typeId?: number;
    items: StockItem[];
  }>;
  filteredLocationIds?: number[];
};

export type ClientMarketOrderResponse = {
  marketOrderStock?: StockItem[];
};

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
  jobs?: ClientEndpointStatus;
  orders?: ClientEndpointStatus;
  corporations?: Array<{
    corporationId: number;
    assets?: ClientEndpointStatus;
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
const stockRequests = new Map<SdeLanguage, Promise<ClientStockResponse>>();
const stockResponses = new Map<SdeLanguage, ClientStockResponse>();
let shipsRequest: Promise<ClientShipsResponse> | undefined;
let shipsResponse: ClientShipsResponse | undefined;
let charactersRequest: Promise<ClientCharacter[]> | undefined;
let charactersResponse: ClientCharacter[] | undefined;
let corpStatusRequest: Promise<ClientCharacter[]> | undefined;
let corpStatusResponse: ClientCharacter[] | undefined;
let stateStatusRequest: Promise<{ characters?: ClientCharacterStatus[] }> | undefined;
let stateStatusResponse: { characters?: ClientCharacterStatus[] } | undefined;
const marketOrderRequests = new Map<string, Promise<ClientMarketOrderResponse | null>>();

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

export async function loadClientMarketOrders(
  settings: Pick<
    PlannerSettings,
    | "personalSellOrdersAsStock"
    | "allCorporationSellOrdersAsStock"
    | "myCorporationSellOrdersAsStock"
  >,
) {
  const session = await loadClientSession();
  if (!session.authenticated || !session.characters?.length) return null;

  const query = new URLSearchParams({
    personalSellOrdersAsStock: String(settings.personalSellOrdersAsStock),
    allCorporationSellOrdersAsStock: String(settings.allCorporationSellOrdersAsStock),
    myCorporationSellOrdersAsStock: String(settings.myCorporationSellOrdersAsStock),
  }).toString();
  const pending = marketOrderRequests.get(query);
  if (pending) return pending;

  const request = fetch(`/api/state/marketOrders?${query}`, { cache: "no-store" })
    .then(async (response) => {
      const data = (await response.json()) as ClientMarketOrderResponse;
      if (!response.ok) throw new Error("Could not load market orders.");
      return data;
    })
    .finally(() => marketOrderRequests.delete(query));
  marketOrderRequests.set(query, request);
  return request;
}

export function loadClientStock(language: SdeLanguage, force = false) {
  const pending = stockRequests.get(language);
  if (pending) return pending;
  const cached = stockResponses.get(language);
  if (!force && cached) return Promise.resolve(cached);

  const request = fetch(
    `/api/state/stock?language=${encodeURIComponent(language)}`,
    {
      cache: "no-store",
    },
  )
    .then(async (response) => {
      const data = (await response.json()) as ClientStockResponse;
      if (!response.ok) throw new Error("Could not load stock.");
      stockResponses.set(language, data);
      return data;
    })
    .finally(() => stockRequests.delete(language));
  stockRequests.set(language, request);
  return request;
}

export function clearClientStockCache(language: SdeLanguage) {
  stockResponses.set(language, { locations: [] });
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
