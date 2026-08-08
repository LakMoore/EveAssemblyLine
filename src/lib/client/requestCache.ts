import type { StockItem } from "@/lib/planning/stockStore";
import type { SdeLanguage } from "@/lib/reference/languages";

export type ClientSession = {
  authenticated?: boolean;
  characters?: Array<{
    characterId: number;
    characterName: string;
    hasDirectorRole: boolean;
    corpAuthCompleted: boolean;
  }>;
};

export type ClientStockResponse = {
  locations?: Array<{
    locationId: number;
    name: string;
    systemId?: number;
    systemName?: string;
    items: StockItem[];
  }>;
  filteredLocationIds?: number[];
};

const stockCacheLifetimeMs = 10_000;
let sessionRequest: Promise<ClientSession> | undefined;
const stockRequests = new Map<SdeLanguage, Promise<ClientStockResponse>>();
const stockResponses = new Map<SdeLanguage, { response: ClientStockResponse; cachedAt: number }>();

export function loadClientSession() {
  sessionRequest ??= fetch("/api/auth/session")
    .then((response) => response.json() as Promise<ClientSession>)
    .catch((error) => {
      sessionRequest = undefined;
      throw error;
    });
  return sessionRequest;
}

export function loadClientStock(language: SdeLanguage, force = false) {
  const cached = stockResponses.get(language);
  if (!force && cached && Date.now() - cached.cachedAt < stockCacheLifetimeMs) {
    return Promise.resolve(cached.response);
  }
  const pending = stockRequests.get(language);
  if (pending) return pending;

  const request = fetch(`/api/state/stock?language=${encodeURIComponent(language)}`, {
    cache: "no-store",
  })
    .then(async (response) => {
      const data = (await response.json()) as ClientStockResponse;
      if (!response.ok) throw new Error("Could not load stock.");
      stockResponses.set(language, { response: data, cachedAt: Date.now() });
      return data;
    })
    .finally(() => stockRequests.delete(language));
  stockRequests.set(language, request);
  return request;
}
