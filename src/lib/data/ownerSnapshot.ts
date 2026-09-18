import { createHash } from "node:crypto";
import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  CharacterSkillRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
import { getAssetsForCharacter, getAssetsForCorporation, type OwnerAssetData } from "./assets";
import { getJobsForCharacter, getJobsForCorporation, type OwnerJobsResponse } from "./jobs";
import {
  getMarketOrdersForCharacter,
  getMarketOrdersForCorporation,
  type MarketOrderOptions,
  type OwnerMarketOrder,
  type OwnerMarketOrdersResponse,
} from "./marketOrders";
import {
  getShipsForCharacter,
  getShipsForCorporation,
  type OwnerShipItem,
  type OwnerShipsResponse,
} from "./ships";
import { getOwnerSnapshotEndpointStatuses, getOwnerSnapshotSkills } from "@/lib/esi/cache";
import type { ClientIndustrySlots } from "@/lib/client/requestCache";
import type { DataOwner, OwnerDataContext } from "./types";

export type OwnerSnapshotLocation = AssetLocation;
export type OwnerSnapshotCorporationSourceLocation = AssetLocation & {
  systemName?: string;
};

export type OwnerSnapshotAsset = Omit<
  AssetRecord,
  "name" | "rootLocation" | "containerId" | "rootLocationId" | "hangarId"
> & {
  containerId: number;
  rootLocationId: number | null;
  hangarId: number | null;
  rootLocation?: OwnerSnapshotAsset | OwnerSnapshotLocation;
};

export type OwnerSnapshotJob = Omit<
  NonNullable<OwnerJobsResponse["jobs"]>[number],
  "activity" | "blueprintTypeName" | "productTypeName"
>;

export type OwnerSnapshotShip = Omit<
  NonNullable<OwnerShipsResponse["ships"]>[number],
  "systemName" | "pilotName" | "locationName" | "items"
> & {
  items: OwnerSnapshotShipItem[];
};

export type OwnerSnapshotShipItem = Omit<
  OwnerShipItem,
  "name" | "containerId" | "rootLocationId" | "hangarId"
> & {
  containerId: number;
  rootLocationId: number | null;
  hangarId: number | null;
};

export type OwnerSnapshotData = {
  schemaVersion: 5;
  owner: DataOwner;
  assets: OwnerSnapshotAsset[];
  industryJobs: IndustryJobRecord[];
  blueprintInstances: BlueprintInstanceRecord[];
  rootLocations: Array<{ itemId: number; location: OwnerSnapshotLocation }>;
  corporationSources: Array<{
    corporationId: number;
    rootLocationId: number;
    locationFlag: string;
    label: string;
    rootLocation?: OwnerSnapshotCorporationSourceLocation;
    canTake: boolean;
    canQuery: boolean;
    selected: boolean;
    containerItemIds: number[];
    containers: Array<{
      itemId: number;
      name?: string;
      locationId: number;
      rootLocationId: number;
      selected: boolean;
    }>;
  }>;
  jobs: OwnerSnapshotJob[];
  marketOrders: OwnerMarketOrder[];
  ships: OwnerSnapshotShip[];
  skills: CharacterSkillRecord[];
};

export type OwnerSnapshotSlice<T extends readonly unknown[]> = {
  eTag: string;
  isEmpty: boolean;
  isModified: boolean;
  status: OwnerSnapshotEndpointStatus;
  data?: T;
};

export type OwnerSnapshotEndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
  hasBody: boolean;
  lastModified?: string;
  lastUpdated?: string;
  expires?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
};

export type OwnerSnapshotEtags = Partial<{
  assets: string;
  blueprintInstances: string;
  corporationSources: string;
  industryJobs: string;
  jobs: string;
  marketOrders: string;
  rootLocations: string;
  ships: string;
  skills: string;
}>;

export type OwnerSnapshot = {
  schemaVersion: 5;
  owner: DataOwner;
  industrySlots?: ClientIndustrySlots;
  assets: OwnerSnapshotSlice<OwnerSnapshotData["assets"]>;
  blueprintInstances: OwnerSnapshotSlice<OwnerSnapshotData["blueprintInstances"]>;
  corporationSources: OwnerSnapshotSlice<OwnerSnapshotData["corporationSources"]>;
  industryJobs: OwnerSnapshotSlice<OwnerSnapshotData["industryJobs"]>;
  jobs: OwnerSnapshotSlice<OwnerSnapshotData["jobs"]>;
  marketOrders: OwnerSnapshotSlice<OwnerSnapshotData["marketOrders"]>;
  rootLocations: OwnerSnapshotSlice<OwnerSnapshotData["rootLocations"]>;
  ships: OwnerSnapshotSlice<OwnerSnapshotData["ships"]>;
  skills: OwnerSnapshotSlice<OwnerSnapshotData["skills"]>;
};

function snapshotLocation(location: AssetLocation): OwnerSnapshotLocation {
  const { discoveredByCharacterId: _discoveredByCharacterId, ...stableLocation } = location;
  return stableLocation;
}

function snapshotAsset(asset: AssetRecord): OwnerSnapshotAsset {
  const { name: _name, rootLocation, ...stableAsset } = asset;
  return {
    ...stableAsset,
    containerId: asset.containerId ?? asset.locationId,
    rootLocationId:
      asset.rootLocationId
      ?? (rootLocation && "kind" in rootLocation ? rootLocation.locationId : null),
    hangarId: asset.hangarId ?? null,
    ...(rootLocation
      ? {
          rootLocation:
            "kind" in rootLocation ? snapshotLocation(rootLocation) : snapshotAsset(rootLocation),
        }
      : {}),
  };
}

function snapshotAssets(data: OwnerAssetData) {
  return {
    assets: data.assets.map(snapshotAsset),
    industryJobs: data.jobs,
    blueprintInstances: data.blueprintInstances.map(
      ({ discoveredByCharacterId: _discoveredByCharacterId, ...blueprint }) => blueprint,
    ),
    rootLocations: [...data.rootLocationsByItemId].map(([itemId, location]) => ({
      itemId,
      location: snapshotLocation(location),
    })),
    corporationSources: data.corporationSources.map((source) => ({
      corporationId: source.corporationId,
      rootLocationId: source.rootLocationId,
      locationFlag: source.locationFlag,
      label: source.label,
      ...(source.rootLocation ? { rootLocation: { ...source.rootLocation } } : {}),
      canTake: source.canTake,
      canQuery: source.canQuery,
      selected: source.selected,
      containerItemIds: source.containers.map((container) => container.itemId),
      containers: source.containers.map(
        ({ itemId, name, locationId, rootLocationId, selected }) => ({
          itemId,
          ...(name ? { name } : {}),
          locationId,
          rootLocationId,
          selected,
        }),
      ),
    })),
  };
}

function snapshotJobs(data: OwnerJobsResponse): OwnerSnapshotData["jobs"] {
  return data.jobs.map(
    ({
      activity: _activity,
      blueprintTypeName: _blueprintTypeName,
      productTypeName: _productTypeName,
      discoveredByCharacterId: _discoveredByCharacterId,
      ...job
    }) => job,
  );
}

function snapshotMarketOrders(data: OwnerMarketOrdersResponse): OwnerSnapshotData["marketOrders"] {
  return data;
}

function snapshotShipItem(item: OwnerShipItem): OwnerSnapshotShipItem {
  const { name: _name, ...stableItem } = item;
  return {
    ...stableItem,
    containerId: item.containerId ?? item.locationId,
    rootLocationId: item.rootLocationId ?? null,
    hangarId: item.hangarId ?? null,
  };
}

function snapshotShips(data: OwnerShipsResponse): OwnerSnapshotData["ships"] {
  return data.ships.map(
    ({
      systemName: _systemName,
      pilotName: _pilotName,
      locationName: _locationName,
      items,
      ...ship
    }) => ({
      ...ship,
      items: items.map(snapshotShipItem),
    }),
  );
}

function buildOwnerSnapshot(
  owner: DataOwner,
  assets: OwnerAssetData,
  jobs: OwnerJobsResponse,
  marketOrders: OwnerMarketOrdersResponse,
  ships: OwnerShipsResponse,
  skills: CharacterSkillRecord[],
): OwnerSnapshotData {
  return {
    schemaVersion: 5,
    owner,
    ...snapshotAssets(assets),
    jobs: snapshotJobs(jobs),
    marketOrders: snapshotMarketOrders(marketOrders),
    ships: snapshotShips(ships),
    skills,
  };
}

function createETag(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function createSnapshotSlice<T extends readonly unknown[]>(
  data: T,
  previousETag: string | undefined,
  isEmpty: boolean,
  status: OwnerSnapshotEndpointStatus,
) {
  const eTag = createETag(data);
  const isModified = isEmpty || previousETag !== eTag;
  return {
    eTag,
    isEmpty,
    isModified,
    status,
    ...(isModified ? { data } : {}),
  } satisfies OwnerSnapshotSlice<T>;
}

function snapshotResponse(
  data: OwnerSnapshotData,
  previousETags: OwnerSnapshotEtags,
  endpointStatuses: ReturnType<typeof getOwnerSnapshotEndpointStatuses>,
  industrySlots?: ClientIndustrySlots,
): OwnerSnapshot {
  return {
    schemaVersion: data.schemaVersion,
    owner: data.owner,
    ...(industrySlots ? { industrySlots } : {}),
    assets: createSnapshotSlice(
      data.assets,
      previousETags.assets,
      data.assets.length === 0,
      endpointStatuses.assets,
    ),
    blueprintInstances: createSnapshotSlice(
      data.blueprintInstances,
      previousETags.blueprintInstances,
      data.blueprintInstances.length === 0,
      endpointStatuses.blueprintInstances,
    ),
    corporationSources: createSnapshotSlice(
      data.corporationSources,
      previousETags.corporationSources,
      data.corporationSources.length === 0,
      endpointStatuses.corporationSources,
    ),
    industryJobs: createSnapshotSlice(
      data.industryJobs,
      previousETags.industryJobs,
      data.industryJobs.length === 0,
      endpointStatuses.industryJobs,
    ),
    jobs: createSnapshotSlice(
      data.jobs,
      previousETags.jobs,
      data.jobs.length === 0,
      endpointStatuses.jobs,
    ),
    marketOrders: createSnapshotSlice(
      data.marketOrders,
      previousETags.marketOrders,
      data.marketOrders.length === 0,
      endpointStatuses.marketOrders,
    ),
    rootLocations: createSnapshotSlice(
      data.rootLocations,
      previousETags.rootLocations,
      data.rootLocations.length === 0,
      endpointStatuses.rootLocations,
    ),
    ships: createSnapshotSlice(
      data.ships,
      previousETags.ships,
      data.ships.length === 0,
      endpointStatuses.ships,
    ),
    skills: createSnapshotSlice(
      data.skills,
      previousETags.skills,
      data.skills.length === 0,
      endpointStatuses.skills,
    ),
  };
}

/** Builds a stable, owner-scoped snapshot from already-authorized providers. */
export async function getOwnerSnapshot(
  owner: DataOwner,
  context: OwnerDataContext,
  marketOrderOptions: MarketOrderOptions,
  previousETags: OwnerSnapshotEtags = {},
  industrySlots?: ClientIndustrySlots,
): Promise<OwnerSnapshot> {
  if (owner.kind === "character") {
    const [assets, jobs, marketOrders, ships] = await Promise.all([
      getAssetsForCharacter(owner.id, context),
      getJobsForCharacter(owner.id, context),
      getMarketOrdersForCharacter(owner.id, context, marketOrderOptions),
      getShipsForCharacter(owner.id, context),
    ]);
    return snapshotResponse(
      buildOwnerSnapshot(
        owner,
        assets,
        jobs,
        marketOrders,
        ships,
        getOwnerSnapshotSkills(owner, context.sessionId),
      ),
      previousETags,
      getOwnerSnapshotEndpointStatuses(owner, context.sessionId),
      industrySlots,
    );
  }

  const [assets, jobs, marketOrders, ships] = await Promise.all([
    getAssetsForCorporation(owner.id, context),
    getJobsForCorporation(owner.id, context),
    getMarketOrdersForCorporation(owner.id, context, marketOrderOptions),
    getShipsForCorporation(owner.id, context),
  ]);
  return snapshotResponse(
    buildOwnerSnapshot(
      owner,
      assets,
      jobs,
      marketOrders,
      ships,
      getOwnerSnapshotSkills(owner, context.sessionId),
    ),
    previousETags,
    getOwnerSnapshotEndpointStatuses(owner, context.sessionId),
  );
}
