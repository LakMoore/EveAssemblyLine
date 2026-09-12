import { NextRequest, NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { getCollectionFacilities } from "@/lib/auth/tokensStore";
import {
  getAllAssetsRaw,
  getCorporationSourceCatalog,
  getCorporationSourcePolicies,
  getResolvedAssetIndex,
  getResolvedAssets,
  getBlueprintInstances,
  getRootLocationsByItemId,
  getRunningIndustryJobs,
  getMarketOrderStock,
  getCorporationAssetSource,
  getCorporationLocationSource,
  getMarketOrderBuyQuantities,
} from "@/lib/esi/cache";
import type { Facility } from "@/lib/planning/facilities";
import {
  getGroups,
  getMarketGroups,
  getBlueprintById,
  getShipTypeIds,
  getStations,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType } from "@/lib/reference/category";
import { formatLocationName, normalizeLocationName } from "@/lib/reference/locationName";
import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
import type {
  BlueprintType,
  IndustryJobStatus,
  PlanStockItem,
  StockContribution,
  StockItem,
} from "@/lib/planning/types";
import {
  calculateFacilities,
  type FacilityCalculationContext,
} from "@/lib/planning/facilitiesServer";
import { createTimingScope, flattenTimingPhases, logTiming } from "@/lib/server/timing";

type RootLocation = {
  locationId: number;
  kind: "station" | "structure" | "anchored";
  resolved: boolean;
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

function normalizeIndustryJobStatus(status: string): IndustryJobStatus | undefined {
  const normalized = status.toLowerCase();
  return ["active", "cancelled", "delivered", "paused", "ready", "reverted"].includes(normalized)
    ? (normalized as IndustryJobStatus)
    : undefined;
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
    resolved: root.resolved,
  };
}

function rootLocationFromFacility(facility: Facility): RootLocation | undefined {
  const locationId = typeof facility.id === "number" ? facility.id : Number(facility.id);
  if (!Number.isInteger(locationId)) return undefined;
  return {
    locationId,
    kind: facility.locationType,
    typeId: facility.typeId,
    name: facility.name,
    systemId: facility.systemId,
    resolved: true,
  };
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
  const categorized = categorizeType(
    type ?? { name: { en: `Type ${contribution.typeId}` } },
    language,
    marketGroups,
    groups,
  );
  const category = categorized.category;
  const systemName = location.systemId ? systems.get(location.systemId)?.name.en : undefined;
  const displayName = location.name
    ? location.kind === "structure"
      ? formatLocationName(systemName, location.name)
      : normalizeLocationName(systemName, location.name)
    : location.kind === "anchored"
      ? "Anchored"
      : location.kind === "structure"
        ? "Structure details unavailable"
        : "Station details unavailable";
  const blueprintType: BlueprintType | undefined =
    category === "blueprint" ? (contribution.blueprintType ?? "bpc") : undefined;
  const bucket =
    buckets.get(location.locationId)
    ?? ({
      locationId: location.locationId,
      name: displayName,
      locationType: location.kind,
      typeId: location.typeId,
      systemId: location.systemId,
      systemName: location.systemId ? systems.get(location.systemId)?.name.en : undefined,
      securityStatus:
        location.systemId === undefined
          ? undefined
          : systems.get(location.systemId)?.securityStatus,
      regionId: location.regionId,
      resolved: location.resolved,
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
  const ownerKey = `${contribution.ownerType}:${contribution.ownerId ?? ""}`;
  const itemKey = `${ownerKey}:${contribution.typeId}:${category}:${blueprintType ?? "item"}:${contribution.locationId ?? location.locationId}:${contribution.rootLocationId ?? location.locationId}${jobKey}`;
  const item: StockItem = bucket.items.get(itemKey) ?? {
    typeId: contribution.typeId,
    name: type?.name[language] ?? type?.name.en ?? `Type ${contribution.typeId}`,
    quantity: 0,
    locationId: contribution.locationId ?? location.locationId,
    rootLocationId: contribution.rootLocationId ?? location.locationId,
    sourceLocationName: displayName,
    sourceLocationKind: location.kind,
    ...(location.systemId !== undefined ? { sourceSystemId: location.systemId } : {}),
    ...(systemName !== undefined ? { sourceSystemName: systemName } : {}),
    corporationSource: contribution.corporationSource,
    ownerType: contribution.ownerType,
    ...(contribution.ownerId !== undefined ? { ownerId: contribution.ownerId } : {}),
    isPackaged: contribution.isPackaged,
    assembledVolume: type?.volume ?? 0,
    packagedVolume: type?.packagedVolume,
    techLevel: type?.techLevel,
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
    item.industryJobStatus = contribution.industryJobStatus;
    item.licensedRuns = contribution.licensedRuns;
    item.activityName = contribution.activityName;
  }
  bucket.items.set(itemKey, item);
  bucket.totalCount += contribution.quantity;
  bucket.totalVolume
    += contribution.quantity
    * (contribution.isPackaged ? (type?.packagedVolume ?? type?.volume ?? 0) : (type?.volume ?? 0));
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
  includeOutput = false,
  includeInstalledBlueprint = true,
  industryJobStatus?: IndustryJobStatus,
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
    includeInstalledBlueprint
    && (
      installedBlueprintIsOriginal
      || installedBlueprintRemainingRuns > 0
      // Research jobs may have no product output. Keep their installed blueprint visible
      // even when all finite runs are consumed so the active job remains trackable.
      || job.productTypeId === undefined
    )
  ) {
    contributions.push({
      itemId: job.blueprintId,
      typeId: job.blueprintTypeId,
      quantity: 1,
      isPackaged: true,
      ownerType: job.ownerType,
      ownerId: job.ownerId,
      blueprintType: installedBlueprintIsOriginal ? "bpo" : "bpc",
      inBuild: true,
      inUse: true,
      jobId: job.jobId,
      industryJobStatus,
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
  const createsOutput = [1, 5, 8, 9].includes(job.activityId);
  if (
    includeOutput
    && createsOutput
    && job.productTypeId
    && productionRuns > 0
    && (!isProduction || productQuantityPerRun !== undefined)
  ) {
    const outputQuantity = !isProduction
      ? productionRuns
      : productionRuns * (productQuantityPerRun ?? 0);
    if (isCopying && job.licensedRuns !== undefined) {
      for (let index = 0; index < outputQuantity; index += 1) {
        contributions.push({
          itemId: job.jobId,
          typeId: job.productTypeId,
          quantity: 1,
          isPackaged: false,
          ownerType: job.ownerType,
          ownerId: job.ownerId,
          blueprintPrint: {
            itemId: -(job.jobId * 1_000_000 + index + 1),
            runs: job.licensedRuns,
            activity: activityName(job.activityId),
            type: "bpc",
          },
          inBuild: true,
          jobId: job.jobId,
          industryJobStatus,
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
        ownerId: job.ownerId,
        inBuild: true,
        jobId: job.jobId,
        industryJobStatus,
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
  const timing = createTimingScope();
  const markPhase = (name: string) => timing.mark(name);
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const [characterIds, corporationSettings] = await Promise.all([
    getSessionCharacterIds(session),
    session.collectionId
      ? getCollectionCorporationSettings(session.collectionId)
      : Promise.resolve([]),
  ]);
  const corporationPolicies = await getCorporationSourcePolicies(
    characterIds,
    corporationSettings,
    session.sessionId,
  );
  const url = new URL(request.url);
  const requestedLanguage = url.searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const corporationSourcesPromise = getCorporationSourceCatalog(
    characterIds,
    corporationPolicies,
    session.sessionId,
  );
  const marketStockPromise = getMarketOrderStock(
    characterIds,
    {
      personalSellOrdersAsStock: true,
      allCorporationSellOrdersAsStock: true,
      myCorporationSellOrdersAsStock: true,
    },
    session.sessionId,
    corporationPolicies,
  );
  const marketBuyOrderQuantitiesPromise = getMarketOrderBuyQuantities(
    characterIds,
    session.sessionId,
    corporationPolicies,
  );
  if (!session.collectionId) {
    return NextResponse.json({ error: "Session collection is unavailable." }, { status: 400 });
  }
  const facilitySettingsPromise = getCollectionFacilities(session.collectionId);
  markPhase("session");
  const [
    assets,
    rawAssets,
    jobs,
    blueprintInstances,
    shipTypeIds,
    groups,
    marketGroups,
    stations,
    systems,
    rootLocationsByItemId,
    corporationSources,
    marketStock,
    marketBuyOrderQuantities,
    facilitySettings,
  ] = await Promise.all([
    getResolvedAssets(characterIds, true, session.sessionId, corporationPolicies),
    getAllAssetsRaw(characterIds, true, session.sessionId, corporationPolicies),
    getRunningIndustryJobs(characterIds, true, session.sessionId, corporationPolicies),
    getBlueprintInstances(characterIds, true, session.sessionId, corporationPolicies),
    getShipTypeIds(),
    getGroups(),
    getMarketGroups(),
    getStations(),
    getSystems(),
    getRootLocationsByItemId(characterIds, true, session.sessionId, corporationPolicies),
    corporationSourcesPromise,
    marketStockPromise,
    marketBuyOrderQuantitiesPromise,
    facilitySettingsPromise,
  ]);
  markPhase("data");
  const facilityResponse = await calculateFacilities(
    request,
    facilitySettings,
    timing.child("facilities"),
    {
      session,
      characterIds,
      corporationPolicies,
      roots: rootLocationsByItemId,
      corporationSources,
      stations,
      systems,
      groups,
    } satisfies FacilityCalculationContext,
  );
  const facilitiesById = new Map(
    facilityResponse.facilities.flatMap((facility) => {
      const location = rootLocationFromFacility(facility);
      return location ? [[location.locationId, location] as const] : [];
    }),
  );
  const types = await getTypesByIds([
    ...new Set([
      ...assets.map((asset) => asset.typeId),
      ...jobs.flatMap((job) =>
        [job.blueprintTypeId, job.productTypeId].filter((id): id is number => id !== undefined),
      ),
    ]),
  ]);
  markPhase("types");
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
  const allAssetIndex = await getResolvedAssetIndex(
    characterIds,
    true,
    session.sessionId,
    corporationPolicies,
  );
  markPhase("indexes");
  const blueprintInstancesByOwnerAndItemId = new Map(
    blueprintInstances.map((blueprint) => [
      `${blueprint.ownerType}:${blueprint.ownerId}:${blueprint.itemId}`,
      blueprint,
    ]),
  );
  const rawAssetsByCorporationId = new Map<number, Map<number, AssetRecord>>();
  for (const asset of rawAssets) {
    if (asset.ownerType !== "corporation") continue;
    const assetsByItemId =
      rawAssetsByCorporationId.get(asset.ownerId) ?? new Map<number, AssetRecord>();
    assetsByItemId.set(asset.itemId, asset);
    rawAssetsByCorporationId.set(asset.ownerId, assetsByItemId);
  }

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
    const corporationSource =
      asset.ownerType === "corporation"
        ? getCorporationAssetSource(
            asset,
            rawAssetsByCorporationId.get(asset.ownerId) ?? new Map<number, AssetRecord>(),
          )
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
        ownerId: asset.ownerId,
        blueprintType,
        ...(asset.inUse || blueprintInstance?.inUse ? { inUse: true } : {}),
        ...(corporationSource ? { corporationSource } : {}),
        me: blueprintInstance?.me,
        te: blueprintInstance?.te,
        ...(blueprintInstance
          ? {
              blueprintPrint: {
                itemId: asset.itemId,
                runs: blueprintInstance.runs,
                me: blueprintInstance.me,
                te: blueprintInstance.te,
                type: blueprintInstance.quantity === -1 ? "bpo" : "bpc",
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
  const resolveRootLocation = (locationId: number) => {
    const location = rootLocationsByItemId.get(locationId);
    return location ? rootLocationFromAssetLocation(location) : undefined;
  };
  for (const job of jobs) {
    const industryJobStatus = normalizeIndustryJobStatus(job.status);
    if (
      industryJobStatus === undefined
      || industryJobStatus === "cancelled"
      || industryJobStatus === "reverted"
    ) continue;
    const blueprint =
      allAssetIndex.get(job.blueprintId)
      ?? assets.find((asset) => asset.itemId === job.blueprintId);
    const blueprintInstance = blueprintInstances.find(
      (instance) =>
        instance.itemId === job.blueprintId
        && instance.ownerType === job.ownerType
        && instance.ownerId === job.ownerId,
    );
    const installedBlueprintInstance =
      blueprintInstance?.runsBeforeJobAdjustments === undefined
        ? blueprintInstance
        : {
            ...blueprintInstance,
            runs: blueprintInstance.runsBeforeJobAdjustments,
          };
    const preferredBlueprintLocation =
      facilitiesById.get(job.facilityId)
      ?? (blueprintInstance && rootLocationsByItemId.has(blueprintInstance.locationId)
        ? resolveRootLocation(blueprintInstance.locationId)
        : undefined)
      ?? (blueprint && isDirectLocation(blueprint)
        ? rootLocationFromAssetLocation(blueprint.rootLocation)
        : rootLocationsByItemId.has(job.blueprintLocationId)
          ? resolveRootLocation(job.blueprintLocationId)
          : rootLocationsByItemId.has(job.locationId)
            ? resolveRootLocation(job.locationId)
            : undefined);
    const blueprintLocation = preferredBlueprintLocation
      ?? facilitiesById.get(job.facilityId) ?? {
        locationId: job.blueprintLocationId,
        kind: "anchored" as const,
        resolved: false,
      };
    if (blueprintLocation.typeId !== undefined && shipTypeIds.has(blueprintLocation.typeId)) {
      continue;
    }
    for (const contribution of installedJobContributions(
      job,
      blueprint,
      installedBlueprintInstance,
      job.productTypeId !== undefined ? productQuantities.get(job.productTypeId) : undefined,
      industryJobStatus !== "delivered",
      industryJobStatus !== "delivered",
      industryJobStatus,
    )) {
      const location = facilitiesById.get(job.facilityId)
        ?? (rootLocationsByItemId.has(job.outputLocationId)
          ? resolveRootLocation(job.outputLocationId)
          : rootLocationsByItemId.has(job.locationId)
            ? resolveRootLocation(job.locationId)
            : undefined) ?? {
          locationId: job.outputLocationId,
          kind: "anchored" as const,
          resolved: false,
        };
      addStockContribution(
        buckets,
        {
          ...contribution,
          locationId: job.outputLocationId,
          rootLocationId: job.facilityId,
          ...(job.ownerType === "corporation"
            ? {
                corporationSource:
                  getCorporationAssetSource(
                    {
                      itemId: job.outputLocationId,
                      locationId: job.outputLocationId,
                      locationFlag: "OfficeFolder",
                    },
                    rawAssetsByCorporationId.get(job.ownerId) ?? new Map<number, AssetRecord>(),
                  )
                  ?? getCorporationLocationSource(
                    job.facilityId,
                    rawAssetsByCorporationId.get(job.ownerId) ?? new Map<number, AssetRecord>(),
                  ),
              }
            : {}),
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
    assets: [
      ...[...buckets.values()].flatMap((bucket) =>
        [...bucket.items.values()].map((item) => ({
          ...item,
          category: item.category as PlanStockItem["category"],
        })),
      ),
      ...(marketStock ?? []),
    ] as PlanStockItem[],
    marketBuyOrderQuantities: marketBuyOrderQuantities ?? {},
    facilities: facilityResponse.facilities,
    corporationSources,
  };
  const timingProfile = timing.complete();
  const profilingEnabled = process.env.NODE_ENV === "development";
  if (profilingEnabled) {
    logTiming(
      "[state/assets] timing",
      {
        ...timingProfile,
        charactersCount: characterIds.length,
        assetsCount: assets.length,
        jobsCount: jobs.length,
        facilitiesCount: facilityResponse.facilities.length,
        jobLocationFallbackCount: jobs.filter((job) => !facilitiesById.has(job.facilityId)).length,
      },
    );
  }
  const response = NextResponse.json(payload);
  if (profilingEnabled) {
    const timingHeader = [
      `total;dur=${timingProfile.totalMs}`,
      ...flattenTimingPhases(timingProfile.phasesMs).map(
        ([name, duration]) => `${name};dur=${duration}`,
      ),
    ].join(", ");
    response.headers.set("Server-Timing", timingHeader);
  }
  return response;
}
