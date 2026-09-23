import {
  getMarketGroups,
  getShipTypeIds,
  getStations,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { getCharacter } from "@/lib/auth/tokensStore";
import { getShipAssets } from "@/lib/esi/cache";
import type { AssetLocation, AssetRecord } from "@/lib/auth/model";
import {
  assertCharacterOwner,
  assertCorporationOwner,
  getCorporationPolicy,
  type OwnerDataContext,
} from "./types";

export type OwnerShipsResponse = {
  ships: OwnerShip[];
  types: Array<{ typeId: number; name: string }>;
};

export type OwnerShipItem = Omit<AssetRecord, "ownerType" | "ownerId" | "rootLocation"> & {
  isAmmo: boolean;
};

export type OwnerShip = {
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
  rootLocation?: AssetLocation;
  items: OwnerShipItem[];
};

/** Returns every asset whose location hierarchy eventually reaches the given ship. */
export function getAssetsContainedByShip<T extends Pick<AssetRecord, "itemId" | "locationId">>(
  shipItemId: number,
  assets: readonly T[],
): T[] {
  const assetsByItemId = new Map(assets.map((asset) => [asset.itemId, asset]));
  return assets.filter((asset) => {
    if (asset.itemId === shipItemId) return false;
    const visited = new Set<number>();
    let locationId = asset.locationId;
    while (!visited.has(locationId)) {
      if (locationId === shipItemId) return true;
      visited.add(locationId);
      const parent = assetsByItemId.get(locationId);
      if (!parent) return false;
      locationId = parent.locationId;
    }
    return false;
  });
}

function rootLocationForAsset(asset: AssetRecord) {
  let locationOrAsset = asset.rootLocation;
  const visited = new Set<number>();
  while (locationOrAsset) {
    if ("kind" in locationOrAsset) return locationOrAsset;
    if (visited.has(locationOrAsset.itemId)) return undefined;
    visited.add(locationOrAsset.itemId);
    locationOrAsset = locationOrAsset.rootLocation;
  }
  return undefined;
}

async function buildShipsResponse(
  assets: AssetRecord[],
  characterIds: readonly number[],
): Promise<OwnerShipsResponse> {
  const [shipTypeIds, stations, systems, marketGroups, characters] = await Promise.all([
    getShipTypeIds(),
    getStations(),
    getSystems(),
    getMarketGroups(),
    Promise.all(characterIds.map((id) => getCharacter(id))),
  ]);
  const characterNamesById = new Map(
    characters
      .filter((character) => character !== null)
      .map((character) => [character.characterId, character.characterName]),
  );
  const types = await getTypesByIds([...new Set(assets.map((asset) => asset.typeId))]);
  const annotatedAssets = assets.map((asset) => ({
    ...asset,
    isAmmo: isAmmunitionType(asset.typeId, types, marketGroups),
  }));
  const ships = annotatedAssets
    .filter((asset) => asset.isSingleton && shipTypeIds.has(asset.typeId))
    .map((asset) => {
      const root = rootLocationForAsset(asset);
      const station = asset.locationType === "station" ? stations.get(asset.locationId) : undefined;
      const systemId =
        root?.systemId
        ?? station?.solarSystemID
        ?? (asset.locationType === "solar_system" ? asset.locationId : undefined);
      const systemName = systemId === undefined ? undefined : systems.get(systemId)?.name.en;
      const isInSpace = asset.locationType === "solar_system";
      const isPiloted = isInSpace && asset.locationFlag === "Pilot";
      return {
        itemId: asset.itemId,
        typeId: asset.typeId,
        name: asset.name,
        systemId,
        systemName,
        ...(isInSpace
          ? {
              isInSpace: true,
              pilotId: asset.ownerId,
              pilotName: characterNamesById.get(asset.ownerId) ?? `Character ${asset.ownerId}`,
              locationName: systemName ?? `System ${systemId}`,
            }
          : {}),
        ownerType: asset.ownerType,
        ownerId: asset.ownerId,
        ...(root ? { rootLocation: root } : {}),
        ...(isInSpace ? { isInSpace: true } : {}),
        ...(isPiloted
          ? {
              pilotId: asset.ownerId,
              pilotName: characterNamesById.get(asset.ownerId) ?? `Character ${asset.ownerId}`,
              locationName: systemName ?? `System ${systemId}`,
            }
          : {}),
        items: getAssetsContainedByShip(asset.itemId, annotatedAssets).map(
          ({ ownerType: _ownerType, ownerId: _ownerId, rootLocation: _rootLocation, ...item }) =>
            item,
        ),
      } satisfies OwnerShip;
    });
  return {
    ships,
    types: [...types.values()].map((type) => ({
      typeId: type._key,
      name: type.name.en,
    })),
  };
}

/** Determines whether an item belongs to the ammunition market-group tree. */
export function isAmmunitionType(
  typeId: number,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
): boolean {
  let marketGroupId = types.get(typeId)?.marketGroupID;
  while (marketGroupId !== undefined) {
    const marketGroup = marketGroups.get(marketGroupId);
    if (!marketGroup) return false;
    if (marketGroup.name.en === "Ammunition & Charges") return true;
    marketGroupId = marketGroup.parentGroupID;
  }
  return false;
}

/** Builds the current ship projection for one attached character. */
export async function getShipsForCharacter(
  characterId: number,
  context: OwnerDataContext,
): Promise<OwnerShipsResponse> {
  assertCharacterOwner(characterId, context);
  const assets = await getShipAssets([characterId], false, context.sessionId);
  return buildShipsResponse(assets, [characterId]);
}

/** Builds the current ship projection for one authorized corporation. */
export async function getShipsForCorporation(
  corporationId: number,
  context: OwnerDataContext,
): Promise<OwnerShipsResponse> {
  assertCorporationOwner(corporationId, context);
  const policy = getCorporationPolicy(corporationId, context);
  const assets = await getShipAssets(
    [...context.characterIds],
    true,
    context.sessionId,
    policy ? [policy] : [],
  );
  return buildShipsResponse(
    assets.filter((asset) => asset.ownerType === "corporation" && asset.ownerId === corporationId),
    context.characterIds,
  );
}
