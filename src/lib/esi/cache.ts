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
  getTypesByIds,
  getShipTypeIds,
} from "@/cache/services/sdeCache";
import { getCharacter, getCharacters } from "@/lib/auth/tokensStore";
import {
  fetchCharacterAssets,
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

export type EndpointStatus = "fresh" | "cached" | "rate_limited" | "error";
export type EndpointCache<T> = {
  lastBody: T;
  etag?: string;
  lastUpdated?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
  status: EndpointStatus;
};

type OwnerCache = {
  allAssetsRaw?: EndpointCache<AssetRecord[]>;
  stockAssetsByItemId?: Map<number, AssetRecord>;
  rootContainersById: Map<number, AssetRecord>;
  assembledShipsByItemId: Map<number, AssetRecord>;
  assembledStructureRigs: AssetRecord[];
  jobs?: EndpointCache<IndustryJobRecord[]>;
  orders?: EndpointCache<MarketOrderRecord[]>;
  unresolvedAssetCount: number;
};

const characterCaches = new Map<number, OwnerCache>();
const corporationCaches = new Map<number, OwnerCache>();

function getCache(map: Map<number, OwnerCache>, id: number): OwnerCache {
  const existing = map.get(id);
  if (existing) return existing;
  const created: OwnerCache = {
    assembledStructureRigs: [],
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
    return {
      status: "error",
      error: error instanceof Error ? error.message : "ESI request failed",
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

function setFresh<T>(body: T, headers?: Headers, previous?: EndpointCache<T>): EndpointCache<T> {
  const maxAge = Number(
    (headers?.get("cache-control") ?? "").match(/max-age=(\d+)/i)?.[1] ?? "300",
  );
  const now = new Date();
  return {
    lastBody: body,
    etag: headers?.get("etag") ?? previous?.etag,
    lastUpdated: now.toISOString(),
    nextRefreshAllowed: new Date(now.getTime() + maxAge * 1000).toISOString(),
    status: "fresh",
  };
}

async function indexAssetsByPurpose(rawAssets: AssetRecord[]) {
  if (rawAssets.length === 0) {
    return {
      stockAssetsByItemId: new Map<number, AssetRecord>(),
      stockLocationItemsByItemId: new Map<number, AssetRecord>(),
      installedStructureRigs: [] as AssetRecord[],
      assembledShipsByItemId: new Map<number, AssetRecord>(),
    };
  }
  const [shipTypeIds] = await Promise.all([
    getShipTypeIds(),
  ]);

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
      !stockLocationIds.has(asset.itemId)
      && !assembledShipsByItemId.has(asset.itemId)
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
) {
  const assetIndexes = await indexAssetsByPurpose(rawAssets);

  const containerRootsById = await resolveContainerRoots(assetIndexes.stockLocationItemsByItemId, token);
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

  cache.allAssetsRaw = setFresh(rawAssets, headers, previous);
  cache.stockAssetsByItemId = resolvedByItemId;
  cache.rootContainersById = containerRootsById;
  cache.assembledShipsByItemId = assetIndexes.assembledShipsByItemId;
  cache.assembledStructureRigs = assetIndexes.installedStructureRigs;


  cache.unresolvedAssetCount = [
    ...resolvedByItemId.values(),
    ...cache.assembledStructureRigs,
    ...cache.assembledShipsByItemId.values(),
  ].filter((asset) => !asset.rootLocation).length;
}

function needsAssetLocationResolution(cache: OwnerCache) {
  return cache.unresolvedAssetCount > 0;
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

async function resolveContainerRoots(containerItemsByItemId: Map<number, AssetRecord>, token: TokenSet) {
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
    await cacheResolvedAssets(cache, cache.allAssetsRaw.lastBody as AssetRecord[], token);
  } catch {
    // Keep raw assets available when ESI is paused or unavailable.
  }
}

export async function refreshCharacterState(
  characterIds: number[],
  options: { force?: boolean } = {},
) {
  const summary: {
    characterId: number;
    assets?: EndpointCache<AssetRecord[] | null>;
    rootContainersById?: Map<number, AssetRecord>;
    jobs?: EndpointCache<IndustryJobRecord[] | null>;
    orders?: EndpointCache<MarketOrderRecord[] | null>;
    corporations?: Array<{
      corporationId: number;
      assets?: EndpointCache<AssetRecord[] | null>;
      rootContainersById?: Map<number, AssetRecord>;
    }>;
  }[] = [];
  for (const characterId of characterIds) {
    const record = await getCharacter(characterId);
    if (!record) continue;
    const cache = getCache(characterCaches, characterId);
    const characterSummary: (typeof summary)[number] = { characterId };
    try {
      if (
        !options.force &&
        cache.allAssetsRaw?.nextRefreshAllowed &&
        Date.parse(cache.allAssetsRaw.nextRefreshAllowed) > Date.now()
      ) {
        characterSummary.assets = { ...cache.allAssetsRaw, status: "cached" };
        if (
          (needsAssetLocationResolution(cache) || needsCompleteAssetGraph(cache)) &&
          Array.isArray(cache.allAssetsRaw.lastBody)
        ) {
          const token = await getUsableToken(record, "personal");
          await cacheResolvedAssets(cache, cache.allAssetsRaw.lastBody as AssetRecord[], token);
        }
      } else {
        const result = await fetchCharacterAssets(record, cache.allAssetsRaw?.etag);
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
          );
          cache.allAssetsRaw.status = "cached";
        } else if (result.assets) {
          await cacheResolvedAssets(
            cache,
            result.assets,
            result.token,
            result.headers,
            cache.allAssetsRaw,
          );
        }
        characterSummary.assets = cache.allAssetsRaw;
        characterSummary.rootContainersById = cache.rootContainersById;
      }
      const jobs = await fetchCharacterIndustryJobs(record);
      cache.jobs = setFresh(jobs.jobs, jobs.headers);
      characterSummary.jobs = cache.jobs;
    } catch (error) {
      await rebuildResolvedAssets(cache, record, "personal");
      characterSummary.assets = {
        ...(cache.allAssetsRaw ?? { lastBody: null }),
        ...endpointStatus(error),
      };
    }
    try {
      const orders = await fetchCharacterMarketOrders(record, cache.orders?.etag);
      if (orders.notModified && cache.orders) {
        cache.orders = setFresh(cache.orders.lastBody, orders.headers, cache.orders);
        cache.orders.status = "cached";
      } else if (orders.orders) {
        cache.orders = setFresh(orders.orders, orders.headers, cache.orders);
      }
      characterSummary.orders = cache.orders;
    } catch (error) {
      characterSummary.orders = {
        ...(cache.orders ?? { lastBody: null }),
        ...endpointStatus(error),
      };
    }

    if (record.corpAuthCompleted && record.hasDirectorRole && record.corporationId) {
      const corpCache = getCache(corporationCaches, record.corporationId);
      const corpSummary: {
        corporationId: number;
        assets?: EndpointCache<AssetRecord[] | null>;
        rootContainersById?: Map<number, AssetRecord>;
        jobs?: EndpointCache<IndustryJobRecord[] | null>;
        orders?: EndpointCache<MarketOrderRecord[] | null>;
      } = { corporationId: record.corporationId };
      try {
        if (
          !options.force &&
          corpCache.allAssetsRaw?.nextRefreshAllowed &&
          Date.parse(corpCache.allAssetsRaw.nextRefreshAllowed) > Date.now()
        ) {
          corpSummary.assets = { ...corpCache.allAssetsRaw, status: "cached" };
          if (
            (needsAssetLocationResolution(corpCache) || needsCompleteAssetGraph(corpCache)) &&
            Array.isArray(corpCache.allAssetsRaw.lastBody)
          ) {
            const token = await getUsableToken(record, "corp");
            await cacheResolvedAssets(corpCache, corpCache.allAssetsRaw.lastBody as AssetRecord[], token);
          }
        } else {
          const result = await fetchCorporationAssets(record, corpCache.allAssetsRaw?.etag);
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
            );
            corpCache.allAssetsRaw.status = "cached";
          } else if (result.assets) {
            await cacheResolvedAssets(
              corpCache,
              result.assets,
              result.token,
              result.headers,
              corpCache.allAssetsRaw,
            );
          }
          corpSummary.assets = corpCache.allAssetsRaw;
          corpSummary.rootContainersById = corpCache.rootContainersById;
        }
      } catch (error) {
        await rebuildResolvedAssets(corpCache, record, "corp");
        corpSummary.assets = {
          ...(corpCache.allAssetsRaw ?? { lastBody: null }),
          ...endpointStatus(error),
        };
      }
      try {
        const jobs = await fetchCorporationIndustryJobs(record);
        corpCache.jobs = setFresh(jobs.jobs, jobs.headers);
        corpSummary.jobs = corpCache.jobs;
      } catch (error) {
        corpSummary.jobs = {
          ...(corpCache.jobs ?? { lastBody: null }),
          ...endpointStatus(error),
        };
      }
      try {
        const orders = await fetchCorporationMarketOrders(record, corpCache.orders?.etag);
        if (orders.notModified && corpCache.orders) {
          corpCache.orders = setFresh(corpCache.orders.lastBody, orders.headers, corpCache.orders);
          corpCache.orders.status = "cached";
        } else if (orders.orders) {
          corpCache.orders = setFresh(orders.orders, orders.headers, corpCache.orders);
        }
        corpSummary.orders = corpCache.orders;
      } catch (error) {
        corpSummary.orders = {
          ...(corpCache.orders ?? { lastBody: null }),
          ...endpointStatus(error),
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
    ...getCache(corporationCaches, id).assembledShipsByItemId.values(),
  ]);
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
      const orders = getCache(characterCaches, characterId).orders?.lastBody;
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
    const orders = getCache(corporationCaches, corporationId).orders?.lastBody;
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
      orders: getCache(characterCaches, characterId).orders ?? {
        status: "cached" as const,
        lastBody: null,
      },
      corporations: (corporationsByCharacter.get(characterId) ?? []).map((corporationId) => ({
        corporationId,
        assets: getCache(corporationCaches, corporationId).allAssetsRaw ?? {
          status: "cached" as const,
          lastBody: null,
        },
        orders: getCache(corporationCaches, corporationId).orders ?? {
          status: "cached" as const,
          lastBody: null,
        },
      })),
    })),
  };
}
