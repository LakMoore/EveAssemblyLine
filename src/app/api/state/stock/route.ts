import { NextRequest, NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  getResolvedAssetIndex,
  getResolvedAssets,
  getBlueprintInstances,
  getRootLocationsByItemId,
  getRunningIndustryJobs,
  getMarketOrderStock,
} from "@/lib/esi/cache";
import { fetchStructureMetadataPerCharacter, getUsableToken } from "@/lib/esi/client";
import { getCharacter } from "@/lib/auth/tokensStore";
import {
  getGroups,
  getMarketGroups,
  getBlueprintById,
  getShipTypeIds,
  getStations,
  getStructureTypeIds,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType } from "@/lib/reference/category";
import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
import type {
  BlueprintType,
  PlanStockItem,
  StockContribution,
  StockItem,
} from "@/lib/planning/types";

type RootLocation = {
  locationId: number;
  kind: "station" | "structure" | "anchored";
  typeId?: number;
  name?: string;
  systemId?: number;
  regionId?: number;
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

function jobUsesOriginalWithoutAssetMetadata(job: IndustryJobRecord, isCopying: boolean) {
  return (
    (job.activityId === 1 || isCopying) && (job.licensedRuns === undefined || job.licensedRuns <= 0)
  );
}

function shouldIncludeAsset(asset: AssetRecord, shipTypeIds: Set<number>) {
  if (asset.isSingleton && shipTypeIds.has(asset.typeId)) return false;
  return true;
}

function rootLocationFromAssetLocation(root: AssetLocation): RootLocation {
  return {
    locationId: root.locationId,
    kind:
      root.kind === "solar_system" ? "anchored" : root.kind === "station" ? "station" : "structure",
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
  rootLocationsByItemId: Map<number, AssetLocation>,
  structureTypeIds: Set<number>,
  stations: Awaited<ReturnType<typeof getStations>>,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  characterIds: number[],
): Promise<RootLocation | undefined> {
  const cachedRoot = rootLocationsByItemId.get(locationId);
  if (cachedRoot) return rootLocationFromAssetLocation(cachedRoot);

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
          usable.push(await getUsableToken(character));
        }
        catch {}
        return usable;
      }),
    )
  ).flat();

  for (const token of tokens) {
    try {
      const result = await fetchStructureMetadataPerCharacter(locationId, token);
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
          console.warn(
            "[stock] Could not resolve root location",
            {
              locationId,
              locationType: resolved.kind,
              typeId: resolved.typeId,
              typeName: resolved.typeId ? types.get(resolved.typeId)?.name.en : undefined,
            },
          );
        }
        return resolved;
      }
    }
    catch {}
  }
  console.warn(
    "[stock] Could not resolve root location",
    {
      locationId,
      locationType: "structure",
    },
  );
  return undefined;
}

function addStockContribution(
  buckets: Map<number, StockBucket>,
  contribution: StockContribution,
  location: RootLocation,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  groups: Awaited<ReturnType<typeof getGroups>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
  language: SdeLanguage,
  systems: Awaited<ReturnType<typeof getSystems>>,
) {
  const type = types.get(contribution.typeId);
  if (!type?.published) return;
  const categorized = categorizeType(type, language, marketGroups, groups);
  const category = categorized.category;
  const blueprintType: BlueprintType | undefined =
    category === "blueprint" ? (contribution.blueprintType ?? "bpc") : undefined;
  const bucket =
    buckets.get(location.locationId)
    ?? ({
      locationId: location.locationId,
      name:
        location.kind === "anchored"
          ? "Anchored"
          : (location.name ?? `Location ${location.locationId}`),
      locationType: location.kind,
      typeId: location.typeId,
      systemId: location.systemId,
      systemName: location.systemId ? systems.get(location.systemId)?.name.en : undefined,
      securityStatus:
        location.systemId === undefined
          ? undefined
          : systems.get(location.systemId)?.securityStatus,
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
  const jobKey = contribution.inBuild && contribution.jobId ? `:job:${contribution.jobId}` : "";
  const itemKey = `${contribution.typeId}:${category}:${blueprintType ?? "item"}:${contribution.locationId ?? location.locationId}:${contribution.rootLocationId ?? location.locationId}${jobKey}`;
  const item: StockItem = bucket.items.get(itemKey) ?? {
    typeId: contribution.typeId,
    name: type.name[language] ?? type.name.en,
    quantity: 0,
    locationId: contribution.locationId ?? location.locationId,
    rootLocationId: contribution.rootLocationId ?? location.locationId,
    isPackaged: contribution.isPackaged,
    assembledVolume: type.volume ?? 0,
    packagedVolume: type.packagedVolume,
    techLevel: type.techLevel,
    ...categorized,
    category,
    ...(blueprintType ? { blueprintType } : {}),
  };
  const sameBlueprint =
    contribution.blueprintPrint !== undefined
    && item.blueprintPrints?.some((print) => print.itemId === contribution.blueprintPrint?.itemId);
  if (!sameBlueprint) item.quantity += contribution.quantity;
  if (category !== "blueprint") {
    item.me ??= contribution.me;
    item.te ??= contribution.te;
  }
  if (contribution.blueprintPrint) {
    const existingPrint = item.blueprintPrints?.find(
      (print) => print.itemId === contribution.blueprintPrint?.itemId,
    );
    if (existingPrint) {
      Object.assign(existingPrint, contribution.blueprintPrint);
    }
    else {
      item.blueprintPrints = [...(item.blueprintPrints ?? []), contribution.blueprintPrint];
    }
  }
  if (contribution.inBuild) {
    item.inBuildQuantity = (item.inBuildQuantity ?? 0) + contribution.quantity;
    item.inBuild = true;
    item.jobRuns = contribution.jobRuns;
    item.inUse = contribution.inUse;
    item.jobId = contribution.jobId;
    item.licensedRuns = contribution.licensedRuns;
    item.activityName = contribution.activityName;
  }
  bucket.items.set(itemKey, item);
  bucket.totalCount += contribution.quantity;
  bucket.totalVolume
    += contribution.quantity
    * (contribution.isPackaged ? (type.packagedVolume ?? type.volume ?? 0) : (type.volume ?? 0));
  buckets.set(location.locationId, bucket);
}

/**
 * Converts an active industry job into the installed blueprint and its current output.
 * Blueprint run metadata is authoritative when the installed item is present in the asset
 * cache. Manufacturing and copying jobs without that metadata are treated as BPO-backed
 * because an original remains reusable while a copy requires finite run accounting.
 */
function installedJobContributions(
  job: IndustryJobRecord,
  blueprint: AssetRecord | undefined,
  blueprintInstance: BlueprintInstanceRecord | undefined,
  productQuantityPerRun?: number,
): StockContribution[] {
  const isCopying = job.activityId === 5;
  const installedRunCount = blueprintInstance?.runs ?? blueprint?.runCount;
  const installedBlueprintIsOriginal =
    blueprintInstance?.quantity === -1
    || (blueprintInstance === undefined && installedRunCount === -1)
    || (
      blueprintInstance === undefined
      && installedRunCount === undefined
      && jobUsesOriginalWithoutAssetMetadata(job, isCopying)
    );
  const installedBlueprintRunsUsed = job.installedRuns ?? getInstalledJobRuns(job);
  const installedBlueprintRemainingRuns = installedBlueprintIsOriginal
    ? -1
    : installedRunCount !== undefined
      ? Math.max(0, installedRunCount - installedBlueprintRunsUsed)
      : 0;
  const contributions: StockContribution[] = [];
  if (
    installedBlueprintIsOriginal
    || installedBlueprintRemainingRuns > 0
    // Research jobs may have no product output. Keep their installed blueprint visible
    // even when all finite runs are consumed so the active job remains trackable.
    || job.productTypeId === undefined
  ) {
    contributions.push({
      itemId: job.blueprintId,
      typeId: job.blueprintTypeId,
      quantity: 1,
      isPackaged: true,
      ownerType: job.ownerType,
      blueprintType: installedBlueprintIsOriginal ? "bpo" : "bpc",
      inBuild: true,
      inUse: true,
      jobId: job.jobId,
      jobRuns: job.runs,
      licensedRuns: job.licensedRuns,
      blueprintRunsAtInstall: installedRunCount,
      ...(!isCopying ? { activityName: activityName(job.activityId) } : {}),
      blueprintPrint: {
        itemId: job.blueprintId,
        runs: installedBlueprintRemainingRuns,
        me: blueprintInstance?.me ?? blueprint?.me,
        te: blueprintInstance?.te ?? blueprint?.te,
        activity: activityName(job.activityId),
        type: installedBlueprintIsOriginal ? "bpo" : "bpc",
      },
    });
  }
  const productionRuns = job.installedRuns ?? getInstalledJobRuns(job);
  const isProduction = job.activityId === 1 || job.activityId === 9;
  if (
    job.productTypeId
    && productionRuns > 0
    && (!isProduction || productQuantityPerRun !== undefined)
  ) {
    const outputQuantity = !isProduction ? productionRuns : productionRuns * productQuantityPerRun!;
    if (isCopying && job.licensedRuns !== undefined) {
      for (let index = 0; index < outputQuantity; index += 1) {
        contributions.push({
          itemId: job.jobId,
          typeId: job.productTypeId,
          quantity: 1,
          isPackaged: false,
          ownerType: job.ownerType,
          blueprintPrint: {
            itemId: -(job.jobId * 1_000_000 + index + 1),
            runs: job.licensedRuns,
            activity: activityName(job.activityId),
            type: "bpc",
          },
          inBuild: true,
          jobId: job.jobId,
          jobRuns: job.runs,
          licensedRuns: job.licensedRuns,
          activityName: activityName(job.activityId),
        });
      }
    }
    else {
      contributions.push({
        itemId: job.jobId,
        typeId: job.productTypeId,
        quantity: outputQuantity,
        isPackaged: false,
        ownerType: job.ownerType,
        inBuild: true,
        jobId: job.jobId,
        jobRuns: job.runs,
        licensedRuns: job.licensedRuns,
        activityName: activityName(job.activityId),
      });
    }
  }
  return contributions;
}

function getInstalledJobRuns(job: IndustryJobRecord) {
  return job.successfulRuns ?? Math.floor(job.runs * (job.probability ?? 1));
}

export async function GET(request: NextRequest) {
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
  const marketStock = await getMarketOrderStock(
    characterIds,
    {
      personalSellOrdersAsStock: true,
      allCorporationSellOrdersAsStock: true,
      myCorporationSellOrdersAsStock: true,
    },
    session.sessionId,
  );
  markPhase("session");
  const [
    assets,
    jobs,
    blueprintInstances,
    shipTypeIds,
    structureTypeIds,
    groups,
    marketGroups,
    stations,
    systems,
    rootLocationsByItemId,
  ] = await Promise.all([
    getResolvedAssets(characterIds, true, session.sessionId),
    getRunningIndustryJobs(characterIds, true, session.sessionId),
    getBlueprintInstances(characterIds, true, session.sessionId),
    getShipTypeIds(),
    getStructureTypeIds(),
    getGroups(),
    getMarketGroups(),
    getStations(),
    getSystems(),
    getRootLocationsByItemId(characterIds, true, session.sessionId),
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
  const jobLocationIds = [
    ...new Set([
      ...jobs.flatMap((job) => [job.blueprintLocationId, job.locationId, job.outputLocationId]),
      ...blueprintInstances.map((blueprint) => blueprint.locationId),
    ]),
  ];
  const jobLocations = new Map(
    await Promise.all(
      jobLocationIds.map(async (locationId) => {
        const cachedRoot = rootLocationsByItemId.get(locationId);
        const location = cachedRoot
          ? rootLocationFromAssetLocation(cachedRoot)
          : await resolveLocation(
              locationId,
              rootLocationsByItemId,
              structureTypeIds,
              stations,
              types,
              characterIds,
            );
        return [locationId, location] as const;
      }),
    ),
  );
  markPhase("locations");
  const buckets = new Map<number, StockBucket>();
  const productQuantities = new Map<number, number>();
  await Promise.all(
    [
      ...new Set(
        jobs.flatMap((job) => (job.productTypeId !== undefined ? [job.productTypeId] : [])),
      ),
    ].map(async (productTypeId) => {
      const job = jobs.find((candidate) => candidate.productTypeId === productTypeId);
      if (!job) return;
      const blueprint = await getBlueprintById(job.blueprintTypeId);
      const activity =
        job.activityId === 9
          ? blueprint?.activities.reaction
          : job.activityId === 1
            ? blueprint?.activities.manufacturing
            : undefined;
      const product = activity?.products?.find((candidate) => candidate.typeID === productTypeId);
      if (product?.quantity && product.quantity > 0) {
        productQuantities.set(productTypeId, product.quantity);
      }
    }),
  );
  const allAssetIndex = await getResolvedAssetIndex(characterIds, true, session.sessionId);
  markPhase("indexes");
  const blueprintInstancesByOwnerAndItemId = new Map(
    blueprintInstances.map((blueprint) => [
      `${blueprint.ownerType}:${blueprint.ownerId}:${blueprint.itemId}`,
      blueprint,
    ]),
  );

  // Add ordinary assets first. Job contributions are added afterwards with a job-specific key,
  // so an installed blueprint and its output remain visible alongside physical stock.
  for (const asset of assets) {
    if (!shouldIncludeAsset(asset, shipTypeIds) || !isDirectLocation(asset)) continue;
    const rootLocation = rootLocationFromAssetLocation(asset.rootLocation);
    if (rootLocation.typeId !== undefined && shipTypeIds.has(rootLocation.typeId)) continue;
    const blueprintInstance = blueprintInstancesByOwnerAndItemId.get(
      `${asset.ownerType}:${asset.ownerId}:${asset.itemId}`,
    );
    const blueprintType = blueprintInstance
      ? blueprintInstance.quantity === -1
        ? "bpo"
        : "bpc"
      : undefined;
    addStockContribution(
      buckets,
      {
        itemId: asset.itemId,
        typeId: asset.typeId,
        quantity: asset.quantity > 0 ? asset.quantity : 1,
        locationId: asset.locationId,
        rootLocationId: asset.rootLocation.locationId,
        isPackaged: !asset.isSingleton,
        ownerType: asset.ownerType,
        blueprintType,
        me: blueprintInstance?.me,
        te: blueprintInstance?.te,
        ...(blueprintInstance
          ? {
              blueprintPrint: {
                itemId: asset.itemId,
                runs: blueprintInstance.runs,
                me: blueprintInstance.me,
                te: blueprintInstance.te,
                type: blueprintType!,
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

  // Jobs can contain the only usable copy of a blueprint. Preserve that installed blueprint even
  // when its asset record is unavailable or its structure metadata is only partially resolved.
  for (const job of jobs) {
    if (job.status === "cancelled" || job.status === "delivered") continue;
    const blueprint =
      allAssetIndex.get(job.blueprintId)
      ?? assets.find((asset) => asset.itemId === job.blueprintId);
    const blueprintInstance = blueprintInstances.find(
      (instance) =>
        instance.itemId === job.blueprintId
        && instance.ownerType === job.ownerType
        && instance.ownerId === job.ownerId,
    );
    const preferredBlueprintLocation =
      (blueprintInstance && jobLocations.get(blueprintInstance.locationId))
      ?? (blueprint && isDirectLocation(blueprint)
        ? rootLocationFromAssetLocation(blueprint.rootLocation)
        : (jobLocations.get(job.blueprintLocationId) ?? jobLocations.get(job.locationId)));
    const blueprintLocation = preferredBlueprintLocation
      ?? jobLocations.get(job.locationId) ?? {
        locationId: job.blueprintLocationId,
        kind: "anchored" as const,
      };
    if (blueprintLocation.typeId !== undefined && shipTypeIds.has(blueprintLocation.typeId)) {
      continue;
    }
    for (const contribution of installedJobContributions(
      job,
      blueprint,
      blueprintInstance,
      job.productTypeId !== undefined ? productQuantities.get(job.productTypeId) : undefined,
    )) {
      const location = jobLocations.get(job.outputLocationId)
        ?? jobLocations.get(job.locationId) ?? {
          locationId: job.outputLocationId,
          kind: "anchored" as const,
        };
      addStockContribution(
        buckets,
        {
          ...contribution,
          locationId: job.outputLocationId,
          rootLocationId: job.facilityId,
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
      .map(({ items: _items, ...location }) => location)
      .sort((left, right) => left.name.localeCompare(right.name)),
    workingStock: [
      ...[...buckets.values()].flatMap((bucket) =>
        [...bucket.items.values()].map((item) => ({
          ...item,
          category: item.category as PlanStockItem["category"],
        })),
      ),
      ...(marketStock ?? []),
    ] as PlanStockItem[],
  };
  const totalMs = Math.round(performance.now() - startedAt);
  const timingHeader = [
    `total;dur=${totalMs}`,
    ...Object.entries(phaseDurations).map(([name, duration]) => `${name};dur=${duration}`),
  ].join(", ");
  console.info(
    "[state/stock] timing",
    {
      totalMs,
      phasesMs: phaseDurations,
      characters: characterIds.length,
      assets: assets.length,
      jobs: jobs.length,
      jobLocations: jobLocations.size,
      locations: payload.locations.length,
    },
  );
  const response = NextResponse.json(payload);
  response.headers.set("Server-Timing", timingHeader);
  return response;
}
