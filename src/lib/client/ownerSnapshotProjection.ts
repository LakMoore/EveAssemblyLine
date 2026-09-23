import type { Facility } from "@/lib/planning/facilities";
import type { BlueprintPrint, StockItem } from "@/lib/planning/types";
import type { TypeMetadata } from "@/lib/reference/types";
import type {
  ClientAssetsResponse,
  ClientCorporationSource,
  ClientIndustrySlots,
  ClientJobsResponse,
  ClientShipsResponse,
} from "./requestCache";
import type { ClientOwnerSnapshot } from "./ownerSnapshotCache";

type SnapshotAsset = ClientOwnerSnapshot["assets"]["data"][number];
type SnapshotLocation = ClientOwnerSnapshot["rootLocations"]["data"][number]["location"];

export type OwnerSnapshotProjectionOptions = {
  metadata: readonly TypeMetadata[];
  facilities?: readonly Facility[];
  characterNames?: ReadonlyMap<number, string>;
  systemNames?: ReadonlyMap<number, string>;
};

function isSnapshotLocation(value: SnapshotAsset["rootLocation"]): value is SnapshotLocation {
  return Boolean(value && "kind" in value);
}

function findRootLocation(snapshot: ClientOwnerSnapshot, asset: SnapshotAsset) {
  let locationOrAsset = asset.rootLocation;
  let depth = 0;
  while (locationOrAsset && depth < 20) {
    if (isSnapshotLocation(locationOrAsset)) return locationOrAsset;
    locationOrAsset = locationOrAsset.rootLocation;
    depth += 1;
  }
  return snapshot.rootLocations.data.find((entry) => entry.itemId === asset.itemId)?.location;
}

function sourceLocationKind(location: SnapshotLocation | undefined) {
  if (!location) return undefined;
  return location.kind === "solar_system" ? ("anchored" as const) : location.kind;
}

function sourceLocationName(
  location: SnapshotLocation | undefined,
  systemNames: ReadonlyMap<number, string> = new Map(),
) {
  if (!location) return undefined;
  if (location.kind === "solar_system") {
    const systemId = location.systemId ?? location.locationId;
    return systemNames.get(systemId) ?? `System ${systemId}`;
  }
  if (location.name) return location.name;
  return location.kind === "structure"
    ? "Structure details unavailable"
    : "Station details unavailable";
}

function metadataMap(metadata: readonly TypeMetadata[]) {
  return new Map(metadata.map((entry) => [entry.typeId, entry]));
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

function slotCategory(activityId: number) {
  if (activityId === 1) return "Manufacturing";
  if (activityId === 9) return "Reactions";
  if ([3, 4, 5, 8].includes(activityId)) return "Science";
  return undefined;
}

function locationName(
  snapshot: ClientOwnerSnapshot,
  locationId: number,
  systemNames: ReadonlyMap<number, string> = new Map(),
) {
  const location = snapshot.rootLocations.data.find(
    (entry) => entry.location.locationId === locationId,
  )?.location;
  return sourceLocationName(location, systemNames) ?? `Location ${locationId}`;
}

function corporationSourceForAsset(
  snapshot: ClientOwnerSnapshot,
  asset: SnapshotAsset,
  rootLocationId: number | undefined,
) {
  if (asset.ownerType !== "corporation" || rootLocationId === undefined) return undefined;
  const source =
    snapshot.corporationSources.data.find(
      (candidate) =>
        candidate.corporationId === asset.ownerId
        && candidate.containerItemIds.includes(asset.containerId)
        && candidate.canQuery,
    )
    ?? snapshot.corporationSources.data.find(
      (candidate) =>
        candidate.corporationId === asset.ownerId
        && candidate.rootLocationId === rootLocationId
        && candidate.locationFlag === asset.locationFlag,
    );
  if (!source) return undefined;
  return {
    rootLocationId: source.rootLocationId,
    locationFlag: source.locationFlag,
    containerItemIds: source.containerItemIds.includes(asset.containerId)
      ? [asset.containerId]
      : [],
  };
}

function projectAsset(
  snapshot: ClientOwnerSnapshot,
  asset: SnapshotAsset,
  metadataByTypeId: Map<number, TypeMetadata>,
  systemNames: ReadonlyMap<number, string>,
): StockItem {
  const metadata = metadataByTypeId.get(asset.typeId);
  const rootLocation = findRootLocation(snapshot, asset);
  const rootLocationId = asset.rootLocationId ?? rootLocation?.locationId ?? undefined;
  const systemId =
    rootLocation?.systemId
    ?? (rootLocation?.kind === "solar_system" ? rootLocation.locationId : undefined);
  const category = metadata?.category ?? "item";
  const blueprintInstance =
    category === "blueprint"
      ? snapshot.blueprintInstances.data.find((instance) => instance.itemId === asset.itemId)
      : undefined;
  const isBpo =
    category === "blueprint"
    && (
      blueprintInstance?.runs === -1
      || (blueprintInstance === undefined && asset.runCount === -1)
    );
  const quantity = isBpo
    ? Math.max(1, blueprintInstance?.quantity ?? asset.quantity)
    : asset.quantity;
  const blueprintPrint: BlueprintPrint | undefined = blueprintInstance
    ? {
        itemId: blueprintInstance.itemId,
        runs: blueprintInstance.runs,
        type: isBpo ? "bpo" : "bpc",
        me: blueprintInstance.me,
        te: blueprintInstance.te,
      }
    : undefined;
  return {
    typeId: asset.typeId,
    name: metadata?.name ?? `Type ${asset.typeId}`,
    quantity,
    locationId: asset.locationId,
    rootLocationId,
    sourceLocationName: sourceLocationName(rootLocation, systemNames),
    sourceLocationKind: sourceLocationKind(rootLocation),
    sourceSystemId: systemId,
    sourceSystemName:
      systemId === undefined ? undefined : (systemNames.get(systemId) ?? `System ${systemId}`),
    ownerType: asset.ownerType,
    ownerId: asset.ownerId,
    inUse: asset.inUse,
    isPackaged: !asset.isSingleton,
    ...(metadata?.isShip !== undefined ? { isShip: metadata.isShip } : {}),
    ...(metadata?.isCargoContainer !== undefined
      ? { isCargoContainer: metadata.isCargoContainer }
      : {}),
    me: asset.me,
    te: asset.te,
    category,
    assembledVolume: metadata?.assembledVolume,
    packagedVolume: metadata?.packagedVolume,
    techLevel: metadata?.techLevel,
    assemblyLineGroup: metadata?.assemblyLineGroup,
    ...(category === "blueprint"
      ? { blueprintType: isBpo ? ("bpo" as const) : ("bpc" as const) }
      : {}),
    ...(asset.runCount !== undefined ? { blueprintRunsAtInstall: asset.runCount } : {}),
    ...(blueprintPrint ? { blueprintPrints: [blueprintPrint] } : {}),
    ...(corporationSourceForAsset(snapshot, asset, rootLocationId)
      ? { corporationSource: corporationSourceForAsset(snapshot, asset, rootLocationId) }
      : {}),
  };
}

function projectMarketOrderStock(
  snapshot: ClientOwnerSnapshot,
  metadataByTypeId: Map<number, TypeMetadata>,
): StockItem[] {
  return snapshot.marketOrders.data.flatMap((order) => {
    if (order.sellOrderQuantity <= 0) return [];
    const item = {
      typeId: order.typeId,
      quantity: order.sellOrderQuantity,
      sourceLocationId: order.locationId,
    };
    const metadata = metadataByTypeId.get(item.typeId);
    const rootLocationId = item.sourceLocationId;
    return {
      ...item,
      name: metadata?.name ?? `Type ${item.typeId}`,
      rootLocationId,
      category: metadata?.category ?? "item",
      ...(metadata?.isShip !== undefined ? { isShip: metadata.isShip } : {}),
      ...(metadata?.isCargoContainer !== undefined
        ? { isCargoContainer: metadata.isCargoContainer }
        : {}),
      assembledVolume: metadata?.assembledVolume,
      packagedVolume: metadata?.packagedVolume,
      techLevel: metadata?.techLevel,
      assemblyLineGroup: metadata?.assemblyLineGroup,
      source: "marketOrder" as const,
    };
  });
}

function projectMissingBlueprintAssets(
  snapshot: ClientOwnerSnapshot,
  metadataByTypeId: Map<number, TypeMetadata>,
  systemNames: ReadonlyMap<number, string>,
): StockItem[] {
  const assetItemIds = new Set(snapshot.assets.data.map((asset) => asset.itemId));
  return snapshot.blueprintInstances.data
    .filter((blueprint) => !assetItemIds.has(blueprint.itemId))
    .flatMap((blueprint) => {
      const metadata = metadataByTypeId.get(blueprint.typeId);
      if (metadata?.category !== "blueprint") return [];
      const source = snapshot.corporationSources.data.find(
        (candidate) =>
          candidate.corporationId === blueprint.ownerId
          && candidate.locationFlag === blueprint.locationFlag,
      );
      const rootLocation = snapshot.rootLocations.data.find(
        (entry) => entry.itemId === blueprint.locationId,
      )?.location;
      const rootLocationId =
        rootLocation?.locationId ?? source?.rootLocationId ?? blueprint.locationId;
      const isBpo = blueprint.runs === -1;
      const corporationSource = source && {
        rootLocationId: source.rootLocationId,
        locationFlag: source.locationFlag,
        containerItemIds: source.containerItemIds.includes(blueprint.locationId)
          ? [blueprint.locationId]
          : [],
      };
      return [
        {
          typeId: blueprint.typeId,
          name: metadata.name,
          quantity: Math.max(1, blueprint.quantity),
          locationId: blueprint.locationId,
          rootLocationId,
          ownerType: blueprint.ownerType,
          ownerId: blueprint.ownerId,
          ...(blueprint.inUse ? { inUse: true } : {}),
          category: "blueprint" as const,
          blueprintType: isBpo ? ("bpo" as const) : ("bpc" as const),
          blueprintPrints: [
            {
              itemId: blueprint.itemId,
              runs: blueprint.runs,
              type: isBpo ? ("bpo" as const) : ("bpc" as const),
              me: blueprint.me,
              te: blueprint.te,
            },
          ],
          ...(rootLocation
            ? {
                sourceLocationName: sourceLocationName(rootLocation, systemNames),
                sourceLocationKind: sourceLocationKind(rootLocation),
                sourceSystemId:
                  rootLocation.kind === "solar_system"
                    ? (rootLocation.systemId ?? rootLocation.locationId)
                    : rootLocation.systemId,
              }
            : {}),
          ...(metadata.assembledVolume !== undefined
            ? { assembledVolume: metadata.assembledVolume }
            : {}),
          ...(metadata.packagedVolume !== undefined
            ? { packagedVolume: metadata.packagedVolume }
            : {}),
          ...(metadata.techLevel !== undefined ? { techLevel: metadata.techLevel } : {}),
          ...(metadata.assemblyLineGroup !== undefined
            ? { assemblyLineGroup: metadata.assemblyLineGroup }
            : {}),
          ...(corporationSource ? { corporationSource } : {}),
        },
      ];
    });
}

function corporationSourceForJob(
  snapshot: ClientOwnerSnapshot,
  job: ClientOwnerSnapshot["jobs"]["data"][number],
) {
  if (job.ownerType !== "corporation") return undefined;
  const source = snapshot.corporationSources.data.find(
    (candidate) =>
      candidate.corporationId === job.ownerId
      && candidate.canTake
      && candidate.containerItemIds.includes(job.outputLocationId),
  );
  if (!source) return undefined;
  const outputIsContainer = source.containerItemIds.includes(job.outputLocationId);
  return {
    rootLocationId: source.rootLocationId,
    locationFlag: source.locationFlag,
    containerItemIds: outputIsContainer ? [job.outputLocationId] : [],
  };
}

function jobOutputLocation(
  snapshot: ClientOwnerSnapshot,
  job: ClientOwnerSnapshot["jobs"]["data"][number],
  corporationSource: ReturnType<typeof corporationSourceForJob>,
  systemNames: ReadonlyMap<number, string>,
) {
  const corporationOutput =
    job.ownerType === "corporation"
    && snapshot.corporationSources.data.some(
      (candidate) =>
        candidate.corporationId === job.ownerId
        && candidate.containerItemIds.includes(job.outputLocationId),
    );
  const outputRootLocation = snapshot.rootLocations.data.find(
    (entry) => entry.itemId === job.outputLocationId,
  )?.location;
  const corporationRootLocation = corporationSource
    ? snapshot.corporationSources.data.find(
        (candidate) =>
          candidate.corporationId === job.ownerId
          && candidate.rootLocationId === corporationSource.rootLocationId
          && candidate.locationFlag === corporationSource.locationFlag,
      )?.rootLocation
    : undefined;
  const rootLocation = corporationOutput
    ? corporationRootLocation
    : (outputRootLocation ?? corporationRootLocation);
  const sourceKind = sourceLocationKind(rootLocation);
  const sourceSystemId =
    rootLocation?.systemId
    ?? (rootLocation?.kind === "solar_system" ? rootLocation.locationId : undefined);
  return {
    rootLocationId:
      rootLocation?.locationId ?? corporationSource?.rootLocationId ?? job.outputLocationId,
    sourceLocationName: sourceLocationName(rootLocation, systemNames) ?? job.outputLocationName,
    sourceLocationKind: sourceKind,
    sourceSystemId,
    sourceSystemName:
      sourceSystemId === undefined
        ? undefined
        : (systemNames.get(sourceSystemId) ?? `System ${sourceSystemId}`),
  };
}

function projectIndustryJobAssets(
  snapshot: ClientOwnerSnapshot,
  metadataByTypeId: Map<number, TypeMetadata>,
  systemNames: ReadonlyMap<number, string>,
): StockItem[] {
  const assets: StockItem[] = [];
  for (const job of snapshot.jobs.data) {
    const status = job.status.toLowerCase();
    if (status === "cancelled" || status === "reverted" || status === "delivered") continue;
    const jobRecord = snapshot.industryJobs.data.find((candidate) => candidate.jobId === job.jobId);
    const corporationSource = corporationSourceForJob(snapshot, job);
    const location = jobOutputLocation(snapshot, job, corporationSource, systemNames);
    const metadata =
      job.productTypeId === undefined ? undefined : metadataByTypeId.get(job.productTypeId);
    if (job.productTypeId !== undefined && job.outputQuantity > 0) {
      assets.push({
        typeId: job.productTypeId,
        name: metadata?.name ?? `Type ${job.productTypeId}`,
        quantity: job.outputQuantity,
        locationId: job.outputLocationId,
        ...location,
        ownerType: job.ownerType,
        ownerId: job.ownerId,
        inBuild: true,
        inBuildQuantity: job.outputQuantity,
        isPackaged: false,
        jobId: job.jobId,
        industryJobStatus: status === "paused" ? "paused" : "active",
        industryJobEndDate: job.endDate,
        jobRuns: job.runs,
        licensedRuns: job.outputRunsPerCopy,
        category: metadata?.category ?? "item",
        isShip: metadata?.isShip,
        isCargoContainer: metadata?.isCargoContainer,
        assembledVolume: metadata?.assembledVolume,
        packagedVolume: metadata?.packagedVolume,
        techLevel: metadata?.techLevel,
        assemblyLineGroup: metadata?.assemblyLineGroup,
        activityName: activityName(job.activityId),
        ...(corporationSource ? { corporationSource } : {}),
      });
    }
    if (!jobRecord) continue;
    const blueprintAsset = snapshot.assets.data.find(
      (asset) => asset.itemId === jobRecord.blueprintId,
    );
    const blueprintInstance = snapshot.blueprintInstances.data.find(
      (instance) =>
        instance.itemId === jobRecord.blueprintId
        && instance.ownerType === job.ownerType
        && instance.ownerId === job.ownerId,
    );
    if (blueprintInstance) continue;
    const isCopying = jobRecord.activityId === 5;
    const installedRunCount =
      blueprintAsset?.runCount
      ?? (jobRecord.licensedRuns !== undefined && jobRecord.licensedRuns > 0
        ? jobRecord.licensedRuns
        : undefined);
    const isBpo =
      installedRunCount === -1
      || (
        installedRunCount === undefined
        && (jobRecord.activityId === 1 || isCopying)
        && (jobRecord.licensedRuns === undefined || jobRecord.licensedRuns <= 0)
      );
    const installedRuns =
      jobRecord.installedRuns ?? Math.floor(jobRecord.runs * (jobRecord.probability ?? 1));
    const remainingRuns = isBpo
      ? -1
      : installedRunCount === undefined
        ? 0
        : Math.max(0, installedRunCount - installedRuns);
    if (
      !isBpo
      && remainingRuns <= 0
      && job.productTypeId !== undefined
      && (jobRecord.activityId === 1 || isCopying)
    ) continue;
    const blueprintMetadata = metadataByTypeId.get(job.blueprintTypeId);
    const blueprintCategory = blueprintMetadata?.category ?? "item";
    assets.push({
      typeId: job.blueprintTypeId,
      name: blueprintMetadata?.name ?? `Type ${job.blueprintTypeId}`,
      quantity: 1,
      locationId: job.outputLocationId,
      ...location,
      ownerType: job.ownerType,
      ownerId: job.ownerId,
      inBuild: true,
      inUse: true,
      jobId: job.jobId,
      industryJobStatus: status === "paused" ? "paused" : "active",
      jobRuns: job.runs,
      licensedRuns: job.outputRunsPerCopy,
      category: blueprintCategory,
      assembledVolume: blueprintMetadata?.assembledVolume,
      packagedVolume: blueprintMetadata?.packagedVolume,
      techLevel: blueprintMetadata?.techLevel,
      assemblyLineGroup: blueprintMetadata?.assemblyLineGroup,
      ...(blueprintCategory === "blueprint"
        ? {
            blueprintType: isBpo ? ("bpo" as const) : ("bpc" as const),
            blueprintPrints: [
              {
                itemId: jobRecord.blueprintId,
                runs: remainingRuns,
                type: isBpo ? ("bpo" as const) : ("bpc" as const),
                me: blueprintAsset?.me,
                te: blueprintAsset?.te,
                activity: activityName(job.activityId),
              },
            ],
          }
        : {}),
      ...(corporationSource ? { corporationSource } : {}),
    });
  }
  return assets;
}

function projectCorporationSources(
  snapshots: readonly ClientOwnerSnapshot[],
  systemNames: ReadonlyMap<number, string>,
): ClientCorporationSource[] {
  const sources = new Map<string, ClientCorporationSource>();
  for (const snapshot of snapshots) {
    for (const source of snapshot.corporationSources.data) {
      const key = `${source.corporationId}:${source.rootLocationId}:${source.locationFlag}`;
      if (sources.has(key)) continue;
      const containers =
        source.containers
        ?? source.containerItemIds.map((itemId) => ({
          itemId,
          locationId: source.rootLocationId,
          rootLocationId: source.rootLocationId,
          selected: true,
        }));
      sources.set(
        key,
        {
          corporationId: source.corporationId,
          rootLocationId: source.rootLocationId,
          locationFlag: source.locationFlag,
          label: source.label ?? (source.locationFlag || "Hangar"),
          ...(source.rootLocation
            ? {
                rootLocation: {
                  ...source.rootLocation,
                  ...(source.rootLocation.kind === "solar_system"
                    ? { name: sourceLocationName(source.rootLocation, systemNames) }
                    : {}),
                  ...(source.rootLocation.systemId !== undefined
                    ? {
                        systemName:
                          systemNames.get(source.rootLocation.systemId)
                          ?? `System ${source.rootLocation.systemId}`,
                      }
                    : {}),
                },
              }
            : {}),
          canTake: source.canTake,
          canQuery: source.canQuery,
          selected: source.selected,
          containers: containers.map((container) => ({ ...container })),
        },
      );
    }
  }
  return [...sources.values()];
}

/** Projects cached owner snapshots into the enriched client asset contract. */
export function projectOwnerSnapshotsToClientAssets(
  snapshots: readonly ClientOwnerSnapshot[],
  options: OwnerSnapshotProjectionOptions,
): ClientAssetsResponse {
  const metadataByTypeId = metadataMap(options.metadata);
  const systemNames = options.systemNames ?? new Map<number, string>();
  const marketBuyOrderQuantities: Record<string, number> = {};
  const assets = snapshots.flatMap((snapshot) => {
    for (const order of snapshot.marketOrders.data) {
      const typeId = String(order.typeId);
      marketBuyOrderQuantities[typeId] =
        (marketBuyOrderQuantities[typeId] ?? 0) + order.buyOrderQuantity;
    }
    return [
      ...snapshot.assets.data.map((asset) =>
        projectAsset(snapshot, asset, metadataByTypeId, systemNames),
      ),
      ...projectMissingBlueprintAssets(snapshot, metadataByTypeId, systemNames),
      ...projectIndustryJobAssets(snapshot, metadataByTypeId, systemNames),
      ...projectMarketOrderStock(snapshot, metadataByTypeId),
    ];
  });
  return {
    assets,
    facilities: [...(options.facilities ?? [])],
    corporationSources: projectCorporationSources(snapshots, systemNames),
    marketBuyOrderQuantities,
  };
}

/** Projects owner-scoped jobs into the existing jobs page response contract. */
export function projectOwnerSnapshotsToClientJobs(
  snapshots: readonly ClientOwnerSnapshot[],
  metadata: readonly TypeMetadata[],
  industrySlots: ReadonlyMap<number, ClientIndustrySlots> = new Map(),
  systemNames: ReadonlyMap<number, string> = new Map(),
): ClientJobsResponse {
  const metadataByTypeId = metadataMap(metadata);
  const slotUsage: NonNullable<ClientJobsResponse["slotUsage"]> = {};
  for (const [characterId, availableSlots] of industrySlots) {
    slotUsage[String(characterId)] = {
      slots: {},
      availableSlots: { ...availableSlots },
    };
  }
  const countedJobIds = new Set<number>();
  for (const snapshot of snapshots) {
    for (const job of snapshot.jobs.data) {
      if (job.status.toLowerCase() !== "active" || countedJobIds.has(job.jobId)) continue;
      countedJobIds.add(job.jobId);
      const category = slotCategory(job.activityId);
      if (category === undefined) continue;
      const characterId = String(job.characterId);
      const usage = slotUsage[characterId] ?? {
        slots: {},
        availableSlots: industrySlots.get(job.characterId) ?? {},
      };
      usage.slots[category] = (usage.slots[category] ?? 0) + 1;
      slotUsage[characterId] = usage;
    }
  }
  const jobs = snapshots.flatMap((snapshot) =>
    snapshot.jobs.data.map((job) => ({
      ...job,
      activity: activityName(job.activityId),
      outputLocationName:
        job.outputLocationName ?? locationName(snapshot, job.outputLocationId, systemNames),
      blueprintTypeName: metadataByTypeId.get(job.blueprintTypeId)?.name,
      productTypeName:
        job.productTypeId === undefined ? undefined : metadataByTypeId.get(job.productTypeId)?.name,
    })),
  );
  return { slotUsage, jobs };
}

/** Projects owner-scoped ships and fitting assets into the existing ships page response contract. */
export function projectOwnerSnapshotsToClientShips(
  snapshots: readonly ClientOwnerSnapshot[],
  options: Pick<OwnerSnapshotProjectionOptions, "metadata" | "characterNames"> & {
    systemNames?: ReadonlyMap<number, string>;
  },
): ClientShipsResponse {
  const metadataByTypeId = metadataMap(options.metadata);
  const ships = snapshots.flatMap((snapshot) =>
    snapshot.ships.data.map((ship) => ({
      ...ship,
      name: ship.name ?? metadataByTypeId.get(ship.typeId)?.name,
      systemName:
        ship.systemId === undefined
          ? undefined
          : (options.systemNames?.get(ship.systemId) ?? `System ${ship.systemId}`),
      pilotName: ship.pilotId === undefined ? undefined : options.characterNames?.get(ship.pilotId),
      locationName:
        ship.systemId === undefined
          ? undefined
          : (options.systemNames?.get(ship.systemId) ?? `System ${ship.systemId}`),
      items: ship.items.map((item) => ({
        itemId: item.itemId,
        typeId: item.typeId,
        name: metadataByTypeId.get(item.typeId)?.name,
        quantity: item.quantity,
        locationId: item.locationId,
        locationType: item.locationType,
        locationFlag: item.locationFlag,
        isSingleton: item.isSingleton,
        isAmmo: item.isAmmo,
      })),
    })),
  );
  const typeIds = [
    ...new Set(ships.flatMap((ship) => [ship.typeId, ...ship.items.map((item) => item.typeId)])),
  ];
  return {
    ships,
    types: typeIds.map((typeId) => ({
      typeId,
      name: metadataByTypeId.get(typeId)?.name ?? `Type ${typeId}`,
    })),
  };
}
