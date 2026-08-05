import type {
  AssetLocation,
  AssetRecord,
  IndustryJobRecord,
  MarketOrderRecord,
  ResolvedAssetRecord,
} from "@/lib/auth/model";
import type { PlanStockItem } from "@/lib/planning/types";
import {
  getGroups,
  getMarketGroups,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { categorizeType } from "@/lib/reference/category";
import { getCharacter, getCharacters } from "@/lib/auth/tokensStore";
import {
  fetchAssetLocations,
  fetchCharacterAssets,
  fetchLocationMetadata,
  fetchCorporationAssets,
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
  fetchCharacterMarketOrders,
  fetchCorporationMarketOrders,
  applyBlueprintMetadata,
  getUsableToken,
} from "./client";

export type EndpointStatus = "fresh" | "cached" | "rate_limited" | "error";
export type EndpointCache = {
  lastBody: unknown;
  etag?: string;
  lastUpdated?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
  status: EndpointStatus;
};

type OwnerCache = {
  assets?: EndpointCache;
  assetLocations?: EndpointCache;
  jobs?: EndpointCache;
  orders?: EndpointCache;
  resolvedAssets: ResolvedAssetRecord[];
  assetsByItemId: Map<number, ResolvedAssetRecord>;
  assembledContainersByItemId: Map<number, ResolvedAssetRecord>;
  unresolvedAssetCount: number;
};

const characterCaches = new Map<number, OwnerCache>();
const corporationCaches = new Map<number, OwnerCache>();

function getCache(map: Map<number, OwnerCache>, id: number): OwnerCache {
  const existing = map.get(id);
  if (existing) return existing;
  const created: OwnerCache = {
    resolvedAssets: [],
    assetsByItemId: new Map(),
    assembledContainersByItemId: new Map(),
    unresolvedAssetCount: 0,
  };
  map.set(id, created);
  return created;
}

function endpointStatus(
  error: unknown,
): Pick<EndpointCache, "status" | "rateLimitedUntil" | "error"> {
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

function setFresh(body: unknown, headers?: Headers, previous?: EndpointCache): EndpointCache {
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

function indexResolvedAssets(
  cache: OwnerCache,
  assets: ResolvedAssetRecord[],
  assembledContainerIds: Set<number>,
) {
  cache.assetsByItemId = new Map(assets.map((asset) => [asset.itemId, asset]));
  cache.assembledContainersByItemId = new Map(
    assets
      .filter((asset) => assembledContainerIds.has(asset.itemId))
      .map((asset) => [asset.itemId, asset]),
  );
  const cachedContainerIds = new Set(cache.assembledContainersByItemId.keys());
  cache.resolvedAssets = assets.filter((asset) => !cachedContainerIds.has(asset.itemId));
}

async function selectCachedAssets(assets: AssetRecord[]) {
  if (assets.length === 0) {
    return { assets, assembledContainerIds: new Set<number>() };
  }
  const [types, groups, marketGroups] = await Promise.all([
    getTypesByIds([...new Set(assets.map((asset) => asset.typeId))]),
    getGroups(),
    getMarketGroups(),
  ]);
  const selected: AssetRecord[] = [];
  const assembledContainerIds = new Set<number>();
  for (const asset of assets) {
    const type = types.get(asset.typeId);
    const categorized = type
      ? categorizeType(type, "en", marketGroups, groups)
      : { category: "item" as const, marketCategory: undefined };
    const isCargoContainer = categorized.marketCategory === "Cargo Containers" ||
      isCargoContainerType(asset.typeId, types, groups, marketGroups);
    const isAssembledContainer = isCargoContainer && !asset.isSingleton;
    const isStockItem = categorized.category === "item" && !asset.isSingleton;
    const isBlueprintOrReaction = categorized.category === "bpo" || categorized.category === "reaction";
    if (!isAssembledContainer && !isStockItem && !isBlueprintOrReaction) continue;
    selected.push(asset);
    if (isAssembledContainer) assembledContainerIds.add(asset.itemId);
  }
  return { assets: selected, assembledContainerIds };
}

async function cacheResolvedAssets(
  cache: OwnerCache,
  assets: AssetRecord[],
  token: Parameters<typeof fetchAssetLocations>[3],
  headers?: Headers,
  previous?: EndpointCache,
) {
  const selected = await selectCachedAssets(assets);
  cache.assets = setFresh(selected.assets, headers, previous);
  const resolved = await resolveAssets(selected.assets, token);
  indexResolvedAssets(cache, resolved, selected.assembledContainerIds);
  cache.unresolvedAssetCount = [
    ...cache.resolvedAssets,
    ...cache.assembledContainersByItemId.values(),
  ].filter((asset) => !asset.location.resolved).length;
  cache.assetLocations = setFresh(
    [...cache.resolvedAssets, ...cache.assembledContainersByItemId.values()],
    headers,
    cache.assetLocations,
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
  let marketGroup = type?.marketGroupID === undefined ? undefined : marketGroups.get(type.marketGroupID);
  while (marketGroup) {
    if (marketGroup.name.en === "Cargo Containers") return true;
    marketGroup = marketGroup.parentGroupID === undefined
      ? undefined
      : marketGroups.get(marketGroup.parentGroupID);
  }
  return false;
}

function directKind(locationType: AssetRecord["locationType"]): AssetLocation["kind"] | null {
  if (locationType === "station" || locationType === "solar_system" || locationType === "structure")
    return locationType;
  return null;
}

async function resolveAssets(
  assets: AssetRecord[],
  token: Parameters<typeof fetchAssetLocations>[3],
) {
  const byItemId = new Map(assets.map((asset) => [asset.itemId, asset]));
  const locationNames = new Map<number, string>();
  const resolvedItemLocations = new Map<number, AssetLocation>();
  const grouped = new Map<string, number[]>();
  for (const asset of assets) {
    const key = `${asset.ownerType}:${asset.ownerId}`;
    const ids = grouped.get(key) ?? [];
    if (!ids.includes(asset.itemId)) ids.push(asset.itemId);
    grouped.set(key, ids);
  }
  for (const [key, ids] of grouped) {
    const [ownerType, ownerId] = key.split(":");
    const locations = await fetchAssetLocations(
      ownerType as AssetRecord["ownerType"],
      Number(ownerId),
      ids,
      token,
    );
    if (!locations) continue;
    for (const location of locations) {
      locationNames.set(location.item_id, location.name);
      const kind =
        location.location_type === "other" || !location.location_type
          ? "structure"
          : directKind(location.location_type as AssetRecord["locationType"]);
      if (kind && location.location_id) {
        resolvedItemLocations.set(location.item_id, {
          locationId: location.location_id,
          kind,
          name: location.name,
          resolved: false,
        });
      }
    }
  }

  const metadata = new Map<number, AssetLocation>();
  const directLocations = new Map<string, number>();
  for (const asset of assets) {
    const kind = directKind(asset.locationType);
    if (kind) directLocations.set(`${kind}:${asset.locationId}`, asset.locationId);
    if (asset.locationType === "item" && !byItemId.has(asset.locationId)) {
      directLocations.set(`structure:${asset.locationId}`, asset.locationId);
    }
  }
  for (const location of resolvedItemLocations.values()) {
    if (location.kind === "structure") {
      directLocations.set(`${location.kind}:${location.locationId}`, location.locationId);
    }
  }
  await Promise.all(
    [...directLocations].map(async ([key, locationId]) => {
      const kind = key.split(":")[0] as "station" | "solar_system" | "structure";
      try {
        const result = await fetchLocationMetadata(locationId, kind, token);
        if (!result.data) throw new Error("Location response was not modified");
        metadata.set(locationId, {
          locationId,
          kind,
          name: result.data.name,
          typeId: result.data.type_id,
          systemId: kind === "solar_system" ? locationId : result.data.system_id,
          regionId: result.data.region_id,
          resolved: true,
        });
      } catch {
        metadata.set(locationId, {
          locationId,
          kind,
          name: locationNames.get(locationId),
          resolved: false,
        });
      }
    }),
  );

  return assets.map<ResolvedAssetRecord>((asset) => {
    const direct = directKind(asset.locationType);
    if (direct) {
      const location = metadata.get(asset.locationId) ?? {
        locationId: asset.locationId,
        kind: direct,
        name: locationNames.get(asset.locationId),
        resolved: false,
      };
      return {
        ...asset,
        location,
        sourceLocationId: asset.locationId,
        sourceLocationName: location.name,
      };
    }
    const resolvedItemLocation = resolvedItemLocations.get(asset.itemId);
    if (resolvedItemLocation) {
      return {
        ...asset,
        location: resolvedItemLocation,
        sourceLocationId: asset.locationId,
        sourceLocationName: resolvedItemLocation.name,
      };
    }
    const visited = new Set<number>();
    let current: AssetRecord | undefined = asset;
    while (current?.locationType === "item") {
      if (visited.has(current.itemId)) break;
      visited.add(current.itemId);
      const parent = byItemId.get(current.locationId);
      if (!parent) {
        const location = metadata.get(current.locationId) ?? {
          locationId: current.locationId,
          kind: "structure" as const,
          name: locationNames.get(current.itemId),
          resolved: false,
        };
        return {
          ...asset,
          location,
          sourceLocationId: asset.locationId,
          sourceLocationName: location.name,
        };
      }
      current = parent;
    }
    const effectiveKind = current ? directKind(current.locationType) : null;
    const location =
      effectiveKind && current
        ? (metadata.get(current.locationId) ?? {
            locationId: current.locationId,
            kind: effectiveKind,
            name: locationNames.get(current.locationId),
            parentLocationId: asset.locationId,
            resolved: false,
          })
        : {
            locationId: asset.locationId,
            kind: "container" as const,
            name: locationNames.get(asset.locationId),
            parentLocationId: asset.locationId,
            resolved: false,
          };
    return {
      ...asset,
      location,
      sourceLocationId: asset.locationId,
      sourceLocationName: location.name,
    };
  });
}

async function rebuildResolvedAssets(
  cache: OwnerCache,
  record: Awaited<ReturnType<typeof getCharacter>>,
  purpose: "personal" | "corp",
) {
  if (!record || cache.resolvedAssets.length > 0 || !Array.isArray(cache.assets?.lastBody)) return;
  try {
    const token = await getUsableToken(record, purpose);
    await cacheResolvedAssets(cache, cache.assets.lastBody as AssetRecord[], token);
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
    assets?: EndpointCache;
    assetLocations?: EndpointCache;
    jobs?: EndpointCache;
    orders?: EndpointCache;
    corporations?: Array<{
      corporationId: number;
      assets?: EndpointCache;
      assetLocations?: EndpointCache;
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
        cache.assets?.nextRefreshAllowed &&
        Date.parse(cache.assets.nextRefreshAllowed) > Date.now()
      ) {
        characterSummary.assets = { ...cache.assets, status: "cached" };
        if (cache.resolvedAssets.length === 0 && Array.isArray(cache.assets.lastBody)) {
          const token = await getUsableToken(record, "personal");
          await cacheResolvedAssets(cache, cache.assets.lastBody as AssetRecord[], token);
        }
      } else {
        const result = await fetchCharacterAssets(record, cache.assets?.etag);
        if (result.notModified && cache.assets) {
          const assets = result.blueprints.length > 0
            ? applyBlueprintMetadata(cache.assets.lastBody as AssetRecord[], result.blueprints)
            : cache.assets.lastBody;
          await cacheResolvedAssets(cache, assets as AssetRecord[], result.token, result.headers, cache.assets);
          cache.assets.status = "cached";
        } else if (result.assets) {
          await cacheResolvedAssets(cache, result.assets, result.token, result.headers, cache.assets);
        }
        characterSummary.assets = cache.assets;
        characterSummary.assetLocations = cache.assetLocations;
      }
      const jobs = await fetchCharacterIndustryJobs(record);
      cache.jobs = setFresh(jobs.jobs, jobs.headers);
      characterSummary.jobs = cache.jobs;
    } catch (error) {
      await rebuildResolvedAssets(cache, record, "personal");
      characterSummary.assets = {
        ...(cache.assets ?? { lastBody: null }),
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
        assets?: EndpointCache;
        assetLocations?: EndpointCache;
        jobs?: EndpointCache;
        orders?: EndpointCache;
      } = { corporationId: record.corporationId };
      try {
        if (
          !options.force &&
          corpCache.assets?.nextRefreshAllowed &&
          Date.parse(corpCache.assets.nextRefreshAllowed) > Date.now()
        ) {
          corpSummary.assets = { ...corpCache.assets, status: "cached" };
          if (corpCache.resolvedAssets.length === 0 && Array.isArray(corpCache.assets.lastBody)) {
            const token = await getUsableToken(record, "corp");
            await cacheResolvedAssets(corpCache, corpCache.assets.lastBody as AssetRecord[], token);
          }
        } else {
          const result = await fetchCorporationAssets(record, corpCache.assets?.etag);
          if (result.notModified && corpCache.assets) {
            const assets = result.blueprints.length > 0
              ? applyBlueprintMetadata(corpCache.assets.lastBody as AssetRecord[], result.blueprints)
              : corpCache.assets.lastBody;
            await cacheResolvedAssets(corpCache, assets as AssetRecord[], result.token, result.headers, corpCache.assets);
            corpCache.assets.status = "cached";
          } else if (result.assets) {
            await cacheResolvedAssets(corpCache, result.assets, result.token, result.headers, corpCache.assets);
          }
          corpSummary.assets = corpCache.assets;
          corpSummary.assetLocations = corpCache.assetLocations;
        }
      } catch (error) {
        await rebuildResolvedAssets(corpCache, record, "corp");
        corpSummary.assets = {
          ...(corpCache.assets ?? { lastBody: null }),
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

export async function getResolvedAssets(characterIds: number[], includeCorporationAssets: boolean) {
  const assets = characterIds.flatMap((id) => getCache(characterCaches, id).resolvedAssets);
  if (!includeCorporationAssets) return assets;
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
    ...[...corporations].flatMap((id) => getCache(corporationCaches, id).resolvedAssets),
  ];
}

export async function getResolvedAssetIndex(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const index = new Map<number, ResolvedAssetRecord>();
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
    for (const asset of getCache(characterCaches, characterId).assetsByItemId.values()) {
      index.set(asset.itemId, asset);
    }
  }
  for (const corporationId of corporationIds) {
    for (const asset of getCache(corporationCaches, corporationId).assetsByItemId.values()) {
      index.set(asset.itemId, asset);
    }
  }
  return index;
}

export async function getAssembledContainerAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
) {
  const assets = characterIds.flatMap((id) =>
    [...getCache(characterCaches, id).assembledContainersByItemId.values()],
  );
  if (!includeCorporationAssets) return assets;
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
    ...[...corporations].flatMap((id) =>
      [...getCache(corporationCaches, id).assembledContainersByItemId.values()],
    ),
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
        .map((cache) => cache.assets?.lastUpdated)
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
  const selectedCharacters = characters.filter((character) => characterIds.includes(character.characterId));
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
      const isMyCorporationOrder = order.issuedBy !== undefined && selectedCharacters.some(
        (character) => character.characterId === order.issuedBy && character.corporationId === corporationId,
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
    if (!characterIds.includes(character.characterId) || !character.corporationId || !character.corpAuthCompleted || !character.hasDirectorRole) continue;
    const corporationIds = corporationsByCharacter.get(character.characterId) ?? [];
    corporationIds.push(character.corporationId);
    corporationsByCharacter.set(character.characterId, corporationIds);
  }
  return {
    characters: characterIds.map((characterId) => ({
      characterId,
      assets: getCache(characterCaches, characterId).assets ?? {
        status: "cached" as const,
        lastBody: null,
      },
      assetLocations: getCache(characterCaches, characterId).assetLocations ?? {
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
        assets: getCache(corporationCaches, corporationId).assets ?? {
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
