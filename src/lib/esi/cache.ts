import type {
  AssetLocation,
  AssetRecord,
  IndustryJobRecord,
  ResolvedAssetRecord,
} from "@/lib/auth/model";
import { getCharacter, getCharacters } from "@/lib/auth/tokensStore";
import {
  fetchAssetLocations,
  fetchCharacterAssets,
  fetchLocationMetadata,
  fetchCorporationAssets,
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
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
  resolvedAssets: ResolvedAssetRecord[];
  unresolvedAssetCount: number;
};

const characterCaches = new Map<number, OwnerCache>();
const corporationCaches = new Map<number, OwnerCache>();

function getCache(map: Map<number, OwnerCache>, id: number): OwnerCache {
  const existing = map.get(id);
  if (existing) return existing;
  const created: OwnerCache = { resolvedAssets: [], unresolvedAssetCount: 0 };
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
    cache.resolvedAssets = await resolveAssets(cache.assets.lastBody as AssetRecord[], token);
    cache.unresolvedAssetCount = cache.resolvedAssets.filter(
      (asset) => !asset.location.resolved,
    ).length;
    cache.assetLocations = setFresh(cache.resolvedAssets);
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
    let personalToken = record.personalAuth;
    try {
      if (
        !options.force &&
        cache.assets?.nextRefreshAllowed &&
        Date.parse(cache.assets.nextRefreshAllowed) > Date.now()
      ) {
        characterSummary.assets = { ...cache.assets, status: "cached" };
        if (cache.resolvedAssets.length === 0 && Array.isArray(cache.assets.lastBody)) {
          const token = await getUsableToken(record, "personal");
          cache.resolvedAssets = await resolveAssets(cache.assets.lastBody as AssetRecord[], token);
          cache.unresolvedAssetCount = cache.resolvedAssets.filter(
            (asset) => !asset.location.resolved,
          ).length;
          cache.assetLocations = setFresh(cache.resolvedAssets);
        }
      } else {
        const result = await fetchCharacterAssets(record, cache.assets?.etag);
        personalToken = result.token;
        if (result.notModified && cache.assets) {
          const assets = result.blueprints.length > 0
            ? applyBlueprintMetadata(cache.assets.lastBody as AssetRecord[], result.blueprints)
            : cache.assets.lastBody;
          cache.assets = setFresh(assets, result.headers, cache.assets);
          cache.assets.status = "cached";
          cache.resolvedAssets = await resolveAssets(assets as AssetRecord[], result.token);
          cache.unresolvedAssetCount = cache.resolvedAssets.filter(
            (asset) => !asset.location.resolved,
          ).length;
          cache.assetLocations = setFresh(cache.resolvedAssets, result.headers, cache.assetLocations);
        } else if (result.assets) {
          cache.assets = setFresh(result.assets, result.headers, cache.assets);
          cache.resolvedAssets = await resolveAssets(result.assets, result.token);
          cache.unresolvedAssetCount = cache.resolvedAssets.filter(
            (asset) => !asset.location.resolved,
          ).length;
          cache.assetLocations = setFresh(cache.resolvedAssets);
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

    if (record.corpAuthCompleted && record.hasDirectorRole && record.corporationId) {
      const corpCache = getCache(corporationCaches, record.corporationId);
      const corpSummary: {
        corporationId: number;
        assets?: EndpointCache;
        assetLocations?: EndpointCache;
        jobs?: EndpointCache;
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
            corpCache.resolvedAssets = await resolveAssets(
              corpCache.assets.lastBody as AssetRecord[],
              token,
            );
            corpCache.unresolvedAssetCount = corpCache.resolvedAssets.filter(
              (asset) => !asset.location.resolved,
            ).length;
            corpCache.assetLocations = setFresh(corpCache.resolvedAssets);
          }
        } else {
          const result = await fetchCorporationAssets(record, corpCache.assets?.etag);
          if (result.notModified && corpCache.assets) {
            const assets = result.blueprints.length > 0
              ? applyBlueprintMetadata(corpCache.assets.lastBody as AssetRecord[], result.blueprints)
              : corpCache.assets.lastBody;
            corpCache.assets = setFresh(
              assets,
              result.headers,
              corpCache.assets,
            );
            corpCache.assets.status = "cached";
            corpCache.resolvedAssets = await resolveAssets(assets as AssetRecord[], result.token);
            corpCache.unresolvedAssetCount = corpCache.resolvedAssets.filter(
              (asset) => !asset.location.resolved,
            ).length;
            corpCache.assetLocations = setFresh(
              corpCache.resolvedAssets,
              result.headers,
              corpCache.assetLocations,
            );
          } else if (result.assets) {
            corpCache.assets = setFresh(result.assets, result.headers, corpCache.assets);
            corpCache.resolvedAssets = await resolveAssets(result.assets, result.token);
            corpCache.unresolvedAssetCount = corpCache.resolvedAssets.filter(
              (asset) => !asset.location.resolved,
            ).length;
            corpCache.assetLocations = setFresh(corpCache.resolvedAssets);
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

export function getStateStatus(characterIds: number[]) {
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
    })),
  };
}
