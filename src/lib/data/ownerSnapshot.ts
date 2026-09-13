import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
import type { PlanStockItem } from "@/lib/planning/types";
import { getAssetsForCharacter, getAssetsForCorporation, type OwnerAssetData } from "./assets";
import { getJobsForCharacter, getJobsForCorporation, type OwnerJobsResponse } from "./jobs";
import {
  getMarketOrdersForCharacter,
  getMarketOrdersForCorporation,
  type MarketOrderOptions,
  type OwnerMarketOrdersResponse,
} from "./marketOrders";
import { getShipsForCharacter, getShipsForCorporation, type OwnerShipsResponse } from "./ships";
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

export type OwnerSnapshotStockItem = Omit<PlanStockItem, "name">;

export type OwnerSnapshotJob = Omit<
  NonNullable<OwnerJobsResponse["jobs"]>[number],
  "activity" | "outputLocationName" | "blueprintTypeName" | "productTypeName"
>;

export type OwnerSnapshotShip = Omit<
  NonNullable<OwnerShipsResponse["ships"]>[number],
  "name" | "systemName" | "pilotName" | "locationName"
>;

export type OwnerSnapshot = {
  schemaVersion: 1;
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
  jobs: {
    slotUsage: OwnerJobsResponse["slotUsage"];
    jobs: OwnerSnapshotJob[];
  };
  marketOrders: {
    marketOrderStock: OwnerSnapshotStockItem[] | null;
    marketBuyOrderQuantities: Record<string, number> | null;
  };
  ships: {
    assets: OwnerSnapshotAsset[];
    ships: OwnerSnapshotShip[];
  };
};

function snapshotLocation(location: AssetLocation): OwnerSnapshotLocation {
  return { ...location };
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
    blueprintInstances: data.blueprintInstances,
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

function snapshotJobs(data: OwnerJobsResponse): OwnerSnapshot["jobs"] {
  return {
    slotUsage: data.slotUsage,
    jobs: data.jobs.map(
      ({
        activity: _activity,
        outputLocationName: _outputLocationName,
        blueprintTypeName: _blueprintTypeName,
        productTypeName: _productTypeName,
        ...job
      }) => job,
    ),
  };
}

function snapshotStockItem(item: PlanStockItem): OwnerSnapshotStockItem {
  const { name: _name, ...stableItem } = item;
  return stableItem;
}

function snapshotMarketOrders(data: OwnerMarketOrdersResponse): OwnerSnapshot["marketOrders"] {
  return {
    marketOrderStock: data.marketOrderStock?.map(snapshotStockItem) ?? null,
    marketBuyOrderQuantities: data.marketBuyOrderQuantities,
  };
}

function snapshotShips(data: OwnerShipsResponse): OwnerSnapshot["ships"] {
  return {
    assets: data.assets.map(snapshotAsset),
    ships: data.ships.map(
      ({
        name: _name,
        systemName: _systemName,
        pilotName: _pilotName,
        locationName: _locationName,
        ...ship
      }) => ship,
    ),
  };
}

function buildOwnerSnapshot(
  owner: DataOwner,
  assets: OwnerAssetData,
  jobs: OwnerJobsResponse,
  marketOrders: OwnerMarketOrdersResponse,
  ships: OwnerShipsResponse,
): OwnerSnapshot {
  return {
    schemaVersion: 1,
    owner,
    ...snapshotAssets(assets),
    jobs: snapshotJobs(jobs),
    marketOrders: snapshotMarketOrders(marketOrders),
    ships: snapshotShips(ships),
  };
}

/** Builds a stable, owner-scoped snapshot from already-authorized providers. */
export async function getOwnerSnapshot(
  owner: DataOwner,
  context: OwnerDataContext,
  marketOrderOptions: MarketOrderOptions,
): Promise<OwnerSnapshot> {
  if (owner.kind === "character") {
    const [assets, jobs, marketOrders, ships] = await Promise.all([
      getAssetsForCharacter(owner.id, context),
      getJobsForCharacter(owner.id, context),
      getMarketOrdersForCharacter(owner.id, context, marketOrderOptions),
      getShipsForCharacter(owner.id, context),
    ]);
    return buildOwnerSnapshot(owner, assets, jobs, marketOrders, ships);
  }

  const [assets, jobs, marketOrders, ships] = await Promise.all([
    getAssetsForCorporation(owner.id, context),
    getJobsForCorporation(owner.id, context),
    getMarketOrdersForCorporation(owner.id, context, marketOrderOptions),
    getShipsForCorporation(owner.id, context),
  ]);
  return buildOwnerSnapshot(owner, assets, jobs, marketOrders, ships);
}
