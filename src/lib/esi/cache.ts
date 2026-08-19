import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  CharacterSkillRecord,
  CharacterTokenRecord,
  IndustryJobRecord,
  MarketOrderRecord,
  TokenSet,
} from "@/lib/auth/model";
import type { EsiCorporationStructure } from "./client";
import type { PlanStockItem } from "@/lib/planning/types";
import {
  getGroups,
  getMarketGroups,
  getTypes,
  getTypesByIds,
  getShipTypeIds,
  getHaulerShipTypeIds,
} from "@/cache/services/sdeCache";
import { getCharacter, getCharacters } from "@/lib/auth/tokensStore";
import {
  fetchCharacterAssets,
  fetchAssetNames,
  fetchCorporationAssets,
  fetchCharacterBlueprints,
  fetchCorporationBlueprints,
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
  fetchCharacterMarketOrders,
  fetchCharacterSkills,
  fetchCorporationMarketOrders,
  fetchCorporationStructures,
  fetchSolarSystemMetadata,
  fetchStationMetadata,
  fetchStructureMetadataPerCharacter,
  getUsableToken,
} from "./client";
import { getStation } from "@/cache/services/sdeCache";
import { parseCacheControlMaxAge } from "@/cache/esiTtl";

export type EndpointStatus = "fresh" | "cached" | "stale" | "rate_limited" | "error";
export type EndpointCache<T> = {
  lastBody: T;
  etag?: string;
  lastUpdated?: string;
  lastModified?: string;
  expires?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
  status: EndpointStatus;
};

export function toClientEndpointStatus<T>(cache: EndpointCache<T> | undefined) {
  if (!cache) return undefined;
  const { lastBody, etag, ...status } = cache;
  return {
    ...status,
    hasBody: lastBody !== null && lastBody !== undefined,
  };
}

type OwnerCache = {
  allAssetsRaw?: EndpointCache<AssetRecord[]>;
  blueprintInstances?: EndpointCache<BlueprintInstanceRecord[]>;
  stockAssetsByItemId?: Map<number, AssetRecord>;
  rootLocationsByItemId: Map<number, AssetLocation>;
  shipAssetsByItemId: Map<number, AssetRecord>;
  assembledShipsByItemId: Map<number, AssetRecord>;
  assembledStructureRigs: AssetRecord[];
  jobs?: EndpointCache<IndustryJobRecord[]>;
  skills?: EndpointCache<CharacterSkillRecord[]>;
  marketOrders?: EndpointCache<MarketOrderRecord[]>;
  structures?: EndpointCache<EsiCorporationStructure[]>;
  unresolvedAssetCount: number;
};

const characterCaches = new Map<string, OwnerCache>();
const corporationCaches = new Map<string, OwnerCache>();

function hasUsableMarketOrders(cache: OwnerCache | undefined) {
  const marketOrders = cache?.marketOrders;
  return Boolean(
    marketOrders
      && Array.isArray(marketOrders.lastBody)
      && marketOrders.status !== "error"
      && marketOrders.status !== "rate_limited",
  );
}

function getUsableMarketOrdersEtag(cache: OwnerCache | undefined) {
  const marketOrders = cache?.marketOrders;
  return marketOrders
    && Array.isArray(marketOrders.lastBody)
    && marketOrders.status !== "error"
    && marketOrders.status !== "rate_limited"
    ? marketOrders.etag
    : undefined;
}

async function refreshBlueprintInstances(
  cache: OwnerCache,
  character: CharacterTokenRecord,
  fetchBlueprints: typeof fetchCharacterBlueprints,
) {
  if (
    cache.blueprintInstances
    && cache.blueprintInstances.nextRefreshAllowed
    && Date.parse(cache.blueprintInstances.nextRefreshAllowed) > Date.now()
  ) {
    cache.blueprintInstances.status = endpointDataStatus(
      cache.blueprintInstances.lastModified,
      cache.blueprintInstances.nextRefreshAllowed,
    );
    return cache.blueprintInstances;
  }
  const result = await fetchBlueprints(character, cache.blueprintInstances?.etag, true);
  cache.blueprintInstances =
    result.notModified && cache.blueprintInstances
      ? setFresh(cache.blueprintInstances.lastBody, result.headers, cache.blueprintInstances)
      : result.fromCache && cache.blueprintInstances
        ? {
            ...cache.blueprintInstances,
            status: endpointDataStatus(
              cache.blueprintInstances.lastModified,
              cache.blueprintInstances.nextRefreshAllowed,
            ),
          }
        : setFresh(
            result.blueprints ?? [],
            result.headers,
            cache.blueprintInstances,
            20 * 60 * 1000,
            false,
            true,
          );
  return cache.blueprintInstances;
}

function getCache(map: Map<string, OwnerCache>, id: number, sessionId: string): OwnerCache {
  const key = String(id);
  const existing = map.get(key);
  if (existing) return existing;
  const created: OwnerCache = {
    assembledStructureRigs: [],
    rootLocationsByItemId: new Map(),
    shipAssetsByItemId: new Map(),
    assembledShipsByItemId: new Map(),
    unresolvedAssetCount: 0,
  };
  map.set(key, created);
  return created;
}

function endpointStatus<T>(
  error: unknown,
): Pick<EndpointCache<T>, "status" | "rateLimitedUntil" | "error" | "reauthorizeRequired"> {
  const status = (error as { status?: number }).status;
  const isInvalidGrant = error instanceof Error && /invalid_grant/i.test(error.message);
  if (status !== 429) {
    const errorMessage =
      status === 401
        ? error instanceof Error
          ? error.message
          : "ESI authorization failed (401)"
        : status === 403
          ? "ESI authorization failed (403); reconnect this character to grant the required scope."
          : error instanceof Error
            ? error.message
            : "ESI request failed";
    return {
      status: "error",
      error: errorMessage,
      reauthorizeRequired: status === 401 || status === 403 || isInvalidGrant,
    };
  }
  const retryAfterValue = (error as { retryAfter?: string }).retryAfter;
  const retryAfterSeconds = Number(retryAfterValue);
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(1, retryAfterSeconds) * 1_000
    : Math.max(1_000, Date.parse(retryAfterValue ?? "") - Date.now());
  return {
    status: "rate_limited",
    rateLimitedUntil: new Date(Date.now() + retryAfterMs).toISOString(),
    error: error instanceof Error ? error.message : "ESI rate limit reached",
  };
}

function normalizeUtcTimestamp(value: string | null | undefined, fallback?: string) {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function setFresh<T>(
  body: T,
  headers?: Headers,
  previous?: EndpointCache<T>,
  lifetimeMs = 5 * 60 * 1000,
  preserveExpiry = false,
  useFallbackLifetime = false,
): EndpointCache<T> {
  const now = new Date();
  const expiresAt = Date.parse(headers?.get("expires") ?? "");
  const maxAge = parseCacheControlMaxAge(headers?.get("cache-control") ?? null);
  const lastModified = normalizeUtcTimestamp(headers?.get("last-modified"), previous?.lastModified);
  const previousExpiry = previous?.expires ?? previous?.nextRefreshAllowed;
  const nextRefreshAllowed =
    preserveExpiry && previousExpiry
      ? previousExpiry
      : Number.isFinite(expiresAt) && expiresAt > now.getTime()
        ? new Date(expiresAt).toISOString()
        : maxAge != null && maxAge > 0
          ? new Date(now.getTime() + maxAge * 1_000).toISOString()
          : useFallbackLifetime
            ? new Date(now.getTime() + lifetimeMs).toISOString()
            : now.toISOString();
  return {
    lastBody: body,
    etag: headers?.get("etag") ?? previous?.etag,
    lastUpdated: now.toISOString(),
    lastModified,
    expires: nextRefreshAllowed,
    nextRefreshAllowed,
    status: endpointDataStatus(lastModified, nextRefreshAllowed),
  };
}

function endpointDataStatus(lastModified?: string, nextRefreshAllowed?: string): EndpointStatus {
  if (nextRefreshAllowed && Date.parse(nextRefreshAllowed) <= Date.now()) return "stale";
  if (lastModified && Date.now() - Date.parse(lastModified) <= 2 * 60 * 1000) return "fresh";
  return "cached";
}

async function indexAssetsByPurpose(rawAssets: AssetRecord[]) {
  if (rawAssets.length === 0) {
    return {
      stockAssetsByItemId: new Map<number, AssetRecord>(),
      shipAssetsByItemId: new Map<number, AssetRecord>(),
      shipTypeIds: new Set<number>(),
      stockLocationItemsByItemId: new Map<number, AssetRecord>(),
      installedStructureRigs: [] as AssetRecord[],
      assembledShipsByItemId: new Map<number, AssetRecord>(),
    };
  }
  const [shipTypeIds, haulerShipTypeIds] = await Promise.all([
    getShipTypeIds(),
    getHaulerShipTypeIds(),
  ]);

  const assetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
  const shipByAssetId = new Map<number, AssetRecord | null>();
  function findContainingShip(asset: AssetRecord): AssetRecord | null {
    const cachedShip = shipByAssetId.get(asset.itemId);
    if (cachedShip !== undefined) return cachedShip;
    const visited = new Set<number>();
    let current: AssetRecord | undefined = asset;
    while (current) {
      if (shipTypeIds.has(current.typeId)) {
        for (const itemId of visited) shipByAssetId.set(itemId, current);
        return current;
      }
      if (visited.has(current.itemId)) break;
      visited.add(current.itemId);
      current = assetsByItemId.get(current.locationId);
    }
    for (const itemId of visited) shipByAssetId.set(itemId, null);
    return null;
  }

  const shipAssetsByItemId = new Map(
    rawAssets
      .map((asset) => [asset, findContainingShip(asset)] as const)
      .filter(
        (entry): entry is readonly [AssetRecord, AssetRecord] =>
          // containing ship exists and is assembled
          entry[1] !== null && entry[1].isSingleton,
      )
      .map(([asset]) => [asset.itemId, asset]),
  );

  const assembledShipsByItemId = new Map(
    rawAssets
      .filter(
        (asset) =>
          asset.isSingleton // assembled
          && shipTypeIds.has(asset.typeId), // ship type
      )
      .map((asset) => [asset.itemId, asset]),
  );

  // find all the unique location IDs from all the assets
  const stockLocationIds = new Set<number>([...rawAssets.map((asset) => asset.locationId)]);

  // all the assets that are actually containers of assets
  const stockLocationItemsByItemId = new Map(
    rawAssets
      .filter((asset) => stockLocationIds.has(asset.itemId))
      .map((asset) => [asset.itemId, asset]),
  );

  // all the assets that are not also locations of other assets or assembled ships
  // assets may be onboard assembled ships!
  const stockAssetsByItemId = new Map(
    rawAssets
      .filter((asset) => {
        // filter out assets that are assembled ships
        if (assembledShipsByItemId.has(asset.itemId)) return false;

        // filter out assets that are locations of other assets, unless they are packaged hauler descendants
        const containingShip = shipByAssetId.get(asset.itemId) ?? null;
        const isParentedByShip = containingShip !== null && containingShip.itemId !== asset.itemId;
        const isPackagedHaulerDescendant =
          isParentedByShip && !asset.isSingleton && haulerShipTypeIds.has(containingShip.typeId);

        // not parented by a ship and not a stock location, or is a packaged hauler descendant
        return (
          (!isParentedByShip && !stockLocationIds.has(asset.itemId)) || isPackagedHaulerDescendant
        );
      })
      .map((asset) => [asset.itemId, asset]),
  );

  const installedStructureRigs = [
    ...stockAssetsByItemId
      .values()
      .filter(
        (asset) =>
          asset.ownerType === "corporation"
          && asset.locationType === "structure"
          && asset.locationFlag.startsWith("RigSlot"),
      ),
  ];

  return {
    stockAssetsByItemId,
    shipAssetsByItemId,
    shipTypeIds,
    stockLocationItemsByItemId,
    installedStructureRigs,
    assembledShipsByItemId,
  };
}

async function cacheResolvedAssets(
  cache: OwnerCache,
  rawAssets: AssetRecord[],
  token: TokenSet,
  headers?: Headers,
  previous?: EndpointCache<AssetRecord[]>,
  assetNamePath?: string,
  preserveExpiry = false,
  useFallbackLifetime = false,
  markRefreshed = false,
  preserveLastModified = false,
) {
  const assetIndexes = await indexAssetsByPurpose(rawAssets);
  let namedAssets = rawAssets;
  if (assetNamePath) {
    const stockAssetIds = new Set(assetIndexes.stockAssetsByItemId.keys());
    namedAssets = await mergeAssetNames(rawAssets, token, assetNamePath, stockAssetIds);
    if (namedAssets !== rawAssets) {
      const namesByItemId = new Map(namedAssets.map((asset) => [asset.itemId, asset]));
      const replaceMapValues = <T extends AssetRecord>(assets: Map<number, T>) => {
        for (const itemId of assets.keys()) {
          const namedAsset = namesByItemId.get(itemId);
          if (namedAsset) assets.set(itemId, namedAsset as T);
        }
      };
      replaceMapValues(assetIndexes.stockAssetsByItemId);
      replaceMapValues(assetIndexes.shipAssetsByItemId);
      replaceMapValues(assetIndexes.stockLocationItemsByItemId);
      replaceMapValues(assetIndexes.assembledShipsByItemId);
    }
  }

  const rootLocationsByItemId = await resolveRootLocations(
    assetIndexes.stockLocationItemsByItemId,
    assetIndexes.shipTypeIds,
    token,
  );
  const inferredRoots = new Map<number, Promise<AssetLocation | null>>();

  function inferRoot(locationId: number, asset: AssetRecord) {
    const existing = inferredRoots.get(locationId);
    if (existing) return existing;
    const resolution = getRealParent(asset, token);
    inferredRoots.set(locationId, resolution);
    return resolution;
  }

  // add locations to stock assets
  const resolvedStockAssets = await Promise.all(
    [...assetIndexes.stockAssetsByItemId.values()].map(async (asset) => {
      const cachedRoot = rootLocationsByItemId.get(asset.locationId);
      if (cachedRoot) return { ...asset, rootLocation: cachedRoot };
      try {
        const rootLocation = await inferRoot(asset.locationId, asset);
        return rootLocation ? { ...asset, rootLocation } : asset;
      }
      catch (error) {
        console.warn(
          "Could not resolve stock asset location",
          {
            itemId: asset.itemId,
            locationId: asset.locationId,
            error,
          },
        );
        return asset;
      }
    }),
  );
  for (const asset of resolvedStockAssets) {
    if (asset.rootLocation && "kind" in asset.rootLocation) {
      rootLocationsByItemId.set(asset.locationId, asset.rootLocation);
    }
  }
  const resolvedByItemId = new Map(resolvedStockAssets.map((asset) => [asset.itemId, asset]));

  const refreshedAt = markRefreshed ? new Date().toISOString() : undefined;
  cache.allAssetsRaw = setFresh(
    namedAssets,
    headers,
    previous,
    assetNamePath?.startsWith("/corporations/") ? 60 * 60 * 1000 : 5 * 60 * 1000,
    preserveExpiry,
    useFallbackLifetime,
  );
  if (preserveLastModified && previous?.lastModified) {
    cache.allAssetsRaw.lastModified = previous.lastModified;
  }
  if (refreshedAt) cache.allAssetsRaw.lastModified = refreshedAt;
  if (refreshedAt) {
    cache.allAssetsRaw.status = endpointDataStatus(
      cache.allAssetsRaw.lastModified,
      cache.allAssetsRaw.nextRefreshAllowed,
    );
  }
  cache.stockAssetsByItemId = resolvedByItemId;
  cache.rootLocationsByItemId = rootLocationsByItemId;
  const resolvedShipAssets = await Promise.all(
    [...assetIndexes.shipAssetsByItemId.values()].map(async (asset) => {
      const cachedRoot = rootLocationsByItemId.get(asset.locationId);
      if (cachedRoot) return { ...asset, rootLocation: cachedRoot };
      try {
        const rootLocation = await inferRoot(asset.locationId, asset);
        return rootLocation ? { ...asset, rootLocation } : asset;
      }
      catch {
        return asset;
      }
    }),
  );
  cache.shipAssetsByItemId = new Map(resolvedShipAssets.map((asset) => [asset.itemId, asset]));
  cache.assembledShipsByItemId = assetIndexes.assembledShipsByItemId;
  cache.assembledStructureRigs = assetIndexes.installedStructureRigs;

  cache.unresolvedAssetCount = [
    ...resolvedByItemId.values(),
    ...cache.assembledStructureRigs,
    ...cache.assembledShipsByItemId.values(),
  ].filter((asset) => !asset.rootLocation).length;
}

async function mergeAssetNames(
  assets: AssetRecord[],
  token: TokenSet,
  ownerPath: string,
  excludedItemIds: ReadonlySet<number>,
) {
  const [types, groups, marketGroups, shipTypeIds] = await Promise.all([
    getTypes(),
    getGroups(),
    getMarketGroups(),
    getShipTypeIds(),
  ]);
  const nameableItemIds = assets
    .filter(
      (asset) =>
        asset.isSingleton
        && !excludedItemIds.has(asset.itemId)
        && (
          shipTypeIds.has(asset.typeId)
          || isCargoContainerType(asset.typeId, types, groups, marketGroups)
        )
        && !asset.name,
    )
    .map((asset) => asset.itemId);
  if (nameableItemIds.length === 0) return assets;
  try {
    const names = await fetchAssetNames(`${ownerPath}/assets/names`, token, nameableItemIds);
    if (names.size === 0) return assets;
    return assets.map((asset) => {
      const name = names.get(asset.itemId);
      return name === undefined ? asset : { ...asset, name };
    });
  }
  catch {
    return assets;
  }
}

function needsCompleteAssetGraph(cache: OwnerCache) {
  return (
    (cache.stockAssetsByItemId == undefined || cache.stockAssetsByItemId.size === 0)
    && Array.isArray(cache.allAssetsRaw?.lastBody)
  );
}

function isCargoContainerType(
  typeId: number,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  groups: Awaited<ReturnType<typeof getGroups>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
) {
  const type = types.get(typeId);
  const group = groups.get(type?.groupID ?? -1);
  if (group?.categoryID === 2) return true;
  let marketGroup =
    type?.marketGroupID === undefined ? undefined : marketGroups.get(type.marketGroupID);
  while (marketGroup) {
    if (marketGroup.name.en === "Cargo Containers") return true;
    marketGroup =
      marketGroup.parentGroupID === undefined
        ? undefined
        : marketGroups.get(marketGroup.parentGroupID);
  }
  return false;
}

function directKind(locationType: AssetRecord["locationType"]): AssetLocation["kind"] | null {
  if (
    locationType === "station"
    || locationType === "solar_system"
    || locationType === "structure"
  ) {
    return locationType;
  }
  return null;
}

async function getRealParent(current: AssetRecord, token: TokenSet): Promise<AssetLocation | null> {
  const locationId = current.locationId;
  const kind = directKind(current.locationType);
  const station = kind === "station" || kind === null ? await getStation(locationId) : null;
  if (station) {
    let name: string | undefined;
    try {
      name = (await fetchStationMetadata(locationId, token)).data?.name;
    }
    catch {
      // SDE still provides the station identity when ESI name lookup is unavailable.
    }
    return {
      locationId,
      kind: "station",
      ...(name ? { name } : {}),
      typeId: station.typeID,
      systemId: station.solarSystemID,
      resolved: true,
    };
  }
  if (kind === "solar_system" || kind === "structure" || kind === null) {
    const result = await (
      kind === "solar_system"
        ? fetchSolarSystemMetadata(locationId, token)
        : fetchStructureMetadataPerCharacter(locationId, token)
    ).catch(() => null);
    if (!result?.data) return null;
    return {
      locationId,
      kind: kind === "solar_system" ? "solar_system" : "structure",
      ...(result.data.type_id !== undefined ? { typeId: result.data.type_id } : {}),
      name: result.data.name,
      ...(result.data.system_id !== undefined || result.data.solar_system_id !== undefined
        ? { systemId: result.data.system_id ?? result.data.solar_system_id }
        : {}),
      ...(result.data.region_id !== undefined ? { regionId: result.data.region_id } : {}),
      resolved: true,
    };
  }
  return null;
}

async function resolveRootLocations(
  containerItemsByItemId: Map<number, AssetRecord>,
  shipTypeIds: Set<number>,
  token: TokenSet,
) {
  // Cache already-resolved roots
  const rootCache = new Map<number, AssetLocation>();

  async function findRoot(location: number): Promise<AssetLocation | null> {
    const cachedRoot = rootCache.get(location);
    if (cachedRoot) {
      return cachedRoot;
    }

    const visited = new Set<number>();
    let current = containerItemsByItemId.get(location);
    while (current) {
      if (visited.has(current.itemId)) {
        throw new Error(`Circular location hierarchy detected at ${current.itemId}`);
      }
      visited.add(current.itemId);
      if (shipTypeIds.has(current.typeId)) {
        const realParent = await getRealParent(current, token);
        if (!realParent) return null;
        for (const id of visited) rootCache.set(id, realParent);
        return realParent;
      }
      const parent = containerItemsByItemId.get(current.locationId);
      if (!parent) {
        // The first parent outside the container index must be resolved through SDE or ESI.
        const realParent = await getRealParent(current, token);
        if (!realParent) return null;
        for (const id of visited) rootCache.set(id, realParent);
        return realParent;
      }
      current = parent;
    }
    console.warn(`Location ${location} is not a container item`);
    return null;
  }

  const results = await Promise.allSettled(
    [...containerItemsByItemId.values()].map(
      async (asset) =>
        [asset.itemId, { ...asset, rootLocation: await findRoot(asset.itemId) }] as const,
    ),
  );
  const roots: Array<readonly [number, AssetLocation]> = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value[1].rootLocation) {
      roots.push([result.value[0], result.value[1].rootLocation]);
    }
    else if (result.status === "fulfilled") {
      const asset = result.value[1];
      if (asset.locationType === "item") continue;
      console.warn(
        "Could not resolve a container root",
        {
          itemId: asset.itemId,
          locationId: asset.locationId,
          locationType: asset.locationType,
        },
      );
    }
    else {
      console.warn("Could not resolve a container root", result.reason);
    }
  }
  return new Map<number, AssetLocation>(roots);
}

async function rebuildResolvedAssets(
  cache: OwnerCache,
  record: Awaited<ReturnType<typeof getCharacter>>,
  purpose: "personal" | "corp",
) {
  if (!record || !needsCompleteAssetGraph(cache) || !Array.isArray(cache.allAssetsRaw?.lastBody)) {
    return;
  }
  try {
    const token = await getUsableToken(record);
    const ownerPath =
      purpose === "corp"
        ? `/corporations/${record.corporationId}`
        : `/characters/${record.characterId}`;
    await cacheResolvedAssets(
      cache,
      cache.allAssetsRaw.lastBody as AssetRecord[],
      token,
      undefined,
      cache.allAssetsRaw,
      ownerPath,
    );
  }
  catch {
    // Keep raw assets available when ESI is paused or unavailable.
  }
}

export async function refreshCharacterState(characterIds: number[], sessionId: string) {
  const characters = await getCharacters();
  const refreshedCorporationIds = new Set<number>();
  const summary: {
    characterId: number;
    assets?: EndpointCache<AssetRecord[] | null>;
    blueprints?: EndpointCache<BlueprintInstanceRecord[] | null>;
    jobs?: EndpointCache<IndustryJobRecord[] | null>;
    skills?: EndpointCache<CharacterSkillRecord[] | null>;
    marketOrders?: EndpointCache<MarketOrderRecord[] | null>;
    corporations?: Array<{
      corporationId: number;
      assets?: EndpointCache<AssetRecord[] | null>;
      blueprints?: EndpointCache<BlueprintInstanceRecord[] | null>;
      structures?: EndpointCache<EsiCorporationStructure[] | null>;
    }>;
  }[] = [];
  for (const characterId of characterIds) {
    const character = await getCharacter(characterId);
    if (!character) continue;
    const cache = getCache(characterCaches, characterId, sessionId);
    const characterSummary: (typeof summary)[number] = { characterId };
    try {
      if (
        !cache.skills
        || !cache.skills.nextRefreshAllowed
        || Date.parse(cache.skills.nextRefreshAllowed) <= Date.now()
      ) {
        const skills = await fetchCharacterSkills(character);
        cache.skills =
          skills.fromCache && cache.skills
            ? {
                ...cache.skills,
                status: endpointDataStatus(
                  cache.skills.lastModified,
                  cache.skills.nextRefreshAllowed,
                ),
              }
            : setFresh(skills.skills ?? [], skills.headers, cache.skills, 5 * 60 * 1000);
      }
      else {
        cache.skills.status = endpointDataStatus(
          cache.skills.lastModified,
          cache.skills.nextRefreshAllowed,
        );
      }
      characterSummary.skills = cache.skills;
    }
    catch (error) {
      cache.skills = {
        ...(cache.skills ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.skills = cache.skills;
    }
    try {
      if (
        cache.allAssetsRaw?.nextRefreshAllowed
        && Date.parse(cache.allAssetsRaw.nextRefreshAllowed) > Date.now()
      ) {
        characterSummary.assets = {
          ...cache.allAssetsRaw,
          status: endpointDataStatus(
            cache.allAssetsRaw.lastModified,
            cache.allAssetsRaw.nextRefreshAllowed,
          ),
        };
        if (Array.isArray(cache.allAssetsRaw.lastBody)) {
          const token = await getUsableToken(character);
          await cacheResolvedAssets(
            cache,
            cache.allAssetsRaw.lastBody as AssetRecord[],
            token,
            undefined,
            cache.allAssetsRaw,
            `/characters/${character.characterId}`,
            true,
            false,
            false,
            true,
          );
        }
      }
      else {
        const previousAssetTiming = cache.allAssetsRaw && {
          lastUpdated: cache.allAssetsRaw.lastUpdated,
          nextRefreshAllowed: cache.allAssetsRaw.nextRefreshAllowed,
        };
        const result = await fetchCharacterAssets(character, cache.allAssetsRaw?.etag, true);
        if (result.notModified && cache.allAssetsRaw) {
          await cacheResolvedAssets(
            cache,
            cache.allAssetsRaw.lastBody as AssetRecord[],
            result.token,
            result.headers,
            cache.allAssetsRaw,
            `/characters/${character.characterId}`,
            false,
            true,
            false,
            true,
          );
          cache.allAssetsRaw.status = endpointDataStatus(
            cache.allAssetsRaw.lastModified,
            cache.allAssetsRaw.nextRefreshAllowed,
          );
        }
        else if (result.assets) {
          await cacheResolvedAssets(
            cache,
            result.assets,
            result.token,
            result.headers,
            cache.allAssetsRaw,
            `/characters/${character.characterId}`,
            result.fromCache,
            true,
            true,
          );
        }
        if (result.fromCache && cache.allAssetsRaw) {
          if (previousAssetTiming) {
            cache.allAssetsRaw.lastUpdated = previousAssetTiming.lastUpdated;
            cache.allAssetsRaw.expires = previousAssetTiming.nextRefreshAllowed;
            cache.allAssetsRaw.nextRefreshAllowed = previousAssetTiming.nextRefreshAllowed;
          }
          cache.allAssetsRaw.status = endpointDataStatus(
            cache.allAssetsRaw.lastModified,
            cache.allAssetsRaw.nextRefreshAllowed,
          );
        }
        characterSummary.assets = cache.allAssetsRaw;
      }
    }
    catch (error) {
      await rebuildResolvedAssets(cache, character, "personal");
      cache.allAssetsRaw = {
        ...(cache.allAssetsRaw ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.assets = {
        ...cache.allAssetsRaw,
      };
    }
    try {
      characterSummary.blueprints = await refreshBlueprintInstances(
        cache,
        character,
        fetchCharacterBlueprints,
      );
    }
    catch (error) {
      cache.blueprintInstances = {
        ...(cache.blueprintInstances ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.blueprints = cache.blueprintInstances;
    }
    try {
      if (
        !cache.jobs
        || !cache.jobs.nextRefreshAllowed
        || Date.parse(cache.jobs.nextRefreshAllowed) <= Date.now()
      ) {
        const jobs = await fetchCharacterIndustryJobs(character, cache.jobs?.etag, true);
        cache.jobs =
          jobs.notModified && cache.jobs
            ? setFresh(cache.jobs.lastBody, jobs.headers, cache.jobs)
            : jobs.fromCache && cache.jobs
              ? {
                  ...cache.jobs,
                  status: endpointDataStatus(
                    cache.jobs.lastModified,
                    cache.jobs.nextRefreshAllowed,
                  ),
                }
              : setFresh(jobs.jobs ?? [], jobs.headers, cache.jobs);
      }
      else {
        cache.jobs.status = endpointDataStatus(
          cache.jobs.lastModified,
          cache.jobs.nextRefreshAllowed,
        );
      }
      characterSummary.jobs = cache.jobs;
    }
    catch (error) {
      cache.jobs = {
        ...(cache.jobs ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.jobs = cache.jobs;
    }
    try {
      if (
        cache.marketOrders?.status === "stale"
        || !cache.marketOrders
        || !cache.marketOrders.nextRefreshAllowed
        || Date.parse(cache.marketOrders.nextRefreshAllowed) <= Date.now()
      ) {
        const orders = await fetchCharacterMarketOrders(
          character,
          getUsableMarketOrdersEtag(cache),
          true,
        );
        if (orders.notModified && cache.marketOrders) {
          cache.marketOrders = setFresh(
            cache.marketOrders.lastBody,
            orders.headers,
            cache.marketOrders,
            5 * 60 * 1000,
            false,
            true,
          );
          cache.marketOrders.status = endpointDataStatus(
            cache.marketOrders.lastModified,
            cache.marketOrders.nextRefreshAllowed,
          );
        }
        else if (orders.notModified) {
          cache.marketOrders = setFresh([], orders.headers);
        }
        else if (orders.orders) {
          cache.marketOrders =
            orders.fromCache && cache.marketOrders
              ? {
                  ...cache.marketOrders,
                  status: endpointDataStatus(
                    cache.marketOrders.lastModified,
                    cache.marketOrders.nextRefreshAllowed,
                  ),
                }
              : setFresh(
                  orders.orders,
                  orders.headers,
                  cache.marketOrders,
                  5 * 60 * 1000,
                  orders.fromCache,
                );
        }
      }
      else {
        cache.marketOrders.status = endpointDataStatus(
          cache.marketOrders.lastModified,
          cache.marketOrders.nextRefreshAllowed,
        );
      }
      characterSummary.marketOrders = cache.marketOrders;
    }
    catch (error) {
      cache.marketOrders = {
        ...(cache.marketOrders ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.marketOrders = {
        ...cache.marketOrders,
      };
    }

    if (
      character.hasDirectorRole
      && character.corporationId
      && !refreshedCorporationIds.has(character.corporationId)
    ) {
      refreshedCorporationIds.add(character.corporationId);
      const corpCache = getCache(corporationCaches, character.corporationId, sessionId);
      const corpSummary: {
        corporationId: number;
        assets?: EndpointCache<AssetRecord[] | null>;
        blueprints?: EndpointCache<BlueprintInstanceRecord[] | null>;
        structures?: EndpointCache<EsiCorporationStructure[] | null>;
        jobs?: EndpointCache<IndustryJobRecord[] | null>;
        marketOrders?: EndpointCache<MarketOrderRecord[] | null>;
      } = { corporationId: character.corporationId };
      try {
        if (
          !corpCache.structures
          || !corpCache.structures.nextRefreshAllowed
          || Date.parse(corpCache.structures.nextRefreshAllowed) <= Date.now()
        ) {
          const structures = await fetchCorporationStructures(character);
          corpCache.structures = setFresh(
            structures,
            undefined,
            corpCache.structures,
            5 * 60 * 1000,
            false,
            true,
          );
        }
        else {
          corpCache.structures.status = endpointDataStatus(
            corpCache.structures.lastModified,
            corpCache.structures.nextRefreshAllowed,
          );
        }
        corpSummary.structures = corpCache.structures;
      }
      catch (error) {
        corpCache.structures = {
          ...(corpCache.structures ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        corpSummary.structures = { ...corpCache.structures };
      }
      try {
        if (
          corpCache.allAssetsRaw?.nextRefreshAllowed
          && Date.parse(corpCache.allAssetsRaw.nextRefreshAllowed) > Date.now()
        ) {
          corpSummary.assets = {
            ...corpCache.allAssetsRaw,
            status: endpointDataStatus(
              corpCache.allAssetsRaw.lastModified,
              corpCache.allAssetsRaw.nextRefreshAllowed,
            ),
          };
          if (Array.isArray(corpCache.allAssetsRaw.lastBody)) {
            const token = await getUsableToken(character);
            await cacheResolvedAssets(
              corpCache,
              corpCache.allAssetsRaw.lastBody as AssetRecord[],
              token,
              undefined,
              corpCache.allAssetsRaw,
              `/corporations/${character.corporationId}`,
              true,
              false,
              false,
              true,
            );
          }
        }
        else {
          const previousAssetTiming = corpCache.allAssetsRaw && {
            lastUpdated: corpCache.allAssetsRaw.lastUpdated,
            nextRefreshAllowed: corpCache.allAssetsRaw.nextRefreshAllowed,
          };
          const result = await fetchCorporationAssets(
            character,
            corpCache.allAssetsRaw?.etag,
            true,
          );
          if (result.notModified && corpCache.allAssetsRaw) {
            await cacheResolvedAssets(
              corpCache,
              corpCache.allAssetsRaw.lastBody as AssetRecord[],
              result.token,
              result.headers,
              corpCache.allAssetsRaw,
              `/corporations/${character.corporationId}`,
              false,
              true,
              false,
              true,
            );
            corpCache.allAssetsRaw.status = endpointDataStatus(
              corpCache.allAssetsRaw.lastModified,
              corpCache.allAssetsRaw.nextRefreshAllowed,
            );
          }
          else if (result.assets) {
            await cacheResolvedAssets(
              corpCache,
              result.assets,
              result.token,
              result.headers,
              corpCache.allAssetsRaw,
              `/corporations/${character.corporationId}`,
              result.fromCache,
              true,
              true,
            );
          }
          corpSummary.assets = corpCache.allAssetsRaw;
          if (result.fromCache && corpCache.allAssetsRaw) {
            if (previousAssetTiming) {
              corpCache.allAssetsRaw.lastUpdated = previousAssetTiming.lastUpdated;
              corpCache.allAssetsRaw.expires = previousAssetTiming.nextRefreshAllowed;
              corpCache.allAssetsRaw.nextRefreshAllowed = previousAssetTiming.nextRefreshAllowed;
            }
            corpCache.allAssetsRaw.status = endpointDataStatus(
              corpCache.allAssetsRaw.lastModified,
              corpCache.allAssetsRaw.nextRefreshAllowed,
            );
          }
        }
      }
      catch (error) {
        corpCache.allAssetsRaw = {
          ...(corpCache.allAssetsRaw ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        await rebuildResolvedAssets(corpCache, character, "corp");
        corpSummary.assets = {
          ...corpCache.allAssetsRaw,
        };
      }
      try {
        corpSummary.blueprints = await refreshBlueprintInstances(
          corpCache,
          character,
          fetchCorporationBlueprints,
        );
      }
      catch (error) {
        corpCache.blueprintInstances = {
          ...(corpCache.blueprintInstances ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        corpSummary.blueprints = corpCache.blueprintInstances;
      }
      try {
        if (
          !corpCache.jobs
          || !corpCache.jobs.nextRefreshAllowed
          || Date.parse(corpCache.jobs.nextRefreshAllowed) <= Date.now()
        ) {
          const jobs = await fetchCorporationIndustryJobs(character, corpCache.jobs?.etag, true);
          corpCache.jobs =
            jobs.notModified && corpCache.jobs
              ? setFresh(corpCache.jobs.lastBody, jobs.headers, corpCache.jobs)
              : jobs.fromCache && corpCache.jobs
                ? {
                    ...corpCache.jobs,
                    status: endpointDataStatus(
                      corpCache.jobs.lastModified,
                      corpCache.jobs.nextRefreshAllowed,
                    ),
                  }
                : setFresh(
                    jobs.jobs ?? [],
                    jobs.headers,
                    corpCache.jobs,
                    5 * 60 * 1000,
                    jobs.fromCache,
                  );
        }
        else {
          corpCache.jobs.status = endpointDataStatus(
            corpCache.jobs.lastModified,
            corpCache.jobs.nextRefreshAllowed,
          );
        }
        corpSummary.jobs = corpCache.jobs;
      }
      catch (error) {
        corpCache.jobs = {
          ...(corpCache.jobs ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        corpSummary.jobs = {
          ...corpCache.jobs,
        };
      }
      try {
        if (
          corpCache.marketOrders?.status === "stale"
          || !corpCache.marketOrders
          || !corpCache.marketOrders.nextRefreshAllowed
          || Date.parse(corpCache.marketOrders.nextRefreshAllowed) <= Date.now()
        ) {
          const orders = await fetchCorporationMarketOrders(
            character,
            getUsableMarketOrdersEtag(corpCache),
            true,
          );
          if (orders.notModified && corpCache.marketOrders) {
            corpCache.marketOrders = setFresh(
              corpCache.marketOrders.lastBody,
              orders.headers,
              corpCache.marketOrders,
              20 * 60 * 1000,
              false,
              true,
            );
            corpCache.marketOrders.status = endpointDataStatus(
              corpCache.marketOrders.lastModified,
              corpCache.marketOrders.nextRefreshAllowed,
            );
          }
          else if (orders.notModified) {
            corpCache.marketOrders = setFresh([], orders.headers);
          }
          else if (orders.orders) {
            corpCache.marketOrders = setFresh(
              orders.orders,
              orders.headers,
              corpCache.marketOrders,
              20 * 60 * 1000,
              orders.fromCache,
            );
          }
        }
        else {
          corpCache.marketOrders.status = endpointDataStatus(
            corpCache.marketOrders.lastModified,
            corpCache.marketOrders.nextRefreshAllowed,
          );
        }
        corpSummary.marketOrders = corpCache.marketOrders;
      }
      catch (error) {
        corpCache.marketOrders = {
          ...(corpCache.marketOrders ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        corpSummary.marketOrders = {
          ...corpCache.marketOrders,
        };
      }
      characterSummary.corporations = [corpSummary];
    }
    summary.push(characterSummary);
  }
  return { characters: summary };
}

export async function getRunningIndustryJobs(
  characterIds: number[],
  includeCorporationJobs: boolean,
  sessionId = "default",
) {
  const jobs = characterIds.flatMap((id) => {
    const body = getCache(characterCaches, id, sessionId).jobs?.lastBody;
    return Array.isArray(body) ? (body as IndustryJobRecord[]) : [];
  });
  if (!includeCorporationJobs) return jobs.filter((job) => job.ownerType === "character");
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...jobs,
    ...[...corporationIds].flatMap((id) => {
      const body = getCache(corporationCaches, id, sessionId).jobs?.lastBody;
      return Array.isArray(body) ? (body as IndustryJobRecord[]) : [];
    }),
  ];
}

/** Returns the stock assets including the root location, excluding container items */
export async function getResolvedAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
): Promise<AssetRecord[]> {
  const assets = characterIds.flatMap((id) =>
    Array.from(getCache(characterCaches, id, sessionId).stockAssetsByItemId?.values() ?? []),
  );
  if (!includeCorporationAssets) return [...assets];

  const characters = await getCharacters();
  const corporations = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporations].flatMap((id) =>
      Array.from(getCache(corporationCaches, id, sessionId).stockAssetsByItemId?.values() ?? []),
    ),
  ];
}

/** Returns ships and every asset contained by a ship, including nested containers. */
export async function getShipAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
): Promise<AssetRecord[]> {
  const assets = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id, sessionId).shipAssetsByItemId.values(),
  ]);
  if (!includeCorporationAssets) return assets;

  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporationIds].flatMap((id) => [
      ...getCache(corporationCaches, id, sessionId).shipAssetsByItemId.values(),
    ]),
  ];
}

/** Returns the complete resolved graph, including containers and ships. */
export async function getAllAssetsRaw(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
) {
  const assets = characterIds.flatMap(
    (id) => getCache(characterCaches, id, sessionId).allAssetsRaw?.lastBody ?? [],
  );
  if (!includeCorporationAssets) return assets;
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporationIds].flatMap(
      (id) => getCache(corporationCaches, id, sessionId).allAssetsRaw?.lastBody ?? [],
    ),
  ];
}

export async function getResolvedAssetIndex(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
) {
  const index = new Map<number, AssetRecord>();
  const characters = await getCharacters();
  const corporationIds = includeCorporationAssets
    ? new Set(
        characters
          .filter(
            (character) =>
              characterIds.includes(character.characterId)
              && character.hasDirectorRole
              && character.corporationId,
          )
          .map((character) => character.corporationId!),
      )
    : new Set<number>();
  for (const characterId of characterIds) {
    for (const asset of getCache(
      characterCaches,
      characterId,
      sessionId,
    ).stockAssetsByItemId?.values() ?? []) {
      index.set(asset.itemId, asset);
    }
  }
  for (const corporationId of corporationIds) {
    for (const asset of getCache(
      corporationCaches,
      corporationId,
      sessionId,
    ).stockAssetsByItemId?.values() ?? []) {
      index.set(asset.itemId, asset);
    }
  }
  return index;
}

export async function getRootLocationsByItemId(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
): Promise<Map<number, AssetLocation>> {
  const locations = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id, sessionId).rootLocationsByItemId.entries(),
  ]);
  if (!includeCorporationAssets) return new Map(locations);
  const characters = await getCharacters();
  const corporations = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...locations,
    ...[...corporations].flatMap((id) => [
      ...getCache(corporationCaches, id, sessionId).rootLocationsByItemId.entries(),
    ]),
  ].reduce(
    (map, [locationId, location]) => {
      map.set(locationId, location);
      return map;
    },
    new Map<number, AssetLocation>(),
  );
}

export async function getCachedCorporationStructures(
  characterIds: number[],
  sessionId = "default",
) {
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [...corporationIds].flatMap(
    (corporationId) =>
      getCache(corporationCaches, corporationId, sessionId).structures?.lastBody ?? [],
  );
}

export async function getAssembledStructureRigAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
) {
  if (!includeCorporationAssets) return [];
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [...corporationIds].flatMap((id) => [
    ...getCache(corporationCaches, id, sessionId).assembledStructureRigs.values(),
  ]);
}

export async function getAssembledShipAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
) {
  const assets = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id, sessionId).assembledShipsByItemId.values(),
  ]);
  if (!includeCorporationAssets) return assets;
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporationIds].flatMap((id) => [
      ...getCache(corporationCaches, id, sessionId).assembledShipsByItemId.values(),
    ]),
  ];
}

export async function getAssetCacheMetadata(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
) {
  const characterCachesForPlan = characterIds.map((id) => getCache(characterCaches, id, sessionId));
  const characters = await getCharacters();
  const corporations = includeCorporationAssets
    ? [
        ...new Set(
          characters
            .filter(
              (character) =>
                characterIds.includes(character.characterId)
                && character.hasDirectorRole
                && character.corporationId,
            )
            .map((character) => character.corporationId!),
        ),
      ]
    : [];
  const corporationCachesForPlan = corporations.map((id) =>
    getCache(corporationCaches, id, sessionId),
  );
  const allCaches = [...characterCachesForPlan, ...corporationCachesForPlan];
  return {
    assetsLastUpdated:
      allCaches
        .map((cache) => cache.allAssetsRaw?.lastUpdated)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
    jobsLastUpdated:
      allCaches
        .map((cache) => cache.jobs?.lastUpdated)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
    unresolvedAssetCount: allCaches.reduce((total, cache) => total + cache.unresolvedAssetCount, 0),
    corporationAssetSources: corporations,
  };
}

export async function getMarketOrderStock(
  characterIds: number[],
  options: {
    personalSellOrdersAsStock: boolean;
    allCorporationSellOrdersAsStock: boolean;
    myCorporationSellOrdersAsStock: boolean;
  },
  sessionId = "default",
): Promise<PlanStockItem[] | null> {
  const stock: PlanStockItem[] = [];
  const typeIds = new Set<number>();
  let hasUsableSource = false;
  let hasUnavailableSource = false;
  const resolveNames = async () => {
    if (typeIds.size === 0) return stock;
    const types = await getTypesByIds([...typeIds]);
    return stock.map((item) => ({
      ...item,
      name: types.get(item.typeId)?.name.en ?? item.name,
    }));
  };
  if (options.personalSellOrdersAsStock) {
    for (const characterId of characterIds) {
      const cache = getCache(characterCaches, characterId, sessionId);
      if (!hasUsableMarketOrders(cache)) {
        hasUnavailableSource = true;
        continue;
      }
      hasUsableSource = true;
      const orders = cache.marketOrders!.lastBody;
      for (const order of orders as MarketOrderRecord[]) {
        if (order.isBuyOrder || order.isCorporation || order.volumeRemain <= 0) continue;
        typeIds.add(order.typeId);
        stock.push({
          typeId: order.typeId,
          name: `Type ${order.typeId}`,
          quantity: order.volumeRemain,
          sourceLocationId: order.locationId,
          ownerType: order.ownerType,
          ownerId: order.ownerId,
          category: "item",
          source: "marketOrder",
        });
      }
    }
  }

  if (!options.allCorporationSellOrdersAsStock && !options.myCorporationSellOrdersAsStock) {
    return resolveNames();
  }
  const characters = await getCharacters();
  const selectedCharacters = characters.filter((character) =>
    characterIds.includes(character.characterId),
  );
  const corporationIds = new Set(
    selectedCharacters
      .filter((character) => character.hasDirectorRole && character.corporationId)
      .map((character) => character.corporationId!),
  );
  for (const corporationId of corporationIds) {
    const cache = getCache(corporationCaches, corporationId, sessionId);
    if (!hasUsableMarketOrders(cache)) {
      hasUnavailableSource = true;
      continue;
    }
    hasUsableSource = true;
    const orders = cache.marketOrders!.lastBody;
    for (const order of orders as MarketOrderRecord[]) {
      if (order.isBuyOrder || order.volumeRemain <= 0) continue;
      const isMyCorporationOrder =
        order.issuedBy !== undefined
        && selectedCharacters.some(
          (character) =>
            character.characterId === order.issuedBy && character.corporationId === corporationId,
        );
      if (!options.allCorporationSellOrdersAsStock && !isMyCorporationOrder) continue;
      typeIds.add(order.typeId);
      stock.push({
        typeId: order.typeId,
        name: `Type ${order.typeId}`,
        quantity: order.volumeRemain,
        sourceLocationId: order.locationId,
        ownerType: order.ownerType,
        ownerId: order.ownerId,
        category: "item",
        source: "marketOrder",
      });
    }
  }
  if (!hasUsableSource || (stock.length === 0 && hasUnavailableSource)) return null;
  return resolveNames();
}

export async function getBlueprintInstances(
  characterIds: number[],
  includeCorporationBlueprints: boolean,
  sessionId = "default",
) {
  const instances = characterIds.flatMap(
    (characterId) =>
      getCache(characterCaches, characterId, sessionId).blueprintInstances?.lastBody ?? [],
  );
  if (!includeCorporationBlueprints) return instances;
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId)
          && character.hasDirectorRole
          && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...instances,
    ...[...corporationIds].flatMap(
      (corporationId) =>
        getCache(corporationCaches, corporationId, sessionId).blueprintInstances?.lastBody ?? [],
    ),
  ];
}

export async function getStateStatus(characterIds: number[], sessionId: string) {
  const characters = await getCharacters();
  const corporationsByCharacter = new Map<number, number[]>();
  for (const character of characters) {
    if (
      !characterIds.includes(character.characterId)
      || !character.corporationId
      || !character.hasDirectorRole
    ) continue;
    const corporationIds = corporationsByCharacter.get(character.characterId) ?? [];
    corporationIds.push(character.corporationId);
    corporationsByCharacter.set(character.characterId, corporationIds);
  }
  return {
    characters: characterIds.map((characterId) => ({
      characterId,
      assets: toClientEndpointStatus(
        getCache(characterCaches, characterId, sessionId).allAssetsRaw,
      ) ?? {
        status: "cached" as const,
        hasBody: false,
      },
      skills: {
        ...(
          toClientEndpointStatus(getCache(characterCaches, characterId, sessionId).skills) ?? {
            status: "cached" as const,
            hasBody: false,
          }
        ),
        body: getCache(characterCaches, characterId, sessionId).skills?.lastBody ?? null,
      },
      blueprints: toClientEndpointStatus(
        getCache(characterCaches, characterId, sessionId).blueprintInstances,
      ) ?? {
        status: "cached" as const,
        hasBody: false,
      },
      jobs: toClientEndpointStatus(getCache(characterCaches, characterId, sessionId).jobs) ?? {
        status: "cached" as const,
        hasBody: false,
      },
      orders: toClientEndpointStatus(
        getCache(characterCaches, characterId, sessionId).marketOrders,
      ) ?? {
        status: "cached" as const,
        hasBody: false,
      },
      corporations: (corporationsByCharacter.get(characterId) ?? []).map((corporationId) => ({
        corporationId,
        assets: toClientEndpointStatus(
          getCache(corporationCaches, corporationId, sessionId).allAssetsRaw,
        ) ?? {
          status: "cached" as const,
          hasBody: false,
        },
        blueprints: toClientEndpointStatus(
          getCache(corporationCaches, corporationId, sessionId).blueprintInstances,
        ) ?? {
          status: "cached" as const,
          hasBody: false,
        },
        jobs: toClientEndpointStatus(
          getCache(corporationCaches, corporationId, sessionId).jobs,
        ) ?? {
          status: "cached" as const,
          hasBody: false,
        },
        orders: toClientEndpointStatus(
          getCache(corporationCaches, corporationId, sessionId).marketOrders,
        ) ?? {
          status: "cached" as const,
          hasBody: false,
        },
        structures: toClientEndpointStatus(
          getCache(corporationCaches, corporationId, sessionId).structures,
        ) ?? {
          status: "cached" as const,
          hasBody: false,
        },
      })),
    })),
  };
}

export async function getCharacterIndustrySlots(characterIds: number[], sessionId: string) {
  const types = await getTypes();
  const skillIds = new Map(
    [
      ["Mass Production", "manufacturing"],
      ["Advanced Mass Production", "manufacturingAdvanced"],
      ["Laboratory Operation", "science"],
      ["Advanced Laboratory Operation", "scienceAdvanced"],
      ["Mass Reactions", "reactions"],
      ["Advanced Mass Reactions", "reactionsAdvanced"],
    ].map(
      ([name, key]) =>
        [key, [...types.values()].find((type) => type.name.en === name)?._key] as const,
    ),
  );
  return new Map(
    characterIds.map((characterId) => {
      const skills = getCache(characterCaches, characterId, sessionId).skills?.lastBody ?? [];
      const levels = new Map(skills.map((skill) => [skill.skillId, skill.activeSkillLevel]));
      const level = (key: string) => levels.get(skillIds.get(key) ?? -1) ?? 0;
      return [
        characterId,
        {
          Manufacturing: 1 + level("manufacturing") + level("manufacturingAdvanced"),
          Reactions: 1 + level("reactions") + level("reactionsAdvanced"),
          Science: 1 + level("science") + level("scienceAdvanced"),
        },
      ] as const;
    }),
  );
}
