import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getShipAssets } from "@/lib/esi/cache";
import {
  getMarketGroups,
  getShipTypeIds,
  getStations,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";

function isAmmunitionType(
  typeId: number,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
) {
  let marketGroupId = types.get(typeId)?.marketGroupID;
  while (marketGroupId !== undefined) {
    const marketGroup = marketGroups.get(marketGroupId);
    if (!marketGroup) return false;
    if (marketGroup.name.en === "Ammunition & Charges") return true;
    marketGroupId = marketGroup.parentGroupID;
  }
  return false;
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const [assets, shipTypeIds, stations, systems, marketGroups] = await Promise.all([
    getShipAssets(session.characterIds, true),
    getShipTypeIds(),
    getStations(),
    getSystems(),
    getMarketGroups(),
  ]);
  const types = await getTypesByIds([...new Set(assets.map((asset) => asset.typeId))]);
  const annotatedAssets = assets.map((asset) => ({
    ...asset,
    isAmmo: isAmmunitionType(asset.typeId, types, marketGroups),
  }));
  const ships = annotatedAssets
    .filter((asset) => asset.isSingleton && shipTypeIds.has(asset.typeId))
    .map((asset) => {
      const root = asset.rootLocation && "kind" in asset.rootLocation ? asset.rootLocation : undefined;
      const station = asset.locationType === "station" ? stations.get(asset.locationId) : undefined;
      const systemId = root?.systemId ?? station?.solarSystemID ??
        (asset.locationType === "solar_system" ? asset.locationId : undefined);
      return {
        itemId: asset.itemId,
        typeId: asset.typeId,
        name: asset.name,
        systemId,
        systemName: systemId === undefined ? undefined : systems.get(systemId)?.name.en,
      };
    });
  return NextResponse.json({
    assets: annotatedAssets,
    ships,
    types: [...types.values()].map((type) => ({
      typeId: type._key,
      name: type.name.en,
    })),
  });
}