import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getResolvedAssetIndex, getResolvedAssets, getRunningIndustryJobs } from "@/lib/esi/cache";
import { fetchLocationMetadata, getUsableToken } from "@/lib/esi/client";
import { getCharacter } from "@/lib/auth/tokensStore";
import {
  getGroups,
  getMarketGroups,
  getBuildBlueprintByProductTypeId,
  getShipTypeIds,
  getStations,
  getStructureTypeIds,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType } from "@/lib/reference/category";
import type { AssetLocation, AssetRecord, IndustryJobRecord } from "@/lib/auth/model";

type TerminalLocation = {
  locationId: number;
  kind: "station" | "structure" | "anchored";
  typeId?: number;
  name?: string;
  systemId?: number;
  regionId?: number;
  resolved?: boolean;
};

type StockItem = {
  typeId: number;
  name: string;
  quantity: number;
  isPackaged: boolean;
  runCount?: number;
  me?: number;
  te?: number;
  blueprintPrints?: Array<{
    itemId: number;
    runs: number;
    me?: number;
    te?: number;
    activity?: string;
  }>;
  assembledVolume: number;
  packagedVolume?: number;
  techLevel?: number;
  category: string;
  marketCategory?: string;
  inBuild?: boolean;
  inBuildQuantity?: number;
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
  jobRuns?: number;
  endDate?: string;
};

type StockBucket = {
  locationId: number;
  name: string;
  locationType: "station" | "structure" | "anchored";
  typeId?: number;
  systemId?: number;
  systemName?: string;
  securityStatus?: number;
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
  blueprintPrint?: {
    itemId: number;
    runs: number;
    me?: number;
    te?: number;
    activity?: string;
    endDate?: string;
  };
  inBuild?: boolean;
  inUse?: boolean;
  job?: IndustryJobRecord;
  blueprintIsOriginal?: boolean;
  blueprintRunsAtInstall?: number;
  blueprintRunsUsed?: number;
  blueprintRunsRemaining?: number;
  activityName?: string;
  jobRuns?: number;
};

function isDirectLocation(asset: AssetRecord): asset is AssetRecord & {
  rootLocation: AssetLocation;
} {
  return asset.rootLocation !== undefined && "kind" in asset.rootLocation;
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

function shouldIncludeAsset(asset: AssetRecord, shipTypeIds: Set<number>) {
  if (asset.isSingleton && shipTypeIds.has(asset.typeId)) return false;
  return true;
}

function createRootLocationIndex(assets: AssetRecord[]) {
  const locations = new Map<number, TerminalLocation>();
  for (const asset of assets) {
    if (!isDirectLocation(asset)) continue;
    const root = asset.rootLocation;
    const kind: TerminalLocation["kind"] = root.kind === "solar_system"
      ? "anchored"
      : root.kind === "station"
        ? "station"
        : "structure";
    locations.set(root.locationId, {
      ...(root.kind !== "solar_system" ? root : {}),
      locationId: root.locationId,
      kind,
      ...(root.kind === "solar_system"
        ? { systemId: root.locationId, resolved: true }
        : {}),
    });
  }
  return locations;
}

function normalizeLocationKinds(
  locations: Map<number, TerminalLocation>,
  stations: Awaited<ReturnType<typeof getStations>>,
  structureTypeIds: Set<number>,
) {
  const stationTypeIds = new Set([...stations.values()].map((station) => station.typeID));
  for (const [locationId, location] of locations) {
    if (location.kind === "anchored") continue;
    if (location.typeId !== undefined && stationTypeIds.has(location.typeId)) {
      locations.set(locationId, { ...location, kind: "station" });
    } else if (location.typeId !== undefined && structureTypeIds.has(location.typeId)) {
      locations.set(locationId, { ...location, kind: "structure" });
    }
  }
}

async function resolveUnknownLocations(
  locations: Map<number, TerminalLocation>,
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
            ...(result.data.type_id !== undefined ? { typeId: result.data.type_id } : {}),
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
  location: TerminalLocation,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  groups: Awaited<ReturnType<typeof getGroups>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
  language: SdeLanguage,
  systems: Awaited<ReturnType<typeof getSystems>>,
) {
  if (location.kind !== "anchored" && location.typeId === undefined) return;
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
      name:
        location.kind === "anchored"
          ? "Anchored"
          : (location.name ?? `Location ${location.locationId}`),
      locationType: location.kind,
      typeId: location.typeId,
      systemId: location.systemId,
      systemName: location.systemId ? systems.get(location.systemId)?.name.en : undefined,
      securityStatus: location.systemId === undefined ? undefined : systems.get(location.systemId)?.securityStatus,
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
    techLevel: type.techLevel,
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
  if (contribution.blueprintPrint) {
    item.blueprintPrints = [...(item.blueprintPrints ?? []), contribution.blueprintPrint];
  }
  if (contribution.inBuild) {
    item.inBuildQuantity = (item.inBuildQuantity ?? 0) + contribution.quantity;
    item.inBuild = true;
    if (contribution.itemId === contribution.job?.blueprintId) {
      item.jobRuns = (item.jobRuns ?? 0) + (contribution.job?.runs ?? 0);
    }
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
  productQuantityPerRun = 1,
): StockContribution[] {
  const isCopying = job.activityId === 5;
  const installedRuns =
    blueprint?.runCount !== undefined && blueprint.runCount >= 0
      ? blueprint.runCount
      : job.licensedRuns !== undefined && job.licensedRuns >= 0
        ? job.licensedRuns
        : -1;
  const remainingRuns = installedRuns === -1
    ? -1
    : isCopying
      ? undefined
      : Math.max(0, installedRuns - job.runs);
  const contributions: StockContribution[] = [
    {
      itemId: job.blueprintId,
      typeId: job.blueprintTypeId,
      quantity: 1,
      isPackaged: true,
      ownerType: job.ownerType,
      ...(remainingRuns !== undefined ? { runCount: remainingRuns } : {}),
      inBuild: true,
      inUse: true,
      job,
      blueprintIsOriginal: installedRuns === -1,
      blueprintRunsAtInstall: installedRuns,
      blueprintRunsUsed: job.runs,
      ...(remainingRuns !== undefined ? { blueprintRunsRemaining: remainingRuns } : {}),
      activityName: activityName(job.activityId),
      ...(installedRuns >= 0 && !isCopying
        ? {
            blueprintPrint: {
              itemId: job.blueprintId,
              runs: Math.max(0, installedRuns - job.runs),
              me: blueprint?.me,
              te: blueprint?.te,
              activity: activityName(job.activityId),
              endDate: job.endDate,
            },
          }
        : {}),
    },
  ];
  if (job.productTypeId && job.successfulRuns !== 0) {
    const outputRuns = job.successfulRuns ?? job.runs;
    const outputQuantity = job.activityId === 5 || job.activityId === 8
      ? outputRuns
      : outputRuns * productQuantityPerRun;
    contributions.push({
      itemId: job.jobId,
      typeId: job.productTypeId,
      quantity: outputQuantity,
      isPackaged: false,
      ownerType: job.ownerType,
      ...(job.activityId === 5 && job.licensedRuns !== undefined
        ? { runCount: outputQuantity * job.licensedRuns }
        : {}),
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
  const [assets, jobs, shipTypeIds, structureTypeIds, groups, marketGroups, stations, systems] =
    await Promise.all([
      getResolvedAssets(session.characterIds, true),
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
  const rootLocations = createRootLocationIndex(assets);
  normalizeLocationKinds(rootLocations, stations, structureTypeIds);
  await resolveUnknownLocations(rootLocations, structureTypeIds, stations, types, session.characterIds);
  normalizeLocationKinds(rootLocations, stations, structureTypeIds);
  const buckets = new Map<number, StockBucket>();
  const productQuantities = new Map<number, number>();
  await Promise.all(
    [...new Set(jobs.flatMap((job) =>
      job.productTypeId !== undefined ? [job.productTypeId] : [],
    ))].map(async (productTypeId) => {
      const buildBlueprint = await getBuildBlueprintByProductTypeId(productTypeId);
      const product = buildBlueprint?.activity === "manufacturing"
        ? buildBlueprint.blueprint.activities.manufacturing?.products?.find(
            (candidate) => candidate.typeID === productTypeId,
          )
        : buildBlueprint?.blueprint.activities.reaction?.products?.find(
            (candidate) => candidate.typeID === productTypeId,
          );
      if (product?.quantity && product.quantity > 0) {
        productQuantities.set(productTypeId, product.quantity);
      }
    }),
  );
  const allAssetIndex = await getResolvedAssetIndex(session.characterIds, true);
  for (const asset of assets) {
    if (!shouldIncludeAsset(asset, shipTypeIds) || !isDirectLocation(asset)) continue;
    const terminal = rootLocations.get(asset.rootLocation.locationId);
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
          ...(asset.runCount !== undefined && asset.runCount >= 0
            ? {
                blueprintPrint: {
                  itemId: asset.itemId,
                  runs: asset.runCount,
                  me: asset.me,
                  te: asset.te,
                },
              }
            : {}),
      },
      terminal,
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
    const blueprintLocation = blueprint && isDirectLocation(blueprint)
      ? rootLocations.get(blueprint.rootLocation.locationId)
      : rootLocations.get(job.locationId);
    if (
      !blueprintLocation ||
      (blueprintLocation.typeId !== undefined && shipTypeIds.has(blueprintLocation.typeId))
    )
      continue;
    for (const [index, contribution] of jobContributions(
      job,
      blueprint,
      job.productTypeId !== undefined ? productQuantities.get(job.productTypeId) : undefined,
    ).entries()) {
      const location =
        index === 0
          ? blueprintLocation
          : (rootLocations.get(job.outputLocationId) ?? rootLocations.get(job.locationId));
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
