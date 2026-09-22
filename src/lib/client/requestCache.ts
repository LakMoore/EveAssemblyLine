import type { PlanStockItem, StockItem } from "@/lib/planning/types";
import type { Facility, FacilityResponse } from "@/lib/planning/facilities";
import type { SdeLanguage } from "@/lib/reference/languages";
import { formatLocationName, normalizeLocationName } from "@/lib/reference/locationName";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { volumeForItem } from "@/lib/planning/volume";
import {
  loadOwnerSnapshots,
  type ClientOwner,
  type ClientOwnerSnapshot,
} from "./ownerSnapshotCache";
import {
  projectOwnerSnapshotsToClientAssets,
  projectOwnerSnapshotsToClientJobs,
  projectOwnerSnapshotsToClientShips,
} from "./ownerSnapshotProjection";

export type ClientSession = {
  authenticated?: boolean;
  snapshotScope?: string;
  characters?: Array<ClientCharacter & ClientCharacterStatus>;
};

export type ClientCharacterState = { characters?: ClientCharacterStatus[] };

export type ClientRefreshEventDetail = {
  refreshedAt: string;
  state?: ClientCharacterState;
  assets?: ClientAssetsResponse;
  jobs?: ClientJobsResponse;
  assetLocations?: Array<{
    locationId: number;
    name: string;
    systemId?: number;
    systemName?: string;
    items: PlanStockItem[];
  }>;
  corporationSources?: ClientCorporationSource[];
  ships?: ClientShipsResponse | null;
  ownerSnapshots?: ClientOwnerSnapshot[];
};

export type ClientAssetsResponse = {
  assets?: StockItem[];
  marketBuyOrderQuantities?: Record<string, number>;
  facilities?: Facility[];
  filteredLocationIds?: number[];
  corporationSources?: ClientCorporationSource[];
};

function normalizeClientLocationName(
  name: string,
  kind: "station" | "structure" | "anchored",
  systemName?: string,
) {
  if (/^Location ID \d+$/i.test(name.trim())) {
    return kind === "structure"
      ? "Structure details unavailable"
      : kind === "station"
        ? "Station details unavailable"
        : "Anchored";
  }
  return kind === "structure"
    ? formatLocationName(systemName, name)
    : normalizeLocationName(systemName, name);
}

export function normalizeClientAssetsResponse(data: ClientAssetsResponse): ClientAssetsResponse {
  const {
    locations: _legacyLocations,
    settings: _legacySettings,
    productionGroups: _legacyProductionGroups,
    ...response
  } = data as ClientAssetsResponse & {
    locations?: unknown;
    settings?: unknown;
    productionGroups?: unknown;
  };
  return {
    ...response,
    assets: response.assets ?? [],
    facilities: response.facilities ?? [],
    corporationSources: (response.corporationSources ?? []).map((source) => ({
      ...source,
      ...(source.rootLocation?.name
        ? {
            rootLocation: {
              ...source.rootLocation,
              name: normalizeClientLocationName(
                source.rootLocation.name,
                source.rootLocation.kind === "solar_system" ? "anchored" : source.rootLocation.kind,
                source.rootLocation.systemName,
              ),
            },
          }
        : {}),
    })),
  };
}

export function applyCorporationSettings(
  data: ClientAssetsResponse,
  settings: readonly ClientCorporationSettings[],
): ClientAssetsResponse {
  const settingsByCorporationId = new Map(settings.map((entry) => [entry.corporationId, entry]));
  return {
    ...data,
    corporationSources: (data.corporationSources ?? []).map((source) => {
      const corporationSettings = settingsByCorporationId.get(source.corporationId);
      if (!corporationSettings) return source;
      const selectedDirectHangar = corporationSettings.directHangars.some(
        (entry) =>
          entry.rootLocationId === source.rootLocationId
          && entry.locationFlag === source.locationFlag,
      );
      const selectedContainerIds = new Set(corporationSettings.containerItemIds);
      return {
        ...source,
        selected: corporationSettings.supportEnabled && selectedDirectHangar,
        containers: source.containers.map((container) => ({
          ...container,
          selected:
            corporationSettings.supportEnabled && selectedContainerIds.has(container.itemId),
        })),
      };
    }),
  };
}

export function isCompleteClientAssetsResponse(value: unknown): value is ClientAssetsResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as ClientAssetsResponse;
  return (
    Array.isArray(response.assets)
    && Array.isArray(response.facilities)
    && Array.isArray(response.corporationSources)
  );
}

/** Applies corporation source selections before stock is sent to the planning service. */
export function filterClientAssetsForPlanning(data: ClientAssetsResponse): ClientAssetsResponse {
  const selectedSources = new Set(
    (data.corporationSources ?? [])
      .filter((source) => source.selected)
      .map((source) => `${source.corporationId}:${source.rootLocationId}:${source.locationFlag}`),
  );
  const selectedContainers = new Set(
    (data.corporationSources ?? []).flatMap((source) =>
      source.containers
        .filter((container) => container.selected)
        .map((container) => container.itemId),
    ),
  );
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const source of data.corporationSources ?? []) {
      for (const container of source.containers) {
        if (selectedContainers.has(container.itemId)) continue;
        if (selectedContainers.has(container.locationId)) {
          selectedContainers.add(container.itemId);
          expanded = true;
        }
      }
    }
  }
  const selectedSourceLocations = new Set(
    (data.corporationSources ?? [])
      .filter((source) => source.selected)
      .map((source) => `${source.corporationId}:${source.rootLocationId}`),
  );
  return {
    ...data,
    assets: (data.assets ?? []).filter((item) => {
      if (item.ownerType !== "corporation") return true;
      const source = item.corporationSource;
      const sourceDetails =
        source === undefined
          ? undefined
          : (data.corporationSources ?? []).find(
              (entry) =>
                entry.corporationId === item.ownerId
                && entry.rootLocationId === source.rootLocationId
                && entry.locationFlag === source.locationFlag,
            );
      if (
        sourceDetails
        && !sourceDetails.canTake
        && item.category !== "blueprint"
        && item.category !== "reactionformula"
      ) return false;
      if (item.inBuild && item.jobId !== undefined && item.locationId !== undefined) {
        const outputContainer = (data.corporationSources ?? [])
          .flatMap((candidate) => candidate.containers)
          .find((container) => container.itemId === item.locationId);
        if (outputContainer) return selectedContainers.has(outputContainer.itemId);
      }
      if (!source) {
        return Boolean(
          item.inBuild
            && item.jobId !== undefined
            && item.ownerId !== undefined
            && item.rootLocationId !== undefined
            && selectedSourceLocations.has(`${item.ownerId}:${item.rootLocationId}`),
        );
      }
      const sourceKey = `${item.ownerId}:${source.rootLocationId}:${source.locationFlag}`;
      const itemRootSourceKey =
        item.rootLocationId === undefined
          ? undefined
          : `${item.ownerId}:${item.rootLocationId}:${source.locationFlag}`;
      const directSourceSelected =
        selectedSources.has(sourceKey)
        || (itemRootSourceKey !== undefined && selectedSources.has(itemRootSourceKey));
      const directSourceLocationSelected =
        selectedSourceLocations.has(`${item.ownerId}:${source.rootLocationId}`)
        || (
          item.rootLocationId !== undefined
          && selectedSourceLocations.has(`${item.ownerId}:${item.rootLocationId}`)
        );
      return (
        source.containerItemIds.some((itemId) => selectedContainers.has(itemId))
        || (
          (source.locationFlag === "" ? directSourceLocationSelected : directSourceSelected)
          && source.containerItemIds.length === 0
        )
      );
    }),
  };
}

export type ClientCorporationSource = {
  corporationId: number;
  rootLocationId: number;
  locationFlag: string;
  label: string;
  rootLocation?: {
    locationId: number;
    kind: "station" | "structure" | "solar_system";
    name?: string;
    systemName?: string;
    typeId?: number;
    systemId?: number;
    regionId?: number;
    resolved: boolean;
  };
  canTake: boolean;
  canQuery: boolean;
  selected: boolean;
  containers: Array<{
    itemId: number;
    name?: string;
    locationId: number;
    rootLocationId: number;
    selected: boolean;
  }>;
};

export function groupClientAssetsByLocation(data: ClientAssetsResponse) {
  const facilityLocations = (data.facilities ?? [])
    .filter((facility): facility is Facility & { id: number } => typeof facility.id === "number")
    .map((facility) => {
      const items = (data.assets ?? []).filter(
        (item) => item.rootLocationId === facility.id || item.sourceLocationId === facility.id,
      );
      return {
        locationId: facility.id,
        name: facility.name,
        locationType: facility.locationType,
        typeId: facility.typeId,
        systemId: facility.systemId,
        systemName: facility.systemName,
        securityStatus: facility.securityStatus,
        resolved: true,
        assetCount: items.length,
        personalAssetCount: items.filter((item) => item.ownerType !== "corporation").length,
        corporationAssetCount: items.filter((item) => item.ownerType === "corporation").length,
        totalCount: items.reduce((total, item) => total + item.quantity, 0),
        totalVolume: items.reduce((total, item) => total + volumeForItem(item), 0),
        items,
      };
    });
  const facilityIds = new Set(facilityLocations.map((location) => location.locationId));
  const assetLocations = new Map<number, StockItem[]>();
  for (const item of data.assets ?? []) {
    const locationId = item.rootLocationId;
    if (
      locationId === undefined
      || facilityIds.has(locationId)
      || item.sourceLocationKind === "anchored"
    ) continue;
    const items = assetLocations.get(locationId) ?? [];
    items.push(item);
    assetLocations.set(locationId, items);
  }
  const resolvedAssetLocations = [...assetLocations].flatMap(([locationId, items]) => {
    const firstItem = items.find((item) => item.sourceLocationName !== undefined);
    if (
      !firstItem?.sourceLocationName
      || !firstItem.sourceLocationKind
      || firstItem.sourceLocationKind === "anchored"
    ) return [];
    return [
      {
        locationId,
        name: firstItem.sourceLocationName,
        locationType: firstItem.sourceLocationKind,
        typeId: undefined,
        systemId: firstItem.sourceSystemId,
        systemName: firstItem.sourceSystemName,
        securityStatus: undefined,
        resolved: items.every((item) => item.sourceLocationName !== undefined),
        assetCount: items.length,
        personalAssetCount: items.filter((item) => item.ownerType !== "corporation").length,
        corporationAssetCount: items.filter((item) => item.ownerType === "corporation").length,
        totalCount: items.reduce((total, item) => total + item.quantity, 0),
        totalVolume: items.reduce((total, item) => total + volumeForItem(item), 0),
        items,
      },
    ];
  });
  const anchoredItemsBySystem = new Map<number, StockItem[]>();
  for (const item of data.assets ?? []) {
    if (
      item.sourceLocationKind !== "anchored"
      || item.sourceSystemId === undefined
      || facilityIds.has(item.rootLocationId ?? -1)
    ) continue;
    const items = anchoredItemsBySystem.get(item.sourceSystemId) ?? [];
    items.push(item);
    anchoredItemsBySystem.set(item.sourceSystemId, items);
  }
  const anchoredLocations = [...anchoredItemsBySystem].map(([systemId, items]) => ({
    locationId: systemId,
    name: items[0]?.sourceSystemName ?? `System ${systemId}`,
    locationType: "anchored" as const,
    systemId,
    systemName: items[0]?.sourceSystemName ?? `System ${systemId}`,
    resolved: items.every((item) => item.sourceSystemName !== undefined),
    assetCount: items.length,
    personalAssetCount: items.filter((item) => item.ownerType !== "corporation").length,
    corporationAssetCount: items.filter((item) => item.ownerType === "corporation").length,
    totalCount: items.reduce((total, item) => total + item.quantity, 0),
    totalVolume: items.reduce((total, item) => total + volumeForItem(item), 0),
    items,
  }));
  return [...facilityLocations, ...resolvedAssetLocations, ...anchoredLocations];
}

export type ClientShipItem = {
  itemId: number;
  typeId: number;
  name?: string;
  quantity: number;
  locationId: number;
  locationType: string;
  locationFlag: string;
  isSingleton: boolean;
  isAmmo: boolean;
};

export type ClientShip = {
  itemId: number;
  typeId: number;
  name?: string;
  systemId?: number;
  systemName?: string;
  isInSpace?: boolean;
  pilotId?: number;
  pilotName?: string;
  locationName?: string;
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
  items: ClientShipItem[];
};

export type ClientShipsResponse = {
  ships?: ClientShip[];
  types?: Array<{ typeId: number; name: string }>;
};

export type ClientJobsResponse = {
  slotUsage?: Record<
    string,
    {
      slots: Record<string, number>;
      availableSlots: Record<string, number>;
    }
  >;
  jobs?: Array<{
    jobId: number;
    characterId: number;
    ownerId: number;
    ownerType: "character" | "corporation";
    activity: string;
    status: string;
    runs: number;
    outputQuantity: number;
    outputRunsPerCopy?: number;
    usesBpo?: boolean;
    startDate: string;
    endDate: string;
    facilityId: number;
    outputLocationId: number;
    outputLocationName: string;
    blueprintTypeId: number;
    blueprintTypeName?: string;
    productTypeId?: number;
    productTypeName?: string;
  }>;
};

export type ClientIndustrySlots = {
  Manufacturing: number;
  Reactions: number;
  Science: number;
};

export type ClientCharacter = {
  characterId: number;
  characterName: string;
  onDeployment: boolean;
  corporationId?: number;
  allianceId?: number;
  corporationName?: string;
  corporationRoles: string[];
  rolesAtBase: string[];
  rolesAtHq: string[];
  rolesAtOther: string[];
  hasDirectorRole: boolean;
  allowCorpRefreshOptIn: boolean;
  canManageCorpRefreshOptIn?: boolean;
  corpRefreshOptInEnabled?: boolean;
  hasAccountantRole: boolean;
  hasTraderRole: boolean;
  corporationSupportEnabled?: boolean;
};

export type ClientCorporationSettings = {
  corporationId: number;
  supportEnabled: boolean;
  directHangars: Array<{
    rootLocationId: number;
    locationFlag: string;
  }>;
  containerItemIds: number[];
};

export type ClientCharacterStatus = {
  characterId: number;
  assets?: ClientEndpointStatus;
  industrySlots?: ClientIndustrySlots;
  skills?: ClientEndpointStatus & {
    body?: Array<{ skillId: number; activeSkillLevel: number }> | null;
  };
  location?: ClientEndpointStatus;
  ship?: ClientEndpointStatus;
  clones?: ClientEndpointStatus;
  blueprints?: ClientEndpointStatus;
  jobs?: ClientEndpointStatus;
  orders?: ClientEndpointStatus;
  corporations?: Array<{
    corporationId: number;
    assets?: ClientEndpointStatus;
    blueprints?: ClientEndpointStatus;
    structures?: ClientEndpointStatus;
    jobs?: ClientEndpointStatus;
    orders?: ClientEndpointStatus;
  }>;
};

export type ClientEndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
  hasBody: boolean;
  lastModified?: string;
  lastUpdated?: string;
  expires?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
};

let sessionRequest: Promise<ClientSession> | undefined;
let sessionRefreshRequest: Promise<ClientSession> | undefined;
const assetsRequests = new Map<string, Promise<ClientAssetsResponse>>();
const assetsResponses = new Map<string, { scope: string; data: ClientAssetsResponse }>();
let assetsCacheGeneration = 0;
const facilitiesRequests = new Map<string, Promise<Facility[]>>();
const facilitiesResponses = new Map<string, Facility[]>();
let shipsRequest: Promise<ClientShipsResponse> | undefined;
let shipsResponse: ClientShipsResponse | undefined;
let jobsRequest: Promise<ClientJobsResponse> | undefined;
let jobsResponse: ClientJobsResponse | undefined;
let corporationSettingsRequest: Promise<ClientCorporationSettings[]> | undefined;
let corporationSettingsResponse: ClientCorporationSettings[] | undefined;
let ownerSnapshotsRequest: Promise<ClientOwnerSnapshot[]> | undefined;
let ownerSnapshotsScope: string | undefined;

const emptyJobsResponse: ClientJobsResponse = { slotUsage: {}, jobs: [] };

function createClientSessionRequest() {
  if (!sessionRequest) {
    const request = fetch("/api/auth/session")
      .then((response) => response.json() as Promise<ClientSession>)
      .then(async (session) => {
        if (!session.authenticated || !session.snapshotScope) return session;
        const snapshots = await loadOwnerSnapshots(
          getClientOwnerSnapshotOwners(session),
          session.snapshotScope,
        ).catch(() => []);
        const snapshotsByCharacterId = new Map(
          snapshots
            .filter((record) => record.snapshot.owner.kind === "character")
            .map((record) => [record.snapshot.owner.id, record.snapshot]),
        );
        return {
          ...session,
          characters: (session.characters ?? []).map((character) => {
            const snapshot = snapshotsByCharacterId.get(character.characterId);
            return {
              ...character,
              ...(snapshot
                ? { skills: { ...snapshot.skills.status, body: snapshot.skills.data } }
                : {}),
            };
          }),
        };
      })
      .catch((error) => {
        if (sessionRequest === request) sessionRequest = undefined;
        throw error;
      });
    sessionRequest = request;
  }
  return sessionRequest;
}

/** Returns the process-wide client session cache populated during application startup. */
export function loadClientSession() {
  return createClientSessionRequest();
}

/** Replaces the cached session once after session-affecting mutations or completed ESI refreshes. */
export function refreshClientSession() {
  if (sessionRefreshRequest) return sessionRefreshRequest;
  sessionRequest = undefined;
  const request = createClientSessionRequest();
  const refreshRequest = request.finally(() => {
    if (sessionRefreshRequest === refreshRequest) sessionRefreshRequest = undefined;
  });
  sessionRefreshRequest = refreshRequest;
  return refreshRequest;
}

function invalidateClientAssetRequests() {
  assetsCacheGeneration += 1;
  assetsRequests.clear();
  assetsResponses.clear();
}

export function loadClientAssets(language: SdeLanguage, reload = false) {
  const key = language;
  if (reload) {
    invalidateClientAssetRequests();
  }
  const pending = assetsRequests.get(key);
  if (!reload && pending) return pending;
  const generation = assetsCacheGeneration;
  let request: Promise<ClientAssetsResponse>;
  request = loadClientSession()
    .then(async (session) => {
      const scope = session.authenticated ? session.snapshotScope : undefined;
      const cachedResponse = assetsResponses.get(key);
      if (!reload && scope && cachedResponse?.scope === scope) return cachedResponse.data;
      const data = await loadClientOwnerSnapshotAssets(language, [], reload);
      const settings = await loadClientCorporationSettings();
      const resolvedData = applyCorporationSettings(data, settings);
      if (scope && generation === assetsCacheGeneration) {
        assetsResponses.set(key, { scope, data: resolvedData });
      }
      return resolvedData;
    })
    .finally(() => {
      if (assetsRequests.get(key) === request) assetsRequests.delete(key);
    });
  assetsRequests.set(key, request);
  return request;
}

export function clearClientAssetsCache(language: SdeLanguage) {
  assetsResponses.delete(language);
}

/** Returns the unique character and supported corporation owners in a client session. */
export function getClientOwnerSnapshotOwners(session: ClientSession): ClientOwner[] {
  const characterOwners = (session.characters ?? []).map((character) => ({
    kind: "character" as const,
    id: character.characterId,
  }));
  const corporationOwners = [
    ...new Set(
      (session.characters ?? [])
        .filter(
          (character) =>
            character.corporationId !== undefined && character.corporationSupportEnabled === true,
        )
        .map((character) => character.corporationId),
    ),
  ]
    .filter((id): id is number => id !== undefined)
    .map((id) => ({ kind: "corporation" as const, id }));
  return [...characterOwners, ...corporationOwners];
}

/** Loads the complete owner snapshots currently cached for the authenticated collection. */
export function loadClientOwnerSnapshots(reload = false) {
  if (reload) {
    ownerSnapshotsRequest = undefined;
    ownerSnapshotsScope = undefined;
  }
  return loadClientSession().then(async (session) => {
    if (!session.authenticated || !session.snapshotScope) return [];
    if (ownerSnapshotsRequest && ownerSnapshotsScope === session.snapshotScope) {
      return ownerSnapshotsRequest;
    }
    const owners = getClientOwnerSnapshotOwners(session);
    const request = loadOwnerSnapshots(owners, session.snapshotScope)
      .then((records) => records.map((record) => record.snapshot))
      .finally(() => {
        if (ownerSnapshotsRequest === request) ownerSnapshotsRequest = undefined;
      });
    ownerSnapshotsScope = session.snapshotScope;
    ownerSnapshotsRequest = request;
    return request;
  });
}

/** Reports whether any expected owner snapshot predates the last completed refresh. */
export async function ownerSnapshotsNeedRefresh(refreshAt: string | null) {
  if (!refreshAt) return false;
  const session = await loadClientSession();
  if (!session.authenticated || !session.snapshotScope) return false;
  const owners = getClientOwnerSnapshotOwners(session);
  const records = await loadOwnerSnapshots(owners, session.snapshotScope);
  const refreshTimestamp = Date.parse(refreshAt);
  return (
    records.length < owners.length
    || records.some((record) => {
      const savedTimestamp = Date.parse(record.savedAt);
      return !Number.isFinite(savedTimestamp) || savedTimestamp < refreshTimestamp;
    })
  );
}

/** Loads owner snapshots and enriches them into the client asset contract. */
export async function loadClientOwnerSnapshotAssets(
  language: SdeLanguage,
  facilities: readonly Facility[] = [],
  reload = false,
) {
  const snapshots = await loadClientOwnerSnapshots(reload);
  const session = await loadClientSession();
  if (!session.authenticated) {
    return { assets: [], facilities: [], corporationSources: [] } satisfies ClientAssetsResponse;
  }
  const resolvedFacilities =
    facilities.length > 0 ? [...facilities] : await loadClientFacilities(language, reload);
  const typeIds = [
    ...new Set(
      snapshots.flatMap((snapshot) => [
        ...snapshot.assets.data.map((asset) => asset.typeId),
        ...snapshot.blueprintInstances.data.map((blueprint) => blueprint.typeId),
        ...snapshot.marketOrders.data.map((order) => order.typeId),
        ...snapshot.jobs.data.flatMap((job) => [job.blueprintTypeId, job.productTypeId ?? 0]),
      ]),
    ),
  ].filter((typeId) => typeId > 0);
  const metadata = await fetchTypeMetadata(typeIds, language);
  return projectOwnerSnapshotsToClientAssets(
    snapshots,
    {
      metadata,
      facilities: resolvedFacilities,
    },
  );
}

function loadClientFacilities(language: SdeLanguage, reload = false) {
  const pending = facilitiesRequests.get(language);
  if (!reload && pending) return pending;
  if (!reload) {
    const cached = facilitiesResponses.get(language);
    if (cached) return Promise.resolve(cached);
  }
  const request = fetch(`/api/facilities?language=${language}`, { cache: "no-store" })
    .then(async (response) => {
      const data = (await response.json()) as FacilityResponse;
      if (!response.ok) throw new Error("Could not load facilities.");
      const facilities = data.facilities;
      facilitiesResponses.set(language, facilities);
      return facilities;
    })
    .finally(() => {
      if (facilitiesRequests.get(language) === request) facilitiesRequests.delete(language);
    });
  facilitiesRequests.set(language, request);
  return request;
}

async function loadClientSystemNames(systemIds: readonly number[]) {
  const entries = await Promise.all(
    systemIds.map(async (systemId) => {
      const response = await fetch(
        `/api/reference/systems?systemId=${systemId}&language=en`,
        { cache: "no-store" },
      );
      if (!response.ok) return undefined;
      const data = (await response.json()) as {
        item?: { systemId?: number; name?: string } | null;
      };
      if (data.item?.systemId !== systemId || !data.item.name) return undefined;
      return [systemId, data.item.name] as const;
    }),
  );
  return new Map(
    entries.filter((entry): entry is readonly [number, string] => entry !== undefined),
  );
}

export function loadClientShips(reload = false) {
  if (reload) shipsResponse = undefined;
  if (!reload && shipsResponse) return Promise.resolve(shipsResponse);
  shipsRequest
    ??= (async () => {
      const [session, snapshots] = await Promise.all([
        loadClientSession(),
        loadClientOwnerSnapshots(reload),
      ]);
      const typeIds = [
        ...new Set(
          snapshots.flatMap((snapshot) =>
            snapshot.ships.data.flatMap((ship) => [
              ship.typeId,
              ...ship.items.map((item) => item.typeId),
            ]),
          ),
        ),
      ];
      const systemIds = [
        ...new Set(
          snapshots.flatMap((snapshot) =>
            snapshot.ships.data.flatMap((ship) =>
              ship.systemId === undefined ? [] : [ship.systemId],
            ),
          ),
        ),
      ];
      const [metadata, systemNames] = await Promise.all([
        fetchTypeMetadata(typeIds, "en"),
        loadClientSystemNames(systemIds),
      ]);
      const characterNames = new Map(
        (session.characters ?? []).map((character) => [
          character.characterId,
          character.characterName,
        ]),
      );
      const data = projectOwnerSnapshotsToClientShips(
        snapshots,
        {
          metadata,
          characterNames,
          systemNames,
        },
      );
      shipsResponse = data;
      return data;
    })().finally(() => {
      shipsRequest = undefined;
    });
  return shipsRequest;
}

export function loadClientJobs(reload = false) {
  if (reload) jobsResponse = undefined;
  if (!reload && jobsResponse) return Promise.resolve(jobsResponse);
  if (jobsRequest) return jobsRequest;
  jobsRequest = (async () => {
    const [snapshots, state] = await Promise.all([
      loadClientOwnerSnapshots(reload),
      loadClientCharacterState(),
    ]);
    const typeIds = [
      ...new Set(
        snapshots.flatMap((snapshot) =>
          snapshot.jobs.data.flatMap((job) => [job.blueprintTypeId, job.productTypeId ?? 0]),
        ),
      ),
    ].filter((typeId) => typeId > 0);
    const metadata = await fetchTypeMetadata(typeIds, "en");
    const industrySlots = new Map(
      (state.characters ?? []).flatMap((character) =>
        character.industrySlots ? [[character.characterId, character.industrySlots] as const] : [],
      ),
    );
    const data = snapshots.length
      ? projectOwnerSnapshotsToClientJobs(snapshots, metadata, industrySlots)
      : emptyJobsResponse;
    jobsResponse = data;
    return data;
  })().finally(() => {
    jobsRequest = undefined;
  });
  return jobsRequest;
}

export function loadClientCharacters() {
  return loadClientSession().then((session) => session.characters ?? []);
}

export function loadClientCorporationSettings(reload = false) {
  if (reload) {
    corporationSettingsRequest = undefined;
    corporationSettingsResponse = undefined;
  }
  if (corporationSettingsResponse) return Promise.resolve(corporationSettingsResponse);
  corporationSettingsRequest
    ??= fetch("/api/auth/corp/settings", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { settings?: ClientCorporationSettings[] };
        if (!response.ok) throw new Error("Could not load corporation settings.");
        corporationSettingsResponse = data.settings ?? [];
        return corporationSettingsResponse;
      })
      .finally(() => {
        corporationSettingsRequest = undefined;
      });
  return corporationSettingsRequest;
}

export async function saveClientCorporationSettings(requestedSettings: ClientCorporationSettings) {
  const response = await fetch(
    "/api/auth/corp/settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestedSettings),
    },
  );
  const data = (await response.json()) as {
    settings?: unknown;
    error?: unknown;
  };
  const errorMessage =
    typeof data.error === "string" ? data.error : "Could not save corporation settings.";
  if (!response.ok) {
    throw new Error(errorMessage);
  }
  if (typeof data.settings !== "object" || data.settings === null) {
    throw new Error(errorMessage);
  }
  const settings = data.settings as ClientCorporationSettings;
  corporationSettingsResponse = [
    ...(corporationSettingsResponse ?? []).filter(
      (entry) => entry.corporationId !== settings.corporationId,
    ),
    settings,
  ];
  return settings;
}

export function loadClientCharacterState(): Promise<ClientCharacterState> {
  return loadClientSession().then(async (session) => {
    const records =
      session.authenticated && session.snapshotScope
        ? await loadOwnerSnapshots(
            getClientOwnerSnapshotOwners(session),
            session.snapshotScope,
          ).catch(() => [])
        : [];
    const snapshots = records.map((record) => record.snapshot);
    return {
      characters: (session.characters ?? []).map((character) => {
        const personalSnapshot = snapshots.find(
          (snapshot) =>
            snapshot.owner.kind === "character" && snapshot.owner.id === character.characterId,
        );
        const corporationSnapshot =
          character.corporationId === undefined
            ? undefined
            : snapshots.find(
                (snapshot) =>
                  snapshot.owner.kind === "corporation"
                  && snapshot.owner.id === character.corporationId,
              );
        return {
          characterId: character.characterId,
          industrySlots: personalSnapshot?.industrySlots,
          assets: personalSnapshot?.assets.status,
          blueprints: personalSnapshot?.blueprintInstances.status,
          clones: personalSnapshot?.clones,
          jobs: personalSnapshot?.industryJobs.status,
          location: personalSnapshot?.location,
          orders: personalSnapshot?.marketOrders.status,
          ship: personalSnapshot?.ships.status,
          skills: personalSnapshot
            ? { ...personalSnapshot.skills.status, body: personalSnapshot.skills.data }
            : undefined,
          corporations:
            character.corporationId === undefined
              ? []
              : [
                  {
                    corporationId: character.corporationId,
                    assets: corporationSnapshot?.assets.status,
                    blueprints: corporationSnapshot?.blueprintInstances.status,
                    jobs: corporationSnapshot?.industryJobs.status,
                    orders: corporationSnapshot?.marketOrders.status,
                    structures: corporationSnapshot?.corporationSources.status,
                  },
                ],
        } satisfies ClientCharacterStatus;
      }),
    };
  });
}

export function invalidateClientCharacterData() {
  invalidateClientAssetRequests();
  sessionRequest = undefined;
  sessionRefreshRequest = undefined;
  corporationSettingsResponse = undefined;
  corporationSettingsRequest = undefined;
  ownerSnapshotsRequest = undefined;
  ownerSnapshotsScope = undefined;
  jobsRequest = undefined;
  jobsResponse = undefined;
}
