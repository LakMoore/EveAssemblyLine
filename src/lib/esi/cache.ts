import type {
  AssetLocation,
  AssetRecord,
  IndustryJobRecord,
  MarketOrderRecord,
  TokenSet,
} from "@/lib/auth/model";
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
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
  fetchCharacterMarketOrders,
  fetchCorporationMarketOrders,
  applyBlueprintMetadata,
  fetchLocationMetadata,
  getUsableToken,
} from "./client";
import { getStation } from "@/cache/services/sdeCache";

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
  status: EndpointStatus;
};

type OwnerCache = {
  allAssetsRaw?: EndpointCache<AssetRecord[]>;
  stockAssetsByItemId?: Map<number, AssetRecord>;
  shipAssetsByItemId: Map<number, AssetRecord>;
  rootContainersById: Map<number, AssetRecord>;
  assembledShipsByItemId: Map<number, AssetRecord>;
  assembledStructureRigs: AssetRecord[];
  jobs?: EndpointCache<IndustryJobRecord[]>;
  marketOrders?: EndpointCache<MarketOrderRecord[]>;
  unresolvedAssetCount: number;
};

const characterCaches = new Map<number, OwnerCache>();
const corporationCaches = new Map<number, OwnerCache>();
const corporationDirectorRotation = new Map<number, number>();

function getCache(map: Map<number, OwnerCache>, id: number): OwnerCache {
  const existing = map.get(id);
  if (existing) return existing;
  const created: OwnerCache = {
    assembledStructureRigs: [],
    shipAssetsByItemId: new Map(),
    rootContainersById: new Map(),
    assembledShipsByItemId: new Map(),
    unresolvedAssetCount: 0,
  };
  map.set(id, created);
  return created;
}

function endpointStatus<T>(
  error: unknown,
): Pick<EndpointCache<T>, "status" | "rateLimitedUntil" | "error"> {
  const status = (error as { status?: number }).status;
  if (status !== 429) {
    const errorMessage = status === 401 || status === 403
      ? `ESI authorization failed (${status}); reconnect this character to grant the required scope.`
      : error instanceof Error ? error.message : "ESI request failed";
    return {
      status: "error",
      error: errorMessage,
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
): EndpointCache<T> {
  const now = new Date();
  const expiresAt = Date.parse(headers?.get("expires") ?? "");
  const lastModified = normalizeUtcTimestamp(headers?.get("last-modified"), previous?.lastModified);
  const previousExpiry = previous?.expires ?? previous?.nextRefreshAllowed;
  const preservePreviousExpiry = preserveExpiry || (!headers && Boolean(previousExpiry));
  const nextRefreshAllowed = preservePreviousExpiry && previousExpiry
    ? previousExpiry
    : Number.isFinite(expiresAt) && expiresAt > now.getTime()
      ? new Date(expiresAt).toISOString()
      : lastModified && Number.isFinite(Date.parse(lastModified))
        ? new Date(Date.parse(lastModified) + lifetimeMs).toISOString()
        : new Date(now.getTime() + lifetimeMs).toISOString();
  return {
    lastBody: body,
    etag: headers?.get("etag") ?? previous?.etag,
    lastUpdated: now.toISOString(),
    lastModified,
    expires: nextRefreshAllowed,
    nextRefreshAllowed,
    status: endpointDataStatus(
      lastModified,
      nextRefreshAllowed,
    ),
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
        shipByAssetId.set(asset.itemId, current);
        return current;
      }
      if (visited.has(current.itemId)) break;
      visited.add(current.itemId);
      current = assetsByItemId.get(current.locationId);
    }
    shipByAssetId.set(asset.itemId, null);
    return null;
  }

  const shipAssetsByItemId = new Map(
    rawAssets
      .map((asset) => [asset, findContainingShip(asset)] as const)
      .filter(
        (entry): entry is readonly [AssetRecord, AssetRecord] =>
          entry[1] !== null && entry[1].isSingleton,
      )
      .map(([asset]) => [asset.itemId, asset]),
  );

  const assembledShipsByItemId = new Map(
    rawAssets
      .filter((asset) =>
        asset.isSingleton                   // assembled
        && shipTypeIds.has(asset.typeId)    // ship type
      )
      .map((asset) => [asset.itemId, asset])
  );

  // find all the unique location IDs from all the assets
  const stockLocationIds = new Set<number>([...rawAssets.map((asset) => asset.locationId)]);

  // all the assets that are actually containers of assets
  const stockLocationItemsByItemId = new Map(rawAssets
    .filter((asset) => stockLocationIds.has(asset.itemId))
    .map((asset) => [asset.itemId, asset])
  );

  // all the assets that are not also locations of other assets or assembled ships
  // assets may be onboard assembled ships!
  const stockAssetsByItemId = new Map(rawAssets
    .filter((asset) => 
      !assembledShipsByItemId.has(asset.itemId)
      && (shipTypeIds.has(asset.typeId)
        ? !asset.isSingleton
        : (() => {
        const containingShip = shipByAssetId.get(asset.itemId) ?? null;
        const isPackagedHaulerDescendant = containingShip !== null
          && containingShip.itemId !== asset.itemId
          && !asset.isSingleton
          && haulerShipTypeIds.has(containingShip.typeId);
        return !stockLocationIds.has(asset.itemId) || isPackagedHaulerDescendant;
      })())
    )
    .map((asset) => [asset.itemId, asset])
  );

  const installedStructureRigs = [...stockAssetsByItemId.values()
    .filter((asset) => 
      asset.ownerType === "corporation" 
      && asset.locationType === "structure" 
      && asset.locationFlag.startsWith("RigSlot")
    )
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

  const containerRootsById = await resolveContainerRoots(
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
      const containerRoot = containerRootsById.get(asset.locationId)?.rootLocation;
      if (containerRoot) return { ...asset, rootLocation: containerRoot };
      try {
        const rootLocation = await inferRoot(asset.locationId, asset);
        return rootLocation ? { ...asset, rootLocation } : asset;
      } catch (error) {
        console.warn("Could not resolve stock asset location", {
          itemId: asset.itemId,
          locationId: asset.locationId,
          error,
        });
        return asset;
      }
    }),
  );
  const resolvedByItemId = new Map(
    resolvedStockAssets.map((asset) => [asset.itemId, asset]),
  );

  cache.allAssetsRaw = setFresh(
    namedAssets,
    headers,
    previous,
    assetNamePath?.startsWith("/corporations/") ? 60 * 60 * 1000 : 5 * 60 * 1000,
    preserveExpiry,
  );
  cache.stockAssetsByItemId = resolvedByItemId;
  const resolvedShipAssets = await Promise.all(
    [...assetIndexes.shipAssetsByItemId.values()].map(async (asset) => {
      const containerRoot = containerRootsById.get(asset.locationId)?.rootLocation;
      if (containerRoot) return { ...asset, rootLocation: containerRoot };
      try {
        const rootLocation = await inferRoot(asset.locationId, asset);
        return rootLocation ? { ...asset, rootLocation } : asset;
      } catch {
        return asset;
      }
    }),
  );
  cache.shipAssetsByItemId = new Map(
    resolvedShipAssets.map((asset) => [asset.itemId, asset]),
  );
  cache.rootContainersById = containerRootsById;
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
        asset.isSingleton &&
        !excludedItemIds.has(asset.itemId) &&
        (shipTypeIds.has(asset.typeId) || isCargoContainerType(asset.typeId, types, groups, marketGroups)) &&
        !asset.name,
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
  } catch {
    return assets;
  }
}

function needsCompleteAssetGraph(cache: OwnerCache) {
  return (cache.stockAssetsByItemId == undefined || cache.stockAssetsByItemId?.size === 0) && Array.isArray(cache.allAssetsRaw?.lastBody);
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
  if (locationType === "station" || locationType === "solar_system" || locationType === "structure") {
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
      name = (await fetchLocationMetadata(locationId, "station", token)).data?.name;
    } catch {
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
    const result = await fetchLocationMetadata(
      locationId,
      kind === "solar_system" ? "solar_system" : "structure",
      token,
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

async function resolveContainerRoots(
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
    if (!current) {
      console.warn(`Location ${location} is not a container item`);
      return null;
    }
    while (true) {
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
  }

  const results = await Promise.allSettled(
    [...containerItemsByItemId.values()].map(async (asset) => [
      asset.itemId,
      { ...asset, rootLocation: await findRoot(asset.itemId) },
    ] as const),
  );
  const roots: Array<readonly [number, AssetRecord]> = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value[1].rootLocation) {
      roots.push(result.value as readonly [number, AssetRecord]);
    } else if (result.status === "fulfilled") {
      const asset = result.value[1];
      if (asset.locationType === "item") continue;
      console.warn("Could not resolve a container root", {
        itemId: asset.itemId,
        locationId: asset.locationId,
        locationType: asset.locationType,
      });
    } else {
      console.warn("Could not resolve a container root", result.reason);
    }
  }
  return new Map<number, AssetRecord>(roots);
}

async function rebuildResolvedAssets(
  cache: OwnerCache,
  record: Awaited<ReturnType<typeof getCharacter>>,
  purpose: "personal" | "corp",
) {
  if (!record || !needsCompleteAssetGraph(cache) || !Array.isArray(cache.allAssetsRaw?.lastBody)) return;
  try {
    const token = await getUsableToken(record, purpose);
    const ownerPath = purpose === "corp"
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
  } catch {
    // Keep raw assets available when ESI is paused or unavailable.
  }
}

export async function refreshCharacterState(
  characterIds: number[],
  options: { force?: boolean } = {},
) {
  const characters = await getCharacters();
  const selectedCorpDirectors = new Map<number, number>();
  const directorsByCorporation = new Map<number, number[]>();
  for (const character of characters) {
    if (
      !characterIds.includes(character.characterId) ||
      !character.corpAuthCompleted ||
      !character.hasDirectorRole ||
      !character.corporationId
    ) continue;
    const directors = directorsByCorporation.get(character.corporationId) ?? [];
    directors.push(character.characterId);
    directorsByCorporation.set(character.corporationId, directors);
  }
  for (const [corporationId, directors] of directorsByCorporation) {
    const offset = corporationDirectorRotation.get(corporationId) ?? 0;
    selectedCorpDirectors.set(corporationId, directors[offset % directors.length]);
    corporationDirectorRotation.set(corporationId, offset + 1);
  }
  const summary: {
    characterId: number;
    assets?: EndpointCache<AssetRecord[] | null>;
    rootContainersById?: Map<number, AssetRecord>;
    jobs?: EndpointCache<IndustryJobRecord[] | null>;
    marketOrders?: EndpointCache<MarketOrderRecord[] | null>;
    corporations?: Array<{
      corporationId: number;
      assets?: EndpointCache<AssetRecord[] | null>;
      rootContainersById?: Map<number, AssetRecord>;
    }>;
  }[] = [];
  for (const characterId of characterIds) {
    const character = await getCharacter(characterId);
    if (!character) continue;
    const cache = getCache(characterCaches, characterId);
    const characterSummary: (typeof summary)[number] = { characterId };
    try {
      if (
        !options.force &&
        cache.allAssetsRaw?.nextRefreshAllowed &&
        Date.parse(cache.allAssetsRaw.nextRefreshAllowed) > Date.now()
      ) {
        characterSummary.assets = {
          ...cache.allAssetsRaw,
          status: endpointDataStatus(cache.allAssetsRaw.lastModified, cache.allAssetsRaw.nextRefreshAllowed),
        };
        if (Array.isArray(cache.allAssetsRaw.lastBody)) {
          const token = await getUsableToken(character, "personal");
          await cacheResolvedAssets(
            cache,
            cache.allAssetsRaw.lastBody as AssetRecord[],
            token,
            undefined,
            cache.allAssetsRaw,
            `/characters/${character.characterId}`,
          );
        }
      } else {
        const previousAssetTiming = cache.allAssetsRaw && {
          lastUpdated: cache.allAssetsRaw.lastUpdated,
          nextRefreshAllowed: cache.allAssetsRaw.nextRefreshAllowed,
        };
        const result = await fetchCharacterAssets(character, cache.allAssetsRaw?.etag);
        if (result.notModified && cache.allAssetsRaw) {
          const assets =
            result.blueprints.length > 0
              ? applyBlueprintMetadata(cache.allAssetsRaw.lastBody as AssetRecord[], result.blueprints)
              : cache.allAssetsRaw.lastBody;
          await cacheResolvedAssets(
            cache,
            assets as AssetRecord[],
            result.token,
            result.headers,
            cache.allAssetsRaw,
            `/characters/${character.characterId}`,
            true,
          );
          cache.allAssetsRaw.status = endpointDataStatus(
            cache.allAssetsRaw.lastModified,
            cache.allAssetsRaw.nextRefreshAllowed,
          );
        } else if (result.assets) {
          await cacheResolvedAssets(
            cache,
            result.assets,
            result.token,
            result.headers,
            cache.allAssetsRaw,
            `/characters/${character.characterId}`,
            result.fromCache,
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
        characterSummary.rootContainersById = cache.rootContainersById;
      }
    } catch (error) {
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
      const jobs = await fetchCharacterIndustryJobs(character);
      cache.jobs = jobs.fromCache && cache.jobs
        ? { ...cache.jobs, status: endpointDataStatus(cache.jobs.lastModified, cache.jobs.nextRefreshAllowed) }
        : setFresh(jobs.jobs, jobs.headers, cache.jobs);
      characterSummary.jobs = cache.jobs;
    } catch (error) {
      cache.jobs = {
        ...(cache.jobs ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.jobs = cache.jobs;
    }
    try {
      const orders = await fetchCharacterMarketOrders(character, cache.marketOrders?.etag);
      if (orders.notModified && cache.marketOrders) {
        cache.marketOrders = setFresh(cache.marketOrders.lastBody, orders.headers, cache.marketOrders, 5 * 60 * 1000, true);
        cache.marketOrders.status = endpointDataStatus(
          cache.marketOrders.lastModified,
          cache.marketOrders.nextRefreshAllowed,
        );
      } else if (orders.notModified) {
        cache.marketOrders = setFresh([], orders.headers);
      } else if (orders.orders) {
        cache.marketOrders = orders.fromCache && cache.marketOrders
          ? { ...cache.marketOrders, status: endpointDataStatus(cache.marketOrders.lastModified, cache.marketOrders.nextRefreshAllowed) }
          : setFresh(orders.orders, orders.headers, cache.marketOrders, 5 * 60 * 1000, orders.fromCache);
      }
      characterSummary.marketOrders = cache.marketOrders;
    } catch (error) {
      cache.marketOrders = {
        ...(cache.marketOrders ?? { lastBody: [] }),
        ...endpointStatus(error),
      };
      characterSummary.marketOrders = {
        ...cache.marketOrders,
      };
    }

    if (
      character.corpAuthCompleted &&
      character.hasDirectorRole &&
      character.corporationId &&
      selectedCorpDirectors.get(character.corporationId) === character.characterId
    ) {
      const corpCache = getCache(corporationCaches, character.corporationId);
      const corpSummary: {
        corporationId: number;
        assets?: EndpointCache<AssetRecord[] | null>;
        rootContainersById?: Map<number, AssetRecord>;
        jobs?: EndpointCache<IndustryJobRecord[] | null>;
        marketOrders?: EndpointCache<MarketOrderRecord[] | null>;
      } = { corporationId: character.corporationId };
      try {
        if (
          !options.force &&
          corpCache.allAssetsRaw?.nextRefreshAllowed &&
          Date.parse(corpCache.allAssetsRaw.nextRefreshAllowed) > Date.now()
        ) {
          corpSummary.assets = {
            ...corpCache.allAssetsRaw,
            status: endpointDataStatus(corpCache.allAssetsRaw.lastModified, corpCache.allAssetsRaw.nextRefreshAllowed),
          };
          if (Array.isArray(corpCache.allAssetsRaw.lastBody)) {
            const token = await getUsableToken(character, "corp");
            await cacheResolvedAssets(
              corpCache,
              corpCache.allAssetsRaw.lastBody as AssetRecord[],
              token,
              undefined,
              corpCache.allAssetsRaw,
              `/corporations/${character.corporationId}`,
            );
          }
        } else {
          const previousAssetTiming = corpCache.allAssetsRaw && {
            lastUpdated: corpCache.allAssetsRaw.lastUpdated,
            nextRefreshAllowed: corpCache.allAssetsRaw.nextRefreshAllowed,
          };
          const result = await fetchCorporationAssets(character, corpCache.allAssetsRaw?.etag);
          if (result.notModified && corpCache.allAssetsRaw) {
            const assets =
              result.blueprints.length > 0
                ? applyBlueprintMetadata(
                    corpCache.allAssetsRaw.lastBody as AssetRecord[],
                    result.blueprints,
                  )
                : corpCache.allAssetsRaw.lastBody;
            await cacheResolvedAssets(
              corpCache,
              assets as AssetRecord[],
              result.token,
              result.headers,
              corpCache.allAssetsRaw,
              `/corporations/${character.corporationId}`,
              true,
            );
            corpCache.allAssetsRaw.status = endpointDataStatus(
              corpCache.allAssetsRaw.lastModified,
              corpCache.allAssetsRaw.nextRefreshAllowed,
            );
          } else if (result.assets) {
            await cacheResolvedAssets(
              corpCache,
              result.assets,
              result.token,
              result.headers,
              corpCache.allAssetsRaw,
              `/corporations/${character.corporationId}`,
              result.fromCache,
            );
          }
          corpSummary.assets = corpCache.allAssetsRaw;
          corpSummary.rootContainersById = corpCache.rootContainersById;
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
      } catch (error) {
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
        const jobs = await fetchCorporationIndustryJobs(character);
        corpCache.jobs = jobs.fromCache && corpCache.jobs
          ? { ...corpCache.jobs, status: endpointDataStatus(corpCache.jobs.lastModified, corpCache.jobs.nextRefreshAllowed) }
          : setFresh(jobs.jobs, jobs.headers, corpCache.jobs, 5 * 60 * 1000, jobs.fromCache);
        corpSummary.jobs = corpCache.jobs;
      } catch (error) {
        corpCache.jobs = {
          ...(corpCache.jobs ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        corpSummary.jobs = {
          ...corpCache.jobs,
        };
      }
      try {
        const orders = await fetchCorporationMarketOrders(character, corpCache.marketOrders?.etag);
        if (orders.notModified && corpCache.marketOrders) {
          corpCache.marketOrders = setFresh(
            corpCache.marketOrders.lastBody,
            orders.headers,
            corpCache.marketOrders,
            20 * 60 * 1000,
            true,
          );
          corpCache.marketOrders.status = endpointDataStatus(
            corpCache.marketOrders.lastModified,
            corpCache.marketOrders.nextRefreshAllowed,
          );
        } else if (orders.notModified) {
          corpCache.marketOrders = setFresh([], orders.headers);
        } else if (orders.orders) {
          corpCache.marketOrders = setFresh(
            orders.orders,
            orders.headers,
            corpCache.marketOrders,
            20 * 60 * 1000,
            orders.fromCache,
          );
        }
        corpSummary.marketOrders = corpCache.marketOrders;
      } catch (error) {
        corpCache.marketOrders = {
          ...(corpCache.marketOrders ?? { lastBody: [] }),
          ...endpointStatus(error),
        };
        corpSummary.marketOrders = {
          ...(corpCache.marketOrders),
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
) {
  const jobs = characterIds.flatMap((id) => {
    const body = getCache(characterCaches, id).jobs?.lastBody;
    return Array.isArray(body) ? (body as IndustryJobRecord[]) : [];
  });
  if (!includeCorporationJobs) return jobs.filter((job) => job.ownerType === "character");
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...jobs,
    ...[...corporationIds].flatMap((id) => {
      const body = getCache(corporationCaches, id).jobs?.lastBody;
      return Array.isArray(body) ? (body as IndustryJobRecord[]) : [];
    }),
  ];
}

/** Returns the stock assets including the root location, excluding container items */
export async function getResolvedAssets(characterIds: number[], includeCorporationAssets: boolean): Promise<AssetRecord[]> {
  const assets = characterIds.flatMap((id) => Array.from(getCache(characterCaches, id).stockAssetsByItemId?.values() ?? []));
  if (!includeCorporationAssets) 
    return [...assets];

  const characters = await getCharacters();
  const corporations = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporations].flatMap((id) => Array.from(getCache(corporationCaches, id).stockAssetsByItemId?.values() ?? [])),
  ];
}

/** Returns ships and every asset contained by a ship, including nested containers. */
export async function getShipAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
): Promise<AssetRecord[]> {
  const assets = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id).shipAssetsByItemId.values(),
  ]);
  if (!includeCorporationAssets) return assets;

  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporationIds].flatMap((id) => [
      ...getCache(corporationCaches, id).shipAssetsByItemId.values(),
    ]),
  ];
}

/** Returns the complete resolved graph, including containers and ships. */
export async function getAllAssetsRaw(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const assets = characterIds.flatMap((id) => getCache(characterCaches, id).allAssetsRaw?.lastBody ?? []);
  if (!includeCorporationAssets) return assets;
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporationIds].flatMap((id) => getCache(corporationCaches, id).allAssetsRaw?.lastBody ?? []),
  ];
}

/** Returns only assets that can be used as parent containers by /state/stock. */
export async function getResolvedContainersById(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const containers = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id).rootContainersById.entries(),
  ]);
  if (!includeCorporationAssets) return new Map(containers);
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  for (const corporationId of corporationIds) {
    for (const entry of getCache(corporationCaches, corporationId).rootContainersById) {
      containers.push(entry);
    }
  }
  return new Map(containers);
}

export async function getResolvedAssetIndex(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const index = new Map<number, AssetRecord>();
  const characters = await getCharacters();
  const corporationIds = includeCorporationAssets
    ? new Set(
        characters
          .filter(
            (character) =>
              characterIds.includes(character.characterId) &&
              character.corpAuthCompleted &&
              character.hasDirectorRole &&
              character.corporationId,
          )
          .map((character) => character.corporationId!),
      )
    : new Set<number>();
  for (const characterId of characterIds) {
    for (const asset of getCache(characterCaches, characterId).stockAssetsByItemId?.values() ?? []) {
      index.set(asset.itemId, asset);
    }
  }
  for (const corporationId of corporationIds) {
    for (const asset of getCache(corporationCaches, corporationId).stockAssetsByItemId?.values() ?? []) {
      index.set(asset.itemId, asset);
    }
  }
  return index;
}

export async function getRootContainersByItemId(
  characterIds: number[],
  includeCorporationAssets: boolean,
): Promise<Map<number, AssetRecord>> {
  const assets = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id).rootContainersById.values(),
  ]);
  if (!includeCorporationAssets) return new Map(assets.map((asset) => [asset.itemId, asset]));
  const characters = await getCharacters();
  const corporations = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets.map((asset) => [asset.itemId, asset]),
    ...[...corporations].flatMap((id) =>
      [...getCache(corporationCaches, id).rootContainersById.values()].map((asset) => [
        asset.itemId,
        asset,
      ]),
    ),
  ]
    .map(([itemId, asset]) => [itemId, asset] as [number, AssetRecord])
    .reduce((map, [itemId, asset]) => {
      map.set(itemId, asset);
      return map;
    }, new Map<number, AssetRecord>());
}

export async function getAssembledStructureRigAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  if (!includeCorporationAssets) return [];
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [...corporationIds].flatMap((id) => [
    ...getCache(corporationCaches, id).assembledStructureRigs.values(),
  ]);
}

export async function getAssembledShipAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const assets = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id).assembledShipsByItemId.values(),
  ]);
  if (!includeCorporationAssets) return assets;
  const characters = await getCharacters();
  const corporationIds = new Set(
    characters
      .filter(
        (character) =>
          characterIds.includes(character.characterId) &&
          character.corpAuthCompleted &&
          character.hasDirectorRole &&
          character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  return [
    ...assets,
    ...[...corporationIds].flatMap((id) => [
      ...getCache(corporationCaches, id).assembledShipsByItemId.values(),
    ]),
  ];
}

export async function getAssetCacheMetadata(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const characterCachesForPlan = characterIds.map((id) => getCache(characterCaches, id));
  const characters = await getCharacters();
  const corporations = includeCorporationAssets
    ? [
        ...new Set(
          characters
            .filter(
              (character) =>
                characterIds.includes(character.characterId) &&
                character.corpAuthCompleted &&
                character.hasDirectorRole &&
                character.corporationId,
            )
            .map((character) => character.corporationId!),
        ),
      ]
    : [];
  const corporationCachesForPlan = corporations.map((id) => getCache(corporationCaches, id));
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
): Promise<PlanStockItem[]> {
  const stock: PlanStockItem[] = [];
  if (options.personalSellOrdersAsStock) {
    for (const characterId of characterIds) {
      const orders = getCache(characterCaches, characterId).marketOrders?.lastBody;
      if (!Array.isArray(orders)) continue;
      for (const order of orders as MarketOrderRecord[]) {
        if (order.isBuyOrder || order.isCorporation || order.volumeRemain <= 0) continue;
        stock.push({
          typeId: order.typeId,
          name: `Type ${order.typeId}`,
          quantity: order.volumeRemain,
          sourceLocationId: order.locationId,
          ownerType: order.ownerType,
          ownerId: order.ownerId,
          locationResolved: true,
          category: "item",
          source: "marketOrder",
        });
      }
    }
  }

  if (!options.allCorporationSellOrdersAsStock && !options.myCorporationSellOrdersAsStock) {
    return stock;
  }
  const characters = await getCharacters();
  const selectedCharacters = characters.filter((character) =>
    characterIds.includes(character.characterId),
  );
  const corporationIds = new Set(
    selectedCharacters
      .filter(
        (character) =>
          character.corpAuthCompleted && character.hasDirectorRole && character.corporationId,
      )
      .map((character) => character.corporationId!),
  );
  for (const corporationId of corporationIds) {
    const orders = getCache(corporationCaches, corporationId).marketOrders?.lastBody;
    if (!Array.isArray(orders)) continue;
    for (const order of orders as MarketOrderRecord[]) {
      if (order.isBuyOrder || order.volumeRemain <= 0) continue;
      const isMyCorporationOrder =
        order.issuedBy !== undefined &&
        selectedCharacters.some(
          (character) =>
            character.characterId === order.issuedBy && character.corporationId === corporationId,
        );
      if (!options.allCorporationSellOrdersAsStock && !isMyCorporationOrder) continue;
      stock.push({
        typeId: order.typeId,
        name: `Type ${order.typeId}`,
        quantity: order.volumeRemain,
        sourceLocationId: order.locationId,
        ownerType: order.ownerType,
        ownerId: order.ownerId,
        locationResolved: true,
        category: "item",
        source: "marketOrder",
      });
    }
  }
  return stock;
}

export async function getStateStatus(characterIds: number[]) {
  const characters = await getCharacters();
  const corporationsByCharacter = new Map<number, number[]>();
  for (const character of characters) {
    if (
      !characterIds.includes(character.characterId) ||
      !character.corporationId ||
      !character.corpAuthCompleted ||
      !character.hasDirectorRole
    )
      continue;
    const corporationIds = corporationsByCharacter.get(character.characterId) ?? [];
    corporationIds.push(character.corporationId);
    corporationsByCharacter.set(character.characterId, corporationIds);
  }
  return {
    characters: characterIds.map((characterId) => ({
      characterId,
      assets: getCache(characterCaches, characterId).allAssetsRaw ?? {
        status: "cached" as const,
        lastBody: null,
      },
      rootContainersById: getCache(characterCaches, characterId).rootContainersById ?? {
        status: "cached" as const,
        lastBody: null,
      },
      jobs: getCache(characterCaches, characterId).jobs ?? {
        status: "cached" as const,
        lastBody: null,
      },
      orders: getCache(characterCaches, characterId).marketOrders ?? {
        status: "cached" as const,
        lastBody: null,
      },
      corporations: (corporationsByCharacter.get(characterId) ?? []).map((corporationId) => ({
        corporationId,
        assets: getCache(corporationCaches, corporationId).allAssetsRaw ?? {
          status: "cached" as const,
          lastBody: null,
        },
        jobs: getCache(corporationCaches, corporationId).jobs ?? {
          status: "cached" as const,
          lastBody: null,
        },
        orders: getCache(corporationCaches, corporationId).marketOrders ?? {
          status: "cached" as const,
          lastBody: null,
        },
      })),
    })),
  };
}
