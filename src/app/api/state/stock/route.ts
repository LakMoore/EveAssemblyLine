import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  getResolvedAssetIndex,
  getResolvedAssets,
  getRootContainersByItemId,
  getRunningIndustryJobs,
} from "@/lib/esi/cache";
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

type RootLocation = {
  locationId: number;
  kind: "station" | "structure" | "anchored";
  typeId?: number;
  name?: string;
  systemId?: number;
  regionId?: number;
};

type StockItem = {
  typeId: number;
  name: string;
  quantity: number;
  locationId: number;
  rootLocationId: number;
  isPackaged: boolean;
  category: string;
  type?: "bpo" | "bpc";
  me?: number;
  te?: number;
  blueprintPrints?: Array<{
    itemId: number;
    runs: number;
    me?: number;
    te?: number;
    activity?: string;
    type: "bpo" | "bpc";
  }>;
  assembledVolume: number;
  packagedVolume?: number;
  techLevel?: number;
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
  licensedRuns?: number;
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
  locationId?: number;
  rootLocationId?: number;
  isPackaged: boolean;
  ownerType: "character" | "corporation";
  runCount?: number;
  me?: number;
  te?: number;
  blueprintType?: "bpo" | "bpc";
  blueprintPrint?: {
    itemId: number;
    runs: number;
    me?: number;
    te?: number;
    activity?: string;
    endDate?: string;
    type: "bpo" | "bpc";
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

function rootLocationFromAssetLocation(root: AssetLocation): RootLocation {
  return {
    locationId: root.locationId,
    kind: root.kind === "solar_system"
      ? "anchored"
      : root.kind === "station"
        ? "station"
        : "structure",
      ...(root.typeId !== undefined ? { typeId: root.typeId } : {}),
      ...(root.name !== undefined ? { name: root.name } : {}),
      ...(root.systemId !== undefined ? { systemId: root.systemId } : {}),
      ...(root.regionId !== undefined ? { regionId: root.regionId } : {}),
      ...(root.kind === "solar_system" && root.systemId === undefined
        ? { systemId: root.locationId }
        : {}),
  };
}

async function resolveLocation(
  locationId: number,
  containersByItemId: Map<number, AssetRecord>,
  structureTypeIds: Set<number>,
  stations: Awaited<ReturnType<typeof getStations>>,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  characterIds: number[],
): Promise<RootLocation | undefined> {
  const container = containersByItemId.get(locationId);
  if (container && isDirectLocation(container)) {
    return rootLocationFromAssetLocation(container.rootLocation);
  }

  const station = stations.get(locationId);
  if (station) {
    return {
      locationId,
      kind: "station",
      typeId: station.typeID,
      name: types.get(station.typeID)?.name.en,
      systemId: station.solarSystemID,
    };
  }

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

  for (const token of tokens) {
    try {
      const result = await fetchLocationMetadata(locationId, "structure", token);
      if (result.data) {
        const resolved: RootLocation = {
          locationId,
          kind: "structure",
          ...(result.data.type_id !== undefined ? { typeId: result.data.type_id } : {}),
          name: result.data.name,
          systemId: result.data.system_id,
          regionId: result.data.region_id,
        };
        if (!resolved.typeId || !structureTypeIds.has(resolved.typeId)) {
          console.warn("[stock] Could not resolve root location", {
            locationId,
            locationType: resolved.kind,
            typeId: resolved.typeId,
            typeName: resolved.typeId ? types.get(resolved.typeId)?.name.en : undefined,
          });
        }
        return resolved;
      }
    } catch {}
  }
  console.warn("[stock] Could not resolve root location", {
    locationId,
    locationType: "structure",
  });
  return undefined;
}

function addContribution(
  buckets: Map<number, StockBucket>,
  contribution: StockContribution,
  location: RootLocation,
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
      ? "bp"
      : categorized.category;
  const blueprintType = category === "bp"
    ? contribution.blueprintType ?? (contribution.runCount === -1 ? "bpo" : "bpc")
    : undefined;
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
      resolved: true,
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
  const jobKey = contribution.inBuild && contribution.job
    ? `:job:${contribution.job.jobId}`
    : "";
  const itemKey = `${contribution.typeId}:${category}:${blueprintType ?? "item"}:${contribution.locationId ?? location.locationId}:${contribution.rootLocationId ?? location.locationId}${jobKey}`;
  const item: StockItem = bucket.items.get(itemKey) ?? {
    typeId: contribution.typeId,
    name: type.name[language] ?? type.name.en ?? `Type ${contribution.typeId}`,
    quantity: 0,
    locationId: contribution.locationId ?? location.locationId,
    rootLocationId: contribution.rootLocationId ?? location.locationId,
    isPackaged: contribution.isPackaged,
    assembledVolume: type.volume ?? 0,
    packagedVolume: type.packagedVolume,
    techLevel: type.techLevel,
    ...categorized,
    category,
    ...(blueprintType ? { type: blueprintType } : {}),
  };
  const sameBlueprint = contribution.blueprintPrint !== undefined && item.blueprintPrints?.some(
    (print) => print.itemId === contribution.blueprintPrint?.itemId,
  );
  if (!sameBlueprint) item.quantity += contribution.quantity;
  if (category !== "bp") {
    item.me ??= contribution.me;
    item.te ??= contribution.te;
  }
  if (contribution.blueprintPrint) {
    const existingPrint = item.blueprintPrints?.find(
      (print) => print.itemId === contribution.blueprintPrint?.itemId,
    );
    if (existingPrint) {
      Object.assign(existingPrint, contribution.blueprintPrint);
    } else {
      item.blueprintPrints = [...(item.blueprintPrints ?? []), contribution.blueprintPrint];
    }
  }
  if (contribution.inBuild) {
    item.inBuildQuantity = (item.inBuildQuantity ?? 0) + contribution.quantity;
    item.inBuild = true;
    item.jobRuns = (item.jobRuns ?? 0) + (contribution.job?.runs ?? 0);
    item.inUse = contribution.inUse;
    item.jobId = contribution.job?.jobId;
    item.installerId = contribution.job?.installerId;
    item.facilityId = contribution.job?.facilityId;
    item.outputLocationId = contribution.job?.outputLocationId;
    item.blueprintId = contribution.job?.blueprintId;
    item.blueprintTypeId = contribution.job?.blueprintTypeId;
    item.blueprintIsOriginal = contribution.blueprintIsOriginal;
    item.blueprintRunsAtInstall = contribution.blueprintRunsAtInstall;
    item.licensedRuns = contribution.job?.licensedRuns;
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
  const blueprintRunCount = blueprint?.runCount;
  const hasKnownBlueprintRuns = blueprintRunCount !== undefined;
  const isOriginal = blueprintRunCount === -1;
  const blueprintRunsUsed = isCopying
    ? job.licensedRuns ?? job.runs
    : job.runs;
  const remainingRuns = isOriginal
    ? -1
    : hasKnownBlueprintRuns
      ? Math.max(0, blueprintRunCount - blueprintRunsUsed)
      : 0;
  const contributions: StockContribution[] = [];
  if (isOriginal || (hasKnownBlueprintRuns && remainingRuns > 0)) {
    contributions.push({
      itemId: job.blueprintId,
      typeId: job.blueprintTypeId,
      quantity: 1,
      isPackaged: true,
      ownerType: job.ownerType,
      blueprintType: isOriginal ? "bpo" : "bpc",
      runCount: remainingRuns,
      inBuild: true,
      inUse: true,
      job,
      blueprintIsOriginal: isOriginal,
      blueprintRunsAtInstall: blueprintRunCount,
      blueprintRunsUsed,
      blueprintRunsRemaining: remainingRuns,
      activityName: activityName(job.activityId),
      blueprintPrint: {
        itemId: job.blueprintId,
        runs: remainingRuns,
        me: blueprint?.me,
        te: blueprint?.te,
        activity: activityName(job.activityId),
        endDate: job.endDate,
        type: isOriginal ? "bpo" : "bpc",
      },
    });
  }
  const outputRuns = job.successfulRuns && job.successfulRuns > 0 ? job.successfulRuns : job.runs;
  if (job.productTypeId && outputRuns > 0) {
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
  const startedAt = performance.now();
  let lastPhaseAt = startedAt;
  const phaseDurations: Record<string, number> = {};
  const markPhase = (name: string) => {
    const now = performance.now();
    phaseDurations[name] = Math.round(now - lastPhaseAt);
    lastPhaseAt = now;
  };
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterIds = await getSessionCharacterIds(session);
  const url = new URL(request.url);
  const requestedLanguage = url.searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  markPhase("session");
  const [assets, jobs, shipTypeIds, structureTypeIds, groups, marketGroups, stations, systems, rootContainersByItemId] =
    await Promise.all([
      getResolvedAssets(characterIds, true),
      getRunningIndustryJobs(characterIds, true),
      getShipTypeIds(),
      getStructureTypeIds(),
      getGroups(),
      getMarketGroups(),
      getStations(),
      getSystems(),
      getRootContainersByItemId(characterIds, true),
    ]);
  markPhase("data");
  const types = await getTypesByIds([
    ...new Set([
      ...assets.map((asset) => asset.typeId),
      ...jobs.flatMap((job) =>
        [job.blueprintTypeId, job.productTypeId].filter((id): id is number => id !== undefined),
      ),
    ]),
  ]);
  markPhase("types");
  const jobLocationIds = [...new Set(jobs.flatMap((job) => [
    job.blueprintLocationId,
    job.locationId,
    job.outputLocationId,
  ]))];
  const jobLocations = new Map(
    await Promise.all(jobLocationIds.map(async (locationId) => [
      locationId,
      await resolveLocation(
        locationId,
        rootContainersByItemId,
        structureTypeIds,
        stations,
        types,
        characterIds,
      ),
    ] as const)),
  );
  markPhase("locations");
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
  const allAssetIndex = await getResolvedAssetIndex(characterIds, true);
  markPhase("indexes");
  for (const asset of assets) {
    if (!shouldIncludeAsset(asset, shipTypeIds) || !isDirectLocation(asset)) continue;
    const rootLocation = rootLocationFromAssetLocation(asset.rootLocation);
    if (!rootLocation || (rootLocation.typeId !== undefined && shipTypeIds.has(rootLocation.typeId))) continue;
    addContribution(
      buckets,
      {
        itemId: asset.itemId,
        typeId: asset.typeId,
        quantity: asset.quantity > 0 ? asset.quantity : 1,
        locationId: asset.locationId,
        rootLocationId: asset.rootLocation.locationId,
        isPackaged: !asset.isSingleton,
        ownerType: asset.ownerType,
        blueprintType: asset.runCount === -1 ? "bpo" : "bpc",
        runCount: asset.runCount,
        me: asset.me,
        te: asset.te,
          ...(asset.runCount !== undefined
            ? {
                blueprintPrint: {
                  itemId: asset.itemId,
                  runs: asset.runCount,
                  me: asset.me,
                  te: asset.te,
                  type: asset.runCount === -1 ? "bpo" : "bpc",
                },
              }
            : {}),
      },
      rootLocation,
      types,
      groups,
      marketGroups,
      language,
      systems,
    );
  }
  for (const job of jobs) {
    if (job.status === "cancelled" || job.status === "delivered") continue;
    const blueprint = allAssetIndex.get(job.blueprintId) ?? assets.find(
      (asset) => asset.itemId === job.blueprintId,
    );
    const preferredBlueprintLocation = blueprint && isDirectLocation(blueprint)
      ? rootLocationFromAssetLocation(blueprint.rootLocation)
      : jobLocations.get(job.blueprintLocationId) ?? jobLocations.get(job.locationId);
    const blueprintLocation = preferredBlueprintLocation ?? jobLocations.get(job.locationId);
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
          : (jobLocations.get(job.outputLocationId) ?? jobLocations.get(job.locationId));
      if (!location || (location.typeId !== undefined && shipTypeIds.has(location.typeId)))
        continue;
      addContribution(
        buckets,
        {
          ...contribution,
          locationId: index === 0 ? job.blueprintLocationId : job.outputLocationId,
          rootLocationId: index === 0 ? job.blueprintLocationId : job.outputLocationId,
        },
        location,
        types,
        groups,
        marketGroups,
        language,
        systems,
      );
    }
  }
  markPhase("aggregate");
  const payload = {
    locations: [...buckets.values()]
      .map((bucket) => ({ ...bucket, items: [...bucket.items.values()] }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  const totalMs = Math.round(performance.now() - startedAt);
  const timingHeader = [`total;dur=${totalMs}`, ...Object.entries(phaseDurations).map(([name, duration]) => `${name};dur=${duration}`)].join(", ");
  console.info("[state/stock] timing", {
    totalMs,
    phasesMs: phaseDurations,
    characters: characterIds.length,
    assets: assets.length,
    jobs: jobs.length,
    jobLocations: jobLocations.size,
    locations: payload.locations.length,
  });
  const response = NextResponse.json(payload);
  response.headers.set("Server-Timing", timingHeader);
  return response;
}
