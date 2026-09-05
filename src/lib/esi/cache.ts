import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  CharacterLocationRecord,
  CharacterShipRecord,
  CharacterSkillRecord,
  CharacterTokenRecord,
  CorporationCollectionSettings,
  CorporationHangarFlag,
  IndustryJobRecord,
  MarketOrderRecord,
  TokenSet,
} from "@/lib/auth/model";
import type {
  EsiCharacterClones,
  EsiCorporationDivision,
  EsiCorporationPublicInfo,
  EsiCorporationStructure,
} from "./client";
import type { PlanStockItem } from "@/lib/planning/types";
import {
  getGroups,
  getMarketGroups,
  getTypes,
  getTypesByIds,
  getShipTypeIds,
  getHaulerShipTypeIds,
  getBlueprintById,
  getSystems,
} from "@/cache/services/sdeCache";
import {
  clearCharacterCorporationAuthorization,
  getCharacter,
  updateCharacterCorporationAuthorization,
} from "@/lib/auth/tokensStore";
import {
  fetchCharacterAssets,
  fetchAssetNames,
  fetchCharacterLocation,
  fetchCharacterShip,
  fetchCorporationAssets,
  fetchCharacterBlueprints,
  fetchCorporationBlueprints,
  fetchCharacterIndustryJobs,
  fetchCorporationIndustryJobs,
  fetchCharacterMarketOrders,
  fetchCharacterClones,
  fetchCharacterSkills,
  fetchCharacterCorporationAuthorization,
  fetchCorporationMarketOrders,
  fetchCorporationStructures,
  fetchCorporationPublicInfo,
  fetchCorporationDivisions,
  fetchUniverseNames,
  fetchSolarSystemMetadata,
  fetchStationMetadata,
  fetchStructureMetadataPerCharacter,
  getUsableToken,
} from "./client";
import { getStation } from "@/cache/services/sdeCache";
import {
  corporationHangarFlagForDivision,
  corporationHangarNumber,
  getCorporationHangarPermissions,
  isCorporationHangarFlag,
} from "./corporationAccess";

export type EndpointStatus = "fresh" | "cached" | "stale" | "rate_limited" | "error";
export type EndpointCache<T> = {
  lastBody: T;
  etag?: string;
  lastModified?: string;
  lastUpdated?: string;
  expires?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
  status: EndpointStatus;
};

/** Identifies the owner and endpoint that reported a location ID. */
export type StructureLocationSource = {
  ownerType: AssetRecord["ownerType"];
  ownerId: number;
  recordType: "asset" | "blueprint" | "job" | "order";
};

export function toClientEndpointStatus<T>(cache: EndpointCache<T> | undefined) {
  if (!cache) return undefined;
  const { lastBody, ...status } = cache;
  return {
    ...status,
    hasBody: lastBody !== null && lastBody !== undefined,
  };
}

type OwnerCache = {
  allAssetsRaw?: EndpointCache<AssetRecord[]>;
  assetItemIds: Set<number>;
  blueprintInstances?: EndpointCache<BlueprintInstanceRecord[]>;
  currentLocation?: EndpointCache<CharacterLocationRecord | null>;
  currentShip?: EndpointCache<CharacterShipRecord | null>;
  clones?: EndpointCache<EsiCharacterClones | null>;
  stockAssetsByItemId?: Map<number, AssetRecord>;
  rootLocationsByItemId: Map<number, AssetLocation>;
  shipAssetsByItemId: Map<number, AssetRecord>;
  assembledShipsByItemId: Map<number, AssetRecord>;
  assembledStructureRigs: AssetRecord[];
  jobAssetDeductions: Map<string, number>;
  jobBlueprintAdjustments: Map<number, { consumedRuns: number; inUse: boolean }>;
  marketOrderAssetDeductions: Map<string, number>;
  jobs?: EndpointCache<IndustryJobRecord[]>;
  skills?: EndpointCache<CharacterSkillRecord[]>;
  marketOrders?: EndpointCache<MarketOrderRecord[]>;
  structures?: EndpointCache<EsiCorporationStructure[]>;
  publicInfo?: EndpointCache<EsiCorporationPublicInfo | null>;
  divisions?: EndpointCache<EsiCorporationDivision[] | null>;
  unresolvedAssetCount: number;
};

export type CorporationSourcePolicy = CorporationCollectionSettings & {
  headquartersId?: number;
};

export type CorporationSourceContainer = {
  itemId: number;
  name?: string;
  locationId: number;
  rootLocationId: number;
  selected: boolean;
};

export type CorporationSourceLocation = AssetLocation & {
  systemName?: string;
};

export type CorporationSourceCatalogEntry = {
  corporationId: number;
  rootLocationId: number;
  locationFlag: CorporationHangarFlag;
  label: string;
  rootLocation?: CorporationSourceLocation;
  canTake: boolean;
  canQuery: boolean;
  selected: boolean;
  containers: CorporationSourceContainer[];
};

type CorporationPolicyCharacter = Pick<
  CharacterTokenRecord,
  "corporationId" | "corporationRoles" | "rolesAtHq" | "rolesAtOther" | "hasDirectorRole"
>;

const characterCaches = new Map<string, OwnerCache>();
const corporationCaches = new Map<string, OwnerCache>();

async function getCharactersByIds(characterIds: readonly number[]) {
  return (await Promise.all(characterIds.map((characterId) => getCharacter(characterId)))).filter(
    (character) => character !== null,
  );
}

/** Resolves the opted-in corporations that are attached to the current collection. */
export async function getCorporationSourcePolicies(
  characterIds: readonly number[],
  settings: readonly CorporationCollectionSettings[],
  sessionId = "default",
): Promise<CorporationSourcePolicy[]> {
  const characters = await getCharactersByIds(characterIds);
  const attachedCorporations = new Set(
    characters
      .filter((character) => character.corporationId !== undefined)
      .map((character) => character.corporationId!),
  );
  return settings
    .filter((entry) => entry.supportEnabled && attachedCorporations.has(entry.corporationId))
    .map((entry) => ({
      ...entry,
      directHangars: [...entry.directHangars],
      containerItemIds: [...entry.containerItemIds],
      headquartersId: getCache(corporationCaches, entry.corporationId, sessionId).publicInfo
        ?.lastBody?.home_station_id,
    }));
}

function corporationSourceRoot(
  locationId: number,
  locationFlag: string,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  const visited = new Set<number>();
  let sourceLocationFlag = isCorporationHangarFlag(locationFlag) ? locationFlag : undefined;
  let current = rawAssetsByItemId.get(locationId);
  while (current && !visited.has(current.itemId)) {
    visited.add(current.itemId);
    if (isCorporationHangarFlag(current.locationFlag)) {
      sourceLocationFlag = current.locationFlag;
    }
    if (!rawAssetsByItemId.has(current.locationId)) {
      return {
        rootLocationId: current.locationId,
        locationFlag: sourceLocationFlag,
      };
    }
    current = rawAssetsByItemId.get(current.locationId);
  }
  return isCorporationHangarFlag(locationFlag)
    ? { rootLocationId: locationId, locationFlag: sourceLocationFlag }
    : undefined;
}

function isDescendantOfContainer(
  asset: Pick<AssetRecord, "itemId" | "locationId">,
  containerItemId: number,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  const visited = new Set<number>();
  let locationId = asset.itemId === containerItemId ? containerItemId : asset.locationId;
  while (!visited.has(locationId)) {
    if (locationId === containerItemId) return true;
    visited.add(locationId);
    const parent = rawAssetsByItemId.get(locationId);
    if (!parent) return false;
    locationId = parent.locationId;
  }
  return false;
}

function sourceIsSelected(
  source: { rootLocationId: number; locationFlag: CorporationHangarFlag },
  locationId: number,
  locationFlag: string,
  itemId: number | undefined,
  policy: CorporationSourcePolicy,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  const directSelected = policy.directHangars.some(
    (entry) =>
      entry.rootLocationId === source.rootLocationId && entry.locationFlag === source.locationFlag,
  );
  const parent = rawAssetsByItemId.get(locationId);
  if (
    directSelected
    && (
      locationId === source.rootLocationId
      || (locationFlag === source.locationFlag && parent?.locationFlag === "OfficeFolder")
    )
  ) return true;
  return (
    itemId !== undefined
    && policy.containerItemIds.some((containerItemId) =>
      isDescendantOfContainer({ itemId, locationId }, containerItemId, rawAssetsByItemId),
    )
  );
}

function isAssetLocation(value: AssetRecord | AssetLocation | undefined): value is AssetLocation {
  return value !== undefined && "kind" in value;
}

function selectedContainerSource(
  record: { itemId?: number; locationId: number },
  policy: CorporationSourcePolicy,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  for (const containerItemId of policy.containerItemIds) {
    if (
      record.itemId === undefined
      || !isDescendantOfContainer(
        { itemId: record.itemId, locationId: record.locationId },
        containerItemId,
        rawAssetsByItemId,
      )
    ) continue;
    const container = rawAssetsByItemId.get(containerItemId);
    if (!container) continue;
    const source = corporationSourceRoot(
      container.locationId,
      container.locationFlag,
      rawAssetsByItemId,
    );
    if (source?.locationFlag) return source;
  }
  return undefined;
}

/** Returns whether a corporation-owned record is visible under a collection source policy. */
export function isCorporationRecordAllowed(
  record: {
    itemId?: number;
    locationId: number;
    locationFlag: string;
    typeId?: number;
  },
  policy: CorporationSourcePolicy,
  characters: readonly CorporationPolicyCharacter[],
  blueprintItemIds: ReadonlySet<number>,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  const source =
    selectedContainerSource(record, policy, rawAssetsByItemId)
    ?? corporationSourceRoot(record.locationId, record.locationFlag, rawAssetsByItemId);
  if (!source?.locationFlag) return false;
  const permission = getCorporationHangarPermissions(
    characters,
    policy.corporationId,
    source.rootLocationId,
    policy.headquartersId ?? -1,
  ).get(source.locationFlag);
  if (!permission?.canQuery) return false;
  if (
    !sourceIsSelected(
      { rootLocationId: source.rootLocationId, locationFlag: source.locationFlag },
      record.locationId,
      record.locationFlag,
      record.itemId,
      policy,
      rawAssetsByItemId,
    )
  ) return false;
  return permission.canTake || (record.itemId !== undefined && blueprintItemIds.has(record.itemId));
}

/** Returns whether a corporation record is accessible without applying source selection. */
export function isCorporationRecordAccessible(
  record: {
    itemId?: number;
    locationId: number;
    locationFlag: string;
    typeId?: number;
  },
  policy: CorporationSourcePolicy,
  characters: readonly CorporationPolicyCharacter[],
  blueprintItemIds: ReadonlySet<number>,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  const source = corporationSourceRoot(record.locationId, record.locationFlag, rawAssetsByItemId);
  if (!source?.locationFlag) return false;
  const permission = getCorporationHangarPermissions(
    characters,
    policy.corporationId,
    source.rootLocationId,
    policy.headquartersId ?? -1,
  ).get(source.locationFlag);
  return Boolean(
    permission?.canQuery
      && (
        permission.canTake
        || (record.itemId !== undefined && blueprintItemIds.has(record.itemId))
      ),
  );
}

/** Identifies a corporation asset's hangar and all ancestor container IDs for client filtering. */
export function getCorporationAssetSource(
  record: Pick<AssetRecord, "itemId" | "locationId" | "locationFlag">,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  const source = corporationSourceRoot(record.locationId, record.locationFlag, rawAssetsByItemId);
  if (!source?.locationFlag) return undefined;
  const containerItemIds: number[] = [];
  const visited = new Set<number>();
  let locationId = record.locationId;
  while (locationId !== source.rootLocationId && !visited.has(locationId)) {
    visited.add(locationId);
    const container = rawAssetsByItemId.get(locationId);
    if (!container) break;
    if (container.locationFlag !== "OfficeFolder") containerItemIds.push(container.itemId);
    locationId = container.locationId;
  }
  return {
    rootLocationId: source.rootLocationId,
    locationFlag: source.locationFlag,
    containerItemIds,
  };
}

/** Finds the corporation hangar represented by a location, when its asset graph identifies one. */
export function getCorporationLocationSource(
  locationId: number,
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  for (const asset of rawAssetsByItemId.values()) {
    const source = corporationSourceRoot(asset.locationId, asset.locationFlag, rawAssetsByItemId);
    if (source?.rootLocationId === locationId && source.locationFlag) {
      return {
        rootLocationId: source.rootLocationId,
        locationFlag: "",
        containerItemIds: [],
      };
    }
  }
  return undefined;
}

/** Returns whether a corporation job or order location is accessible with Take permission. */
function isCorporationLocationAccessible(
  locationId: number,
  policy: CorporationSourcePolicy,
  characters: readonly CorporationPolicyCharacter[],
  rawAssetsByItemId: ReadonlyMap<number, AssetRecord>,
) {
  for (const asset of rawAssetsByItemId.values()) {
    const source = corporationSourceRoot(asset.locationId, asset.locationFlag, rawAssetsByItemId);
    if (!source || source.rootLocationId !== locationId || !source.locationFlag) continue;
    const permission = getCorporationHangarPermissions(
      characters,
      policy.corporationId,
      source.rootLocationId,
      policy.headquartersId ?? -1,
    ).get(source.locationFlag);
    if (permission?.canTake) return true;
  }
  return false;
}

function corporationSourceLabel(
  locationFlag: CorporationHangarFlag,
  divisions: readonly EsiCorporationDivision[] | null | undefined,
) {
  const divisionNumber =
    locationFlag === "CorpDeliveries" ? 0 : Number(locationFlag.slice("CorpSAG".length));
  const division = corporationHangarFlagForDivision(divisionNumber);
  const divisionName = divisions?.find((entry) => entry.division === divisionNumber)?.name;
  return (
    divisionName
    ?? (division === "CorpDeliveries"
      ? "Deliveries"
      : `Hangar ${locationFlag.slice("CorpSAG".length)}`)
  );
}

/** Lists accessible corporation hangars and named containers for the source editor. */
export async function getCorporationSourceCatalog(
  characterIds: readonly number[],
  policies: readonly CorporationSourcePolicy[],
  sessionId = "default",
): Promise<CorporationSourceCatalogEntry[]> {
  const characters = await getCharactersByIds(characterIds);
  const [types, groups, marketGroups, systems] = await Promise.all([
    getTypes(),
    getGroups(),
    getMarketGroups(),
    getSystems(),
  ]);
  const catalogs = await Promise.all(
    policies.map(async (policy) => {
      const cache = getCache(corporationCaches, policy.corporationId, sessionId);
      const rawAssets = cache.allAssetsRaw?.lastBody ?? [];
      const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
      const sourceEntries = new Map<string, CorporationSourceCatalogEntry>();
      for (const asset of rawAssets) {
        if (asset.ownerType !== "corporation") continue;
        const source = corporationSourceRoot(
          asset.locationId,
          asset.locationFlag,
          rawAssetsByItemId,
        );
        if (!source?.locationFlag) continue;
        const permission = getCorporationHangarPermissions(
          characters,
          policy.corporationId,
          source.rootLocationId,
          policy.headquartersId ?? -1,
        ).get(source.locationFlag);
        if (!permission?.canQuery) continue;
        const key = `${source.rootLocationId}:${source.locationFlag}`;
        if (!sourceEntries.has(key)) {
          const rootLocationCandidate =
            cache.rootLocationsByItemId.get(asset.itemId)
            ?? cache.stockAssetsByItemId?.get(asset.itemId)?.rootLocation;
          let rootLocation = isAssetLocation(rootLocationCandidate)
            ? rootLocationCandidate
            : undefined;
          const station = await getStation(source.rootLocationId);
          if (station) {
            const names = await fetchUniverseNames([source.rootLocationId]).catch(() => new Map());
            rootLocation = {
              locationId: source.rootLocationId,
              kind: "station",
              ...(names.get(source.rootLocationId)
                ? { name: names.get(source.rootLocationId) }
                : {}),
              typeId: station.typeID,
              systemId: station.solarSystemID,
              resolved: true,
            };
          }
          else if (rootLocation?.kind === "station" && !rootLocation.name) {
            const names = await fetchUniverseNames([rootLocation.locationId]).catch(
              () => new Map(),
            );
            const name = names.get(rootLocation.locationId);
            if (name) rootLocation = { ...rootLocation, name };
          }
          const systemName =
            rootLocation?.systemId === undefined
              ? undefined
              : systems.get(rootLocation.systemId)?.name.en;
          sourceEntries.set(
            key,
            {
              corporationId: policy.corporationId,
              rootLocationId: source.rootLocationId,
              locationFlag: source.locationFlag,
              label: corporationSourceLabel(source.locationFlag, cache.divisions?.lastBody),
              ...(rootLocation
                ? {
                    rootLocation: {
                      ...rootLocation,
                      ...(systemName ? { systemName } : {}),
                    },
                  }
                : {}),
              canTake: permission.canTake,
              canQuery: permission.canQuery,
              selected: policy.directHangars.some(
                (entry) =>
                  entry.rootLocationId === source.rootLocationId
                  && entry.locationFlag === source.locationFlag,
              ),
              containers: [],
            },
          );
        }
        const entry = sourceEntries.get(key)!;
        if (
          asset.isSingleton
          && isCargoContainerType(asset.typeId, types, groups, marketGroups)
          && !entry.containers.some((container) => container.itemId === asset.itemId)
        ) {
          const cachedAsset = cache.stockAssetsByItemId?.get(asset.itemId);
          const name = asset.name ?? cachedAsset?.name;
          entry.containers.push({
            itemId: asset.itemId,
            ...(name ? { name } : {}),
            locationId: asset.locationId,
            rootLocationId: source.rootLocationId,
            selected: policy.containerItemIds.includes(asset.itemId),
          });
        }
      }
      const unnamedContainerIds = [
        ...new Set(
          [...sourceEntries.values()].flatMap((entry) =>
            entry.containers
              .filter((container) => container.name === undefined)
              .map((container) => container.itemId),
          ),
        ),
      ];
      const nameResolver = characters.find(
        (character) =>
          character.corporationId === policy.corporationId
          && (
            character.hasDirectorRole === true
            || character.corporationRoles?.includes("Director") === true
          ),
      );
      if (unnamedContainerIds.length > 0 && nameResolver) {
        try {
          const names = await fetchAssetNames(
            `/corporations/${policy.corporationId}/assets/names`,
            await getUsableToken(nameResolver),
            unnamedContainerIds,
          );
          for (const entry of sourceEntries.values()) {
            entry.containers = entry.containers.map((container) => {
              const name = names.get(container.itemId);
              return name === undefined ? container : { ...container, name };
            });
          }
        }
        catch {
          // Cached container IDs remain usable when ESI name resolution is unavailable.
        }
      }
      return [...sourceEntries.values()]
        .sort(
          (left, right) =>
            corporationHangarNumber(left.locationFlag)
            - corporationHangarNumber(right.locationFlag),
        )
        .map((entry) => ({
          ...entry,
          containers: entry.containers.sort((left, right) =>
            (left.name ?? `Container ${left.itemId}`).localeCompare(
              right.name ?? `Container ${right.itemId}`,
            ),
          ),
        }));
    }),
  );
  return catalogs.flat();
}

type CorporationProjection = {
  characters: CharacterTokenRecord[];
  corporationIds: number[];
  policiesByCorporationId: Map<number, CorporationSourcePolicy>;
};

async function getCorporationProjection(
  characterIds: readonly number[],
  includeCorporationData: boolean,
  sessionId: string,
  policies?: readonly CorporationSourcePolicy[],
): Promise<CorporationProjection> {
  const characters = await getCharactersByIds(characterIds);
  if (!includeCorporationData) {
    return { characters, corporationIds: [], policiesByCorporationId: new Map() };
  }
  if (policies !== undefined) {
    const policiesByCorporationId = new Map(
      policies.map((policy) => [policy.corporationId, policy]),
    );
    return {
      characters,
      corporationIds: [...policiesByCorporationId.keys()],
      policiesByCorporationId,
    };
  }
  const corporationIds = [
    ...new Set(
      characters
        .filter((character) => character.hasDirectorRole && character.corporationId)
        .map((character) => character.corporationId!),
    ),
  ];
  return { characters, corporationIds, policiesByCorporationId: new Map() };
}

function getProjectedCorporationAssets(
  cache: OwnerCache,
  policy: CorporationSourcePolicy | undefined,
  characters: readonly CharacterTokenRecord[],
) {
  if (!policy) return effectiveAssets(cache);
  const rawAssets = cache.allAssetsRaw?.lastBody ?? [];
  const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
  const blueprintItemIds = new Set(
    (cache.blueprintInstances?.lastBody ?? []).map((blueprint) => blueprint.itemId),
  );
  return effectiveAssets(cache).filter((asset) =>
    isCorporationRecordAccessible(asset, policy, characters, blueprintItemIds, rawAssetsByItemId),
  );
}

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
  const result = await fetchBlueprints(character, cache.blueprintInstances?.etag);
  cache.blueprintInstances =
    result.notModified && cache.blueprintInstances
      ? setFresh(cache.blueprintInstances.lastBody, result.headers, cache.blueprintInstances, true)
      : setFresh(result.blueprints ?? [], result.headers, cache.blueprintInstances);
  return cache.blueprintInstances;
}

/** Refreshes the character's current location and reports whether its body changed. */
async function refreshCurrentLocation(cache: OwnerCache, character: CharacterTokenRecord) {
  if (
    cache.currentLocation?.nextRefreshAllowed
    && Date.parse(cache.currentLocation.nextRefreshAllowed) > Date.now()
  ) {
    cache.currentLocation.status = endpointDataStatus(
      cache.currentLocation.lastModified,
      cache.currentLocation.nextRefreshAllowed,
    );
    return false;
  }
  const previous = cache.currentLocation?.lastBody;
  const result = await fetchCharacterLocation(character, cache.currentLocation?.etag);
  cache.currentLocation =
    result.notModified && cache.currentLocation
      ? setFresh(cache.currentLocation.lastBody, result.headers, cache.currentLocation, true)
      : setFresh(result.location, result.headers, cache.currentLocation);
  const current = cache.currentLocation.lastBody;
  return (
    previous?.solarSystemId !== current?.solarSystemId
    || previous?.stationId !== current?.stationId
    || previous?.structureId !== current?.structureId
  );
}

/** Refreshes the character's current ship and reports whether its body changed. */
async function refreshCurrentShip(cache: OwnerCache, character: CharacterTokenRecord) {
  if (
    cache.currentShip?.nextRefreshAllowed
    && Date.parse(cache.currentShip.nextRefreshAllowed) > Date.now()
  ) {
    cache.currentShip.status = endpointDataStatus(
      cache.currentShip.lastModified,
      cache.currentShip.nextRefreshAllowed,
    );
    return false;
  }
  const previous = cache.currentShip?.lastBody;
  const result = await fetchCharacterShip(character, cache.currentShip?.etag);
  cache.currentShip =
    result.notModified && cache.currentShip
      ? setFresh(cache.currentShip.lastBody, result.headers, cache.currentShip, true)
      : setFresh(result.ship, result.headers, cache.currentShip);
  const current = cache.currentShip.lastBody;
  return (
    previous?.itemId !== current?.itemId
    || previous?.typeId !== current?.typeId
    || previous?.name !== current?.name
  );
}

function getCache(map: Map<string, OwnerCache>, id: number, sessionId: string): OwnerCache {
  const key = map === corporationCaches ? `${id}` : `${sessionId}:${id}`;
  const existing = map.get(key);
  if (existing) return existing;
  const created: OwnerCache = {
    assetItemIds: new Set(),
    assembledStructureRigs: [],
    rootLocationsByItemId: new Map(),
    shipAssetsByItemId: new Map(),
    assembledShipsByItemId: new Map(),
    jobAssetDeductions: new Map(),
    jobBlueprintAdjustments: new Map(),
    marketOrderAssetDeductions: new Map(),
    unresolvedAssetCount: 0,
  };
  map.set(key, created);
  return created;
}

type RefreshOwnerKind = "character" | "corporation";
type RefreshProfileValue =
  | number
  | {
      totalMS: number;
      sections: Record<string, RefreshProfileValue>;
    };

export type RefreshProfiler = {
  start(section: string): void;
  end(section: string): void;
  finish(): void;
};

/** Collects opt-in section timings for one owner refresh without affecting refresh outcomes. */
export function createRefreshProfiler(
  kind: RefreshOwnerKind,
  ownerId: number | string,
): RefreshProfiler {
  const enabled = process.env.NODE_ENV === "development";
  const startedAt = performance.now();
  type ActiveSection = {
    name: string;
    startedAt: number;
    sections: Map<string, RefreshProfileValue>;
  };
  const rootSections = new Map<string, RefreshProfileValue>();
  const activeSections: ActiveSection[] = [];

  function finishSection(section: ActiveSection, totalMS: number): RefreshProfileValue {
    if (section.sections.size === 0) return totalMS;
    return {
      totalMS,
      sections: Object.fromEntries(section.sections),
    };
  }

  return {
    start(section: string) {
      if (enabled) {
        activeSections.push({ name: section, startedAt: performance.now(), sections: new Map() });
      }
    },
    end(section: string) {
      if (!enabled) return;
      const activeSection = activeSections.pop();
      if (!activeSection || activeSection.name !== section) return;
      const totalMS = Math.round((performance.now() - activeSection.startedAt) * 100) / 100;
      const parentSections = activeSections.at(-1)?.sections ?? rootSections;
      parentSections.set(section, finishSection(activeSection, totalMS));
    },
    finish() {
      if (!enabled) return;
      console.info(
        "[ESI refresh profile]",
        JSON.stringify(
          {
            owner: `${kind}:${ownerId}`,
            totalMS: Math.round((performance.now() - startedAt) * 100) / 100,
            sections: Object.fromEntries(rootSections),
          },
          null,
          2,
        ),
      );
    },
  };
}

function endpointStatus<T>(
  error: unknown,
): Pick<EndpointCache<T>, "status" | "rateLimitedUntil" | "error" | "reauthorizeRequired"> {
  const status = (error as { status?: number }).status;
  if (status !== 420 && status !== 429) {
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
      ...((error as { reauthorizeRequired?: boolean }).reauthorizeRequired
      || (status && status >= 400 && status < 500)
        ? { reauthorizeRequired: true }
        : {}),
    };
  }
  const retryAfterValue = (error as { retryAfter?: string }).retryAfter;
  const retryAfterSeconds = Number(retryAfterValue);
  const retryAfterTimestamp = Date.parse(retryAfterValue ?? "");
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(1, retryAfterSeconds) * 1_000
    : Number.isFinite(retryAfterTimestamp)
      ? Math.max(1_000, retryAfterTimestamp - Date.now())
      : 60_000;
  return {
    status: "rate_limited",
    rateLimitedUntil: new Date(Date.now() + retryAfterMs).toISOString(),
    error: error instanceof Error ? error.message : "ESI rate limit reached",
  };
}

/** Builds the derived asset record used for a character's currently piloted ship. */
export function buildCurrentShipAsset(
  ship: CharacterShipRecord,
  location: CharacterLocationRecord,
): AssetRecord {
  const locationId = location.stationId ?? location.structureId ?? location.solarSystemId;
  const kind = location.stationId ? "station" : location.structureId ? "structure" : "solar_system";
  return {
    itemId: ship.itemId,
    typeId: ship.typeId,
    name: ship.name,
    quantity: 1,
    locationId,
    locationType: kind,
    locationFlag: "Pilot",
    isSingleton: true,
    ownerType: "character",
    ownerId: ship.characterId,
    rootLocation: {
      locationId,
      kind,
      systemId: location.solarSystemId,
      resolved: kind !== "structure",
    },
  };
}

/** Returns the active ship when both current-location endpoints have cached bodies. */
function getCurrentShipAsset(cache: OwnerCache) {
  const ship = cache.currentShip?.lastBody;
  const location = cache.currentLocation?.lastBody;
  return ship && location ? buildCurrentShipAsset(ship, location) : undefined;
}

/** Adds or enriches the current ship without persisting it into the raw assets response. */
function includeCurrentShip(rawAssets: AssetRecord[], cache: OwnerCache) {
  const currentShip = getCurrentShipAsset(cache);
  if (!currentShip) return rawAssets;
  const existingIndex = rawAssets.findIndex((asset) => asset.itemId === currentShip.itemId);
  if (existingIndex < 0) return [...rawAssets, currentShip];
  const indexedAssets = [...rawAssets];
  indexedAssets[existingIndex] = {
    ...indexedAssets[existingIndex],
    ...currentShip,
  };
  return indexedAssets;
}

/** Adds a current ship ID to the item IDs that must never be resolved as structures. */
export function getKnownNonStructureItemIds(
  assetItemIds: ReadonlySet<number>,
  currentShipItemId?: number,
) {
  const knownItemIds = new Set(assetItemIds);
  if (currentShipItemId !== undefined) knownItemIds.add(currentShipItemId);
  return knownItemIds;
}

function normalizeUtcTimestamp(value: string | null | undefined, fallback?: string) {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

export function setFresh<T>(
  body: T,
  headers?: Headers,
  previous?: EndpointCache<T>,
  preserveLastModified = false,
): EndpointCache<T> {
  const lastModified = normalizeUtcTimestamp(
    headers?.get("last-modified"),
    preserveLastModified ? previous?.lastModified : undefined,
  );
  const nextRefreshAllowed = normalizeUtcTimestamp(headers?.get("expires"));
  return {
    lastBody: body,
    etag: headers?.get("etag") ?? previous?.etag,
    lastModified,
    lastUpdated: new Date().toISOString(),
    expires: nextRefreshAllowed,
    nextRefreshAllowed,
    status: endpointDataStatus(lastModified, nextRefreshAllowed),
  };
}
export function endpointDataStatus(
  lastModified?: string,
  nextRefreshAllowed?: string,
): EndpointStatus {
  if (nextRefreshAllowed && Date.parse(nextRefreshAllowed) <= Date.now()) return "stale";
  if (lastModified && Date.now() - Date.parse(lastModified) <= 2 * 60 * 1000) return "fresh";
  return "cached";
}

function jobStartedAfter(job: IndustryJobRecord, lastModified: string | undefined) {
  const jobStartedAt = Date.parse(job.startDate);
  const endpointModifiedAt = Date.parse(lastModified ?? "");
  return (
    Number.isFinite(jobStartedAt)
    && Number.isFinite(endpointModifiedAt)
    && jobStartedAt > endpointModifiedAt
  );
}

function getJobMaterials(
  job: IndustryJobRecord,
  blueprint: Awaited<ReturnType<typeof getBlueprintById>>,
) {
  if (!blueprint) return [];
  switch (job.activityId) {
  case 1:
    return blueprint.activities.manufacturing?.materials ?? [];
  case 3:
    return blueprint.activities.research_time?.materials ?? [];
  case 4:
    return blueprint.activities.research_material?.materials ?? [];
  case 5:
    return blueprint.activities.copying?.materials ?? [];
  case 8:
    return blueprint.activities.invention?.materials ?? [];
  case 9:
    return blueprint.activities.reaction?.materials ?? [];
  default:
    return [];
  }
}

async function refreshJobAdjustments(
  cache: OwnerCache,
  jobs: IndustryJobRecord[],
  assetsLastModified: string | undefined,
  blueprintsLastModified: string | undefined,
) {
  cache.jobAssetDeductions = new Map();
  cache.jobBlueprintAdjustments = new Map();
  if (!assetsLastModified && !blueprintsLastModified) return;

  const blueprintIds = [
    ...new Set(
      jobs
        .filter(
          (job) =>
            jobStartedAfter(job, assetsLastModified)
            || jobStartedAfter(job, blueprintsLastModified),
        )
        .map((job) => job.blueprintTypeId),
    ),
  ];
  const blueprints = new Map(
    await Promise.all(
      blueprintIds.map(async (typeId) => [typeId, await getBlueprintById(typeId)] as const),
    ),
  );
  const blueprintInstances = new Map(
    (cache.blueprintInstances?.lastBody ?? []).map((blueprint) => [blueprint.itemId, blueprint]),
  );

  for (const job of jobs) {
    const blueprint = blueprints.get(job.blueprintTypeId) ?? null;
    if (jobStartedAfter(job, assetsLastModified)) {
      for (const material of getJobMaterials(job, blueprint)) {
        const key = `${material.typeID}:${job.facilityId}`;
        cache.jobAssetDeductions.set(
          key,
          (cache.jobAssetDeductions.get(key) ?? 0) + material.quantity * job.runs,
        );
      }
    }

    if (!jobStartedAfter(job, blueprintsLastModified) || job.activityId === 9) continue;
    const blueprintInstance = blueprintInstances.get(job.blueprintId);
    if (!blueprintInstance) continue;
    const adjustment = cache.jobBlueprintAdjustments.get(job.blueprintId) ?? {
      consumedRuns: 0,
      inUse: false,
    };
    if (blueprintInstance.quantity === -1) adjustment.inUse = true;
    else adjustment.consumedRuns += job.runs;
    cache.jobBlueprintAdjustments.set(job.blueprintId, adjustment);
  }
}

function effectiveAssets(cache: OwnerCache) {
  const deductions = new Map(cache.jobAssetDeductions);
  for (const [key, quantity] of cache.marketOrderAssetDeductions) {
    deductions.set(key, (deductions.get(key) ?? 0) + quantity);
  }
  return [...(cache.stockAssetsByItemId?.values() ?? [])].flatMap((asset) => {
    const rootLocationId =
      asset.rootLocation && "kind" in asset.rootLocation
        ? asset.rootLocation.locationId
        : asset.locationId;
    const key = `${asset.typeId}:${rootLocationId}`;
    const deduction = deductions.get(key) ?? 0;
    const blueprintAdjustment = cache.jobBlueprintAdjustments.get(asset.itemId);
    if (deduction <= 0) return blueprintAdjustment?.inUse ? [{ ...asset, inUse: true }] : [asset];
    const deductedQuantity = Math.min(asset.quantity, deduction);
    const quantity = asset.quantity - deductedQuantity;
    deductions.set(key, deduction - deductedQuantity);
    if (quantity <= 0) return [];
    return [
      {
        ...asset,
        quantity,
        ...(blueprintAdjustment?.inUse ? { inUse: true } : {}),
      },
    ];
  });
}

function marketOrderIssuedAfter(order: MarketOrderRecord, lastModified: string | undefined) {
  const orderIssuedAt = Date.parse(order.issuedAt);
  const assetsModifiedAt = Date.parse(lastModified ?? "");
  return (
    Number.isFinite(orderIssuedAt)
    && Number.isFinite(assetsModifiedAt)
    && orderIssuedAt > assetsModifiedAt
  );
}

export function getMarketOrderAssetDeductions(
  orders: readonly MarketOrderRecord[],
  assetsLastModified?: string,
) {
  const deductions = new Map<string, number>();
  for (const order of orders) {
    if (
      order.isBuyOrder
      || order.volumeTotal <= 0
      || !marketOrderIssuedAfter(order, assetsLastModified)
    ) continue;
    const key = `${order.typeId}:${order.locationId}`;
    deductions.set(key, (deductions.get(key) ?? 0) + order.volumeTotal);
  }
  return deductions;
}

function refreshMarketOrderAdjustments(cache: OwnerCache, assetsLastModified?: string) {
  cache.marketOrderAssetDeductions = hasUsableMarketOrders(cache)
    ? getMarketOrderAssetDeductions(cache.marketOrders!.lastBody, assetsLastModified)
    : new Map();
}

function effectiveBlueprints(cache: OwnerCache) {
  return (cache.blueprintInstances?.lastBody ?? []).map((blueprint) => {
    const adjustment = cache.jobBlueprintAdjustments.get(blueprint.itemId);
    if (!adjustment) return blueprint;
    return {
      ...blueprint,
      runsBeforeJobAdjustments: blueprint.runs,
      runs:
        blueprint.quantity === -1
          ? blueprint.runs
          : Math.max(0, blueprint.runs - adjustment.consumedRuns),
      ...(adjustment.inUse ? { inUse: true } : {}),
    };
  });
}

type IndustryJobsFetcher = (
  record: CharacterTokenRecord,
  etag?: string,
) => ReturnType<typeof fetchCharacterIndustryJobs>;

async function refreshIndustryJobs(
  cache: OwnerCache,
  character: CharacterTokenRecord,
  fetchJobs: IndustryJobsFetcher,
  assetsLastModified: string | undefined,
  blueprintsLastModified: string | undefined,
) {
  if (
    !cache.jobs
    || !cache.jobs.nextRefreshAllowed
    || Date.parse(cache.jobs.nextRefreshAllowed) <= Date.now()
  ) {
    const jobs = await fetchJobs(character, cache.jobs?.etag);
    cache.jobs =
      jobs.notModified && cache.jobs
        ? setFresh(cache.jobs.lastBody, jobs.headers, cache.jobs, true)
        : setFresh(jobs.jobs ?? [], jobs.headers, cache.jobs);
  }
  else {
    cache.jobs.status = endpointDataStatus(cache.jobs.lastModified, cache.jobs.nextRefreshAllowed);
  }
  try {
    await refreshJobAdjustments(
      cache,
      cache.jobs.lastBody,
      assetsLastModified,
      blueprintsLastModified,
    );
  }
  catch {
    cache.jobAssetDeductions = new Map();
    cache.jobBlueprintAdjustments = new Map();
  }
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
  preserveLastModified = false,
) {
  const initialAssetIndexes = await indexAssetsByPurpose(rawAssets);
  let namedAssets = rawAssets;
  if (assetNamePath) {
    const stockAssetIds = new Set(initialAssetIndexes.stockAssetsByItemId.keys());
    namedAssets = await mergeAssetNames(rawAssets, token, assetNamePath, stockAssetIds);
  }

  const indexedAssets = includeCurrentShip(namedAssets, cache);
  const assetIndexes =
    indexedAssets === rawAssets ? initialAssetIndexes : await indexAssetsByPurpose(indexedAssets);
  const assetItemIds = new Set(indexedAssets.map((asset) => asset.itemId));
  const knownNonStructureItemIds = getKnownNonStructureItemIds(
    assetItemIds,
    cache.currentShip?.lastBody?.itemId,
  );
  const rootLocationsByItemId = await resolveRootLocations(
    assetIndexes.stockLocationItemsByItemId,
    assetIndexes.shipTypeIds,
    token,
    knownNonStructureItemIds,
  );
  const inferredRoots = new Map<number, Promise<AssetLocation | null>>();

  function inferRoot(locationId: number, asset: AssetRecord) {
    const existing = inferredRoots.get(locationId);
    if (existing) return existing;
    const resolution = getRealParent(asset, token, knownNonStructureItemIds);
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

  cache.allAssetsRaw = setFresh(namedAssets, headers, previous, preserveLastModified);
  cache.assetItemIds = assetItemIds;
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
        && (
          (shipTypeIds.has(asset.typeId) && !excludedItemIds.has(asset.itemId))
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

export function isCargoContainerType(
  typeId: number,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  groups: Awaited<ReturnType<typeof getGroups>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
) {
  const type = types.get(typeId);
  const group = groups.get(type?.groupID ?? -1);
  if (group?.categoryID === 2) return true;
  if (group?.categoryID === 9) return false;
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

async function getRealParent(
  current: AssetRecord,
  token: TokenSet,
  assetItemIds: ReadonlySet<number>,
): Promise<AssetLocation | null> {
  if (current.rootLocation && "kind" in current.rootLocation) return current.rootLocation;
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
  if (assetItemIds.has(locationId)) return null;
  if (kind === "solar_system" || kind === "structure" || kind === null) {
    const result = await (
      kind === "solar_system"
        ? fetchSolarSystemMetadata(locationId, token)
        : fetchStructureMetadataPerCharacter(locationId, token)
    ).catch(() => null);
    if (!result?.data) {
      return {
        locationId,
        kind: kind === "solar_system" ? "solar_system" : "structure",
        resolved: false,
      };
    }
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
  assetItemIds: ReadonlySet<number>,
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
        const realParent = await getRealParent(current, token, assetItemIds);
        if (!realParent) return null;
        for (const id of visited) rootCache.set(id, realParent);
        return realParent;
      }
      const parent = containerItemsByItemId.get(current.locationId);
      if (!parent) {
        // The first parent outside the container index must be resolved through SDE or ESI.
        const realParent = await getRealParent(current, token, assetItemIds);
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
  rebuildEvenIfComplete = false,
) {
  if (
    !record
    || (!rebuildEvenIfComplete && !needsCompleteAssetGraph(cache))
    || !Array.isArray(cache.allAssetsRaw?.lastBody)
  ) {
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

export function copyRefreshCache(
  kind: "character" | "corporation",
  ownerId: number,
  sourceSessionId: string,
  targetSessionId: string,
) {
  if (kind === "corporation") return;
  if (sourceSessionId === targetSessionId) return;
  const sourceCache = characterCaches.get(`${sourceSessionId}:${ownerId}`);
  if (!sourceCache) return;
  characterCaches.set(`${targetSessionId}:${ownerId}`, structuredClone(sourceCache));
}

/** Removes corporation data after its authorization is revoked. */
export function invalidateCorporationCache(corporationId: number, sessionId: string) {
  void sessionId;
  corporationCaches.delete(`${corporationId}`);
}

export async function refreshCharacterState(
  character: CharacterTokenRecord,
  sessionId: string,
  profiler: RefreshProfiler,
): Promise<void> {
  const cache = getCache(characterCaches, character.characterId, sessionId);
  let currentShipStateChanged = false;
  profiler.start("location");
  try {
    currentShipStateChanged = await refreshCurrentLocation(cache, character);
  }
  catch (error) {
    cache.currentLocation = {
      ...(cache.currentLocation ?? { lastBody: null }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("location");
  }
  profiler.start("ship");
  try {
    currentShipStateChanged =
      (await refreshCurrentShip(cache, character)) || currentShipStateChanged;
  }
  catch (error) {
    cache.currentShip = {
      ...(cache.currentShip ?? { lastBody: null }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("ship");
  }
  profiler.start("clones");
  try {
    if (
      !cache.clones
      || !cache.clones.nextRefreshAllowed
      || Date.parse(cache.clones.nextRefreshAllowed) <= Date.now()
    ) {
      const clones = await fetchCharacterClones(character);
      cache.clones = setFresh(clones.data, clones.headers, cache.clones);
    }
    else {
      cache.clones.status = endpointDataStatus(
        cache.clones.lastModified,
        cache.clones.nextRefreshAllowed,
      );
    }
  }
  catch (error) {
    cache.clones = {
      ...(cache.clones ?? { lastBody: null }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("clones");
  }
  profiler.start("skills");
  try {
    if (
      !cache.skills
      || !cache.skills.nextRefreshAllowed
      || Date.parse(cache.skills.nextRefreshAllowed) <= Date.now()
    ) {
      const skills = await fetchCharacterSkills(character, cache.skills?.etag);
      cache.skills =
        skills.notModified && cache.skills
          ? setFresh(cache.skills.lastBody, skills.headers, cache.skills, true)
          : setFresh(skills.skills ?? [], skills.headers, cache.skills);
    }
    else {
      cache.skills.status = endpointDataStatus(
        cache.skills.lastModified,
        cache.skills.nextRefreshAllowed,
      );
    }
  }
  catch (error) {
    cache.skills = {
      ...(cache.skills ?? { lastBody: [] }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("skills");
  }
  profiler.start("blueprints");
  let assetsRebuilt = false;
  try {
    await refreshBlueprintInstances(cache, character, fetchCharacterBlueprints);
  }
  catch (error) {
    cache.blueprintInstances = {
      ...(cache.blueprintInstances ?? { lastBody: [] }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("blueprints");
  }
  profiler.start("assets");
  try {
    if (
      !cache.allAssetsRaw?.nextRefreshAllowed
      || Date.parse(cache.allAssetsRaw.nextRefreshAllowed) <= Date.now()
    ) {
      const result = await fetchCharacterAssets(character, cache.allAssetsRaw?.etag);
      if (result.notModified && cache.allAssetsRaw) {
        await cacheResolvedAssets(
          cache,
          cache.allAssetsRaw.lastBody as AssetRecord[],
          result.token,
          result.headers,
          cache.allAssetsRaw,
          `/characters/${character.characterId}`,
          true,
        );
        assetsRebuilt = true;
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
        );
        assetsRebuilt = true;
      }
    }
  }
  catch (error) {
    await rebuildResolvedAssets(cache, character, "personal");
    cache.allAssetsRaw = {
      ...(cache.allAssetsRaw ?? { lastBody: [] }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("assets");
  }
  profiler.start("assetRebuild");
  try {
    if (currentShipStateChanged && !assetsRebuilt) {
      await rebuildResolvedAssets(cache, character, "personal", true);
    }
  }
  finally {
    profiler.end("assetRebuild");
  }
  profiler.start("jobs");
  try {
    await refreshIndustryJobs(
      cache,
      character,
      fetchCharacterIndustryJobs,
      cache.allAssetsRaw?.lastModified,
      cache.blueprintInstances?.lastModified,
    );
  }
  catch (error) {
    cache.jobs = {
      ...(cache.jobs ?? { lastBody: [] }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("jobs");
  }
  profiler.start("marketOrders");
  try {
    if (
      cache.marketOrders?.status === "stale"
      || !cache.marketOrders
      || !cache.marketOrders.nextRefreshAllowed
      || Date.parse(cache.marketOrders.nextRefreshAllowed) <= Date.now()
    ) {
      const orders = await fetchCharacterMarketOrders(character, getUsableMarketOrdersEtag(cache));
      if (orders.notModified && cache.marketOrders) {
        cache.marketOrders = setFresh(
          cache.marketOrders.lastBody,
          orders.headers,
          cache.marketOrders,
          true,
        );
        cache.marketOrders.status = endpointDataStatus(
          cache.marketOrders.lastModified,
          cache.marketOrders.nextRefreshAllowed,
        );
      }
      else if (orders.notModified) {
        cache.marketOrders = setFresh([], orders.headers, undefined);
      }
      else if (orders.orders) {
        cache.marketOrders = setFresh(orders.orders, orders.headers, cache.marketOrders);
      }
    }
    else {
      cache.marketOrders.status = endpointDataStatus(
        cache.marketOrders.lastModified,
        cache.marketOrders.nextRefreshAllowed,
      );
    }
    refreshMarketOrderAdjustments(cache, cache.allAssetsRaw?.lastModified);
  }
  catch (error) {
    cache.marketOrders = {
      ...(cache.marketOrders ?? { lastBody: [] }),
      ...endpointStatus(error),
    };
  }
  finally {
    profiler.end("marketOrders");
  }
}

/** Refreshes corporation-owned state using a verified director character. */
async function refreshCorporationCache(
  character: CharacterTokenRecord,
  corporationId: number,
  sessionId: string,
  profiler: RefreshProfiler,
): Promise<void> {
  const corpCache = getCache(corporationCaches, corporationId, sessionId);
  const corpSummary: {
    corporationId: number;
    publicInfo?: EndpointCache<EsiCorporationPublicInfo | null>;
    divisions?: EndpointCache<EsiCorporationDivision[] | null>;
    assets?: EndpointCache<AssetRecord[] | null>;
    blueprints?: EndpointCache<BlueprintInstanceRecord[] | null>;
    structures?: EndpointCache<EsiCorporationStructure[] | null>;
    jobs?: EndpointCache<IndustryJobRecord[] | null>;
    marketOrders?: EndpointCache<MarketOrderRecord[] | null>;
  } = { corporationId };
  profiler.start("corporation");
  try {
    if (
      !corpCache.publicInfo
      || !corpCache.publicInfo.nextRefreshAllowed
      || Date.parse(corpCache.publicInfo.nextRefreshAllowed) <= Date.now()
    ) {
      const publicInfo = await fetchCorporationPublicInfo(character, corpCache.publicInfo?.etag);
      corpCache.publicInfo =
        publicInfo.notModified && corpCache.publicInfo
          ? setFresh(corpCache.publicInfo.lastBody, publicInfo.headers, corpCache.publicInfo, true)
          : setFresh(publicInfo.corporation ?? null, publicInfo.headers, corpCache.publicInfo);
    }
    else {
      corpCache.publicInfo.status = endpointDataStatus(
        corpCache.publicInfo.lastModified,
        corpCache.publicInfo.nextRefreshAllowed,
      );
    }
    corpSummary.publicInfo = corpCache.publicInfo;
  }
  catch (error) {
    corpCache.publicInfo = {
      ...(corpCache.publicInfo ?? { lastBody: null }),
      ...endpointStatus(error),
    };
    corpSummary.publicInfo = { ...corpCache.publicInfo };
  }
  finally {
    profiler.end("corporation");
  }
  profiler.start("divisions");
  try {
    if (
      !corpCache.divisions
      || !corpCache.divisions.nextRefreshAllowed
      || Date.parse(corpCache.divisions.nextRefreshAllowed) <= Date.now()
    ) {
      const divisions = await fetchCorporationDivisions(character, corpCache.divisions?.etag);
      corpCache.divisions =
        divisions.notModified && corpCache.divisions
          ? setFresh(corpCache.divisions.lastBody, divisions.headers, corpCache.divisions, true)
          : setFresh(divisions.divisions ?? null, divisions.headers, corpCache.divisions);
    }
    else {
      corpCache.divisions.status = endpointDataStatus(
        corpCache.divisions.lastModified,
        corpCache.divisions.nextRefreshAllowed,
      );
    }
    corpSummary.divisions = corpCache.divisions;
  }
  catch (error) {
    corpCache.divisions = {
      ...(corpCache.divisions ?? { lastBody: null }),
      ...endpointStatus(error),
    };
    corpSummary.divisions = { ...corpCache.divisions };
  }
  finally {
    profiler.end("divisions");
  }
  profiler.start("structures");
  try {
    if (
      !corpCache.structures
      || !corpCache.structures.nextRefreshAllowed
      || Date.parse(corpCache.structures.nextRefreshAllowed) <= Date.now()
    ) {
      const structures = await fetchCorporationStructures(character, corpCache.structures?.etag);
      corpCache.structures =
        structures.notModified && corpCache.structures
          ? setFresh(corpCache.structures.lastBody, structures.headers, corpCache.structures, true)
          : setFresh(structures.structures, structures.headers, corpCache.structures);
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
  finally {
    profiler.end("structures");
  }
  profiler.start("assets");
  try {
    if (
      !corpCache.allAssetsRaw?.nextRefreshAllowed
      || Date.parse(corpCache.allAssetsRaw.nextRefreshAllowed) <= Date.now()
    ) {
      const result = await fetchCorporationAssets(character, corpCache.allAssetsRaw?.etag);
      if (result.notModified && corpCache.allAssetsRaw) {
        await cacheResolvedAssets(
          corpCache,
          corpCache.allAssetsRaw.lastBody as AssetRecord[],
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
      }
      else if (result.assets) {
        await cacheResolvedAssets(
          corpCache,
          result.assets,
          result.token,
          result.headers,
          corpCache.allAssetsRaw,
          `/corporations/${character.corporationId}`,
        );
      }
      corpSummary.assets = corpCache.allAssetsRaw;
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
  finally {
    profiler.end("assets");
  }
  profiler.start("blueprints");
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
  finally {
    profiler.end("blueprints");
  }
  profiler.start("jobs");
  try {
    await refreshIndustryJobs(
      corpCache,
      character,
      fetchCorporationIndustryJobs,
      corpCache.allAssetsRaw?.lastModified,
      corpCache.blueprintInstances?.lastModified,
    );
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
  finally {
    profiler.end("jobs");
  }
  profiler.start("marketOrders");
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
      );
      if (orders.notModified && corpCache.marketOrders) {
        corpCache.marketOrders = setFresh(
          corpCache.marketOrders.lastBody,
          orders.headers,
          corpCache.marketOrders,
          true,
        );
        corpCache.marketOrders.status = endpointDataStatus(
          corpCache.marketOrders.lastModified,
          corpCache.marketOrders.nextRefreshAllowed,
        );
      }
      else if (orders.notModified) {
        corpCache.marketOrders = setFresh([], orders.headers, undefined);
      }
      else if (orders.orders) {
        corpCache.marketOrders = setFresh(orders.orders, orders.headers, corpCache.marketOrders);
      }
    }
    else {
      corpCache.marketOrders.status = endpointDataStatus(
        corpCache.marketOrders.lastModified,
        corpCache.marketOrders.nextRefreshAllowed,
      );
    }
    refreshMarketOrderAdjustments(corpCache, corpCache.allAssetsRaw?.lastModified);
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
  finally {
    profiler.end("marketOrders");
  }
}

export async function refreshCorporationState(
  corporationId: number,
  character: CharacterTokenRecord,
  sessionId: string,
  profiler: RefreshProfiler,
): Promise<void> {
  profiler.start("authorization");
  try {
    const verification = await fetchCharacterCorporationAuthorization(
      character.characterId,
      character.personalAuth,
      corporationId,
    );
    if (
      !verification.authorized
      || !verification.roles
      || !verification.roles.roles.includes("Director")
    ) {
      invalidateCorporationCache(corporationId, sessionId);
      await clearCharacterCorporationAuthorization(character.characterId);
      throw new Error("Corporation authorization is incomplete");
    }
    const updatedCharacter = await updateCharacterCorporationAuthorization(
      character.characterId,
      {
        corporationId: verification.corporationId,
        allianceId: verification.characterInfo.alliance_id,
        corporationRoles: verification.roles.roles,
        rolesAtBase: verification.roles.rolesAtBase,
        rolesAtHq: verification.roles.rolesAtHq,
        rolesAtOther: verification.roles.rolesAtOther,
        hasDirectorRole: verification.roles.roles.includes("Director"),
        hasAccountantRole: verification.roles.roles.includes("Accountant"),
        hasTraderRole: verification.roles.roles.includes("Trader"),
        hasStationManagerRole: verification.roles.roles.includes("Station_Manager"),
      },
    );
    if (!updatedCharacter) {
      invalidateCorporationCache(corporationId, sessionId);
      throw new Error("Character authorization record is missing");
    }
    await refreshCorporationCache(
      { ...updatedCharacter, personalAuth: verification.token },
      corporationId,
      sessionId,
      profiler,
    );
  }
  finally {
    profiler.end("authorization");
  }
}

export async function getRunningIndustryJobs(
  characterIds: number[],
  includeCorporationJobs: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
) {
  const jobs = characterIds.flatMap((id) => {
    const body = getCache(characterCaches, id, sessionId).jobs?.lastBody;
    return Array.isArray(body) ? (body as IndustryJobRecord[]) : [];
  });
  if (!includeCorporationJobs) return jobs.filter((job) => job.ownerType === "character");
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...jobs,
    ...projection.corporationIds.flatMap((corporationId) => {
      const body = getCache(corporationCaches, corporationId, sessionId).jobs?.lastBody;
      const corporationJobs = Array.isArray(body) ? (body as IndustryJobRecord[]) : [];
      const policy = projection.policiesByCorporationId.get(corporationId);
      if (!policy) return corporationJobs;
      const rawAssets =
        getCache(corporationCaches, corporationId, sessionId).allAssetsRaw?.lastBody ?? [];
      const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
      return corporationJobs.filter((job) =>
        isCorporationLocationAccessible(
          job.facilityId,
          policy,
          projection.characters,
          rawAssetsByItemId,
        ),
      );
    }),
  ];
}

/** Returns the stock assets including the root location, excluding container items */
export async function getResolvedAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
): Promise<AssetRecord[]> {
  const assets = characterIds.flatMap((id) =>
    effectiveAssets(getCache(characterCaches, id, sessionId)),
  );
  if (!includeCorporationAssets) return [...assets];
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...assets,
    ...projection.corporationIds.flatMap((corporationId) =>
      getProjectedCorporationAssets(
        getCache(corporationCaches, corporationId, sessionId),
        projection.policiesByCorporationId.get(corporationId),
        projection.characters,
      ),
    ),
  ];
}

/** Returns ships and every asset contained by a ship, including nested containers. */
export async function getShipAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
): Promise<AssetRecord[]> {
  const assets = characterIds.flatMap((id) => {
    const cache = getCache(characterCaches, id, sessionId);
    const assetsByItemId = new Map(cache.shipAssetsByItemId);
    const currentShip = getCurrentShipAsset(cache);
    if (currentShip) {
      const existing = assetsByItemId.get(currentShip.itemId);
      assetsByItemId.set(
        currentShip.itemId,
        existing ? { ...existing, ...currentShip } : currentShip,
      );
    }
    return [...assetsByItemId.values()];
  });
  if (!includeCorporationAssets) return assets;
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...assets,
    ...projection.corporationIds.flatMap((corporationId) => {
      const cache = getCache(corporationCaches, corporationId, sessionId);
      const policy = projection.policiesByCorporationId.get(corporationId);
      if (!policy) return [...cache.shipAssetsByItemId.values()];
      const selectedAssets = getProjectedCorporationAssets(cache, policy, projection.characters);
      return selectedAssets.filter((asset) => cache.shipAssetsByItemId.has(asset.itemId));
    }),
  ];
}

/** Returns the complete resolved graph, including containers and ships. */
export async function getAllAssetsRaw(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
) {
  const assets = characterIds.flatMap(
    (id) => getCache(characterCaches, id, sessionId).allAssetsRaw?.lastBody ?? [],
  );
  if (!includeCorporationAssets) return assets;
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...assets,
    ...projection.corporationIds.flatMap((corporationId) => {
      const cache = getCache(corporationCaches, corporationId, sessionId);
      const rawAssets = cache.allAssetsRaw?.lastBody ?? [];
      const policy = projection.policiesByCorporationId.get(corporationId);
      if (!policy) return rawAssets;
      const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
      const blueprintItemIds = new Set(
        (cache.blueprintInstances?.lastBody ?? []).map((blueprint) => blueprint.itemId),
      );
      return rawAssets.filter((asset) =>
        isCorporationRecordAccessible(
          asset,
          policy,
          projection.characters,
          blueprintItemIds,
          rawAssetsByItemId,
        ),
      );
    }),
  ];
}

export async function getResolvedAssetIndex(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
) {
  const index = new Map<number, AssetRecord>();
  const projection = await getCorporationProjection(
    characterIds,
    includeCorporationAssets,
    sessionId,
    policies,
  );
  for (const characterId of characterIds) {
    for (const asset of effectiveAssets(getCache(characterCaches, characterId, sessionId))) {
      index.set(asset.itemId, asset);
    }
  }
  for (const corporationId of projection.corporationIds) {
    const cache = getCache(corporationCaches, corporationId, sessionId);
    for (const asset of getProjectedCorporationAssets(
      cache,
      projection.policiesByCorporationId.get(corporationId),
      projection.characters,
    )) {
      index.set(asset.itemId, asset);
    }
  }
  return index;
}

function getProjectedCorporationRootLocations(
  cache: OwnerCache,
  policy: CorporationSourcePolicy | undefined,
  characters: readonly CharacterTokenRecord[],
) {
  if (!policy) return new Map(cache.rootLocationsByItemId);
  const rawAssets = cache.allAssetsRaw?.lastBody ?? [];
  const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
  const blueprintItemIds = new Set(
    (cache.blueprintInstances?.lastBody ?? []).map((blueprint) => blueprint.itemId),
  );
  const allowedLocationIds = new Set<number>();
  for (const asset of rawAssets) {
    const allowed = isCorporationRecordAccessible(
      asset,
      policy,
      characters,
      blueprintItemIds,
      rawAssetsByItemId,
    );
    if (!allowed) continue;
    allowedLocationIds.add(asset.itemId);
    allowedLocationIds.add(asset.locationId);
  }
  return new Map(
    [...cache.rootLocationsByItemId].filter(([itemId]) => allowedLocationIds.has(itemId)),
  );
}

export async function getRootLocationsByItemId(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
): Promise<Map<number, AssetLocation>> {
  const locations = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id, sessionId).rootLocationsByItemId.entries(),
  ]);
  if (!includeCorporationAssets) return new Map(locations);
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...locations,
    ...projection.corporationIds.flatMap((id) => {
      const cache = getCache(corporationCaches, id, sessionId);
      return [
        ...getProjectedCorporationRootLocations(
          cache,
          projection.policiesByCorporationId.get(id),
          projection.characters,
        ).entries(),
      ];
    }),
  ].reduce(
    (map, [locationId, location]) => {
      map.set(locationId, location);
      return map;
    },
    new Map<number, AssetLocation>(),
  );
}

/** Selects the character authorized to resolve a location reported by an owned record. */
async function getStructureResolverCharacter(
  source: StructureLocationSource,
  characterIds: number[],
) {
  if (source.ownerType === "character") {
    return characterIds.includes(source.ownerId) ? getCharacter(source.ownerId) : undefined;
  }

  const characters = await getCharactersByIds(characterIds);
  return characters.find(
    (character) =>
      characterIds.includes(character.characterId)
      && character.corporationId === source.ownerId
      && (
        character.hasDirectorRole
        || (
          source.recordType === "order"
          && (character.hasAccountantRole || character.hasTraderRole)
        )
      ),
  );
}

/** Returns the cache belonging to the record that reported a location. */
function getSourceOwnerCache(source: StructureLocationSource, sessionId: string) {
  return source.ownerType === "character"
    ? getCache(characterCaches, source.ownerId, sessionId)
    : getCache(corporationCaches, source.ownerId, sessionId);
}

/** Returns whether the candidate is an assembled or currently piloted ship item. */
function isKnownShipItemId(locationId: number, source: StructureLocationSource, sessionId: string) {
  const cache = getSourceOwnerCache(source, sessionId);
  return (
    cache.assembledShipsByItemId.has(locationId)
    || cache.currentShip?.lastBody?.itemId === locationId
  );
}

/** Returns whether the source owner's asset cache contains the candidate location as an item. */
function isAssetItemId(locationId: number, source: StructureLocationSource, sessionId: string) {
  return getSourceOwnerCache(source, sessionId).assetItemIds.has(locationId);
}

/**
 * Resolves a structure location with the token belonging to the character that reported it.
 * Asset item IDs are never sent to the structure endpoint because they are container IDs,
 * not public structure IDs.
 */
export async function resolveStructureLocationForOwner(
  locationId: number,
  source: StructureLocationSource,
  characterIds: number[],
  sessionId = "default",
): Promise<AssetLocation | undefined> {
  const rootLocations = await getRootLocationsByItemId(
    characterIds,
    source.ownerType === "corporation",
    sessionId,
  );
  const cachedRoot = rootLocations.get(locationId);
  if (cachedRoot?.name) return cachedRoot;

  if (
    isKnownShipItemId(locationId, source, sessionId)
    || isAssetItemId(locationId, source, sessionId)
  ) return undefined;

  const character = await getStructureResolverCharacter(source, characterIds);
  if (!character) return undefined;
  const result = await fetchStructureMetadataPerCharacter(
    locationId,
    await getUsableToken(character),
  );
  if (!result.data) return undefined;
  return {
    locationId,
    kind: "structure",
    ...(result.data.type_id !== undefined ? { typeId: result.data.type_id } : {}),
    name: result.data.name,
    ...(result.data.system_id !== undefined ? { systemId: result.data.system_id } : {}),
    ...(result.data.region_id !== undefined ? { regionId: result.data.region_id } : {}),
    resolved: true,
  };
}

/** Returns the corporations represented by the supplied attached characters. */
export function getCorporationIdsForCharacters(
  characters: readonly Pick<CharacterTokenRecord, "corporationId">[],
) {
  return new Set(
    characters
      .map((character) => character.corporationId)
      .filter((corporationId): corporationId is number => corporationId !== undefined),
  );
}

export async function getCachedCorporationStructures(
  characterIds: number[],
  sessionId = "default",
) {
  const characters = await getCharactersByIds(characterIds);
  const corporationIds = getCorporationIdsForCharacters(characters);
  return [...corporationIds].flatMap(
    (corporationId) =>
      getCache(corporationCaches, corporationId, sessionId).structures?.lastBody ?? [],
  );
}

export async function getAssembledStructureRigAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
) {
  if (!includeCorporationAssets) return [];
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return projection.corporationIds.flatMap((corporationId) => {
    const cache = getCache(corporationCaches, corporationId, sessionId);
    const policy = projection.policiesByCorporationId.get(corporationId);
    if (!policy) return [...cache.assembledStructureRigs.values()];
    const selectedAssets = new Set(
      getProjectedCorporationAssets(cache, policy, projection.characters).map(
        (asset) => asset.itemId,
      ),
    );
    return cache.assembledStructureRigs.filter((asset) => selectedAssets.has(asset.itemId));
  });
}

export async function getAssembledShipAssets(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
) {
  const assets = characterIds.flatMap((id) => [
    ...getCache(characterCaches, id, sessionId).assembledShipsByItemId.values(),
  ]);
  if (!includeCorporationAssets) return assets;
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...assets,
    ...projection.corporationIds.flatMap((corporationId) => {
      const cache = getCache(corporationCaches, corporationId, sessionId);
      const policy = projection.policiesByCorporationId.get(corporationId);
      if (!policy) return [...cache.assembledShipsByItemId.values()];
      const selectedAssets = new Set(
        getProjectedCorporationAssets(cache, policy, projection.characters).map(
          (asset) => asset.itemId,
        ),
      );
      return [...cache.assembledShipsByItemId.values()].filter((asset) =>
        selectedAssets.has(asset.itemId),
      );
    }),
  ];
}

export async function getAssetCacheMetadata(
  characterIds: number[],
  includeCorporationAssets: boolean,
  sessionId = "default",
  policies?: readonly CorporationSourcePolicy[],
) {
  const characterCachesForPlan = characterIds.map((id) => getCache(characterCaches, id, sessionId));
  const projection = await getCorporationProjection(
    characterIds,
    includeCorporationAssets,
    sessionId,
    policies,
  );
  const corporations = projection.corporationIds;
  const corporationCachesForPlan = corporations.map((id) =>
    getCache(corporationCaches, id, sessionId),
  );
  const allCaches = [...characterCachesForPlan, ...corporationCachesForPlan];
  return {
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
  policies?: readonly CorporationSourcePolicy[],
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
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  for (const corporationId of projection.corporationIds) {
    const cache = getCache(corporationCaches, corporationId, sessionId);
    if (!hasUsableMarketOrders(cache)) {
      hasUnavailableSource = true;
      continue;
    }
    hasUsableSource = true;
    const orders = cache.marketOrders!.lastBody;
    const policy = projection.policiesByCorporationId.get(corporationId);
    const rawAssets = cache.allAssetsRaw?.lastBody ?? [];
    const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
    for (const order of orders as MarketOrderRecord[]) {
      if (order.isBuyOrder || order.volumeRemain <= 0) continue;
      if (
        policy
        && !isCorporationLocationAccessible(
          order.locationId,
          policy,
          projection.characters,
          rawAssetsByItemId,
        )
      ) continue;
      const isMyCorporationOrder =
        order.issuedBy !== undefined
        && projection.characters.some(
          (character) =>
            character.characterId === order.issuedBy && character.corporationId === corporationId,
        );
      if (!options.allCorporationSellOrdersAsStock && !isMyCorporationOrder) continue;
      typeIds.add(order.typeId);
      const corporationSource = getCorporationLocationSource(order.locationId, rawAssetsByItemId);
      stock.push({
        typeId: order.typeId,
        name: `Type ${order.typeId}`,
        quantity: order.volumeRemain,
        sourceLocationId: order.locationId,
        ownerType: order.ownerType,
        ownerId: order.ownerId,
        category: "item",
        source: "marketOrder",
        ...(corporationSource ? { corporationSource } : {}),
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
  policies?: readonly CorporationSourcePolicy[],
) {
  const instances = characterIds.flatMap((characterId) =>
    effectiveBlueprints(getCache(characterCaches, characterId, sessionId)),
  );
  if (!includeCorporationBlueprints) return instances;
  const projection = await getCorporationProjection(characterIds, true, sessionId, policies);
  return [
    ...instances,
    ...projection.corporationIds.flatMap((corporationId) => {
      const cache = getCache(corporationCaches, corporationId, sessionId);
      const corporationBlueprints = effectiveBlueprints(cache);
      const policy = projection.policiesByCorporationId.get(corporationId);
      if (!policy) return corporationBlueprints;
      const rawAssets = cache.allAssetsRaw?.lastBody ?? [];
      const rawAssetsByItemId = new Map(rawAssets.map((asset) => [asset.itemId, asset]));
      const blueprintItemIds = new Set(corporationBlueprints.map((blueprint) => blueprint.itemId));
      return corporationBlueprints.filter((blueprint) =>
        isCorporationRecordAccessible(
          blueprint,
          policy,
          projection.characters,
          blueprintItemIds,
          rawAssetsByItemId,
        ),
      );
    }),
  ];
}

export async function getStateStatus(
  characterIds: number[],
  sessionId: string,
  characters?: CharacterTokenRecord[],
) {
  const records = characters ?? (await getCharactersByIds(characterIds));
  const characterById = new Map(records.map((character) => [character.characterId, character]));
  const corporationsByCharacter = new Map<number, number[]>();
  for (const character of records) {
    if (!characterIds.includes(character.characterId) || !character.corporationId) continue;
    const corporationIds = corporationsByCharacter.get(character.characterId) ?? [];
    corporationIds.push(character.corporationId);
    corporationsByCharacter.set(character.characterId, corporationIds);
  }
  return {
    characters: characterIds.map((characterId) => ({
      characterId,
      onDeployment: characterById.get(characterId)?.onDeployment ?? false,
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
      location: toClientEndpointStatus(
        getCache(characterCaches, characterId, sessionId).currentLocation,
      ) ?? {
        status: "cached" as const,
        hasBody: false,
      },
      ship: toClientEndpointStatus(
        getCache(characterCaches, characterId, sessionId).currentShip,
      ) ?? {
        status: "cached" as const,
        hasBody: false,
      },
      clones: toClientEndpointStatus(getCache(characterCaches, characterId, sessionId).clones) ?? {
        status: "cached" as const,
        hasBody: false,
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
