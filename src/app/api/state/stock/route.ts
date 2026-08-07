import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import {
  getResolvedAssetIndex,
  getResolvedAssets,
  getResolvedContainersById,
  getRunningIndustryJobs,
} from "@/lib/esi/cache";
import { fetchLocationMetadata, getUsableToken } from "@/lib/esi/client";
import { getCharacter } from "@/lib/auth/tokensStore";
import {
  getGroups,
  getMarketGroups,
  getShipTypeIds,
  getStations,
  getStructureTypeIds,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType } from "@/lib/reference/category";
import type { AssetRecord, IndustryJobRecord } from "@/lib/auth/model";

type StockItem = {
  typeId: number;
  name: string;
  quantity: number;
  isPackaged: boolean;
  runCount?: number;
  me?: number;
  te?: number;
  assembledVolume: number;
  packagedVolume?: number;
  category: string;
  marketCategory?: string;
  inBuild?: boolean;
  inUse?: boolean;
  jobId?: number;
  installerId?: number;
  facilityId?: number;
  outputLocationId?: number;
  blueprintId?: number;
  blueprintTypeId?: number;
  blueprintIsOriginal?: boolean;
  blueprintRunsAtInstall?: number;
  blueprintRunsUsed?: number;
  blueprintRunsRemaining?: number;
  activityName?: string;
  endDate?: string;
};

type StockBucket = {
  locationId: number;
  name: string;
  locationType: "station" | "structure";
  typeId?: number;
  systemId?: number;
  systemName?: string;
  regionId?: number;
  resolved: boolean;
  assetCount: number;
  personalAssetCount: number;
  corporationAssetCount: number;
  totalCount: number;
  totalVolume: number;
  items: Map<string, StockItem>;
};

type StockContribution = {
  itemId: number;
  typeId: number;
  quantity: number;
  isPackaged: boolean;
  ownerType: "character" | "corporation";
  runCount?: number;
  me?: number;
  te?: number;
  inBuild?: boolean;
  inUse?: boolean;
  job?: IndustryJobRecord;
  blueprintIsOriginal?: boolean;
  blueprintRunsAtInstall?: number;
  blueprintRunsUsed?: number;
  blueprintRunsRemaining?: number;
  activityName?: string;
};

function isDirectLocation(
  asset: AssetRecord,
): asset is AssetRecord & { rootLocationType: "station" | "structure" } {
  return asset.rootLocationKind === "station" || asset.rootLocationKind === "structure";
}

function activityName(activityId: number) {
  return (
    (
      {
        1: "Manufacturing",
        3: "Time research",
        4: "Material research",
        5: "Copying",
        8: "Invention",
        9: "Reactions",
      } as Record<number, string>
    )[activityId] ?? "Industry job"
  );
}

function terminalContainerFor(
  asset: AssetRecord,
  containersById: Map<number, AssetRecord>,
  shipTypeIds: Set<number>,
) {
  let current = asset;
  const visited = new Set<number>();
  while (current.locationType === "item") {
    if (visited.has(current.itemId)) return undefined;
    visited.add(current.itemId);
    const parent = containersById.get(current.locationId);
    if (!parent) break;
    if (parent.location.typeId !== undefined && shipTypeIds.has(parent.location.typeId))
      return parent.location;
    current = parent;
  }
  return current.location;
}

function shouldIncludeAsset(
  asset: AssetRecord,
  containerIds: Set<number>,
  shipTypeIds: Set<number>,
) {
  if (containerIds.has(asset.itemId)) return false;
  if (asset.isSingleton && shipTypeIds.has(asset.typeId)) return false;
  return true;
}

function createLocationIndex(assets: AssetRecord[]) {
  const locations = new Map<number, AssetRecord>();
  for (const asset of assets) {
    if (isDirectLocation(asset.location)) locations.set(asset.location.locationId, asset.location);
  }
  return locations;
}

async function resolveUnknownLocations(
  locations: Map<number, AssetRecord>,
  structureTypeIds: Set<number>,
  stations: Awaited<ReturnType<typeof getStations>>,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  characterIds: number[],
) {
  const characters = await Promise.all(characterIds.map((id) => getCharacter(id)));
  const tokens = (
    await Promise.all(
      characters.map(async (character) => {
        if (!character) return [];
        const usable = [];
        try {
          usable.push(await getUsableToken(character, "personal"));
        } catch {}
        try {
          if (character.corpAuth) usable.push(await getUsableToken(character, "corp"));
        } catch {}
        return usable;
      }),
    )
  ).flat();

  for (const [locationId, location] of locations) {
    if (location.typeId !== undefined) {
      if (!location.name) {
        const typeName = types.get(location.typeId)?.name.en;
        if (typeName) locations.set(locationId, { ...location, name: typeName });
      }
      continue;
    }
    const station = stations.get(locationId);
    if (station) {
      locations.set(locationId, {
        locationId,
        kind: "station",
        typeId: station.typeID,
        name: types.get(station.typeID)?.name.en,
        systemId: station.solarSystemID,
        resolved: true,
      });
      continue;
    }
    for (const token of tokens) {
      try {
        const result = await fetchLocationMetadata(locationId, "structure", token);
        if (result.data) {
          locations.set(locationId, {
            ...location,
            kind: "structure",
            typeId: result.data.type_id,
            name: result.data.name,
            systemId: result.data.system_id,
            regionId: result.data.region_id,
            resolved: true,
          });
          break;
        }
      } catch {}
    }
    const resolved = locations.get(locationId);
    if (!resolved?.typeId || !structureTypeIds.has(resolved.typeId)) {
      console.warn("[stock] Could not resolve terminal location", {
        locationId,
        locationType: location.kind,
        typeId: resolved?.typeId,
        typeName: resolved?.typeId ? types.get(resolved.typeId)?.name.en : undefined,
      });
    }
  }
}

function addContribution(
  buckets: Map<number, StockBucket>,
  contribution: StockContribution,
  location: AssetRecord,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  groups: Awaited<ReturnType<typeof getGroups>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
  language: SdeLanguage,
  systems: Awaited<ReturnType<typeof getSystems>>,
) {
  if (!isDirectLocation(location) || location.typeId === undefined) return;
  const type = types.get(contribution.typeId);
  if (!type?.published) return;
  const categorized = categorizeType(type, language, marketGroups, groups);
  const category =
    categorized.category === "blueprint"
      ? contribution.runCount === -1
        ? "bpo"
        : "bpc"
      : categorized.category;
  const bucket =
    buckets.get(location.locationId) ??
    ({
      locationId: location.locationId,
      name: location.name ?? `Location ${location.locationId}`,
      locationType: location.kind,
      typeId: location.typeId,
      systemId: location.systemId,
      systemName: location.systemId ? systems.get(location.systemId)?.name.en : undefined,
      regionId: location.regionId,
      resolved: location.resolved !== false,
      assetCount: 0,
      personalAssetCount: 0,
      corporationAssetCount: 0,
      totalCount: 0,
      totalVolume: 0,
      items: new Map(),
    } satisfies StockBucket);
  bucket.assetCount += 1;
  if (contribution.ownerType === "corporation") bucket.corporationAssetCount += 1;
  else bucket.personalAssetCount += 1;
  const itemKey = `${contribution.typeId}:${contribution.runCount === undefined ? "item" : category}`;
  const item = bucket.items.get(itemKey) ?? {
    typeId: contribution.typeId,
    name: type.name[language] ?? type.name.en ?? `Type ${contribution.typeId}`,
    quantity: 0,
    isPackaged: contribution.isPackaged,
    assembledVolume: type.volume ?? 0,
    packagedVolume: type.packagedVolume,
    ...categorized,
    category,
  };
  item.quantity += contribution.quantity;
  item.runCount =
    item.runCount === -1 || contribution.runCount === -1
      ? -1
      : contribution.runCount === undefined
        ? item.runCount
        : (item.runCount ?? 0) + contribution.runCount;
  item.me ??= contribution.me;
  item.te ??= contribution.te;
  if (contribution.inBuild) {
    item.inBuild = true;
    item.inUse = contribution.inUse;
    item.jobId = contribution.job?.jobId;
    item.installerId = contribution.job?.installerId;
    item.facilityId = contribution.job?.facilityId;
    item.outputLocationId = contribution.job?.outputLocationId;
    item.blueprintId = contribution.job?.blueprintId;
    item.blueprintTypeId = contribution.job?.blueprintTypeId;
    item.blueprintIsOriginal = contribution.blueprintIsOriginal;
    item.blueprintRunsAtInstall = contribution.blueprintRunsAtInstall;
    item.blueprintRunsUsed = contribution.blueprintRunsUsed;
    item.blueprintRunsRemaining = contribution.blueprintRunsRemaining;
    item.activityName = contribution.activityName;
    item.endDate = contribution.job?.endDate;
  }
  bucket.items.set(itemKey, item);
  bucket.totalCount += contribution.quantity;
  bucket.totalVolume +=
    contribution.quantity *
    (contribution.isPackaged ? (type.packagedVolume ?? type.volume ?? 0) : (type.volume ?? 0));
  buckets.set(location.locationId, bucket);
}

function jobContributions(
  job: IndustryJobRecord,
  blueprint: AssetRecord | undefined,
): StockContribution[] {
  const installedRuns =
    blueprint?.runCount !== undefined && blueprint.runCount >= 0
      ? blueprint.runCount
      : job.licensedRuns !== undefined && job.licensedRuns >= 0
        ? job.licensedRuns
        : -1;
  const remainingRuns = installedRuns === -1 ? -1 : Math.max(0, installedRuns - job.runs);
  const contributions: StockContribution[] = [
    {
      itemId: job.blueprintId,
      typeId: job.blueprintTypeId,
      quantity: 1,
      isPackaged: true,
      ownerType: job.ownerType,
      runCount: remainingRuns,
      inBuild: true,
      inUse: true,
      job,
      blueprintIsOriginal: installedRuns === -1,
      blueprintRunsAtInstall: installedRuns,
      blueprintRunsUsed: job.runs,
      blueprintRunsRemaining: remainingRuns,
      activityName: activityName(job.activityId),
    },
  ];
  if (job.productTypeId && job.successfulRuns !== 0) {
    contributions.push({
      itemId: job.jobId,
      typeId: job.productTypeId,
      quantity: job.successfulRuns ?? job.runs,
      isPackaged: false,
      ownerType: job.ownerType,
      inBuild: true,
      job,
      activityName: activityName(job.activityId),
    });
  }
  return contributions;
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const url = new URL(request.url);
  const requestedLanguage = url.searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const [
    assets,
    containersById,
    jobs,
    shipTypeIds,
    structureTypeIds,
    groups,
    marketGroups,
    stations,
    systems,
  ] = await Promise.all([
    getResolvedAssets(session.characterIds, true),
    getResolvedContainersById(session.characterIds, true),
    getRunningIndustryJobs(session.characterIds, true),
    getShipTypeIds(),
    getStructureTypeIds(),
    getGroups(),
    getMarketGroups(),
    getStations(),
    getSystems(),
  ]);
  const types = await getTypesByIds([
    ...new Set([
      ...assets.map((asset) => asset.typeId),
      ...jobs.flatMap((job) =>
        [job.blueprintTypeId, job.productTypeId].filter((id): id is number => id !== undefined),
      ),
    ]),
  ]);
  const locations = createLocationIndex(assets);
  normalizeLocationKinds(locations, stations, structureTypeIds);
  await resolveUnknownLocations(locations, structureTypeIds, stations, types, session.characterIds);
  const containerIds = new Set(containersById.keys());
  const terminalByContainerId = new Map<number, AssetRecord | undefined>();
  function normalizeLocationKinds(
    locations: Map<number, AssetRecord>,
    stations: Awaited<ReturnType<typeof getStations>>,
    structureTypeIds: Set<number>,
  ) {
    const stationTypeIds = new Set([...stations.values()].map((station) => station.typeID));
    for (const [locationId, location] of locations) {
      if (location.typeId !== undefined && stationTypeIds.has(location.typeId)) {
        locations.set(locationId, { ...location, rootLocationKind: "station" });
      } else if (location.typeId !== undefined && structureTypeIds.has(location.typeId)) {
        locations.set(locationId, { ...location, rootLocationKind: "structure" });
      }
    }
  }
  for (const container of containersById.values()) {
    terminalByContainerId.set(
      container.itemId,
      terminalContainerFor(container, containersById, shipTypeIds),
    );
  }
  const buckets = new Map<number, StockBucket>();
  const allAssetIndex = await getResolvedAssetIndex(session.characterIds, true);
  for (const asset of assets) {
    if (!shouldIncludeAsset(asset, containerIds, shipTypeIds)) continue;
    const terminal =
      terminalByContainerId.get(asset.locationId) ?? asset.locationId;
    if (!terminal || (terminal.typeId !== undefined && shipTypeIds.has(terminal.typeId))) continue;
    addContribution(
      buckets,
      {
        itemId: asset.itemId,
        typeId: asset.typeId,
        quantity: asset.quantity > 0 ? asset.quantity : 1,
        isPackaged: !asset.isSingleton,
        ownerType: asset.ownerType,
        runCount: asset.runCount,
        me: asset.me,
        te: asset.te,
      },
      locations.get(terminal.locationId) ?? terminal,
      types,
      groups,
      marketGroups,
      language,
      systems,
    );
  }
  for (const job of jobs) {
    if (job.status === "cancelled" || job.status === "delivered") continue;
    const blueprint = allAssetIndex.get(job.blueprintId);
    const blueprintLocation = containersById.get(blueprint?.locationId ?? job.locationId);
    if (
      !blueprintLocation ||
      (blueprintLocation !== undefined && shipTypeIds.has(blueprintLocation.typeId))
    )
      continue;
    for (const [index, contribution] of jobContributions(job, blueprint).entries()) {
      const location =
        index === 0
          ? blueprintLocation
          : (locations.get(job.outputLocationId) ?? locations.get(job.locationId));
      if (!location || (location.typeId !== undefined && shipTypeIds.has(location.typeId)))
        continue;
      addContribution(
        buckets,
        contribution,
        location,
        types,
        groups,
        marketGroups,
        language,
        systems,
      );
    }
  }
  return NextResponse.json({
    locations: [...buckets.values()]
      .map((bucket) => ({ ...bucket, items: [...bucket.items.values()] }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}
