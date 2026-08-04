import { createHash } from "node:crypto";
import type {
  AssetRecord,
  CharacterTokenRecord,
  IndustryJobRecord,
  MarketOrderRecord,
  TokenSet,
} from "@/lib/auth/model";
import { getCachedEsiResponse, setCachedEsiResponse } from "@/cache/services/esiCache";
import { refreshTokenSet } from "@/lib/auth/eveSso";
import { getCharacter, upsertCharacter } from "@/lib/auth/tokensStore";

const esiBaseUrl = process.env.ESI_BASE_URL ?? "https://esi.evetech.net/latest";
const refreshLocks = new Map<string, Promise<TokenSet>>();
let esiRateLimitedUntil = 0;

export type EsiAssetLocation = {
  item_id: number;
  name: string;
  location_id?: number;
  location_type?: string;
};

export type EsiAsset = {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
  location_type: string;
  location_flag: string;
  is_singleton: boolean;
};

export type EsiBlueprint = {
  item_id: number;
  runs: number;
  material_efficiency: number;
  time_efficiency: number;
};

type EsiIndustryJob = {
  job_id: number;
  installer_id: number;
  facility_id: number;
  location_id?: number;
  station_id?: number;
  output_location_id: number;
  activity_id: number;
  blueprint_id: number;
  blueprint_type_id: number;
  blueprint_location_id: number;
  runs: number;
  licensed_runs?: number;
  product_type_id?: number;
  status: string;
  successful_runs?: number;
  start_date: string;
  end_date: string;
};

type EsiMarketOrder = {
  order_id: number;
  type_id: number;
  location_id: number;
  volume_remain: number;
  volume_total: number;
  is_buy_order: boolean;
  is_corporation?: boolean;
  issued_by?: number;
};

export type EsiCorporationStructure = {
  structure_id: number;
  type_id: number;
  corporation_id: number;
  system_id: number;
  profile_id: number;
  name?: string;
  state: string;
  fuel_expires?: string;
  state_timer_start?: string;
  state_timer_end?: string;
  unanchors_at?: string;
  reinforce_hour?: number;
  services?: Array<{ name: string; state: "online" | "offline" | "cleanup" }>;
};

type EsiUniverseName = {
  id: number;
  name: string;
  category: string;
};

async function getUsableToken(record: CharacterTokenRecord, purpose: "personal" | "corp") {
  const usesCorporationToken = purpose === "corp" && Boolean(record.corpAuth);
  const tokenSet = usesCorporationToken ? record.corpAuth : record.personalAuth;
  if (!tokenSet) throw new Error(`Missing ${purpose} ESI authorization`);
  if (Date.parse(tokenSet.accessTokenExpiresAt) > Date.now() + 5 * 60 * 1000) return tokenSet;
  const lockKey = `${record.characterId}:${purpose}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;
  const refresh = refreshTokenSet(tokenSet)
    .then(async (updated) => {
      const current = await getCharacter(record.characterId);
      if (current) {
        await upsertCharacter({
          ...current,
          ...(usesCorporationToken ? { corpAuth: updated } : { personalAuth: updated }),
        });
      }
      return updated;
    })
    .finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, refresh);
  return refresh;
}

export async function requestEsi<T>(
  path: string,
  tokenSet?: TokenSet,
  init?: RequestInit,
): Promise<{ data: T | null; headers: Headers; status: number }> {
  const body = typeof init?.body === "string" ? init.body : "";
  const cachePath = body
    ? `${path}&body_hash=${createHash("sha256").update(body).digest("hex")}`
    : path;
  const cached = await getCachedEsiResponse<T>(cachePath);
  if (cached) {
    return { data: cached.data, headers: new Headers(cached.headers), status: cached.status };
  }
  if (esiRateLimitedUntil > Date.now()) {
    const error = new Error(
      `ESI requests paused until ${new Date(esiRateLimitedUntil).toISOString()}`,
    );
    (error as Error & { status?: number; retryAfter?: string }).status = 429;
    (error as Error & { status?: number; retryAfter?: string }).retryAfter = String(
      Math.ceil((esiRateLimitedUntil - Date.now()) / 1000),
    );
    throw error;
  }
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (tokenSet) headers.set("authorization", `Bearer ${tokenSet.accessToken}`);
  const response = await fetch(`${esiBaseUrl}${path}`, { ...init, headers, cache: "no-store" });
  if (response.status === 304)
    return { data: null, headers: response.headers, status: response.status };
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = parseRetryAfterMs(retryAfter);
      esiRateLimitedUntil = Math.max(esiRateLimitedUntil, Date.now() + retryAfterMs);
    }
    const error = new Error(`ESI request failed (${response.status})`);
    (error as Error & { status?: number; retryAfter?: string }).status = response.status;
    (error as Error & { status?: number; retryAfter?: string }).retryAfter =
      response.headers.get("retry-after") ?? undefined;
    throw error;
  }
  const data = (await response.json()) as T;
  const remainingHeader = response.headers.get("x-esi-error-limit-remain");
  const resetHeader = response.headers.get("x-esi-error-limit-reset");
  const remaining = Number(remainingHeader);
  const resetSeconds = Number(resetHeader);
  if (remainingHeader && resetHeader && remaining <= 0 && Number.isFinite(resetSeconds)) {
    esiRateLimitedUntil = Math.max(
      esiRateLimitedUntil,
      Date.now() + Math.max(1, resetSeconds) * 1_000,
    );
  }
  await setCachedEsiResponse(
    cachePath,
    {
      data,
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    },
    response.headers.get("cache-control"),
  );
  return { data, headers: response.headers, status: response.status };
}

export function getEsiRateLimitUntil() {
  return esiRateLimitedUntil > Date.now() ? new Date(esiRateLimitedUntil).toISOString() : null;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(1_000, timestamp - Date.now()) : 60_000;
}

export async function requestEsiConditional<T>(path: string, tokenSet: TokenSet, etag?: string) {
  const headers = etag ? { "if-none-match": etag } : undefined;
  return requestEsi<T>(path, tokenSet, { headers });
}

async function fetchPages<T>(path: string, tokenSet: TokenSet, etag?: string) {
  const first = await requestEsiConditional<T[]>(`${path}?page=1`, tokenSet, etag);
  const pageCount = Number(first.headers.get("x-pages") ?? "1");
  if (first.status === 304) return { data: null, headers: first.headers, notModified: true };
  if (pageCount <= 1) return { data: first.data ?? [], headers: first.headers, notModified: false };
  const rest: T[][] = [];
  for (let page = 2; page <= pageCount; page += 1) {
    const result = await requestEsi<T[]>(`${path}?page=${page}`, tokenSet);
    rest.push(result.data ?? []);
  }
  return {
    data: [first.data ?? [], ...rest].flat().filter((item): item is T => item !== null),
    headers: first.headers,
    notModified: false,
  };
}

function mapAsset(
  asset: EsiAsset,
  ownerType: "character" | "corporation",
  ownerId: number,
  blueprintsByItemId?: Map<number, EsiBlueprint>,
): AssetRecord {
  const blueprint = blueprintsByItemId?.get(asset.item_id);
  return {
    itemId: asset.item_id,
    typeId: asset.type_id,
    quantity: asset.quantity,
    ...(blueprint
      ? {
          runCount: blueprint.runs,
          me: blueprint.material_efficiency,
          te: blueprint.time_efficiency,
        }
      : {}),
    locationId: asset.location_id,
    locationType:
      asset.location_type === "station" ||
      asset.location_type === "solar_system" ||
      asset.location_type === "item" ||
      asset.location_type === "structure"
        ? asset.location_type
        : "other",
    locationFlag: asset.location_flag,
    isSingleton: asset.is_singleton,
    ownerType,
    ownerId,
  };
}

async function fetchBlueprints(path: string, token: TokenSet) {
  const result = await fetchPages<EsiBlueprint>(path, token);
  return {
    data: result.data ?? [],
    byItemId: new Map((result.data ?? []).map((blueprint) => [blueprint.item_id, blueprint])),
  };
}

export function applyBlueprintMetadata(assets: AssetRecord[], blueprints: EsiBlueprint[]) {
  const byItemId = new Map(blueprints.map((blueprint) => [blueprint.item_id, blueprint]));
  return assets.map((asset) => {
    const blueprint = byItemId.get(asset.itemId);
    if (!blueprint) return asset;
    return {
      ...asset,
      runCount: blueprint.runs,
      me: blueprint.material_efficiency,
      te: blueprint.time_efficiency,
    };
  });
}

export async function fetchCharacterAssets(record: CharacterTokenRecord, etag?: string) {
  const token = await getUsableToken(record, "personal");
  const result = await fetchPages<EsiAsset>(
    `/characters/${record.characterId}/assets/`,
    token,
    etag,
  );
  let blueprintsByItemId = new Map<number, EsiBlueprint>();
  let blueprints: EsiBlueprint[] = [];
  try {
    const result = await fetchBlueprints(`/characters/${record.characterId}/blueprints/`, token);
    blueprintsByItemId = result.byItemId;
    blueprints = result.data;
  } catch {}
  return {
    assets:
      result.data?.map((asset) => mapAsset(asset, "character", record.characterId, blueprintsByItemId)) ??
      null,
    token,
    blueprints,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationAssets(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole || !record.corpAuthCompleted) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record, "corp");
  const result = await fetchPages<EsiAsset>(
    `/corporations/${record.corporationId}/assets/`,
    token,
    etag,
  );
  let blueprintsByItemId = new Map<number, EsiBlueprint>();
  let blueprints: EsiBlueprint[] = [];
  try {
    const result = await fetchBlueprints(`/corporations/${record.corporationId}/blueprints/`, token);
    blueprintsByItemId = result.byItemId;
    blueprints = result.data;
  } catch {}
  return {
    assets:
      result.data?.map((asset) =>
        mapAsset(asset, "corporation", record.corporationId!, blueprintsByItemId),
      ) ?? null,
    blueprints,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

function mapIndustryJob(
  job: EsiIndustryJob,
  ownerType: IndustryJobRecord["ownerType"],
  ownerId: number,
): IndustryJobRecord {
  return {
    jobId: job.job_id,
    installerId: job.installer_id,
    facilityId: job.facility_id,
    locationId: job.location_id ?? job.station_id ?? job.facility_id,
    outputLocationId: job.output_location_id,
    activityId: job.activity_id,
    blueprintId: job.blueprint_id,
    blueprintTypeId: job.blueprint_type_id,
    blueprintLocationId: job.blueprint_location_id,
    runs: job.runs,
    ...(job.licensed_runs !== undefined ? { licensedRuns: job.licensed_runs } : {}),
    ...(job.product_type_id !== undefined ? { productTypeId: job.product_type_id } : {}),
    status: job.status,
    ...(job.successful_runs !== undefined ? { successfulRuns: job.successful_runs } : {}),
    startDate: job.start_date,
    endDate: job.end_date,
    ownerType,
    ownerId,
  };
}

export async function fetchCharacterIndustryJobs(record: CharacterTokenRecord) {
  const token = await getUsableToken(record, "personal");
  const result = await requestEsi<EsiIndustryJob[]>(
    `/characters/${record.characterId}/industry/jobs/`,
    token,
  );
  return {
    jobs: (result.data ?? [])
      .filter((job) => job.status !== "cancelled" && job.status !== "delivered")
      .map((job) => mapIndustryJob(job, "character", record.characterId)),
    headers: result.headers,
  };
}

export async function fetchCorporationIndustryJobs(record: CharacterTokenRecord) {
  if (!record.corporationId || !record.hasDirectorRole || !record.corpAuthCompleted) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record, "corp");
  const result = await requestEsi<EsiIndustryJob[]>(
    `/corporations/${record.corporationId}/industry/jobs/`,
    token,
  );
  return {
    jobs: (result.data ?? [])
      .filter((job) => job.status !== "cancelled" && job.status !== "delivered")
      .map((job) => mapIndustryJob(job, "corporation", record.corporationId!)),
    headers: result.headers,
  };
}

function mapMarketOrder(
  order: EsiMarketOrder,
  ownerType: MarketOrderRecord["ownerType"],
  ownerId: number,
): MarketOrderRecord {
  return {
    orderId: order.order_id,
    typeId: order.type_id,
    locationId: order.location_id,
    volumeRemain: order.volume_remain,
    volumeTotal: order.volume_total,
    isBuyOrder: order.is_buy_order,
    ...(order.is_corporation !== undefined ? { isCorporation: order.is_corporation } : {}),
    ...(order.issued_by !== undefined ? { issuedBy: order.issued_by } : {}),
    ownerType,
    ownerId,
  };
}

export async function fetchCharacterMarketOrders(record: CharacterTokenRecord, etag?: string) {
  const token = await getUsableToken(record, "personal");
  const result = await fetchPages<EsiMarketOrder>(
    `/characters/${record.characterId}/orders`,
    token,
    etag,
  );
  return {
    orders: result.data?.map((order) => mapMarketOrder(order, "character", record.characterId)) ?? null,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationMarketOrders(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole || !record.corpAuthCompleted) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record, "corp");
  const result = await fetchPages<EsiMarketOrder>(
    `/corporations/${record.corporationId}/orders`,
    token,
    etag,
  );
  return {
    orders: result.data?.map((order) => mapMarketOrder(order, "corporation", record.corporationId!)) ?? null,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationStructures(record: CharacterTokenRecord) {
  if (!record.corporationId || (!record.hasStationManagerRole && !record.hasDirectorRole)) {
    throw new Error("Corporation structure authorization is incomplete");
  }
  const token = await getUsableToken(record, "corp");
  const result = await requestEsi<EsiCorporationStructure[]>(
    `/corporations/${record.corporationId}/structures/`,
    token,
  );
  return result.data ?? [];
}

export async function fetchAssetLocations(
  owner: AssetRecord["ownerType"],
  ownerId: number,
  itemIds: number[],
  token: TokenSet,
) {
  if (itemIds.length === 0) return [];
  const path =
    owner === "character"
      ? `/characters/${ownerId}/assets/locations/`
      : `/corporations/${ownerId}/assets/locations/`;
  const batchSize = 1000;
  const uniqueItemIds = [...new Set(itemIds)];
  const batches = Array.from({ length: Math.ceil(uniqueItemIds.length / batchSize) }, (_, index) =>
    uniqueItemIds.slice(index * batchSize, (index + 1) * batchSize),
  );
  const locations: EsiAssetLocation[] = [];
  for (const batch of batches) {
    try {
      const result = await requestEsi<EsiAssetLocation[]>(path, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (result.data) locations.push(...result.data);
    } catch (error) {
      if ((error as { status?: number }).status !== 429) throw error;
    }
  }
  return locations;
}

export async function fetchCharacterCorporationId(characterId: number) {
  const result = await requestEsi<{ corporation_id: number }>(`/characters/${characterId}/`);
  if (!result.data) throw new Error("Missing corporation verification response");
  return result.data.corporation_id;
}

export async function fetchUniverseNames(ids: number[]) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map<number, string>();
  const result = await requestEsi<EsiUniverseName[]>("/universe/names/", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(uniqueIds),
  });
  return new Map((result.data ?? []).map((entry) => [entry.id, entry.name]));
}

export async function fetchCharacterRoles(characterId: number, token: TokenSet) {
  const result = await requestEsi<{ roles?: string[] }>(`/characters/${characterId}/roles/`, token);
  if (!result.data) throw new Error("Missing roles verification response");
  return result.data.roles ?? [];
}

export async function fetchLocationMetadata(
  locationId: number,
  kind: "station" | "solar_system" | "structure",
  token?: TokenSet,
) {
  const path =
    kind === "station"
      ? `/universe/stations/${locationId}/`
      : kind === "solar_system"
        ? `/universe/systems/${locationId}/`
        : `/universe/structures/${locationId}/`;
  return requestEsi<{
    name: string;
    type_id?: number;
    system_id?: number;
    constellation_id?: number;
    region_id?: number;
  }>(path, token);
}

export { getUsableToken };
