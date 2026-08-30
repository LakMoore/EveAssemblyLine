import { getSdeBuildNumber, getStations, getSystems } from "@/cache/services/sdeCache";
import type { AssetLocation } from "@/lib/auth/model";
import { fetchUniverseNames } from "@/lib/esi/client";
import { getRootLocationsByItemId } from "@/lib/esi/cache";
import type { FacilitySettingsEntry } from "@/lib/planning/facilities";
import type { SdeLanguage } from "@/lib/reference/languages";
import type { MarketStation } from "./signals";

export type ResolvedMarketStation = MarketStation & { systemName: string };
export type MarketStationSearchOption = {
  stationId: number;
  name: string;
  systemName: string;
  kind: "station" | "structure";
};

const stationCache = new Map<string, ResolvedMarketStation>();
const stationSearchIndexes = new Map<string, Promise<MarketStationSearchOption[]>>();
const stationCacheSeconds = 60 * 60 * 24 * 365;

/** Filters station names by every whitespace-separated query term and ranks prefix matches first. */
export function filterMarketStationOptions(
  options: MarketStationSearchOption[],
  query: string,
  limit = 20,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return [];
  return options
    .filter((option) => {
      const normalizedName = option.name.toLocaleLowerCase();
      return queryTerms.every((term) => normalizedName.includes(term));
    })
    .sort((left, right) => {
      const leftName = left.name.toLocaleLowerCase();
      const rightName = right.name.toLocaleLowerCase();
      const leftStarts = leftName.startsWith(normalizedQuery) ? 0 : 1;
      const rightStarts = rightName.startsWith(normalizedQuery) ? 0 : 1;
      return leftStarts - rightStarts || leftName.localeCompare(rightName);
    })
    .slice(0, limit);
}

/** Builds search options only from structure locations resolved while processing owned assets. */
export function getResolvedStructureSearchOptions(
  rootLocations: ReadonlyMap<number, AssetLocation>,
  systemNamesById: ReadonlyMap<number, string>,
): MarketStationSearchOption[] {
  return [...rootLocations.values()].flatMap((location) => {
    if (
      location.kind !== "structure"
      || !location.resolved
      || !location.name
      || !location.systemId
    ) return [];
    const systemName = systemNamesById.get(location.systemId);
    if (!systemName) return [];
    return [{ stationId: location.locationId, name: location.name, systemName, kind: "structure" }];
  });
}

/** Merges live asset roots with persisted facilities that retain resolved structure metadata. */
export async function getKnownMarketStructureLocations(
  characterIds: number[],
  sessionId: string,
  facilities: Iterable<FacilitySettingsEntry>,
): Promise<Map<number, AssetLocation>> {
  const [rootLocations, npcStations] = await Promise.all([
    characterIds.length > 0
      ? getRootLocationsByItemId(characterIds, true, sessionId)
      : Promise.resolve(new Map<number, AssetLocation>()),
    getStations(),
  ]);
  const structures = new Map<number, AssetLocation>();
  for (const facility of facilities) {
    if (facility.locationId === undefined || npcStations.has(facility.locationId)) continue;
    structures.set(
      facility.locationId,
      {
        locationId: facility.locationId,
        kind: "structure",
        name: facility.name,
        typeId: facility.typeId,
        systemId: facility.systemId,
        resolved: true,
      },
    );
  }
  for (const location of rootLocations.values()) {
    if (location.kind === "structure" && location.resolved) {
      structures.set(location.locationId, location);
    }
  }
  return structures;
}

/** Builds one process-local searchable NPC station index using batched ESI name resolution. */
async function getMarketStationSearchIndex(language: SdeLanguage) {
  const sdeBuildNumber = await getSdeBuildNumber();
  const cacheKey = `${sdeBuildNumber}:${language}`;
  const cached = stationSearchIndexes.get(cacheKey);
  if (cached) return cached;
  const pending = Promise.all([getStations(), getSystems()]).then(async ([stations, systems]) => {
    const names = await fetchUniverseNames([...stations.keys()]);
    return [...stations.values()].flatMap((station) => {
      const name = names.get(station._key);
      const system = systems.get(station.solarSystemID);
      if (!name || !system) return [];
      return [
        {
          stationId: station._key,
          name,
          systemName: system.name[language],
          kind: "station" as const,
        },
      ];
    });
  });
  stationSearchIndexes.set(cacheKey, pending);
  try {
    return await pending;
  }
  catch (error) {
    stationSearchIndexes.delete(cacheKey);
    throw error;
  }
}

/** Finds NPC stations and previously resolved asset structures matching a partial-name query. */
export async function searchMarketStations(
  query: string,
  language: SdeLanguage,
  characterIds: number[] = [],
  sessionId = "default",
  facilities: Iterable<FacilitySettingsEntry> = [],
) {
  const [stations, systems, rootLocations] = await Promise.all([
    getMarketStationSearchIndex(language),
    getSystems(),
    characterIds.length > 0
      ? getKnownMarketStructureLocations(characterIds, sessionId, facilities)
      : Promise.resolve(new Map<number, AssetLocation>()),
  ]);
  const systemNamesById = new Map(
    [...systems.values()].map((system) => [system._key, system.name[language]]),
  );
  const structures = getResolvedStructureSearchOptions(rootLocations, systemNamesById);
  return filterMarketStationOptions([...stations, ...structures], query);
}

/** Resolves validated NPC station metadata from the SDE and public ESI. */
export async function resolveMarketStations(
  stationIds: number[],
  language: SdeLanguage,
  rootLocations: ReadonlyMap<number, AssetLocation> = new Map(),
): Promise<ResolvedMarketStation[]> {
  const [sdeBuildNumber, stations, systems] = await Promise.all([
    getSdeBuildNumber(),
    getStations(),
    getSystems(),
  ]);
  return Promise.all(
    [...new Set(stationIds)].map(async (stationId) => {
      const station = stations.get(stationId);
      if (!station) {
        const structure = rootLocations.get(stationId);
        if (
          structure?.kind !== "structure"
          || !structure.resolved
          || !structure.name
          || !structure.systemId
        ) throw new Error(`Market location ${stationId} is unavailable.`);
        const structureSystem = systems.get(structure.systemId);
        if (!structureSystem) {
          throw new Error(`Structure ${stationId} has no known solar system.`);
        }
        return {
          stationId,
          name: structure.name,
          systemId: structure.systemId,
          systemName: structureSystem.name[language],
          regionId: structure.regionId ?? structureSystem.regionID,
        };
      }
      const cacheKey = `${sdeBuildNumber}:${stationId}:${language}`;
      const cached = stationCache.get(cacheKey);
      if (cached) return cached;
      const system = systems.get(station.solarSystemID);
      if (!system) throw new Error(`Station ${stationId} has no known solar system.`);
      const response = await fetch(
        `https://esi.evetech.net/latest/universe/stations/${stationId}/?datasource=tranquility&language=${language}&sde_build=${sdeBuildNumber}`,
        { next: { revalidate: stationCacheSeconds } },
      );
      if (!response.ok) throw new Error(`Station ${stationId} metadata request failed.`);
      const data = (await response.json()) as { name?: unknown };
      if (typeof data.name !== "string" || data.name.trim().length === 0) {
        throw new Error(`Station ${stationId} metadata did not include a name.`);
      }
      const resolved: ResolvedMarketStation = {
        stationId,
        name: data.name.trim(),
        systemId: station.solarSystemID,
        systemName: system.name[language],
        regionId: system.regionID,
      };
      stationCache.set(cacheKey, resolved);
      return resolved;
    }),
  );
}
