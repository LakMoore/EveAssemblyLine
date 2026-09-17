import {
  getBlueprintsByInventionProductId,
  getBlueprintIndexes,
  getBuildBlueprintByProductTypeId,
  getCompressibleTypes,
  getGroups,
  getMarketGroups,
  getIndustryTargetFilters,
  getSkillPrerequisites,
  getTypeMaterials,
} from "@/cache/services/sdeCache";
import { getTypes } from "@/lib/sde/loader";
import { categorizeType } from "@/lib/reference/category";
import { AssemblyLineGroups } from "@/lib/reference/assemblyLineGroups";
import { getProductionGroupReferences, productionGroupForType } from "./productionGroups";
import { requiredMaterialQuantity } from "./materialQuantities";
import type { RequestProfiler } from "@/lib/server/profiling";
import {
  PlanBuildItem,
  PlanJobInput,
  PlanJobInputs,
  PlanJobInputStatus,
  PlanActivityLocations,
  ResponseHaulBucket,
  PlanHaulTask,
  ResponseLocationBucket,
  PlanResponse,
  PlanWarning,
  PlannerRequest,
  PlanCalculation,
  PlanSourceCounts,
  PlanSourceCountsByLocation,
  PlanSourceCountsByType,
  PlanSourceIcon,
  PlanDemandSources,
  PlanStockItem,
  BlueprintPrint,
  ResponsePlanItem,
  ResponsePlanItems,
  ResponseMaterial,
  ResponseItem,
  StockOwnerType,
} from "./types";
import {
  allocateReprocessing,
  getNetReprocessingRequirements,
  type ReprocessingAllocation,
  type ReprocessingCandidate,
  reprocessCommittedPurchases,
  specialReprocessableTypeIds,
} from "./reprocessStock";
import { allocateStockpileStock } from "./stockpileAllocation";
import { getFinalPlanningLedgerTransfers, type PlanningLedger } from "./planningLedger";
import {
  getStockRootLocationId,
  isAvailableIndustryProductionOutput,
  isIndustryProductionOutput,
  isUsableIndustryProductionOutput,
} from "./stockPolicies";

type Material = PlanCalculation["lists"]["materialsToBuy"][number];
type Efficiency = { me: number; te: number };
type ManufacturingRunAllocation = {
  runs: number;
  efficiency: Efficiency;
  source: "bpo" | "bpc" | "fallback";
};
type StockLot = {
  typeId: number;
  quantity: number;
  rootLocationId: number;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  industryJobOutput: boolean;
  volumePerUnit: number;
  sourceItem: PlanStockItem;
};

/** Builds a job-input group and derives its aggregate completion state. */
function summarizePlanJobInputs(
  blueprint: PlanJobInput,
  materials: PlanJobInput[],
  blueprintCounts: Pick<PlanJobInputs, "bpoCount" | "bpcRuns"> = {
    bpoCount: 0,
    bpcRuns: 0,
  },
): PlanJobInputs {
  const completionPercent = materials.length
    ? Math.min(...materials.map((input) => input.completionPercent))
    : 100;
  return {
    blueprint,
    materials,
    ...blueprintCounts,
    completionPercent,
    status: completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked",
  };
}

/** Adds a discovered demand contribution to a calculation row's provenance map. */
function addDemandSource(
  demandSources: PlanDemandSources,
  demandingTypeId: number | undefined,
  quantity: number,
  headlineQuantity: number,
) {
  if (demandingTypeId === undefined || quantity <= 0 || headlineQuantity <= 0) {
    return demandSources;
  }
  const next = new Map(demandSources);
  const existing = next.get(demandingTypeId);
  next.set(
    demandingTypeId,
    {
      quantity: (existing?.quantity ?? 0) + quantity,
      headlineQuantity: (existing?.headlineQuantity ?? 0) + headlineQuantity,
    },
  );
  return next;
}

/** Merges demand provenance from calculation rows representing the same type. */
function mergeDemandSources(existing: PlanDemandSources, next: PlanDemandSources) {
  const merged = new Map(existing);
  for (const [typeId, source] of next) {
    const current = merged.get(typeId);
    merged.set(
      typeId,
      {
        quantity: (current?.quantity ?? 0) + source.quantity,
        headlineQuantity: (current?.headlineQuantity ?? 0) + source.headlineQuantity,
      },
    );
  }
  return merged;
}

/** Aggregates item quantities by type ID. */
function aggregateQuantitiesByTypeId(
  items: ReadonlyArray<{ typeId: number; quantity: number }>,
): Map<number, number> {
  const quantitiesByTypeId = new Map<number, number>();
  for (const item of items) {
    quantitiesByTypeId.set(item.typeId, (quantitiesByTypeId.get(item.typeId) ?? 0) + item.quantity);
  }
  return quantitiesByTypeId;
}

function getPreferredActivityLocationIds(locations: PlanActivityLocations | undefined) {
  return new Set(
    [locations?.manufacturing, locations?.reactions, locations?.reprocessing].filter(
      (locationId): locationId is number => locationId !== undefined,
    ),
  );
}

function haulingKey(
  itemTypeId: number,
  fromLocationId: number,
  toLocationId: number,
  ownerType?: "character" | "corporation",
  ownerId?: number,
  source?: "production",
) {
  return `${itemTypeId}:${fromLocationId}:${toLocationId}:${ownerType ?? "unassigned"}:${ownerId ?? 0}:${source ?? "stock"}`;
}

type ProfileEntry = { count: number; totalMs: number; maxMs: number };

class PlanProfiler {
  private readonly entries = new Map<string, ProfileEntry>();
  private readonly enabled = process.env.NODE_ENV === "development";

  get isEnabled() {
    return this.enabled;
  }

  count(name: string) {
    if (!this.enabled) return;
    const entry = this.entries.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    this.entries.set(name, entry);
  }

  measure<T>(
    name: string,
    operation: () => Promise<T>,
    details?: () => Record<string, number | string>,
  ): Promise<T> {
    if (!this.enabled) return operation();
    const startedAt = performance.now();
    return operation().then(
      (value) => {
        this.record(name, startedAt, details);
        return value;
      },
      (error: unknown) => {
        this.record(name, startedAt, details);
        throw error;
      },
    );
  }

  private record(name: string, startedAt: number, details?: () => Record<string, number | string>) {
    const elapsedMs = performance.now() - startedAt;
    const entry = this.entries.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    entry.totalMs += elapsedMs;
    entry.maxMs = Math.max(entry.maxMs, elapsedMs);
    this.entries.set(name, entry);
    if (elapsedMs >= 100) {
      console.debug(`[plan] slow ${name}: ${elapsedMs.toFixed(1)}ms`, details?.());
    }
  }

  logSummary() {
    if (!this.enabled) return;
    console.debug(
      "[plan] profile",
      Object.fromEntries(
        [...this.entries.entries()].map(([name, entry]) => [
          name,
          {
            count: entry.count,
            totalMs: Number(entry.totalMs.toFixed(1)),
            maxMs: Number(entry.maxMs.toFixed(1)),
          },
        ]),
      ),
    );
  }
}

function measureProfiled<T>(
  profiler: RequestProfiler | undefined,
  section: string,
  operation: () => Promise<T>,
): Promise<T> {
  return profiler?.measure(section, operation) ?? operation();
}

export type PlanningData = {
  types: Awaited<ReturnType<typeof getTypes>>;
  compressibleTypes: Awaited<ReturnType<typeof getCompressibleTypes>>;
  typeMaterials: Awaited<ReturnType<typeof getTypeMaterials>>;
  groups: Awaited<ReturnType<typeof getGroups>>;
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>;
  targetFilters: Awaited<ReturnType<typeof getIndustryTargetFilters>>;
  skillPrerequisites: Awaited<ReturnType<typeof getSkillPrerequisites>>;
};

/** Loads the immutable SDE data shared by every pass in one plan calculation. */
async function loadPlanningData(): Promise<PlanningData> {
  const [
    types,
    compressibleTypes,
    typeMaterials,
    groups,
    marketGroups,
    targetFilters,
    skillPrerequisites,
  ] = await Promise.all([
    getTypes(),
    getCompressibleTypes(),
    getTypeMaterials(),
    getGroups(),
    getMarketGroups(),
    getIndustryTargetFilters(),
    getSkillPrerequisites(),
  ]);
  return {
    types,
    compressibleTypes,
    typeMaterials,
    groups,
    marketGroups,
    targetFilters,
    skillPrerequisites,
  };
}

function clampEfficiency(value: number, maximum: number) {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** Builds bounded owned-stock and purchase candidates for demand-limited reprocessing. */
async function allocatePlanReprocessing(
  request: PlannerRequest,
  preliminaryPlan: PlanCalculation,
  locations: PlanActivityLocations | undefined,
  planningData: PlanningData,
  ownedQuantityLimits?: ReadonlyMap<number, number>,
): Promise<ReprocessingAllocation> {
  const { types, compressibleTypes, typeMaterials } = planningData;
  const compressedTypeIds = new Set(compressibleTypes.values());
  const reprocessableTypeIds = new Set([
    ...compressibleTypes.keys(),
    ...compressibleTypes.values(),
    ...specialReprocessableTypeIds,
  ]);
  const requiredMaterials = getNetReprocessingRequirements(preliminaryPlan.lists.materialsToBuy);
  const reservedDirectStock = new Map(
    preliminaryPlan.lists.materialsToBuy
      .filter((material) => reprocessableTypeIds.has(material.typeId))
      .map((material) => [material.typeId, material.stockQuantity]),
  );
  const reprocessingLocationId = locations?.reprocessing ?? locations?.manufacturing;

  const ownedQuantityByTypeId = new Map<number, number>();
  const localQuantityByTypeId = new Map<number, number>();
  for (const item of request.stock) {
    if (
      item.category === "blueprint"
      || item.category === "reactionformula"
      || !reprocessableTypeIds.has(item.typeId)
      || !isUsableIndustryProductionOutput(item)
    ) continue;
    ownedQuantityByTypeId.set(
      item.typeId,
      (ownedQuantityByTypeId.get(item.typeId) ?? 0) + item.quantity,
    );
    if (
      item.source !== "marketOrder"
      && reprocessingLocationId !== undefined
      && getStockRootLocationId(item) === reprocessingLocationId
    ) {
      localQuantityByTypeId.set(
        item.typeId,
        (localQuantityByTypeId.get(item.typeId) ?? 0) + item.quantity,
      );
    }
  }

  const candidateFor = (
    typeId: number,
    availableQuantity: number,
    source: ReprocessingCandidate["source"],
  ): ReprocessingCandidate | undefined => {
    const materialRecord = typeMaterials.get(typeId);
    const type = types.get(typeId);
    const portionSize = type?.portionSize ?? 1;
    if (!type || !materialRecord?.materials?.length || portionSize <= 0 || availableQuantity <= 0) {
      return undefined;
    }
    return {
      typeId,
      availableQuantity,
      portionSize,
      efficiency: request.reprocessingEfficiencies?.[String(typeId)] ?? 50,
      yields: new Map(
        materialRecord.materials.map((material) => [material.materialTypeID, material.quantity]),
      ),
      source,
      volumePerUnit: type.packagedVolume ?? type.volume ?? 0,
      isCompressed: compressedTypeIds.has(typeId),
      ...(source === "owned"
        ? {
            quantityAtReprocessingLocation: Math.min(
              availableQuantity,
              localQuantityByTypeId.get(typeId) ?? 0,
            ),
          }
        : {}),
    };
  };
  const ownedCandidates = [...ownedQuantityByTypeId].flatMap(([typeId, quantity]) => {
    const reservedQuantity = reservedDirectStock.get(typeId) ?? 0;
    const usableQuantity = Math.max(0, quantity - reservedQuantity);
    const availableQuantity = Math.min(
      usableQuantity,
      ownedQuantityLimits?.get(typeId) ?? usableQuantity,
    );
    const candidate = candidateFor(typeId, availableQuantity, "owned");
    return candidate ? [candidate] : [];
  });
  const purchaseQuantityByTypeId = request.items
    .filter((item) => item.fromCompression)
    .reduce(
      (quantities, item) =>
        quantities.set(item.typeId, (quantities.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const purchaseCandidates = [...purchaseQuantityByTypeId].flatMap(([typeId, quantity]) => {
    const candidate = candidateFor(typeId, quantity, "purchase");
    return candidate ? [candidate] : [];
  });
  const committed = reprocessCommittedPurchases(purchaseCandidates);
  const remainingMaterials = new Map(requiredMaterials);
  for (const [typeId, quantity] of committed.producedMaterials) {
    remainingMaterials.set(typeId, Math.max(0, (remainingMaterials.get(typeId) ?? 0) - quantity));
  }
  const owned = allocateReprocessing(remainingMaterials, ownedCandidates);
  const producedMaterials = new Map(committed.producedMaterials);
  for (const [typeId, quantity] of owned.producedMaterials) {
    producedMaterials.set(typeId, (producedMaterials.get(typeId) ?? 0) + quantity);
  }
  return {
    ...owned,
    consumedPurchases: committed.purchased,
    producedMaterials,
  };
}

/** Returns the first complete contribution from an owned candidate to a preliminary shortage. */
function firstOwnedContributionQuantity(
  typeId: number,
  currentQuantity: number,
  preliminaryPlan: PlanCalculation,
  request: PlannerRequest,
  planningData: PlanningData,
) {
  const type = planningData.types.get(typeId);
  const materials = planningData.typeMaterials.get(typeId)?.materials;
  const portionSize = type?.portionSize ?? 1;
  if (!type || !materials?.length || portionSize <= 0) return currentQuantity;
  const requirements = getNetReprocessingRequirements(preliminaryPlan.lists.materialsToBuy);
  const efficiency = request.reprocessingEfficiencies?.[String(typeId)] ?? 50;
  const usefulRuns = materials.flatMap((material) => {
    const yieldPerRun = (material.quantity * efficiency) / 100;
    const shortage = requirements.get(material.materialTypeID) ?? 0;
    return yieldPerRun > 0 && shortage > 0 ? [Math.ceil(shortage / yieldPerRun)] : [];
  });
  if (usefulRuns.length === 0) return currentQuantity;
  return Math.min(currentQuantity, Math.min(...usefulRuns) * portionSize);
}

/** Returns whether a reduced allocation preserves the current material purchases. */
function preservesPurchaseQuantities(current: PlanCalculation, baseline: PlanCalculation) {
  const baselineBuyQuantities = new Map(
    baseline.lists.materialsToBuy.map((material) => [material.typeId, material.buyQuantity]),
  );
  return current.lists.materialsToBuy.every(
    (material) => material.buyQuantity <= (baselineBuyQuantities.get(material.typeId) ?? 0),
  );
}

/** Removes owned reprocessing that is not needed to preserve the current purchase plan. */
async function minimizeOwnedReprocessing(
  request: PlannerRequest,
  allocation: ReprocessingAllocation,
  baseline: PlanCalculation,
  preliminaryPlan: PlanCalculation,
  locations: PlanActivityLocations | undefined,
  planningData: PlanningData,
  options: PlanPassOptions,
): Promise<ReprocessingAllocation> {
  let minimized = allocation;
  let currentPlan = baseline;
  const compressedTypeIds = new Set(planningData.compressibleTypes.values());
  const ownedAllocations = [...allocation.consumedOwned].sort(
    ([leftTypeId], [rightTypeId]) =>
      Number(compressedTypeIds.has(leftTypeId)) - Number(compressedTypeIds.has(rightTypeId)),
  );
  for (const [typeId, currentQuantity] of ownedAllocations) {
    if (compressedTypeIds.has(typeId)) continue;
    const limitedQuantity = firstOwnedContributionQuantity(
      typeId,
      currentQuantity,
      preliminaryPlan,
      request,
      planningData,
    );
    if (limitedQuantity >= currentQuantity) continue;
    const quantityLimits = new Map(minimized.consumedOwned);
    quantityLimits.set(typeId, limitedQuantity);
    const candidateAllocation = await allocatePlanReprocessing(
      request,
      preliminaryPlan,
      locations,
      planningData,
      quantityLimits,
    );
    const candidatePlan = await calculatePlanPass(
      request,
      planningData,
      {
        ...options,
        locations,
        persistStockConsumption: false,
        reprocessing: candidateAllocation,
      },
    );
    if (!preservesPurchaseQuantities(candidatePlan, currentPlan)) continue;
    minimized = candidateAllocation;
    currentPlan = candidatePlan;
  }
  return minimized;
}

/** Converts committed compressed purchases in special stockpiles into future available stock. */
async function getFutureCompressedMaterialStock(
  request: PlannerRequest,
  stockpiles: NonNullable<PlannerRequest["stockpiles"]>,
  planningData: PlanningData,
): Promise<PlanStockItem[]> {
  const { types, typeMaterials } = planningData;
  const futureStock: PlanStockItem[] = [];
  for (const stockpile of stockpiles) {
    if (stockpile.kind !== "special") continue;
    const purchaseQuantities = new Map<number, number>();
    for (const item of stockpile.items) {
      if (!item.fromCompression) continue;
      purchaseQuantities.set(
        item.typeId,
        (purchaseQuantities.get(item.typeId) ?? 0) + item.quantity,
      );
    }
    const candidates = [...purchaseQuantities].flatMap(([typeId, quantity]) => {
      const type = types.get(typeId);
      const materialRecord = typeMaterials.get(typeId);
      const portionSize = type?.portionSize ?? 1;
      if (!type || !materialRecord?.materials?.length || portionSize <= 0) return [];
      return [
        {
          typeId,
          availableQuantity: quantity,
          portionSize,
          efficiency:
            stockpile.reprocessingEfficiencies?.[String(typeId)]
            ?? request.reprocessingEfficiencies?.[String(typeId)]
            ?? 50,
          yields: new Map(
            materialRecord.materials.map((material) => [
              material.materialTypeID,
              material.quantity,
            ]),
          ),
          source: "purchase" as const,
          volumePerUnit: type.packagedVolume ?? type.volume ?? 0,
        },
      ];
    });
    const producedMaterials = reprocessCommittedPurchases(candidates).producedMaterials;
    for (const [typeId, quantity] of producedMaterials) {
      if (quantity <= 0) continue;
      futureStock.push({
        typeId,
        name: types.get(typeId)?.name.en ?? `Type ${typeId}`,
        quantity,
        category: "item",
        rootLocationId: stockpile.locations.reprocessing,
        locationId: stockpile.locations.reprocessing,
      });
    }
  }
  return futureStock;
}

/** Calculates the detailed internal result after selecting reprocessing portions for shortages. */
export async function calculatePlanCalculation(
  request: PlannerRequest,
  profiler?: RequestProfiler,
): Promise<PlanCalculation> {
  const populatedStockpiles = request.stockpiles.filter((stockpile) => stockpile.items.length > 0);
  if (populatedStockpiles.length === 0) {
    throw new Error("Plan calculation requires at least one populated stockpile.");
  }
  const planningData = await measureProfiled(profiler, "planningData", loadPlanningData);
  return measureProfiled(
    profiler,
    "stockpilePlan",
    () =>
      calculateStockpilePlan(
        { ...request, stockpiles: populatedStockpiles },
        planningData,
        profiler,
      ),
  );
}

/** Calculates a plan and returns the compact public response shape. */
export async function calculatePlan(
  request: PlannerRequest,
  profiler?: RequestProfiler,
): Promise<PlanResponse> {
  const result = await measureProfiled(
    profiler,
    "calculation",
    () => calculatePlanCalculation(request, profiler),
  );
  return measureProfiled(
    profiler,
    "response",
    () => toPlanResponse(result, getRequestActivityLocationIds(request), request.language ?? "en"),
  );
}

async function loadResponseTypeData() {
  const [types, groups, marketGroups] = await Promise.all([
    getTypes(),
    getGroups(),
    getMarketGroups(),
  ]);
  return { types, groups, marketGroups };
}

/** Converts the detailed internal result into the compact public response. */
export function toPlanResponse(
  result: PlanCalculation,
  activityLocationIds?: ReadonlySet<number>,
  language: NonNullable<PlannerRequest["language"]> = "en",
): Promise<PlanResponse> {
  return loadResponseTypeData().then(({ types, groups, marketGroups }) => {
    const resolveTypeName = (typeId: number) => {
      const name = types.get(typeId)?.name;
      return name?.[language] ?? name?.en ?? `Type ${typeId}`;
    };
    const resolveAssemblyLineGroup = (typeId: number) => {
      const type = types.get(typeId);
      const groupId = type?.groupID;
      return (
        categorizeType(
          {
            name: type?.name ?? {},
            groupID: type?.groupID,
            marketGroupID: type?.marketGroupID,
          },
          language,
          marketGroups,
          groups,
        ).assemblyLineGroup
        ?? (groupId === undefined
          ? "Unknown"
          : (
              groups.get(groupId)?.name[language]
              ?? groups.get(groupId)?.name.en
              ?? `Group ${groupId}`
            ))
      );
    };
    const {
      planItems,
      materialsToBuy: _materialsToBuy,
      bpcsNeeded,
      bpcsToBuy,
      inventionJobs,
      reactionJobs,
      manufacturingJobs,
      reprocessingJobs,
      haulingTasks,
      ...otherLists
    } = result.lists;
    const locationBuckets = <T extends { locationId?: number; activityLocationId?: number }>(
      entries: T[],
      locationFor: (entry: T) => number | undefined,
    ): ResponseLocationBucket<ResponseItem<T>>[] => {
      const buckets = new Map<string, ResponseLocationBucket<ResponseItem<T>>>();
      for (const entry of entries) {
        const locationId = locationFor(entry);
        const { activityLocationId: _activityLocationId, locationId: _locationId, ...item } = entry;
        delete (item as { locationId?: number }).locationId;
        const key = String(locationId ?? "unlocated");
        const bucket = buckets.get(key) ?? {
          ...(locationId !== undefined ? { locationId } : {}),
          items: [],
        };
        bucket.items.push(item as ResponseItem<T>);
        buckets.set(key, bucket);
      }
      return [...buckets.values()];
    };
    const toBlueprintPurchaseItem = (blueprint: (typeof bpcsNeeded)[number]) => ({
      typeId: blueprint.typeId,
      typeName: resolveTypeName(blueprint.typeId),
      unitVolume: blueprint.unitVolume,
      neededQuantity: blueprint.buyQuantity,
      bposInUse: blueprint.bposInUse ?? 0,
      bpoCount: blueprint.bpoCount + (blueprint.bposInUse ?? 0),
    });
    const toBlueprintPurchase = (blueprint: (typeof bpcsNeeded)[number]) => ({
      item: toBlueprintPurchaseItem(blueprint),
      assemblyLineGroup: resolveAssemblyLineGroup(blueprint.typeId),
    });
    const planActivityLocationIds = activityLocationIds ?? getResultActivityLocationIds(result);
    const allPlanActivityLocationIds = new Set([
      ...planActivityLocationIds,
      ...planItems
        .map((entry) => entry.stockpileLocationId ?? entry.activityLocationId)
        .filter((locationId): locationId is number => locationId !== undefined),
    ]);
    const remoteIndustryOutputQuantity = (typeId: number, locationId: number | undefined) => {
      if (locationId === undefined) return 0;
      return Object
        .entries(result.availableSourceCountsByType?.get(typeId) ?? {})
        .filter(([sourceLocationId]) => Number(sourceLocationId) !== locationId)
        .reduce((total, [, counts]) => total + (counts?.industry ?? 0), 0);
    };
    const allPlanItems = mergeResponsePlanItems(planItems, undefined).map((entry) =>
      toResponsePlanItem(
        entry,
        haulingTasks,
        allPlanActivityLocationIds,
        resolveTypeName,
        result.availableSourceCountsByType?.get(entry.typeId),
        result.availableStockQuantitiesByType?.get(entry.typeId),
        0,
        false,
      ),
    );
    const planItemsByActivityLocation = new Map<
      number | undefined,
      PlanCalculation["lists"]["planItems"]
    >();
    for (const entry of planItems) {
      const locationId = entry.stockpileLocationId ?? entry.activityLocationId;
      const locationEntries = planItemsByActivityLocation.get(locationId) ?? [];
      locationEntries.push(entry);
      planItemsByActivityLocation.set(locationId, locationEntries);
    }
    const responsePlanItems: ResponsePlanItems = {
      all: allPlanItems,
      byActivityLocation: [...planItemsByActivityLocation.entries()].map(
        ([locationId, entries]) => ({
          ...(locationId !== undefined ? { locationId } : {}),
          items: mergeResponsePlanItems(entries, locationId).map((entry) =>
            toResponsePlanItem(
              entry,
              haulingTasks,
              new Set([...(locationId !== undefined ? [locationId] : [])]),
              resolveTypeName,
              sourceCountsForLocation(
                result.availableSourceCountsByType?.get(entry.typeId),
                locationId,
              ),
              locationId === undefined
                ? undefined
                : (
                    result.availableStockQuantitiesByLocationAndType?.get(
                      locationTypeKey(locationId, entry.typeId),
                    ) ?? 0
                  ),
              remoteIndustryOutputQuantity(entry.typeId, locationId),
              true,
            ),
          ),
        }),
      ),
    };
    const haulBuckets = new Map<string, ResponseHaulBucket>();
    for (const task of haulingTasks) {
      const ownerKey = `${task.ownerType ?? "unassigned"}:${task.ownerId ?? 0}`;
      const key = `${task.fromLocationId}:${task.toLocationId}:${ownerKey}`;
      const bucket = haulBuckets.get(key) ?? {
        fromLocationId: task.fromLocationId,
        toLocationId: task.toLocationId,
        ...(task.ownerType ? { ownerType: task.ownerType } : {}),
        ...(task.ownerId !== undefined ? { ownerId: task.ownerId } : {}),
        items: [],
      };
      const item: ResponseMaterial = {
        typeId: task.typeId,
        typeName: task.typeName,
        unitVolume: task.unitVolume,
        neededQuantity: task.neededQuantity,
        ...(task.inBuildQuantity !== undefined ? { inBuildQuantity: task.inBuildQuantity } : {}),
      };
      const existingItem = bucket.items.find((candidate) => candidate.typeId === item.typeId);
      if (existingItem) {
        const totalVolume =
          existingItem.neededQuantity * existingItem.unitVolume
          + item.neededQuantity * item.unitVolume;
        existingItem.neededQuantity += item.neededQuantity;
        existingItem.unitVolume = totalVolume / existingItem.neededQuantity;
        existingItem.inBuildQuantity =
          (existingItem.inBuildQuantity ?? 0) + (item.inBuildQuantity ?? 0);
      }
      else bucket.items.push(item);
      haulBuckets.set(key, bucket);
    }
    const materialPurchaseEntries = _materialsToBuy
      .filter((material) => material.buyQuantity > 0)
      .map((material) => ({
        item: {
          typeId: material.typeId,
          typeName: resolveTypeName(material.typeId),
          unitVolume: material.unitVolume,
          neededQuantity: material.buyQuantity,
        },
        assemblyLineGroup: resolveAssemblyLineGroup(material.typeId),
      }));
    const blueprintCopyEntries = bpcsNeeded
      .filter((blueprint) => blueprint.buyQuantity > 0)
      .map((blueprint) => ({
        ...toBlueprintPurchaseItem(blueprint),
        ...(blueprint.activityLocationId !== undefined
          ? { locationId: blueprint.activityLocationId }
          : {}),
      }));
    const blueprintBuyEntries = bpcsToBuy
      .filter((blueprint) => blueprint.buyQuantity > 0)
      .map(toBlueprintPurchase);
    return {
      metadata: {
        generatedAt: result.metadata.generatedAt,
        ...(result.metadata.planId ? { planId: result.metadata.planId } : {}),
        ...(result.metadata.unresolvedAssetCount !== undefined
          ? { unresolvedAssetCount: result.metadata.unresolvedAssetCount }
          : {}),
        ...(result.metadata.corporationAssetSources
          ? { corporationAssetSources: result.metadata.corporationAssetSources }
          : {}),
      },
      lists: {
        ...otherLists,
        warnings: locationBuckets(result.metadata.warnings ?? [], (entry) => entry.locationId),
        planItems: responsePlanItems,
        materialsToBuy: groupResponseMaterialEntries(materialPurchaseEntries),
        bpcToCopy: locationBuckets(blueprintCopyEntries, (entry) => entry.locationId),
        bpoToBuy: groupResponseMaterialEntries(blueprintBuyEntries),
        inventionJobs: locationBuckets(inventionJobs, (entry) => entry.locationId),
        reactionJobs: locationBuckets(reactionJobs, (entry) => entry.locationId),
        manufacturingJobs: locationBuckets(manufacturingJobs, (entry) => entry.locationId),
        reprocessingJobs: locationBuckets(reprocessingJobs, (entry) => entry.locationId),
        haulingTasks: [...haulBuckets.values()],
      },
    };
  });
}

type ResponseMaterialEntry<T extends ResponseMaterial> = {
  item: T;
  assemblyLineGroup: string;
};

function groupResponseMaterialEntries<T extends ResponseMaterial>(
  entries: ResponseMaterialEntry<T>[],
): AssemblyLineGroups<T> {
  return AssemblyLineGroups
    .groupBy(entries, (entry) => entry.assemblyLineGroup)
    .map((bucket) => ({
      assemblyLineGroup: bucket.assemblyLineGroup,
      items: bucket.items
        .map((entry) => entry.item)
        .slice()
        .sort(
          (left, right) =>
            left.typeName.localeCompare(right.typeName) || left.typeId - right.typeId,
        ),
    }))
    .sort((left, right) => left.assemblyLineGroup.localeCompare(right.assemblyLineGroup));
}

function getRequestActivityLocationIds(request: PlannerRequest): Set<number> {
  return new Set(
    request.stockpiles.flatMap((stockpile) => [
      stockpile.locations.manufacturing,
      stockpile.locations.reactions,
      stockpile.locations.reprocessing,
      stockpile.locations.copying,
      stockpile.locations.invention,
      ...Object.values(stockpile.groupAssignments ?? {}),
    ]),
  );
}

function getResultActivityLocationIds(result: PlanCalculation): Set<number> {
  return new Set(
    [
      ...result.lists.inventionJobs,
      ...result.lists.reactionJobs,
      ...result.lists.manufacturingJobs,
      ...result.lists.reprocessingJobs,
    ]
      .map((job) => job.locationId)
      .filter((locationId): locationId is number => locationId !== undefined),
  );
}

function mergeResponsePlanItems(
  entries: PlanCalculation["lists"]["planItems"],
  activityLocationId?: number,
): PlanCalculation["lists"]["planItems"] {
  const merged = new Map<string, PlanCalculation["lists"]["planItems"][number]>();
  const sourceLocationByKey = new Map<string, number | undefined>();
  const mergeSourceCounts =
    activityLocationId === undefined ? mergePlanSourceCountsByMaximum : mergePlanSourceCounts;
  for (const entry of entries) {
    const sourceCounts = sourceCountsForLocation(entry.availableSourceCounts, activityLocationId);
    const key = `${entry.kind}:${entry.typeId}`;
    const sourceLocationId = entry.stockpileLocationId ?? entry.activityLocationId;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(
        key,
        {
          ...entry,
          activityLocationId,
          availableSourceCounts: sourceCounts,
        },
      );
      sourceLocationByKey.set(key, sourceLocationId);
      continue;
    }
    if (entry.kind === "material" && existing.kind === "material") {
      merged.set(
        key,
        {
          ...existing,
          quantity: existing.quantity + entry.quantity,
          requiredQuantity: existing.requiredQuantity + entry.requiredQuantity,
          stockQuantity: existing.stockQuantity + entry.stockQuantity,
          availableStockQuantity: Math.max(
            existing.availableStockQuantity,
            entry.availableStockQuantity,
          ),
          productionQuantity: existing.productionQuantity + entry.productionQuantity,
          reprocessingQuantity:
            (existing.reprocessingQuantity ?? 0) + (entry.reprocessingQuantity ?? 0),
          buyQuantity: existing.buyQuantity + entry.buyQuantity,
          remainingProductionQuantity:
            existing.remainingProductionQuantity + entry.remainingProductionQuantity,
          availableSourceCounts: mergeSourceCounts(existing.availableSourceCounts, sourceCounts),
          demandSources: mergeDemandSources(existing.demandSources, entry.demandSources),
        },
      );
    }
    else if (entry.kind === "bpc" && existing.kind === "bpc") {
      merged.set(
        key,
        {
          ...existing,
          neededQuantity: existing.neededQuantity + entry.neededQuantity,
          stockQuantity: existing.stockQuantity + entry.stockQuantity,
          stockRuns: existing.stockRuns + entry.stockRuns,
          buyQuantity: existing.buyQuantity + entry.buyQuantity,
          bpoCount: existing.bpoCount + entry.bpoCount,
          bposInUse: (existing.bposInUse ?? 0) + (entry.bposInUse ?? 0),
          availableSourceCounts: mergeSourceCounts(existing.availableSourceCounts, sourceCounts),
          demandSources: mergeDemandSources(existing.demandSources, entry.demandSources),
        },
      );
    }
    else if (entry.kind === "reaction" && existing.kind === "reaction") {
      const sameSourceLocation = sourceLocationByKey.get(key) === sourceLocationId;
      merged.set(
        key,
        {
          ...existing,
          runsNeeded: existing.runsNeeded + entry.runsNeeded,
          availableQuantity: sameSourceLocation
            ? Math.max(existing.availableQuantity, entry.availableQuantity)
            : existing.availableQuantity + entry.availableQuantity,
          bpoCount: sameSourceLocation
            ? Math.max(existing.bpoCount, entry.bpoCount)
            : existing.bpoCount + entry.bpoCount,
          bposInUse: sameSourceLocation
            ? Math.max(existing.bposInUse, entry.bposInUse)
            : existing.bposInUse + entry.bposInUse,
          availableSourceCounts: mergeSourceCounts(existing.availableSourceCounts, sourceCounts),
          demandSources: mergeDemandSources(existing.demandSources, entry.demandSources),
        },
      );
      if (!sameSourceLocation) sourceLocationByKey.set(key, undefined);
    }
  }
  return [...merged.values()];
}

function mergePlanSourceCounts(
  left: PlanSourceCountsByLocation | undefined,
  right: PlanSourceCountsByLocation | undefined,
): PlanSourceCountsByLocation | undefined {
  const counts: PlanSourceCountsByLocation = {};
  for (const sourceCountsByLocation of [left, right]) {
    for (const [locationId, sourceCounts] of Object.entries(sourceCountsByLocation ?? {})) {
      const mergedSourceCounts = counts[Number(locationId)] ?? {};
      for (const [source, count] of Object.entries(sourceCounts ?? {})) {
        const sourceIcon = source as PlanSourceIcon;
        mergedSourceCounts[sourceIcon] = (mergedSourceCounts[sourceIcon] ?? 0) + count;
      }
      counts[Number(locationId)] = mergedSourceCounts;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function sourceCountsForLocation(
  countsByLocation: PlanSourceCountsByLocation | undefined,
  locationId: number | undefined,
) {
  if (locationId === undefined) return countsByLocation;
  const counts = countsByLocation?.[locationId];
  return counts ? { [locationId]: counts } : undefined;
}

function toResponsePlanItem(
  entry: PlanCalculation["lists"]["planItems"][number],
  haulingTasks: PlanCalculation["lists"]["haulingTasks"],
  activityLocationIds: ReadonlySet<number>,
  resolveTypeName: (typeId: number) => string,
  availableSourceCountsOverride?: PlanSourceCountsByLocation,
  availableQuantityOverride?: number,
  additionalAvailableQuantity = 0,
  includeHaulingQuantity = false,
): ResponsePlanItem {
  const haulingQuantity = haulingTasks
    .filter(
      (task) =>
        task.typeId === entry.typeId
        && task.source !== "production"
        && activityLocationIds.has(task.toLocationId),
    )
    .reduce((total, task) => total + task.neededQuantity, 0);
  const outboundHaulingQuantity = includeHaulingQuantity
    ? haulingTasks
        .filter(
          (task) =>
            task.typeId === entry.typeId
            && task.source !== "production"
            && activityLocationIds.has(task.fromLocationId),
        )
        .reduce((total, task) => total + task.neededQuantity, 0)
    : 0;
  const identity = {
    typeId: entry.typeId,
    typeName: resolveTypeName(entry.typeId),
    unitVolume: entry.unitVolume,
    demandSources: [...entry.demandSources].map(([typeId, source]) => ({
      typeId,
      quantity: source.quantity,
      headlineQuantity: source.headlineQuantity,
    })),
    availableSourceCounts: availableSourceCountsOverride ?? entry.availableSourceCounts,
    haulingQuantity,
  };
  if (entry.kind === "material") {
    const availableQuantity =
      (availableQuantityOverride ?? entry.availableStockQuantity)
      + (includeHaulingQuantity ? haulingQuantity : 0);
    const netAvailableQuantity = Math.max(0, availableQuantity - outboundHaulingQuantity);
    const plannedProductionQuantity = Math.max(
      0,
      entry.productionQuantity - (entry.reprocessingQuantity ?? 0),
    );
    const effectiveAvailableQuantity = netAvailableQuantity + additionalAvailableQuantity;
    const surplusAvailableQuantity = availableQuantity + additionalAvailableQuantity;
    const neededQuantity = Math.max(
      plannedProductionQuantity,
      entry.requiredQuantity - effectiveAvailableQuantity,
    );
    return {
      ...identity,
      kind: "material",
      requiredQuantity: entry.requiredQuantity,
      availableQuantity,
      neededQuantity,
      surplusQuantity: Math.max(
        0,
        surplusAvailableQuantity + plannedProductionQuantity - entry.requiredQuantity,
      ),
    };
  }
  if (entry.kind === "bpc") {
    return {
      ...identity,
      kind: "bpc",
      requiredQuantity: entry.neededQuantity,
      availableQuantity: entry.stockRuns,
      neededQuantity: Math.max(0, entry.neededQuantity - entry.stockRuns),
      surplusQuantity: Math.max(0, entry.stockRuns - entry.neededQuantity),
      bpoCount: entry.bpoCount + (entry.bposInUse ?? 0),
      bposInUse: entry.bposInUse ?? 0,
      buildTime: entry.buildTime,
    };
  }
  return {
    ...identity,
    kind: "reaction",
    requiredQuantity: entry.runsNeeded,
    availableQuantity: entry.availableQuantity,
    bpoCount: entry.bpoCount,
    bposInUse: entry.bposInUse,
    neededQuantity: 0,
    surplusQuantity: 0,
  };
}

/** Configures final-product hauling for a planning pass. */
type PlanPassOptions = {
  blockedInputStock?: PlanStockItem[];
  finalProductLocations?: Map<number, number>;
  locations?: PlanActivityLocations;
  reprocessing?: ReprocessingAllocation;
  persistStockConsumption?: boolean;
};

function activityLocations(
  stockpile: NonNullable<PlannerRequest["stockpiles"]>[number],
): PlanActivityLocations {
  return {
    manufacturing: stockpile.locations.manufacturing,
    reactions: stockpile.locations.reactions,
    reprocessing: stockpile.locations.reprocessing,
    copying: stockpile.locations.copying,
    invention: stockpile.locations.invention,
    market: stockpile.locations.stock,
  };
}

/** Calculates one stockpile plan, including prepared reprocessing allocation. */
async function calculateStockpilePlanPass(
  request: PlannerRequest,
  locations: PlanActivityLocations | undefined,
  planningData: PlanningData,
  options: PlanPassOptions = {},
): Promise<PlanCalculation> {
  const preliminaryPlan = await calculatePlanPass(
    {
      ...request,
      items: request.items.filter((item) => !item.fromCompression),
    },
    planningData,
    { ...options, locations },
  );
  const reprocessing = await allocatePlanReprocessing(
    request,
    preliminaryPlan,
    locations,
    planningData,
  );
  const preliminaryFinalPlan = await calculatePlanPass(
    request,
    planningData,
    {
      ...options,
      reprocessing,
      persistStockConsumption: false,
      locations,
    },
  );
  const minimizedReprocessing = await minimizeOwnedReprocessing(
    request,
    reprocessing,
    preliminaryFinalPlan,
    preliminaryPlan,
    locations,
    planningData,
    options,
  );
  return calculatePlanPass(
    request,
    planningData,
    {
      ...options,
      reprocessing: minimizedReprocessing,
      persistStockConsumption: true,
      locations,
    },
  );
}

/** Executes one deterministic planning pass with an optional prepared reprocessing allocation. */
async function calculatePlanPass(
  request: PlannerRequest,
  planningData: PlanningData,
  options: PlanPassOptions = {},
): Promise<PlanCalculation> {
  const {
    blockedInputStock,
    finalProductLocations,
    locations,
    reprocessing,
    persistStockConsumption = false,
  } = options;
  const profiler = new PlanProfiler();
  const startedAt = performance.now();
  profiler.count("calculatePlan");
  const fallbackByTypeId = new Map<number, string>();
  function typeName(typeId: number, fallback: string) {
    fallbackByTypeId.set(typeId, fallback);
    return fallback;
  }
  const language = request.language ?? "en";
  const {
    types: typeRecords,
    groups,
    marketGroups,
    targetFilters,
    skillPrerequisites,
  } = planningData;
  const productionGroups = getProductionGroupReferences(targetFilters, groups, language);
  const buildableTypeIds = new Set((await getBlueprintIndexes()).byBuildProductTypeId.keys());
  const facilityProfilesByLocationId = new Map(
    (request.facilityProfiles ?? []).map((profile) => [profile.locationId, profile]),
  );
  const marketOrderStock = aggregateQuantitiesByTypeId(
    request.stock.filter(
      (item) =>
        item.category === "item"
        && item.source === "marketOrder"
        && (locations?.market === undefined || getStockRootLocationId(item) === locations.market),
    ),
  );
  const initialMarketOrderStock = new Map(marketOrderStock);
  const standardStock = aggregateQuantitiesByTypeId(
    request.stock
      .filter(isUsableIndustryProductionOutput)
      .filter((item) => item.category !== "blueprint" && item.category !== "reactionformula")
      .filter((item) => item.source !== "marketOrder"),
  );
  const stockLots: StockLot[] = request.stock
    .filter(isUsableIndustryProductionOutput)
    .filter((item) => item.category !== "blueprint" && item.category !== "reactionformula")
    .filter((item) => item.source !== "marketOrder")
    .flatMap((item) => {
      const rootLocationId = getStockRootLocationId(item);
      if (typeof rootLocationId !== "number" || !Number.isInteger(rootLocationId)) return [];
      return [
        {
          typeId: item.typeId,
          quantity: item.quantity,
          rootLocationId,
          ownerType: item.ownerType,
          ownerId: item.ownerId,
          industryJobOutput: isIndustryProductionOutput(item),
          volumePerUnit: item.isPackaged
            ? (
                typeRecords.get(item.typeId)?.packagedVolume
                ?? typeRecords.get(item.typeId)?.volume
                ?? 0
              )
            : (typeRecords.get(item.typeId)?.volume ?? 0),
          sourceItem: item,
        },
      ];
    });
  const stockLotsByTypeId = new Map<number, StockLot[]>();
  const industryOutputLotsByTypeId = new Map<number, StockLot[]>();
  for (const lot of stockLots) {
    const lots = stockLotsByTypeId.get(lot.typeId) ?? [];
    lots.push(lot);
    stockLotsByTypeId.set(lot.typeId, lots);
    if (lot.industryJobOutput) {
      const outputLots = industryOutputLotsByTypeId.get(lot.typeId) ?? [];
      outputLots.push(lot);
      industryOutputLotsByTypeId.set(lot.typeId, outputLots);
    }
  }
  const stockByLocationAndType = new Map<number, Map<number, number>>();
  const industryOutputByLocationAndType = new Map<number, Map<number, number>>();
  const industryOutputByType = new Map<number, number>();
  const reservedJobInputByLocationAndType = new Map<string, number>();
  for (const lot of stockLots) {
    const locationStock = stockByLocationAndType.get(lot.rootLocationId) ?? new Map();
    locationStock.set(lot.typeId, (locationStock.get(lot.typeId) ?? 0) + lot.quantity);
    stockByLocationAndType.set(lot.rootLocationId, locationStock);
    if (lot.industryJobOutput) {
      const outputAtLocation =
        industryOutputByLocationAndType.get(lot.rootLocationId) ?? new Map<number, number>();
      outputAtLocation.set(lot.typeId, (outputAtLocation.get(lot.typeId) ?? 0) + lot.quantity);
      industryOutputByLocationAndType.set(lot.rootLocationId, outputAtLocation);
      industryOutputByType.set(
        lot.typeId,
        (industryOutputByType.get(lot.typeId) ?? 0) + lot.quantity,
      );
    }
  }
  const jobInputStockLots = stockLots.map((lot) => ({ ...lot }));
  const haulingByKey = new Map<string, PlanHaulTask>();
  function isHaulExcluded(
    typeId: number,
    fromLocationId: number,
    toLocationId: number | undefined,
    ownerType?: "character" | "corporation",
    ownerId?: number,
  ) {
    if (toLocationId === undefined || fromLocationId === toLocationId) return false;
    return (
      request.haulExclusions?.some(
        (exclusion) =>
          exclusion.typeId === typeId
          && exclusion.fromLocationId === fromLocationId
          && exclusion.toLocationId === toLocationId
          && (
            exclusion.ownerType === undefined
            || (exclusion.ownerType === ownerType && exclusion.ownerId === ownerId)
          ),
      ) ?? false
    );
  }
  function canUseLotForDestination(lot: StockLot, destinationRootLocationId: number | undefined) {
    return !isHaulExcluded(
      lot.typeId,
      lot.rootLocationId,
      destinationRootLocationId,
      lot.ownerType,
      lot.ownerId,
    );
  }
  const reprocessingLocationId = locations?.reprocessing ?? locations?.manufacturing;
  const preferredActivityLocationIds = new Set([
    ...getPreferredActivityLocationIds(locations),
    ...(finalProductLocations?.values() ?? []),
  ]);
  function addHauling(
    lot: StockLot,
    quantity: number,
    destinationRootLocationId: number | undefined,
  ) {
    if (
      quantity <= 0
      || destinationRootLocationId === undefined
      || isHaulExcluded(
        lot.typeId,
        lot.rootLocationId,
        destinationRootLocationId,
        lot.ownerType,
        lot.ownerId,
      )
      || !preferredActivityLocationIds.has(destinationRootLocationId)
      || lot.rootLocationId === destinationRootLocationId
    ) return;
    const source = lot.industryJobOutput ? ("production" as const) : undefined;
    const key = haulingKey(
      lot.typeId,
      lot.rootLocationId,
      destinationRootLocationId,
      lot.ownerType,
      lot.ownerId,
      source,
    );
    const existing = haulingByKey.get(key);
    const task = existing ?? {
      typeId: lot.typeId,
      typeName: lot.sourceItem.name,
      unitVolume: lot.volumePerUnit,
      neededQuantity: 0,
      fromLocationId: lot.rootLocationId,
      toLocationId: destinationRootLocationId,
      ownerType: lot.ownerType,
      ownerId: lot.ownerId,
      ...(source ? { source } : {}),
    };
    const totalVolume = task.neededQuantity * task.unitVolume + quantity * lot.volumePerUnit;
    task.neededQuantity += quantity;
    task.unitVolume = totalVolume / task.neededQuantity;
    if (lot.industryJobOutput) {
      task.inBuildQuantity = (task.inBuildQuantity ?? 0) + quantity;
    }
    haulingByKey.set(key, task);
  }
  function consumeTrackedStock(
    typeId: number,
    quantity: number,
    destinationRootLocationId: number | undefined,
    source: "inStock" | "inBuild" = "inStock",
    allowRemoteInBuild = false,
  ) {
    let remaining = quantity;
    const candidateLots = (stockLotsByTypeId.get(typeId) ?? [])
      .filter((lot) => lot.quantity > 0)
      .filter((lot) => (source === "inBuild" ? lot.industryJobOutput : !lot.industryJobOutput))
      .filter((lot) => canUseLotForDestination(lot, destinationRootLocationId))
      .filter(
        (lot) =>
          source !== "inBuild"
          || allowRemoteInBuild
          || lot.rootLocationId === destinationRootLocationId,
      )
      .sort(
        (left, right) =>
          Number(left.rootLocationId !== destinationRootLocationId)
            - Number(right.rootLocationId !== destinationRootLocationId)
          || left.rootLocationId - right.rootLocationId
          || (left.ownerId ?? 0) - (right.ownerId ?? 0),
      );
    for (const lot of candidateLots) {
      if (remaining <= 0) break;
      const consumed = Math.min(lot.quantity, remaining);
      addHauling(lot, consumed, destinationRootLocationId);
      lot.quantity -= consumed;
      remaining -= consumed;
    }
  }
  function getInBuildStock(typeId: number, locationId: number | undefined) {
    if (locationId === undefined) return 0;
    return industryOutputByLocationAndType.get(locationId)?.get(typeId) ?? 0;
  }
  function getInstallableRuns(inputs: PlanJobInputs, requestedRuns: number) {
    if (requestedRuns <= 0) return 0;
    const requiredInputs = [inputs.blueprint, ...inputs.materials].filter(
      (input) => input.requiredQuantity > 0,
    );
    if (requiredInputs.length === 0) return requestedRuns;
    return Math.min(
      requestedRuns,
      ...requiredInputs.map((input) =>
        Math.floor((input.availableQuantity * requestedRuns) / input.requiredQuantity),
      ),
    );
  }
  function getDestinationStockQuantity(
    typeId: number,
    destinationRootLocationId: number | undefined,
  ) {
    return (stockLotsByTypeId.get(typeId) ?? [])
      .filter((lot) => !lot.industryJobOutput)
      .filter((lot) => canUseLotForDestination(lot, destinationRootLocationId))
      .reduce((total, lot) => total + lot.quantity, 0);
  }
  function getMaterialInstallableRuns(
    inputs: PlanJobInputs,
    requestedRuns: number,
    destinationRootLocationId: number | undefined,
  ) {
    if (requestedRuns <= 0) return 0;
    const materialInputs = inputs.materials.filter((input) => input.requiredQuantity > 0);
    if (materialInputs.length === 0) return requestedRuns;
    return Math.min(
      requestedRuns,
      ...materialInputs.map((input) =>
        Math.floor(
          (getDestinationStockQuantity(input.typeId, destinationRootLocationId) * requestedRuns)
            / input.requiredQuantity,
        ),
      ),
    );
  }
  function reserveJobInputDemand(
    inputs: PlanJobInputs,
    requestedRuns: number,
    installableRuns: number,
    locationId: number | undefined,
  ) {
    if (locationId === undefined || requestedRuns <= 0 || installableRuns <= 0) return;
    for (const material of inputs.materials) {
      const key = `${locationId}:${material.typeId}`;
      const quantity = Math.ceil((material.requiredQuantity * installableRuns) / requestedRuns);
      reservedJobInputByLocationAndType.set(
        key,
        (reservedJobInputByLocationAndType.get(key) ?? 0) + quantity,
      );
    }
  }
  /** Returns stock that can be delivered to a job without consuming the material-plan ledger. */
  function getJobInputAvailability(typeId: number, locationId: number | undefined) {
    if (locationId === undefined) return 0;
    return jobInputStockLots
      .filter(
        (lot) =>
          lot.typeId === typeId
          && lot.quantity > 0
          && canUseLotForDestination(lot, locationId)
          && (!lot.industryJobOutput || lot.rootLocationId === locationId),
      )
      .reduce((total, lot) => total + lot.quantity, 0);
  }

  /** Reserves input lots in job order, including ordinary stock that must be hauled to the job. */
  function reserveJobInputAvailability(
    inputs: PlanJobInputs,
    requestedRuns: number,
    locationId: number | undefined,
  ) {
    const installableRuns = getInstallableRuns(inputs, requestedRuns);
    if (installableRuns <= 0 || locationId === undefined) return;
    for (const material of inputs.materials) {
      let remaining = Math.ceil((material.requiredQuantity * installableRuns) / requestedRuns);
      for (const lot of jobInputStockLots
        .filter(
          (lot) =>
            lot.typeId === material.typeId
            && lot.quantity > 0
            && canUseLotForDestination(lot, locationId)
            && (!lot.industryJobOutput || lot.rootLocationId === locationId),
        )
        .sort(
          (left, right) =>
            Number(left.rootLocationId !== locationId) - Number(right.rootLocationId !== locationId)
            || left.rootLocationId - right.rootLocationId,
        )) {
        if (remaining <= 0) break;
        const reserved = Math.min(lot.quantity, remaining);
        lot.quantity -= reserved;
        remaining -= reserved;
      }
    }
  }
  function consumeAvailableStock(
    typeId: number,
    quantity: number,
    destinationRootLocationId: number | undefined,
    allowRemoteInBuild = false,
    finalProductLocationId?: number,
  ) {
    const totalAvailable = standardStock.get(typeId) ?? 0;
    const totalInBuild = industryOutputByType.get(typeId) ?? 0;
    const inBuildAvailable = (industryOutputLotsByTypeId.get(typeId) ?? [])
      .filter((lot) => allowRemoteInBuild || lot.rootLocationId === destinationRootLocationId)
      .filter((lot) => canUseLotForDestination(lot, destinationRootLocationId))
      .reduce((total, lot) => total + lot.quantity, 0);
    const inStockAvailable = (stockLotsByTypeId.get(typeId) ?? [])
      .filter((lot) => !lot.industryJobOutput)
      .filter((lot) => canUseLotForDestination(lot, destinationRootLocationId))
      .reduce((total, lot) => total + lot.quantity, 0);
    const consumed = Math.min(quantity, inStockAvailable + inBuildAvailable);
    if (consumed <= 0) return 0;

    const inStockConsumed = Math.min(consumed, inStockAvailable);
    const inBuildConsumed = consumed - inStockConsumed;
    const remainingTotal = totalAvailable - consumed;
    if (remainingTotal > 0) standardStock.set(typeId, remainingTotal);
    else standardStock.delete(typeId);
    if (inStockConsumed > 0) {
      consumeTrackedStock(
        typeId,
        inStockConsumed,
        finalProductLocationId ?? destinationRootLocationId,
        "inStock",
      );
    }
    if (inBuildConsumed > 0) {
      let remainingInBuild = inBuildConsumed;
      const outputLots = (industryOutputLotsByTypeId.get(typeId) ?? [])
        .filter((lot) => lot.quantity > 0)
        .filter((lot) => allowRemoteInBuild || lot.rootLocationId === destinationRootLocationId)
        .filter((lot) => canUseLotForDestination(lot, destinationRootLocationId))
        .sort(
          (left, right) =>
            Number(left.rootLocationId !== destinationRootLocationId)
              - Number(right.rootLocationId !== destinationRootLocationId)
            || left.rootLocationId - right.rootLocationId,
        );
      for (const lot of outputLots) {
        if (remainingInBuild <= 0) break;
        const consumedFromLot = Math.min(lot.quantity, remainingInBuild);
        const outputAtLocation = industryOutputByLocationAndType.get(lot.rootLocationId);
        const remainingAtLocation = (outputAtLocation?.get(typeId) ?? 0) - consumedFromLot;
        if (remainingAtLocation > 0) outputAtLocation?.set(typeId, remainingAtLocation);
        else outputAtLocation?.delete(typeId);
        if (outputAtLocation?.size === 0) {
          industryOutputByLocationAndType.delete(lot.rootLocationId);
        }
        lot.quantity -= consumedFromLot;
        addHauling(lot, consumedFromLot, destinationRootLocationId);
        addHauling(lot, consumedFromLot, finalProductLocationId);
        remainingInBuild -= consumedFromLot;
      }
      const remainingOutputTotal = totalInBuild - inBuildConsumed;
      if (remainingOutputTotal > 0) industryOutputByType.set(typeId, remainingOutputTotal);
      else industryOutputByType.delete(typeId);
    }
    return consumed;
  }
  const demandOnlyOutputByType = [...request.stock, ...(blockedInputStock ?? [])]
    .filter(
      (item) =>
        isIndustryProductionOutput(item)
        && isAvailableIndustryProductionOutput(item)
        && !isUsableIndustryProductionOutput(item),
    )
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  function consumeDemandOnlyOutput(typeId: number, quantity: number) {
    const available = demandOnlyOutputByType.get(typeId) ?? 0;
    const consumed = Math.min(quantity, available);
    if (consumed > 0) {
      const remaining = available - consumed;
      if (remaining > 0) demandOnlyOutputByType.set(typeId, remaining);
      else demandOnlyOutputByType.delete(typeId);
    }
    return consumed;
  }
  if (reprocessing) {
    for (const [typeId, quantity] of reprocessing.consumedOwned) {
      const marketAvailable = marketOrderStock.get(typeId) ?? 0;
      const marketConsumed = Math.min(marketAvailable, quantity);
      if (marketConsumed > 0) {
        const remainingMarket = marketAvailable - marketConsumed;
        if (remainingMarket > 0) marketOrderStock.set(typeId, remainingMarket);
        else marketOrderStock.delete(typeId);
      }
      consumeAvailableStock(typeId, quantity - marketConsumed, reprocessingLocationId, true);
    }
  }

  const materials = new Map<string, Material>();
  const bpcs = new Map<number, PlanCalculation["lists"]["bpcsNeeded"][number]>();
  const reactionFormulas = new Map<number, PlanCalculation["lists"]["planItems"][number]>();
  const manufacturingJobs = new Map<
    string,
    PlanCalculation["lists"]["manufacturingJobs"][number]
  >();
  const reactionJobs = new Map<string, PlanCalculation["lists"]["reactionJobs"][number]>();
  const inventionJobs = new Map<string, PlanCalculation["lists"]["inventionJobs"][number]>();
  const jobInputsByActivityAndBlueprint = new Map<string, PlanJobInputs>();
  const requiredSkillLevels = new Map<number, number>();
  const inventedBpcTypeIds = new Set<number>();
  const producedParts = new Map(reprocessing?.producedMaterials ?? []);
  const sourceCountsByTypeId = new Map<number, Map<number, Map<PlanSourceIcon, number>>>();
  for (const stockItem of request.stock) {
    const locationId = getStockRootLocationId(stockItem);
    if (locationId === undefined) continue;
    const sourceCountsByLocation =
      sourceCountsByTypeId.get(stockItem.typeId) ?? new Map<number, Map<PlanSourceIcon, number>>();
    const sourceCounts =
      sourceCountsByLocation.get(locationId) ?? new Map<PlanSourceIcon, number>();
    const addSource = (source: PlanSourceIcon, quantityOverride?: number) => {
      const quantity =
        quantityOverride
        ?? (source === "invention" || source === "copying"
          ? (stockItem.jobRuns ?? stockItem.quantity)
            * (source === "copying" ? (stockItem.licensedRuns ?? 1) : 1)
          : stockItem.quantity);
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + quantity);
    };
    if (stockItem.category === "item" && stockItem.source === "marketOrder") {
      addSource("market");
    }
    if (isIndustryProductionOutput(stockItem) && !isUsableIndustryProductionOutput(stockItem)) {
      addSource("industry", stockItem.inBuildQuantity ?? stockItem.quantity);
    }
    if (
      stockItem.inBuild
      && stockItem.category === "blueprint"
      && stockItem.blueprintRunsAtInstall !== undefined
      && stockItem.activityName === "Invention"
    ) {
      addSource("invention");
    }
    if (
      stockItem.inBuild
      && stockItem.category === "blueprint"
      && stockItem.activityName === "Copying"
    ) {
      addSource("copying");
    }
    if (sourceCounts.size > 0) {
      sourceCountsByLocation.set(locationId, sourceCounts);
      sourceCountsByTypeId.set(stockItem.typeId, sourceCountsByLocation);
    }
  }
  for (const [typeId, quantity] of reprocessing?.producedMaterials ?? []) {
    if (quantity <= 0) continue;
    const locationId = reprocessingLocationId;
    if (locationId === undefined) continue;
    const sourceCountsByLocation =
      sourceCountsByTypeId.get(typeId) ?? new Map<number, Map<PlanSourceIcon, number>>();
    const sourceCounts =
      sourceCountsByLocation.get(locationId) ?? new Map<PlanSourceIcon, number>();
    sourceCounts.set("reprocessing", (sourceCounts.get("reprocessing") ?? 0) + quantity);
    sourceCountsByLocation.set(locationId, sourceCounts);
    sourceCountsByTypeId.set(typeId, sourceCountsByLocation);
  }
  function sourceMetadata(typeId: number) {
    const countsByLocation = sourceCountsByTypeId.get(typeId);
    if (!countsByLocation) return undefined;
    return {
      icons: [...countsByLocation.values()].flatMap((counts) => [...counts.keys()]),
      counts: Object.fromEntries(
        [...countsByLocation].map(([locationId, counts]) => [
          locationId,
          Object.fromEntries(counts),
        ]),
      ) as PlanSourceCountsByLocation,
    };
  }
  const initialBuildTypeIds = new Set(request.items.map((item) => item.typeId));
  const totalStock = aggregateQuantitiesByTypeId(
    request.stock
      .filter(isAvailableIndustryProductionOutput)
      .filter((item) => item.category !== "blueprint" && item.category !== "reactionformula")
      .filter((item) => item.source !== "marketOrder"),
  );
  for (const [typeId, quantity] of marketOrderStock) {
    if (!initialBuildTypeIds.has(typeId)) continue;
    totalStock.set(typeId, (totalStock.get(typeId) ?? 0) + quantity);
  }
  for (const [typeId, quantity] of reprocessing?.producedMaterials ?? []) {
    totalStock.set(typeId, (totalStock.get(typeId) ?? 0) + quantity);
  }
  const availableStockQuantitiesByLocationAndType = new Map<string, number>();
  const availableStockQuantitiesByType = new Map<number, number>();
  const addAvailableStock = (typeId: number, quantity: number, locationId: number | undefined) => {
    if (quantity <= 0) return;
    const locationKey = locationTypeKey(locationId, typeId);
    availableStockQuantitiesByLocationAndType.set(
      locationKey,
      (availableStockQuantitiesByLocationAndType.get(locationKey) ?? 0) + quantity,
    );
    availableStockQuantitiesByType.set(
      typeId,
      (availableStockQuantitiesByType.get(typeId) ?? 0) + quantity,
    );
  };
  for (const stockItem of request.stock) {
    if (
      stockItem.category !== "item"
      || !isAvailableIndustryProductionOutput(stockItem)
      || (stockItem.source === "marketOrder" && !initialBuildTypeIds.has(stockItem.typeId))
    ) continue;
    addAvailableStock(stockItem.typeId, stockItem.quantity, getStockRootLocationId(stockItem));
  }
  for (const [typeId, quantity] of reprocessing?.producedMaterials ?? []) {
    addAvailableStock(typeId, quantity, reprocessingLocationId);
  }
  const allBlueprintStockItems = request.stock.filter((item) => item.category === "blueprint");
  const blueprintCopyStock = new Map<number, { copies: number; runs: number }>();
  const blueprintPrintsByLocation = new Map<string, BlueprintPrint[]>();
  const blueprintCopiesByType = new Map<number, BlueprintPrint[]>();
  const blueprintMaterialEfficiencyByLocation = new Map<string, number>();
  const blueprintOriginalCountsByLocation = new Map<string, number>();
  const seenBlueprintPrints = new Set<number>();
  const blueprintOriginalCounts = new Map<number, number>();
  const blueprintInUseCounts = new Map<number, number>();
  for (const bpStockItem of allBlueprintStockItems) {
    const locationId = getStockRootLocationId(bpStockItem);
    const existing = blueprintCopyStock.get(bpStockItem.typeId) ?? { copies: 0, runs: 0 };
    const prints = bpStockItem.blueprintPrints ?? [];
    const bpoPrints = prints.filter((print) => print.type === "bpo");
    const totalBpoCount =
      bpStockItem.blueprintType === "bpo" ? bpStockItem.quantity : bpoPrints.length;
    const bposInUse = bpStockItem.inUse ? totalBpoCount : 0;
    const availableBpoCount = totalBpoCount - bposInUse;
    const uniquePrints = prints.filter((print) => {
      if (seenBlueprintPrints.has(print.itemId)) return false;
      seenBlueprintPrints.add(print.itemId);
      return true;
    });
    const copiesByType = blueprintCopiesByType.get(bpStockItem.typeId) ?? [];
    blueprintCopiesByType.set(
      bpStockItem.typeId,
      [...copiesByType, ...uniquePrints.filter((print) => print.type === "bpc")],
    );
    if (locationId !== undefined) {
      const locationKey = `${bpStockItem.typeId}:${locationId}`;
      const printsAtLocation = blueprintPrintsByLocation.get(locationKey) ?? [];
      blueprintPrintsByLocation.set(locationKey, [...printsAtLocation, ...uniquePrints]);
      if (availableBpoCount > 0) {
        blueprintOriginalCountsByLocation.set(
          locationKey,
          (blueprintOriginalCountsByLocation.get(locationKey) ?? 0) + availableBpoCount,
        );
      }
      const addMaterialEfficiency = (efficiency: number | undefined) => {
        const current = blueprintMaterialEfficiencyByLocation.get(locationKey);
        const next = clampEfficiency(efficiency ?? 0, 10);
        if (current === undefined || next > current) {
          blueprintMaterialEfficiencyByLocation.set(locationKey, next);
        }
      };
      if (bpStockItem.blueprintType === "bpo" || bpoPrints.length > 0) {
        addMaterialEfficiency(prints.find((print) => print.type === "bpo")?.me ?? bpStockItem.me);
      }
      for (const print of prints) {
        if (print.type === "bpc" && print.runs > 0) addMaterialEfficiency(print.me);
      }
    }
    if (availableBpoCount > 0) {
      blueprintOriginalCounts.set(
        bpStockItem.typeId,
        (blueprintOriginalCounts.get(bpStockItem.typeId) ?? 0) + availableBpoCount,
      );
    }
    if (bposInUse > 0) {
      blueprintInUseCounts.set(
        bpStockItem.typeId,
        (blueprintInUseCounts.get(bpStockItem.typeId) ?? 0) + bposInUse,
      );
    }
    if (prints.length > 0 && uniquePrints.length === 0) continue;
    const printRuns = uniquePrints
      .filter((print) => print.type === "bpc")
      .reduce((total, print) => total + Math.max(0, print.runs), 0);
    blueprintCopyStock.set(
      bpStockItem.typeId,
      {
        copies: existing.copies + bpStockItem.quantity,
        runs: existing.runs + printRuns,
      },
    );
  }
  const availableReactionFormulas = request.stock.filter(
    (item) => item.category === "reactionformula",
  );
  const reactionFormulaStockByLocation = new Map<number, Map<number, number>>();
  const reactionFormulaInUseByLocation = new Map<number, Map<number, number>>();
  for (const item of availableReactionFormulas) {
    const locationId = getStockRootLocationId(item);
    if (locationId === undefined) continue;
    const formulasAtLocation =
      reactionFormulaStockByLocation.get(locationId) ?? new Map<number, number>();
    if (!item.inUse) {
      formulasAtLocation.set(
        item.typeId,
        (formulasAtLocation.get(item.typeId) ?? 0) + item.quantity,
      );
      reactionFormulaStockByLocation.set(locationId, formulasAtLocation);
    }
    if (item.inUse) {
      const inUseAtLocation =
        reactionFormulaInUseByLocation.get(locationId) ?? new Map<number, number>();
      inUseAtLocation.set(item.typeId, (inUseAtLocation.get(item.typeId) ?? 0) + item.quantity);
      reactionFormulaInUseByLocation.set(locationId, inUseAtLocation);
    }
  }
  function getLocationQuantity(
    stock: Map<number, Map<number, number>>,
    locationId: number | undefined,
    typeId: number,
  ) {
    return locationId === undefined ? 0 : (stock.get(locationId)?.get(typeId) ?? 0);
  }
  function inputStatus(availableQuantity: number, requiredQuantity: number): PlanJobInputStatus {
    if (requiredQuantity <= 0 || availableQuantity >= requiredQuantity) return "ready";
    return availableQuantity > 0 ? "partial" : "blocked";
  }
  function inputItem(
    kind: PlanJobInput["kind"],
    typeId: number,
    name: string,
    availableQuantity: number,
    requiredQuantity: number,
    inBuildQuantity = 0,
  ): PlanJobInput {
    return {
      kind,
      typeId,
      name,
      availableQuantity,
      ...(inBuildQuantity > 0 ? { inBuildQuantity } : {}),
      requiredQuantity,
      completionPercent:
        requiredQuantity <= 0
          ? 100
          : Math.min(100, Math.round((availableQuantity / requiredQuantity) * 100)),
      status: inputStatus(availableQuantity, requiredQuantity),
    };
  }
  function createJobInputs(
    activity: "manufacturing" | "reaction",
    blueprint: NonNullable<
      Awaited<ReturnType<typeof getBuildBlueprintByProductTypeId>>
    >["blueprint"],
    runs: number,
    efficiency: Efficiency,
    locationId: number | undefined,
    materialMultiplier = 1,
    materialRunAllocations: readonly ManufacturingRunAllocation[] = [
      { runs, efficiency, source: "fallback" },
    ],
  ): PlanJobInputs {
    const activityData = blueprint.activities[activity];
    const materials = (activityData?.materials ?? []).map((material) => {
      const adjustedRequiredQuantity = materialRunAllocations.reduce(
        (total, allocation) =>
          total
          + requiredMaterialQuantity(
            activity,
            material.quantity,
            allocation.runs,
            allocation.efficiency,
            materialMultiplier,
          ),
        0,
      );
      const availableQuantity = getJobInputAvailability(material.typeID, locationId);
      const inBuildQuantity = Math.min(
        availableQuantity,
        getLocationQuantity(industryOutputByLocationAndType, locationId, material.typeID),
      );
      return inputItem(
        "material",
        material.typeID,
        typeName(material.typeID, `Type ${material.typeID}`),
        availableQuantity,
        adjustedRequiredQuantity,
        inBuildQuantity,
      );
    });
    const bpoCount =
      locationId === undefined
        ? 0
        : (blueprintOriginalCountsByLocation.get(`${blueprint._key}:${locationId}`) ?? 0);
    const copyStock = blueprintCopyStock.get(blueprint._key);
    const availableBlueprintQuantity =
      activity === "reaction"
        ? getLocationQuantity(reactionFormulaStockByLocation, locationId, blueprint._key)
        : bpoCount > 0
          ? bpoCount
          : (copyStock?.runs ?? 0);
    const requiredBlueprintQuantity = activity === "reaction" || bpoCount > 0 ? 1 : runs;
    const blueprintInput = inputItem(
      "blueprint",
      blueprint._key,
      typeName(blueprint._key, activity === "reaction" ? "Reaction Formula" : "Blueprint"),
      availableBlueprintQuantity,
      requiredBlueprintQuantity,
    );
    return summarizePlanJobInputs(
      blueprintInput,
      materials,
      {
        bpoCount: activity === "manufacturing" ? bpoCount : 0,
        bpcRuns: activity === "manufacturing" ? (copyStock?.runs ?? 0) : 0,
      },
    );
  }
  function mergeJobInputs(
    existing: PlanJobInputs | undefined,
    next: PlanJobInputs,
    reusableBlueprint: boolean,
  ): PlanJobInputs {
    if (!existing) return next;
    const materialByTypeId = new Map(
      existing.materials.map((material) => [material.typeId, material]),
    );
    for (const material of next.materials) {
      const previous = materialByTypeId.get(material.typeId);
      materialByTypeId.set(
        material.typeId,
        inputItem(
          "material",
          material.typeId,
          material.name,
          previous?.availableQuantity ?? material.availableQuantity,
          (previous?.requiredQuantity ?? 0) + material.requiredQuantity,
          Math.max(previous?.inBuildQuantity ?? 0, material.inBuildQuantity ?? 0),
        ),
      );
    }
    const blueprint = inputItem(
      "blueprint",
      next.blueprint.typeId,
      next.blueprint.name,
      next.blueprint.availableQuantity,
      reusableBlueprint
        ? Math.max(existing.blueprint.requiredQuantity, next.blueprint.requiredQuantity)
        : existing.blueprint.requiredQuantity + next.blueprint.requiredQuantity,
      Math.max(existing.blueprint.inBuildQuantity ?? 0, next.blueprint.inBuildQuantity ?? 0),
    );
    return summarizePlanJobInputs(
      blueprint,
      [...materialByTypeId.values()],
      {
        bpoCount: next.bpoCount,
        bpcRuns: next.bpcRuns,
      },
    );
  }
  const usedRunsByBlueprint = new Map<number, number>();
  const usedRunsByBlueprintPrint = new Map<number, number>();
  const consumedMarketOrderStock = new Set<number>();
  const buildBlacklist = new Set(request.settings.buildBlacklist);
  const buildBlueprintsByTypeId = new Map<
    number,
    ReturnType<typeof getBuildBlueprintByProductTypeId>
  >();
  const defaultEfficiency: Efficiency = { me: 0, te: 0 };
  const manufacturingTimeMultiplier = request.facilityTimeMultipliers?.manufacturing ?? 1;
  const reactionTimeMultiplier = request.facilityTimeMultipliers?.reactions ?? 1;
  const manufacturingSkillTimeMultiplier = request.skillTimeMultipliers?.manufacturing ?? 1;
  const reactionSkillTimeMultiplier = request.skillTimeMultipliers?.reactions ?? 1;
  const zeroEfficiencyWarnings = new Map<string, PlanWarning>();
  const insufficientBpcRunWarnings = new Map<string, PlanWarning>();

  function manufacturingRunAllocations(
    blueprintTypeId: number,
    locationId: number | undefined,
    runs: number,
    fallbackEfficiency: Efficiency,
  ): ManufacturingRunAllocation[] {
    if (locationId === undefined || runs <= 0) {
      return [{ runs, efficiency: fallbackEfficiency, source: "fallback" }];
    }
    const locationKey = `${blueprintTypeId}:${locationId}`;
    const prints = blueprintPrintsByLocation.get(locationKey) ?? [];
    const bpoCount = blueprintOriginalCountsByLocation.get(locationKey) ?? 0;
    const bpoEfficiency = clampEfficiency(
      prints
        .filter((print) => print.type === "bpo")
        .reduce(
          (maximum, print) => Math.max(maximum, print.me ?? 0),
          blueprintMaterialEfficiencyByLocation.get(locationKey) ?? 0,
        ),
      10,
    );
    const copies = (blueprintCopiesByType.get(blueprintTypeId) ?? [])
      .filter((print) => print.runs > 0)
      .sort(
        (left, right) =>
          (right.me ?? 0) - (left.me ?? 0) || right.runs - left.runs || left.itemId - right.itemId,
      );
    const bestCopyEfficiency = copies.reduce(
      (maximum, print) => Math.max(maximum, print.me ?? 0),
      0,
    );
    if (bpoCount > 0 && bpoEfficiency >= bestCopyEfficiency) {
      return [
        { runs, efficiency: { me: bpoEfficiency, te: fallbackEfficiency.te }, source: "bpo" },
      ];
    }

    let remainingRuns = runs;
    const allocations: ManufacturingRunAllocation[] = [];
    for (const copy of copies) {
      if (remainingRuns <= 0) break;
      const usedRuns = usedRunsByBlueprintPrint.get(copy.itemId) ?? 0;
      const copyRuns = Math.max(0, copy.runs - usedRuns);
      const allocatedRuns = Math.min(remainingRuns, copyRuns);
      if (allocatedRuns <= 0) continue;
      usedRunsByBlueprintPrint.set(copy.itemId, usedRuns + allocatedRuns);
      allocations.push({
        runs: allocatedRuns,
        efficiency: { me: clampEfficiency(copy.me ?? 0, 10), te: copy.te ?? fallbackEfficiency.te },
        source: "bpc",
      });
      remainingRuns -= allocatedRuns;
    }
    if (remainingRuns > 0 && bpoCount > 0) {
      allocations.push({
        runs: remainingRuns,
        efficiency: { me: bpoEfficiency, te: fallbackEfficiency.te },
        source: "bpo",
      });
      remainingRuns = 0;
    }
    if (remainingRuns > 0) {
      allocations.push({ runs: remainingRuns, efficiency: fallbackEfficiency, source: "fallback" });
    }
    return allocations;
  }

  function fallbackManufacturingEfficiency(typeId: number): Efficiency {
    const techLevel = typeRecords.get(typeId)?.techLevel;
    if (techLevel === 2 || techLevel === 3) {
      return {
        me: clampEfficiency(request.settings.fallbackT2OrT3Me ?? 0, 10),
        te: clampEfficiency(request.settings.fallbackT2OrT3Te ?? 0, 20),
      };
    }
    return {
      me: clampEfficiency(request.settings.fallbackT1Me ?? 0, 10),
      te: clampEfficiency(request.settings.fallbackT1Te ?? 0, 20),
    };
  }

  function manufacturingEfficiency(
    typeId: number,
    blueprintTypeId: number,
    locationId: number | undefined,
  ): Efficiency {
    const warningKey = `${blueprintTypeId}:${locationId ?? "unlocated"}`;
    const selectedEfficiency =
      locationId === undefined
        ? undefined
        : blueprintMaterialEfficiencyByLocation.get(`${blueprintTypeId}:${locationId}`);
    if (selectedEfficiency !== undefined) {
      return { me: selectedEfficiency, te: 0 };
    }
    const fallbackEfficiency = fallbackManufacturingEfficiency(typeId);
    if (!zeroEfficiencyWarnings.has(warningKey)) {
      zeroEfficiencyWarnings.set(
        warningKey,
        {
          code: "manufacturing-blueprint-me-zero",
          typeId: blueprintTypeId,
          ...(locationId === undefined ? {} : { locationId }),
          fallbackMe: fallbackEfficiency.me,
          fallbackTe: fallbackEfficiency.te,
        },
      );
    }
    return fallbackEfficiency;
  }

  function activityProfile(typeId: number, activity: "manufacturing" | "reaction") {
    const group = productionGroupForType(typeRecords.get(typeId), groups, productionGroups);
    const fallbackLocationId =
      activity === "manufacturing" ? locations?.manufacturing : locations?.reactions;
    const locationId =
      (group ? request.groupAssignments?.[group.key] : undefined) ?? fallbackLocationId;
    const facility =
      locationId === undefined ? undefined : facilityProfilesByLocationId.get(locationId);
    const bonus = group && facility ? facility.buildTypeGroups[group.key] : undefined;
    return {
      locationId,
      materialMultiplier:
        activity === "manufacturing"
          ? (bonus?.manufacturingMaterialMultiplier ?? 1)
          : (bonus?.reactionMaterialMultiplier ?? 1),
      timeMultiplier:
        activity === "manufacturing"
          ? (bonus?.manufacturingTimeMultiplier ?? manufacturingTimeMultiplier)
          : (bonus?.reactionTimeMultiplier ?? reactionTimeMultiplier),
    };
  }

  function addRequiredSkills(skills: Array<{ typeID: number; level: number }> | undefined) {
    for (const skill of skills ?? []) {
      requiredSkillLevels.set(
        skill.typeID,
        Math.max(requiredSkillLevels.get(skill.typeID) ?? 0, skill.level),
      );
    }
  }

  function addSkillPrerequisites() {
    const pending = [...requiredSkillLevels.keys()];
    const expanded = new Set<number>();
    while (pending.length > 0) {
      const skillId = pending.pop();
      if (skillId === undefined) continue;
      if (expanded.has(skillId)) continue;
      expanded.add(skillId);
      for (const prerequisite of skillPrerequisites.get(skillId) ?? []) {
        requiredSkillLevels.set(
          prerequisite.skillId,
          Math.max(requiredSkillLevels.get(prerequisite.skillId) ?? 0, prerequisite.level),
        );
        if (!expanded.has(prerequisite.skillId)) pending.push(prerequisite.skillId);
      }
    }
  }

  function materialKey(typeId: number, activityLocationId?: number, stockpileLocationId?: number) {
    if (stockpileLocationId !== undefined) return `${typeId}:stockpile:${stockpileLocationId}`;
    if (activityLocationId !== undefined) return `${typeId}:activity:${activityLocationId}`;
    return `${typeId}:unlocated`;
  }

  function getMaterial(typeId: number, activityLocationId?: number, stockpileLocationId?: number) {
    return materials.get(materialKey(typeId, activityLocationId, stockpileLocationId));
  }

  function updateMaterial(
    typeId: number,
    update: Partial<Material>,
    activityLocationId?: number,
    stockpileLocationId?: number,
  ) {
    const existing = getMaterial(typeId, activityLocationId, stockpileLocationId);
    materials.set(
      materialKey(typeId, activityLocationId, stockpileLocationId),
      {
        typeId,
        unitVolume:
          existing?.unitVolume
          ?? typeRecords.get(typeId)?.packagedVolume
          ?? typeRecords.get(typeId)?.volume
          ?? 0,
        demandSources: existing?.demandSources ?? new Map(),
        quantity: existing?.quantity ?? 0,
        requiredQuantity: existing?.requiredQuantity ?? 0,
        stockQuantity: existing?.stockQuantity ?? 0,
        availableStockQuantity: existing?.availableStockQuantity ?? totalStock.get(typeId) ?? 0,
        productionQuantity: existing?.productionQuantity ?? 0,
        reprocessingQuantity: existing?.reprocessingQuantity ?? 0,
        buyQuantity: existing?.buyQuantity ?? 0,
        remainingProductionQuantity: existing?.remainingProductionQuantity ?? 0,
        availableSourceCounts: existing?.availableSourceCounts ?? sourceMetadata(typeId)?.counts,
        ...(activityLocationId !== undefined ? { activityLocationId } : {}),
        ...(stockpileLocationId !== undefined ? { stockpileLocationId } : {}),
        ...update,
      },
    );
  }

  for (const [typeId, quantity] of reprocessing?.producedMaterials ?? []) {
    updateMaterial(
      typeId,
      {
        productionQuantity: quantity,
        reprocessingQuantity: quantity,
      },
      reprocessingLocationId,
    );
  }

  const selectedReprocessingTypeIds = new Set([
    ...(reprocessing?.consumedOwned.keys() ?? []),
    ...(reprocessing?.consumedPurchases.keys() ?? []),
  ]);
  for (const typeId of selectedReprocessingTypeIds) {
    const ownedQuantity = request.stock
      .filter(
        (item) =>
          item.typeId === typeId
          && item.category !== "blueprint"
          && item.category !== "reactionformula",
      )
      .reduce((total, item) => total + item.quantity, 0);
    const consumedOwned = reprocessing?.consumedOwned.get(typeId) ?? 0;
    const consumedPurchases = reprocessing?.consumedPurchases.get(typeId) ?? 0;
    updateMaterial(
      typeId,
      {
        quantity: consumedPurchases,
        requiredQuantity: consumedOwned + consumedPurchases,
        stockQuantity: consumedOwned,
        availableStockQuantity: ownedQuantity,
        buyQuantity: consumedPurchases,
      },
    );
  }

  async function addMaterial(
    typeId: number,
    quantity: number,
    demandAlreadyRecorded = false,
    useAvailableStock = true,
    activityRootLocationId?: number,
    stockpileLocationId?: number,
    demandingTypeId?: number,
    demandingQuantity?: number,
  ) {
    return profiler.measure(
      "addMaterial",
      async () => {
        const stockConsumed = useAvailableStock
          ? consumeAvailableStock(typeId, quantity, activityRootLocationId)
          : 0;
        const materialActivityLocationId =
          stockpileLocationId === undefined ? activityRootLocationId : undefined;
        const existing = getMaterial(typeId, materialActivityLocationId, stockpileLocationId);
        updateMaterial(
          typeId,
          {
            quantity: (existing?.quantity ?? 0) + quantity - stockConsumed,
            requiredQuantity:
              (existing?.requiredQuantity ?? 0) + (demandAlreadyRecorded ? 0 : quantity),
            demandSources: demandAlreadyRecorded
              ? (existing?.demandSources ?? new Map())
              : addDemandSource(
                  existing?.demandSources ?? new Map(),
                  demandingTypeId,
                  demandingQuantity ?? quantity,
                  quantity,
                ),
            stockQuantity:
              (existing?.stockQuantity ?? 0) + (demandAlreadyRecorded ? 0 : stockConsumed),
            buyQuantity: (existing?.buyQuantity ?? 0) + quantity - stockConsumed,
          },
          materialActivityLocationId,
          stockpileLocationId,
        );
      },
    );
  }

  async function expand(
    typeId: number,
    quantity: number,
    fallbackName: string,
    stack: Set<number>,
    efficiency: Efficiency,
    allowMarketOrderStock = false,
    activityRootLocationId?: number,
    finalProductLocationId?: number,
    stockConsumptionQuantity = quantity,
    demandActivityLocationId?: number,
    demandStockpileLocationId?: number,
    consumeBuildableStock = false,
    demandingTypeId?: number,
    demandingQuantity?: number,
  ) {
    let phase = "stock";
    let activity = "unknown";
    const requestedQuantity = quantity;
    return profiler.measure(
      "expand",
      async () => {
        if (quantity <= 0) return;
        let remainingStockConsumption = Math.min(quantity, Math.max(0, stockConsumptionQuantity));

        const finalProductStockConsumed =
          finalProductLocationId === undefined
            ? 0
            : consumeAvailableStock(
                typeId,
                remainingStockConsumption,
                finalProductLocationId,
                true,
              );
        remainingStockConsumption -= finalProductStockConsumed;
        const standardConsumed =
          finalProductStockConsumed
          + consumeAvailableStock(
            typeId,
            remainingStockConsumption,
            activityRootLocationId,
            false,
            finalProductLocationId,
          );
        remainingStockConsumption -= standardConsumed - finalProductStockConsumed;
        const marketAvailable = allowMarketOrderStock ? (marketOrderStock.get(typeId) ?? 0) : 0;
        const marketConsumed = Math.min(marketAvailable, remainingStockConsumption);
        const stockConsumed = standardConsumed + marketConsumed;
        const existingMaterial = getMaterial(
          typeId,
          demandActivityLocationId,
          demandStockpileLocationId,
        );
        updateMaterial(
          typeId,
          {
            requiredQuantity: (existingMaterial?.requiredQuantity ?? 0) + requestedQuantity,
            stockQuantity: (existingMaterial?.stockQuantity ?? 0) + stockConsumed,
            demandSources: addDemandSource(
              existingMaterial?.demandSources ?? new Map(),
              demandingTypeId,
              demandingQuantity ?? requestedQuantity,
              requestedQuantity,
            ),
          },
          demandActivityLocationId,
          demandStockpileLocationId,
        );
        if (stockConsumed > 0) {
          if (marketConsumed > 0) {
            const remainingMarket = marketAvailable - marketConsumed;
            if (remainingMarket > 0) marketOrderStock.set(typeId, remainingMarket);
            else marketOrderStock.delete(typeId);
            consumedMarketOrderStock.add(typeId);
          }
          quantity -= stockConsumed;
        }
        if (quantity <= 0) return;

        let buildBlueprint: ReturnType<typeof getBuildBlueprintByProductTypeId> | undefined;
        let candidate:
          | Awaited<ReturnType<typeof getBuildBlueprintByProductTypeId>>
          | null
          | undefined;
        if (!stack.has(typeId) && !buildBlacklist.has(typeId)) {
          phase = "blueprint lookup";
          buildBlueprint = buildBlueprintsByTypeId.get(typeId);
          if (!buildBlueprintsByTypeId.has(typeId)) {
            buildBlueprint = profiler.measure(
              "expand.buildBlueprintLookup",
              () => getBuildBlueprintByProductTypeId(typeId),
              () => ({ typeId }),
            );
            buildBlueprintsByTypeId.set(typeId, buildBlueprint);
          }
          candidate = await buildBlueprint;
        }
        if (candidate?.blueprint && consumeBuildableStock) {
          let additionalStockConsumed = 0;
          const additionalFinalProductStockConsumed =
            finalProductLocationId === undefined
              ? 0
              : consumeAvailableStock(typeId, quantity, finalProductLocationId, true);
          additionalStockConsumed += additionalFinalProductStockConsumed;
          quantity -= additionalFinalProductStockConsumed;
          const additionalStandardConsumed = consumeAvailableStock(
            typeId,
            quantity,
            activityRootLocationId,
            false,
            finalProductLocationId,
          );
          additionalStockConsumed += additionalStandardConsumed;
          quantity -= additionalStandardConsumed;
          if (additionalStockConsumed > 0) {
            const existingMaterial = getMaterial(
              typeId,
              demandActivityLocationId,
              demandStockpileLocationId,
            );
            updateMaterial(
              typeId,
              {
                stockQuantity: (existingMaterial?.stockQuantity ?? 0) + additionalStockConsumed,
              },
              demandActivityLocationId,
              demandStockpileLocationId,
            );
          }
        }
        quantity -= consumeDemandOnlyOutput(typeId, quantity);
        if (quantity <= 0) return;

        const available = producedParts.get(typeId) ?? 0;
        const consumed = Math.min(available, quantity, remainingStockConsumption);
        if (consumed > 0) {
          const remaining = available - consumed;
          if (remaining > 0) producedParts.set(typeId, remaining);
          else producedParts.delete(typeId);
          quantity -= consumed;
        }
        if (quantity <= 0) return;

        if (stack.has(typeId) || buildBlacklist.has(typeId)) {
          await addMaterial(
            typeId,
            quantity,
            true,
            false,
            activityRootLocationId,
            demandStockpileLocationId,
          );
          return;
        }

        if (!candidate?.blueprint) {
          await addMaterial(
            typeId,
            quantity,
            true,
            false,
            activityRootLocationId,
            demandStockpileLocationId,
          );
          return;
        }
        const blueprint = candidate.blueprint;

        activity = candidate.activity;
        const profile = activityProfile(typeId, candidate.activity);
        const activityLocationId = profile.locationId;
        const fallbackEfficiency =
          candidate.activity === "manufacturing"
            ? manufacturingEfficiency(typeId, blueprint._key, activityLocationId)
            : efficiency;
        const productionActivity =
          candidate.activity === "manufacturing"
            ? candidate.blueprint.activities.manufacturing
            : candidate.blueprint.activities.reaction;
        if (!productionActivity?.products) {
          throw new Error(`Blueprint ${blueprint._key} has no ${candidate.activity} products.`);
        }
        const product = productionActivity.products.find((entry) => entry.typeID === typeId);
        if (!product) {
          throw new Error(`Blueprint ${blueprint._key} does not produce type ${typeId}.`);
        }
        const productQuantity = product.quantity;
        const runsNeeded = Math.ceil(quantity / productQuantity);
        const materialRunAllocations: ManufacturingRunAllocation[] =
          candidate.activity === "manufacturing"
            ? manufacturingRunAllocations(
                blueprint._key,
                activityLocationId,
                runsNeeded,
                fallbackEfficiency,
              )
            : [{ runs: runsNeeded, efficiency: fallbackEfficiency, source: "fallback" }];
        if (
          candidate.activity === "manufacturing"
          && materialRunAllocations.some((allocation) => allocation.source !== "fallback")
        ) {
          zeroEfficiencyWarnings.delete(`${blueprint._key}:${activityLocationId ?? "unlocated"}`);
        }
        if (
          candidate.activity === "manufacturing"
          && materialRunAllocations.some((allocation) => allocation.source === "fallback")
          && materialRunAllocations.some((allocation) => allocation.source === "bpc")
          && (blueprintOriginalCountsByLocation.get(`${blueprint._key}:${activityLocationId}`) ?? 0)
            === 0
        ) {
          const warningKey = `${blueprint._key}:${activityLocationId ?? "unlocated"}`;
          insufficientBpcRunWarnings.set(
            warningKey,
            {
              code: "manufacturing-bpc-runs-insufficient",
              typeId,
              ...(activityLocationId === undefined ? {} : { locationId: activityLocationId }),
            },
          );
        }
        const effectiveEfficiency = materialRunAllocations[0]?.efficiency ?? fallbackEfficiency;
        const producedQuantity = runsNeeded * productQuantity;
        updateMaterial(
          typeId,
          {
            productionQuantity:
              (
                getMaterial(typeId, demandActivityLocationId, demandStockpileLocationId)
                  ?.productionQuantity ?? 0
              ) + producedQuantity,
          },
          demandActivityLocationId,
          demandStockpileLocationId,
        );
        const surplus = producedQuantity - quantity;
        if (surplus > 0) producedParts.set(typeId, (producedParts.get(typeId) ?? 0) + surplus);
        const nextStack = new Set(stack).add(typeId);

        let remainingRuns = runsNeeded;
        const copyStock = blueprintCopyStock.get(blueprint._key);

        if (activity === "manufacturing") {
          const manufacturingActivity = blueprint.activities.manufacturing;
          if (!manufacturingActivity) {
            throw new Error(`Blueprint ${blueprint._key} has no manufacturing activity.`);
          }
          addRequiredSkills(blueprint.activities.manufacturing?.skills);
          const jobKey = locationTypeKey(activityLocationId, blueprint._key);
          const existing = manufacturingJobs.get(jobKey);
          const existingInputs = jobInputsByActivityAndBlueprint.get(jobKey);
          const jobInputs = createJobInputs(
            "manufacturing",
            blueprint,
            runsNeeded,
            effectiveEfficiency,
            activityLocationId,
            profile.materialMultiplier,
            materialRunAllocations,
          );
          const installableRuns = getInstallableRuns(jobInputs, runsNeeded);
          const materialInstallableRuns = getMaterialInstallableRuns(
            jobInputs,
            runsNeeded,
            activityLocationId,
          );
          reserveJobInputDemand(jobInputs, runsNeeded, materialInstallableRuns, activityLocationId);
          reserveJobInputAvailability(jobInputs, runsNeeded, activityLocationId);
          const mergedJobInputs = mergeJobInputs(
            existingInputs,
            jobInputs,
            (blueprintOriginalCounts.get(blueprint._key) ?? 0) > 0,
          );
          jobInputsByActivityAndBlueprint.set(jobKey, mergedJobInputs);
          manufacturingJobs.set(
            jobKey,
            {
              typeId: blueprint._key,
              name: typeName(blueprint._key, `${fallbackName} Blueprint`),
              countNeeded: (existing?.countNeeded ?? 0) + runsNeeded,
              runsAvailable: Math.min(
                existing?.runsAvailable ?? Number.MAX_SAFE_INTEGER,
                installableRuns,
              ),
              totalTime: Math.ceil(
                (existing?.totalTime ?? 0)
                  + manufacturingActivity.time
                    * (1 - effectiveEfficiency.te / 100)
                    * profile.timeMultiplier
                    * manufacturingSkillTimeMultiplier
                    * runsNeeded,
              ),
              inputs: mergedJobInputs,
              ...(activityLocationId !== undefined ? { locationId: activityLocationId } : {}),
            },
          );
          phase = "manufacturing materials";
          await profiler.measure(
            "expand.materials",
            async () => {
              for (const material of blueprint.activities.manufacturing?.materials ?? []) {
                const materialQuantity = materialRunAllocations.reduce(
                  (total, allocation) =>
                    total
                    + requiredMaterialQuantity(
                      "manufacturing",
                      material.quantity,
                      allocation.runs,
                      allocation.efficiency,
                      profile.materialMultiplier,
                    ),
                  0,
                );
                await expand(
                  material.typeID,
                  materialQuantity,
                  typeName(material.typeID, `Type ${material.typeID}`),
                  nextStack,
                  defaultEfficiency,
                  false,
                  activityLocationId,
                  undefined,
                  requiredMaterialQuantity(
                    "manufacturing",
                    material.quantity,
                    materialInstallableRuns,
                    effectiveEfficiency,
                    profile.materialMultiplier,
                  ),
                  activityLocationId,
                  undefined,
                  true,
                  typeId,
                  quantity,
                );
              }
            },
          );
          const bpoCount = blueprintOriginalCounts.get(blueprint._key) ?? 0;
          const bpcRunsUsed = materialRunAllocations
            .filter((allocation) => allocation.source === "bpc")
            .reduce((total, allocation) => total + allocation.runs, 0);
          const alreadyUsedRuns = usedRunsByBlueprint.get(blueprint._key) ?? 0;
          usedRunsByBlueprint.set(blueprint._key, alreadyUsedRuns + bpcRunsUsed);
          remainingRuns = Math.max(0, runsNeeded - bpcRunsUsed);
          if (bpoCount > 0 && remainingRuns > 0) {
            addRequiredSkills(blueprint.activities.copying?.skills);
          }
          const bpcBuyQuantity =
            bpoCount > 0
              ? Math.ceil(Math.max(0, remainingRuns) / blueprint.maxProductionLimit)
              : Math.max(0, remainingRuns);
          bpcs.set(
            blueprint._key,
            {
              typeId: blueprint._key,
              unitVolume:
                typeRecords.get(blueprint._key)?.packagedVolume
                ?? typeRecords.get(blueprint._key)?.volume
                ?? 0,
              neededQuantity: (bpcs.get(blueprint._key)?.neededQuantity ?? 0) + runsNeeded,
              demandSources: addDemandSource(
                bpcs.get(blueprint._key)?.demandSources ?? new Map(),
                demandingTypeId,
                demandingQuantity ?? requestedQuantity,
                runsNeeded,
              ),
              stockQuantity: copyStock?.copies ?? 0,
              stockRuns: copyStock?.runs ?? 0,
              availableSourceCounts: sourceMetadata(blueprint._key)?.counts,
              bpoCount,
              bposInUse: blueprintInUseCounts.get(blueprint._key) ?? 0,
              buildTime: blueprint.activities.copying?.time ?? 0,
              activityLocationId,
              buyQuantity: (bpcs.get(blueprint._key)?.buyQuantity ?? 0) + bpcBuyQuantity,
            },
          );
          return;
        }
        const reactionActivity = blueprint.activities.reaction;
        if (!reactionActivity) {
          throw new Error(`Blueprint ${blueprint._key} has no reaction activity.`);
        }
        addRequiredSkills(blueprint.activities.reaction?.skills);
        const jobKey = locationTypeKey(activityLocationId, blueprint._key);
        const existing = reactionJobs.get(jobKey);
        const existingInputs = jobInputsByActivityAndBlueprint.get(jobKey);
        const jobInputs = createJobInputs(
          "reaction",
          blueprint,
          runsNeeded,
          efficiency,
          activityLocationId,
          profile.materialMultiplier,
        );
        const installableRuns = getInstallableRuns(jobInputs, runsNeeded);
        const materialInstallableRuns = getMaterialInstallableRuns(
          jobInputs,
          runsNeeded,
          activityLocationId,
        );
        reserveJobInputDemand(jobInputs, runsNeeded, materialInstallableRuns, activityLocationId);
        reserveJobInputAvailability(jobInputs, runsNeeded, activityLocationId);
        const mergedJobInputs = mergeJobInputs(existingInputs, jobInputs, false);
        jobInputsByActivityAndBlueprint.set(jobKey, mergedJobInputs);
        reactionJobs.set(
          jobKey,
          {
            typeId: blueprint._key,
            name: typeName(blueprint._key, `${fallbackName} Reaction Formula`),
            countNeeded: (existing?.countNeeded ?? 0) + runsNeeded,
            runsAvailable: (existing?.runsAvailable ?? 0) + installableRuns,
            totalTime:
              (existing?.totalTime ?? 0)
              + reactionActivity.time
                * (1 - efficiency.te / 100)
                * profile.timeMultiplier
                * reactionSkillTimeMultiplier
                * runsNeeded,
            inputs: mergedJobInputs,
            ...(activityLocationId !== undefined ? { locationId: activityLocationId } : {}),
          },
        );
        const existingFormula = reactionFormulas.get(blueprint._key);
        const formulaCount = getLocationQuantity(
          reactionFormulaStockByLocation,
          activityLocationId,
          blueprint._key,
        );
        const formulaInUseCount = getLocationQuantity(
          reactionFormulaInUseByLocation,
          activityLocationId,
          blueprint._key,
        );
        reactionFormulas.set(
          blueprint._key,
          {
            kind: "reaction",
            typeId: blueprint._key,
            demandSources: addDemandSource(
              existingFormula?.demandSources ?? new Map(),
              demandingTypeId,
              demandingQuantity ?? requestedQuantity,
              runsNeeded,
            ),
            unitVolume:
              typeRecords.get(blueprint._key)?.packagedVolume
              ?? typeRecords.get(blueprint._key)?.volume
              ?? 0,
            runsNeeded:
              (existingFormula && existingFormula.kind === "reaction"
                ? existingFormula.runsNeeded
                : 0) + runsNeeded,
            availableQuantity: formulaCount,
            bpoCount: formulaCount + formulaInUseCount,
            bposInUse: formulaInUseCount,
            activityLocationId,
          },
        );
        if (runsNeeded > 0 && formulaCount === 0) {
          await addMaterial(
            blueprint._key,
            1,
            false,
            true,
            activityLocationId,
            undefined,
            typeId,
            quantity,
          );
        }
        else if (runsNeeded > 0) {
          consumeTrackedStock(blueprint._key, 1, locations?.reactions);
        }
        phase = "reaction materials";
        await profiler.measure(
          "expand.materials",
          async () => {
            for (const material of blueprint.activities.reaction?.materials ?? []) {
              const materialQuantity = requiredMaterialQuantity(
                "reaction",
                material.quantity,
                runsNeeded,
                efficiency,
                profile.materialMultiplier,
              );
              await expand(
                material.typeID,
                materialQuantity,
                typeName(material.typeID, `Type ${material.typeID}`),
                nextStack,
                defaultEfficiency,
                false,
                activityLocationId,
                undefined,
                buildableTypeIds.has(material.typeID)
                  && (standardStock.get(material.typeID) ?? 0) >= materialQuantity
                  ? materialQuantity
                  : requiredMaterialQuantity(
                      "reaction",
                      material.quantity,
                      materialInstallableRuns,
                      efficiency,
                      profile.materialMultiplier,
                    ),
                activityLocationId,
                undefined,
                false,
                typeId,
                requestedQuantity,
              );
            }
          },
        );
      },
      () => ({ typeId, quantity, depth: stack.size, activity, phase }),
    );
  }

  for (const item of request.items) {
    if (item.fromCompression) continue;
    const finalProductLocationId = finalProductLocations?.get(item.typeId);
    await expand(
      item.typeId,
      item.quantity,
      item.name,
      new Set(),
      {
        me: clampEfficiency(item.me, 10),
        te: clampEfficiency(item.te, 20),
      },
      true,
      locations?.manufacturing,
      finalProductLocationId,
      item.quantity,
      undefined,
      finalProductLocationId,
    );
  }

  await profiler.measure(
    "invention",
    async () => {
      for (const bpc of [...bpcs.values()]) {
        const inventingBlueprints = await profiler.measure(
          "inventionBlueprintLookup",
          () => getBlueprintsByInventionProductId(bpc.typeId),
        );
        if (inventingBlueprints.length === 0) continue;
        const inventingBlueprint = inventingBlueprints[0];
        const invention = inventingBlueprint.activities.invention;
        const inventionProduct = invention?.products?.find(
          (product) => product.typeID === bpc.typeId,
        );
        if (!invention || !inventionProduct) continue;

        const successProbability = inventionProduct.probability ?? 1;
        const remainingBpcRuns = Math.max(0, bpc.neededQuantity - bpc.stockRuns);
        if (remainingBpcRuns <= 0) continue;

        addRequiredSkills(invention.skills);
        inventedBpcTypeIds.add(bpc.typeId);

        const successfulBpcRuns = inventingBlueprint.maxProductionLimit;
        const successfulBpcQuantity = Math.ceil(remainingBpcRuns / successfulBpcRuns);
        const inventionAttempts = Math.ceil(successfulBpcQuantity / successProbability);
        const jobKey = locationTypeKey(locations?.invention, inventingBlueprint._key);
        const existing = inventionJobs.get(jobKey);
        inventionJobs.set(
          jobKey,
          {
            typeId: inventingBlueprint._key,
            name: typeName(inventingBlueprint._key, "Blueprint Copy"),
            countNeeded: (existing?.countNeeded ?? 0) + inventionAttempts,
            ...(locations
              ? {
                  locationId: locations.invention,
                }
              : {}),
          },
        );
        const sourceBpc = bpcs.get(inventingBlueprint._key);
        const sourceBpoCount = blueprintOriginalCounts.get(inventingBlueprint._key) ?? 0;
        const sourceCopyStock = blueprintCopyStock.get(inventingBlueprint._key);
        const sourceNeededQuantity = (sourceBpc?.neededQuantity ?? 0) + inventionAttempts;
        const sourceRemainingRuns = Math.max(
          0,
          sourceNeededQuantity - (sourceCopyStock?.runs ?? 0),
        );
        bpcs.set(
          inventingBlueprint._key,
          {
            typeId: inventingBlueprint._key,
            unitVolume:
              typeRecords.get(inventingBlueprint._key)?.packagedVolume
              ?? typeRecords.get(inventingBlueprint._key)?.volume
              ?? 0,
            demandSources: addDemandSource(
              sourceBpc?.demandSources ?? new Map(),
              bpc.typeId,
              remainingBpcRuns,
              inventionAttempts,
            ),
            neededQuantity: sourceNeededQuantity,
            stockQuantity: sourceBpc?.stockQuantity ?? 0,
            stockRuns: sourceBpc?.stockRuns ?? 0,
            availableSourceCounts: sourceMetadata(inventingBlueprint._key)?.counts,
            bpoCount: sourceBpoCount,
            bposInUse: blueprintInUseCounts.get(inventingBlueprint._key) ?? 0,
            buildTime: inventingBlueprint.activities.copying?.time ?? 0,
            activityLocationId: locations?.invention,
            buyQuantity:
              sourceBpoCount > 0
                ? Math.ceil(sourceRemainingRuns / inventingBlueprint.maxProductionLimit)
                : sourceRemainingRuns,
          },
        );
        for (const material of invention.materials ?? []) {
          await addMaterial(
            material.typeID,
            material.quantity * inventionAttempts,
            false,
            true,
            locations?.invention,
            undefined,
            inventingBlueprint._key,
            inventionAttempts,
          );
        }
      }
    },
  );

  addSkillPrerequisites();

  const reprocessingTypeIds = new Set([
    ...(reprocessing?.consumedOwned.keys() ?? []),
    ...(reprocessing?.consumedPurchases.keys() ?? []),
  ]);
  for (const material of materials.values()) {
    material.remainingProductionQuantity = producedParts.get(material.typeId) ?? 0;
    if (locations !== undefined && !reprocessingTypeIds.has(material.typeId)) {
      material.buyQuantity = Math.max(
        0,
        material.requiredQuantity
          - material.availableStockQuantity
          - Math.max(0, material.productionQuantity - (material.reprocessingQuantity ?? 0)),
      );
    }
  }

  if (blockedInputStock) {
    for (const sourceItem of blockedInputStock) {
      let remainingQuantity = sourceItem.quantity;
      const sourceLocationId = getStockRootLocationId(sourceItem);
      if (remainingQuantity <= 0 || sourceLocationId === undefined) continue;
      const destinationMaterials = [...materials.values()].filter(
        (material) =>
          material.typeId === sourceItem.typeId
          && material.buyQuantity > 0
          && material.activityLocationId !== undefined,
      );
      for (const material of destinationMaterials) {
        if (remainingQuantity <= 0) break;
        const hauledQuantity = remainingQuantity;
        const creditedQuantity = Math.min(remainingQuantity, material.buyQuantity);
        const destinationLocationId = material.activityLocationId;
        if (destinationLocationId === undefined) continue;
        if (
          isHaulExcluded(
            sourceItem.typeId,
            sourceLocationId,
            destinationLocationId,
            sourceItem.ownerType,
            sourceItem.ownerId,
          )
        ) continue;
        const sourceLot: StockLot = {
          typeId: sourceItem.typeId,
          quantity: hauledQuantity,
          rootLocationId: sourceLocationId,
          ownerType: sourceItem.ownerType,
          ownerId: sourceItem.ownerId,
          industryJobOutput: isIndustryProductionOutput(sourceItem),
          volumePerUnit: sourceItem.isPackaged
            ? (
                typeRecords.get(sourceItem.typeId)?.packagedVolume
                ?? typeRecords.get(sourceItem.typeId)?.volume
                ?? 0
              )
            : (typeRecords.get(sourceItem.typeId)?.volume ?? 0),
          sourceItem,
        };
        addHauling(sourceLot, hauledQuantity, destinationLocationId);
        material.quantity = Math.max(0, material.quantity - creditedQuantity);
        material.stockQuantity += creditedQuantity;
        material.buyQuantity = Math.max(0, material.buyQuantity - creditedQuantity);
        remainingQuantity -= hauledQuantity;
      }
    }
  }

  const demandByLocationAndType = new Map<string, number>();
  for (const material of materials.values()) {
    if (material.activityLocationId === undefined) continue;
    const key = locationTypeKey(material.activityLocationId, material.typeId);
    demandByLocationAndType.set(
      key,
      (demandByLocationAndType.get(key) ?? 0) + material.requiredQuantity,
    );
  }
  const plannedFutureHaulByLot = new Map<StockLot, number>();
  const plannedOutboundByLocationAndType = new Map<string, number>();
  for (const material of materials.values()) {
    const destinationLocationId = material.activityLocationId;
    if (destinationLocationId === undefined || material.requiredQuantity <= 0) continue;
    const localQuantity = getLocationQuantity(
      stockByLocationAndType,
      destinationLocationId,
      material.typeId,
    );
    const inboundQuantity = [...haulingByKey.values()]
      .filter(
        (task) =>
          task.typeId === material.typeId
          && task.toLocationId === destinationLocationId
          && task.source !== "production",
      )
      .reduce((total, task) => total + task.neededQuantity, 0);
    let remainingDemand = Math.max(0, material.requiredQuantity - localQuantity - inboundQuantity);
    if (remainingDemand <= 0) continue;

    for (const lot of stockLotsByTypeId.get(material.typeId) ?? []) {
      if (
        remainingDemand <= 0
        || lot.industryJobOutput
        || lot.rootLocationId === destinationLocationId
        || isHaulExcluded(
          lot.typeId,
          lot.rootLocationId,
          destinationLocationId,
          lot.ownerType,
          lot.ownerId,
        )
      ) continue;
      const plannedQuantity = plannedFutureHaulByLot.get(lot) ?? 0;
      const sourceKey = locationTypeKey(lot.rootLocationId, lot.typeId);
      const sourceDemand = demandByLocationAndType.get(sourceKey) ?? 0;
      const existingOutbound = [...haulingByKey.values()]
        .filter(
          (task) =>
            task.typeId === lot.typeId
            && task.fromLocationId === lot.rootLocationId
            && task.source !== "production",
        )
        .reduce((total, task) => total + task.neededQuantity, 0);
      const plannedOutbound = plannedOutboundByLocationAndType.get(sourceKey) ?? 0;
      const sourceSurplus = Math.max(
        0,
        (stockByLocationAndType.get(lot.rootLocationId)?.get(lot.typeId) ?? 0)
          - sourceDemand
          - existingOutbound,
      );
      const availableQuantity = Math.min(
        Math.max(0, lot.quantity - plannedQuantity),
        Math.max(0, sourceSurplus - plannedOutbound),
      );
      const hauledQuantity = Math.min(availableQuantity, remainingDemand);
      if (hauledQuantity <= 0) continue;
      addHauling(lot, hauledQuantity, destinationLocationId);
      plannedFutureHaulByLot.set(lot, plannedQuantity + hauledQuantity);
      plannedOutboundByLocationAndType.set(sourceKey, plannedOutbound + hauledQuantity);
      remainingDemand -= hauledQuantity;
    }
  }

  const resolvedName = (typeId: number) => {
    const name = typeRecords.get(typeId)?.name;
    return name?.[language] ?? name?.en ?? fallbackByTypeId.get(typeId) ?? `Type ${typeId}`;
  };
  const resolveJobInputs = (inputs: PlanJobInputs) => {
    inputs.blueprint.name = resolvedName(inputs.blueprint.typeId);
    for (const material of inputs.materials) material.name = resolvedName(material.typeId);
  };
  const skillsRequired: PlanCalculation["lists"]["skillsRequired"] = [...requiredSkillLevels]
    .map(([skillId, requiredLevel]) => ({
      skillId,
      name: resolvedName(skillId),
      requiredLevel,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const job of manufacturingJobs.values()) job.name = resolvedName(job.typeId);
  for (const job of reactionJobs.values()) job.name = resolvedName(job.typeId);
  for (const job of manufacturingJobs.values()) resolveJobInputs(job.inputs);
  for (const job of reactionJobs.values()) resolveJobInputs(job.inputs);
  for (const job of inventionJobs.values()) job.name = resolvedName(job.typeId);
  const reprocessingJobs: PlanCalculation["lists"]["reprocessingJobs"] =
    reprocessingLocationId === undefined
      ? []
      : [...(reprocessing?.readyToReprocess ?? [])].map(([typeId, quantity]) => ({
          typeId,
          name: resolvedName(typeId),
          countNeeded: quantity,
          efficiency: request.reprocessingEfficiencies?.[String(typeId)] ?? 50,
          locationId: reprocessingLocationId,
        }));

  const localDemandByLocationAndType = reservedJobInputByLocationAndType;
  const localStockByLocationAndType = new Map<string, number>();
  for (const lot of stockLots) {
    const key = `${lot.rootLocationId}:${lot.typeId}`;
    localStockByLocationAndType.set(
      key,
      (localStockByLocationAndType.get(key) ?? 0) + lot.sourceItem.quantity,
    );
  }
  const outboundCapacityByLocationAndType = new Map<string, number>();
  for (const [key, quantity] of localStockByLocationAndType) {
    outboundCapacityByLocationAndType.set(
      key,
      Math.max(0, quantity - (localDemandByLocationAndType.get(key) ?? 0)),
    );
  }
  const haulingTasks = [...haulingByKey.values()]
    .map((task) => {
      const key = `${task.fromLocationId}:${task.typeId}`;
      const outboundCapacity = outboundCapacityByLocationAndType.get(key);
      if (outboundCapacity === undefined || task.neededQuantity <= outboundCapacity) return task;
      const retainedQuantity = Math.max(0, outboundCapacity);
      task.neededQuantity = retainedQuantity;
      outboundCapacityByLocationAndType.set(key, 0);
      return task;
    })
    .filter((task) => task.neededQuantity > 0);
  const materialsToBuy = [...materials.values()];
  const bpcRequirements = [...bpcs.values()];
  const bpcsNeeded = bpcRequirements.filter(
    (bpc) => !inventedBpcTypeIds.has(bpc.typeId) && bpc.bpoCount > 0,
  );
  const bpcsToBuy = bpcRequirements.filter(
    (bpc) => !inventedBpcTypeIds.has(bpc.typeId) && bpc.bpoCount === 0,
  );
  const reactionFormulaTypeIds = new Set(reactionFormulas.keys());
  const planItems: PlanCalculation["lists"]["planItems"] = [
    ...materialsToBuy
      .filter((material) => !reactionFormulaTypeIds.has(material.typeId))
      .map((material) => ({ kind: "material" as const, ...material })),
    ...[...bpcs.values()].map((bpc) => ({ kind: "bpc" as const, ...bpc })),
    ...reactionFormulas.values(),
  ];
  for (const stockItem of request.stock) {
    if (
      !isIndustryProductionOutput(stockItem)
      || !isAvailableIndustryProductionOutput(stockItem)
      || isUsableIndustryProductionOutput(stockItem)
    ) continue;
    const locationId = getStockRootLocationId(stockItem);
    if (
      locationId === undefined
      || planItems.some(
        (entry) =>
          entry.kind === "material"
          && entry.typeId === stockItem.typeId
          && (entry.stockpileLocationId ?? entry.activityLocationId) === locationId,
      )
    ) continue;
    planItems.push({
      kind: "material",
      typeId: stockItem.typeId,
      demandSources: new Map(),
      unitVolume:
        typeRecords.get(stockItem.typeId)?.packagedVolume
        ?? typeRecords.get(stockItem.typeId)?.volume
        ?? 0,
      availableSourceCounts: sourceMetadata(stockItem.typeId)?.counts,
      activityLocationId: locationId,
      quantity: 0,
      requiredQuantity: 0,
      stockQuantity: 0,
      availableStockQuantity: totalStock.get(stockItem.typeId) ?? 0,
      productionQuantity: 0,
      reprocessingQuantity: 0,
      buyQuantity: 0,
      remainingProductionQuantity: 0,
    });
  }
  const availableSourceCountsByType: PlanSourceCountsByType = new Map();
  for (const entry of planItems) {
    const mergedSourceCounts = mergePlanSourceCountsByMaximum(
      availableSourceCountsByType.get(entry.typeId),
      entry.availableSourceCounts,
    );
    if (mergedSourceCounts) availableSourceCountsByType.set(entry.typeId, mergedSourceCounts);
  }
  for (const task of haulingTasks) task.typeName = resolvedName(task.typeId);
  const result = {
    metadata: {
      generatedAt: new Date().toISOString(),
      unresolvedAssetCount: request.unresolvedAssetCount ?? 0,
      corporationAssetSources: [
        ...new Set(
          request.stock
            .filter((stock) => stock.ownerType === "corporation")
            .map((stock) => stock.ownerId)
            .filter((id): id is number => id !== undefined),
        ),
      ],
      warnings: [...zeroEfficiencyWarnings.values(), ...insufficientBpcRunWarnings.values()],
    },
    lists: {
      planItems,
      materialsToBuy,
      bpcsNeeded,
      bpcsToBuy,
      inventionJobs: [...inventionJobs.values()],
      reactionJobs: [...reactionJobs.values()],
      manufacturingJobs: [...manufacturingJobs.values()],
      reprocessingJobs,
      skillsRequired,
      haulingTasks,
    },
    availableSourceCountsByType,
    availableStockQuantitiesByLocationAndType,
    availableStockQuantitiesByType,
  };
  if (persistStockConsumption) {
    for (const lot of stockLots) lot.sourceItem.quantity = lot.quantity;
    const remainingMarketConsumption = new Map<number, number>();
    for (const [typeId, initialQuantity] of initialMarketOrderStock) {
      remainingMarketConsumption.set(
        typeId,
        Math.max(0, initialQuantity - (marketOrderStock.get(typeId) ?? 0)),
      );
    }
    for (const item of request.stock.filter((stockItem) => stockItem.source === "marketOrder")) {
      const consumed = Math.min(item.quantity, remainingMarketConsumption.get(item.typeId) ?? 0);
      item.quantity -= consumed;
      remainingMarketConsumption.set(
        item.typeId,
        (remainingMarketConsumption.get(item.typeId) ?? 0) - consumed,
      );
    }
  }
  if (profiler.isEnabled) {
    console.debug(
      `[plan] calculatePlan completed in ${(performance.now() - startedAt).toFixed(1)}ms`,
      {
        items: request.items.length,
        materials: materialsToBuy.length,
        manufacturingJobs: manufacturingJobs.size,
        reactionJobs: reactionJobs.size,
      },
    );
    profiler.logSummary();
  }
  return result;
}

async function calculateStockpilePlan(
  request: PlannerRequest,
  planningData: PlanningData,
  profiler?: RequestProfiler,
): Promise<PlanCalculation> {
  const stockpiles = request.stockpiles;
  const futureCompressedMaterialStock = await measureProfiled(
    profiler,
    "futureCompressedStock",
    () => getFutureCompressedMaterialStock(request, stockpiles, planningData),
  );
  const planningRequest =
    futureCompressedMaterialStock.length > 0
      ? { ...request, stock: [...request.stock, ...futureCompressedMaterialStock] }
      : request;
  const futureStockIndexes = new Set(
    futureCompressedMaterialStock.map((_, index) => request.stock.length + index),
  );
  const stockpileAllocation = await measureProfiled(
    profiler,
    "allocateStockpile",
    () =>
      allocateStockpileStock(
        planningRequest,
        stockpiles,
        planningData,
        calculatePlanPass,
        futureStockIndexes,
        profiler,
      ),
  );
  const stockpileResults: PlanCalculation[] = [];
  for (const [stockpileIndex, stockpile] of stockpiles.entries()) {
    const locations = activityLocations(stockpile);
    const finalProductLocations = new Map(
      stockpile.items.map((item) => [item.typeId, stockpile.locations.stock] as const),
    );
    const result = await measureProfiled(
      profiler,
      `stockpilePass.${stockpileIndex}`,
      () =>
        calculateStockpilePlanPass(
          {
            ...planningRequest,
            stockpiles: [],
            items: stockpile.items,
            stock: stockpileAllocation.stockpileStock[stockpileIndex],
            reprocessingEfficiencies:
              stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
            groupAssignments: stockpile.groupAssignments,
          },
          locations,
          planningData,
          {
            blockedInputStock: stockpileAllocation.blockedInputStock[stockpileIndex],
            finalProductLocations,
          },
        ),
    );
    stockpileResults.push(result);
  }
  return measureProfiled(
    profiler,
    "reconcileStockpiles",
    () => reconcileStockpilePlan(stockpileResults, request, stockpileAllocation.ledger),
  );
}

/** Produces the final plan from stockpile outputs and their immutable allocation ledger. */
async function reconcileStockpilePlan(
  stockpileResults: PlanCalculation[],
  request: PlannerRequest,
  ledger: PlanningLedger,
): Promise<PlanCalculation> {
  const finalPhase = ledger.phases.at(-1);
  if (finalPhase?.name !== (request.stockpiles.length === 1 ? "single-stockpile" : "final")) {
    throw new Error("Stockpile allocation did not produce a final ledger phase.");
  }
  const mergedResult = await mergeStockpileResults(
    stockpileResults,
    request.stock,
    request,
    ledger,
  );
  const restoredStock = restorePlanStockQuantities(mergedResult, request);
  const restoredSources = restorePlanSourceCounts(restoredStock, request.stock);
  return restorePlanResourceCounts(restoredSources, request.stock);
}

/** Reallocates merged manufacturing inputs from usable stock held at each build location. */
function reconcileMergedManufacturingJobInputs(
  jobs: PlanCalculation["lists"]["manufacturingJobs"],
  request: PlannerRequest,
) {
  const availableStock = request.stock
    .filter(
      (item) =>
        item.category === "item"
        && item.source !== "marketOrder"
        && isUsableIndustryProductionOutput(item)
        && getStockRootLocationId(item) !== undefined,
    )
    .map((item) => ({ ...item }));
  return jobs.map((job) => {
    const materials = job.inputs.materials.map((input) => {
      let remainingQuantity = input.requiredQuantity;
      for (const item of availableStock
        .filter((candidate) => {
          const sourceLocationId = getStockRootLocationId(candidate);
          return (
            candidate.typeId === input.typeId
            && candidate.quantity > 0
            && sourceLocationId !== undefined
            && (sourceLocationId === job.locationId || !candidate.inBuild)
            && !(
              job.locationId !== undefined
              && request.haulExclusions?.some(
                (exclusion) =>
                  exclusion.typeId === input.typeId
                  && exclusion.fromLocationId === sourceLocationId
                  && exclusion.toLocationId === job.locationId
                  && (
                    exclusion.ownerType === undefined
                    || (
                      exclusion.ownerType === candidate.ownerType
                      && exclusion.ownerId === candidate.ownerId
                    )
                  ),
              )
            )
          );
        })
        .sort(
          (left, right) =>
            Number(getStockRootLocationId(left) !== job.locationId)
              - Number(getStockRootLocationId(right) !== job.locationId)
            || (getStockRootLocationId(left) ?? 0) - (getStockRootLocationId(right) ?? 0),
        )) {
        if (remainingQuantity <= 0) break;
        const allocatedQuantity = Math.min(remainingQuantity, item.quantity);
        item.quantity -= allocatedQuantity;
        remainingQuantity -= allocatedQuantity;
      }
      const availableQuantity = input.requiredQuantity - remainingQuantity;
      const completionPercent =
        input.requiredQuantity <= 0
          ? 100
          : Math.min(100, Math.round((availableQuantity / input.requiredQuantity) * 100));
      return {
        ...input,
        availableQuantity,
        ...(input.inBuildQuantity === undefined
          ? {}
          : { inBuildQuantity: Math.min(input.inBuildQuantity, availableQuantity) }),
        completionPercent,
        status:
          completionPercent >= 100
            ? ("ready" as const)
            : completionPercent > 0
              ? ("partial" as const)
              : ("blocked" as const),
      };
    });
    return {
      ...job,
      inputs: summarizePlanJobInputs(
        job.inputs.blueprint,
        materials,
        {
          bpoCount: job.inputs.bpoCount,
          bpcRuns: job.inputs.bpcRuns,
        },
      ),
    };
  });
}

function mergeHaulingTasks(tasks: PlanCalculation["lists"]["haulingTasks"]) {
  const mergedByRoute = new Map<string, PlanCalculation["lists"]["haulingTasks"][number]>();
  for (const task of tasks) {
    const key = haulingKey(
      task.typeId,
      task.fromLocationId,
      task.toLocationId,
      task.ownerType,
      task.ownerId,
      task.source,
    );
    const existing = mergedByRoute.get(key);
    if (existing) {
      const totalVolume =
        existing.neededQuantity * existing.unitVolume + task.neededQuantity * task.unitVolume;
      existing.neededQuantity += task.neededQuantity;
      existing.unitVolume = totalVolume / existing.neededQuantity;
      existing.inBuildQuantity = (existing.inBuildQuantity ?? 0) + (task.inBuildQuantity ?? 0);
      continue;
    }
    mergedByRoute.set(key, { ...task });
  }
  return [...mergedByRoute.values()];
}

/** Caps outbound haulage at a location to stock that remains after its own final-product demand. */
/** Sums eligible stock quantities by their effective location and type. */
function getStockQuantitiesByLocationAndType(
  stock: readonly PlanStockItem[],
  includesItem: (item: PlanStockItem) => boolean,
): Map<string, number> {
  const quantitiesByLocationAndType = new Map<string, number>();
  for (const item of stock) {
    const rootLocationId = getStockRootLocationId(item);
    if (rootLocationId === undefined || !includesItem(item)) continue;
    const key = locationTypeKey(rootLocationId, item.typeId);
    quantitiesByLocationAndType.set(
      key,
      (quantitiesByLocationAndType.get(key) ?? 0) + item.quantity,
    );
  }
  return quantitiesByLocationAndType;
}

/** Retains hauling tasks only while the capacity at their relevant endpoint remains. */
function capHaulingTasksToCapacity(
  tasks: PlanCalculation["lists"]["haulingTasks"],
  capacityByLocationAndType: ReadonlyMap<string, number>,
  getCapacityKey: (task: PlanCalculation["lists"]["haulingTasks"][number]) => string,
) {
  const allocatedByLocationAndType = new Map<string, number>();
  return tasks
    .map((task) => {
      const key = getCapacityKey(task);
      const capacity = capacityByLocationAndType.get(key);
      if (capacity === undefined) return task;
      const allocatedQuantity = allocatedByLocationAndType.get(key) ?? 0;
      const retainedQuantity = Math.min(
        task.neededQuantity,
        Math.max(0, capacity - allocatedQuantity),
      );
      allocatedByLocationAndType.set(key, allocatedQuantity + retainedQuantity);
      if (retainedQuantity === task.neededQuantity) return task;
      return { ...task, neededQuantity: retainedQuantity };
    })
    .filter((task) => task.neededQuantity > 0);
}

/** Caps ordinary stock hauling to final remote reservations in the allocation ledger. */
function capNonProductionHaulingToLedgerReservations(
  tasks: PlanCalculation["lists"]["haulingTasks"],
  ledger: PlanningLedger,
) {
  const reservedQuantityBySource = new Map<string, number>();
  for (const transfer of getFinalPlanningLedgerTransfers(ledger)) {
    if (transfer.sourceLocationId === undefined) continue;
    const key = locationTypeKey(transfer.sourceLocationId, transfer.typeId);
    reservedQuantityBySource.set(key, (reservedQuantityBySource.get(key) ?? 0) + transfer.quantity);
  }
  const productionTasks = tasks.filter((task) => task.source === "production");
  const stockTasks = tasks.filter((task) => task.source !== "production");
  return [
    ...productionTasks,
    ...capHaulingTasksToCapacity(
      stockTasks,
      reservedQuantityBySource,
      (task) => locationTypeKey(task.fromLocationId, task.typeId),
    ),
  ];
}

/** Caps inbound hauling to remaining material demand at the destination. */
function capHaulingTasksToDestinationDemand(
  tasks: PlanCalculation["lists"]["haulingTasks"],
  stock: PlanStockItem[],
  results: PlanCalculation[],
) {
  const localStockByLocationAndType = getStockQuantitiesByLocationAndType(
    stock,
    (item) =>
      item.category === "item"
      && item.source !== "marketOrder"
      && isUsableIndustryProductionOutput(item),
  );
  const demandByLocationAndType = new Map<string, number>();
  for (const result of results) {
    for (const material of result.lists.materialsToBuy) {
      const locationId = material.stockpileLocationId ?? material.activityLocationId;
      if (locationId === undefined || material.requiredQuantity <= 0) continue;
      const key = locationTypeKey(locationId, material.typeId);
      demandByLocationAndType.set(
        key,
        (demandByLocationAndType.get(key) ?? 0) + material.requiredQuantity,
      );
    }
  }
  const remainingDemandByLocationAndType = new Map(demandByLocationAndType);
  for (const [key, localStockQuantity] of localStockByLocationAndType) {
    const demand = remainingDemandByLocationAndType.get(key);
    if (demand !== undefined) {
      remainingDemandByLocationAndType.set(key, Math.max(0, demand - localStockQuantity));
    }
  }
  return capHaulingTasksToCapacity(
    tasks,
    remainingDemandByLocationAndType,
    (task) => locationTypeKey(task.toLocationId, task.typeId),
  );
}

/** Counts total and in-use resources at an activity location using the supplied quantity resolver. */
function countPlanResources(
  stock: PlanStockItem[],
  typeId: number,
  locationId: number,
  getQuantity: (item: PlanStockItem) => number,
): { total: number; available: number; inUse: number } {
  let total = 0;
  let inUse = 0;
  for (const item of stock) {
    if (item.typeId !== typeId || getStockRootLocationId(item) !== locationId) continue;
    const quantity = getQuantity(item);
    total += quantity;
    if (item.inUse) inUse += quantity;
  }
  return { total, available: Math.max(0, total - inUse), inUse };
}

/** Counts owned BPOs and BPO-backed prints at an activity location. */
function countPlanBlueprints(stock: PlanStockItem[], typeId: number, locationId: number) {
  return countPlanResources(
    stock,
    typeId,
    locationId,
    (item) => {
      if (item.category !== "blueprint") return 0;
      return item.blueprintType === "bpo"
        ? item.quantity
        : (item.blueprintPrints?.filter((print) => print.type === "bpo").length ?? 0);
    },
  );
}

/** Counts reaction formulas at an activity location. */
function countPlanReactionFormulas(stock: PlanStockItem[], typeId: number, locationId: number) {
  return countPlanResources(
    stock,
    typeId,
    locationId,
    (item) => (item.category === "reactionformula" ? item.quantity : 0),
  );
}

function restorePlanStockQuantities(
  result: PlanCalculation,
  request: PlannerRequest,
): PlanCalculation {
  const { stock, items: buildItems } = request;
  const buildTypeIds = new Set(buildItems.map((item) => item.typeId));
  const demandLocationsByType = new Map<number, Set<number>>();
  for (const entry of result.lists.planItems) {
    if (entry.kind !== "material" || entry.requiredQuantity <= 0) continue;
    const locationId = entry.stockpileLocationId ?? entry.activityLocationId;
    if (locationId === undefined) continue;
    const locations = demandLocationsByType.get(entry.typeId) ?? new Set<number>();
    locations.add(locationId);
    demandLocationsByType.set(entry.typeId, locations);
  }
  const canUseSourceForDemand = (
    typeId: number,
    sourceLocationId: number | undefined,
    ownerType?: StockOwnerType,
    ownerId?: number,
  ) => {
    const demandLocations = demandLocationsByType.get(typeId);
    if (sourceLocationId === undefined || !demandLocations || demandLocations.size === 0) {
      return true;
    }
    return [...demandLocations].some((destinationLocationId) => {
      if (sourceLocationId === destinationLocationId) return true;
      return !(request.haulExclusions ?? []).some(
        (exclusion) =>
          exclusion.typeId === typeId
          && exclusion.fromLocationId === sourceLocationId
          && exclusion.toLocationId === destinationLocationId
          && (
            exclusion.ownerType === undefined
            || (exclusion.ownerType === ownerType && exclusion.ownerId === ownerId)
          ),
      );
    });
  };
  const canUseStockForDemand = (item: PlanStockItem) =>
    canUseSourceForDemand(item.typeId, getStockRootLocationId(item), item.ownerType, item.ownerId);
  const availableStockQuantitiesByLocationAndType = new Map<string, number>();
  const availableStockQuantitiesByType = new Map<number, number>();
  const excludedStockQuantitiesByLocationAndType = new Map<string, number>();
  const excludedStockQuantitiesByType = new Map<number, number>();
  for (const item of stock) {
    if (
      item.category !== "item"
      || !isAvailableIndustryProductionOutput(item)
      || (item.source === "marketOrder" && !buildTypeIds.has(item.typeId))
    ) continue;
    const locationId = getStockRootLocationId(item);
    const locationKey = locationTypeKey(locationId, item.typeId);
    if (!canUseStockForDemand(item)) {
      excludedStockQuantitiesByLocationAndType.set(
        locationKey,
        (excludedStockQuantitiesByLocationAndType.get(locationKey) ?? 0) + item.quantity,
      );
      excludedStockQuantitiesByType.set(
        item.typeId,
        (excludedStockQuantitiesByType.get(item.typeId) ?? 0) + item.quantity,
      );
      continue;
    }
    availableStockQuantitiesByLocationAndType.set(
      locationKey,
      (availableStockQuantitiesByLocationAndType.get(locationKey) ?? 0) + item.quantity,
    );
    availableStockQuantitiesByType.set(
      item.typeId,
      (availableStockQuantitiesByType.get(item.typeId) ?? 0) + item.quantity,
    );
  }
  for (const [key, quantity] of result.availableStockQuantitiesByLocationAndType ?? []) {
    const separatorIndex = key.lastIndexOf(":");
    const sourceLocationValue = key.slice(0, separatorIndex);
    const typeId = Number(key.slice(separatorIndex + 1));
    const sourceLocationId =
      sourceLocationValue === "unlocated" ? undefined : Number(sourceLocationValue);
    if (
      !Number.isSafeInteger(typeId)
      || (sourceLocationId !== undefined && !Number.isSafeInteger(sourceLocationId))
    ) continue;
    const locationKey = locationTypeKey(sourceLocationId, typeId);
    const eligibleQuantity = Math.max(
      0,
      quantity - (excludedStockQuantitiesByLocationAndType.get(locationKey) ?? 0),
    );
    availableStockQuantitiesByLocationAndType.set(
      key,
      Math.max(availableStockQuantitiesByLocationAndType.get(key) ?? 0, eligibleQuantity),
    );
  }
  const restoredStockQuantitiesByType = new Map<number, number>();
  for (const [key, quantity] of availableStockQuantitiesByLocationAndType) {
    const separatorIndex = key.lastIndexOf(":");
    const typeId = Number(key.slice(separatorIndex + 1));
    if (!Number.isSafeInteger(typeId)) continue;
    restoredStockQuantitiesByType.set(
      typeId,
      (restoredStockQuantitiesByType.get(typeId) ?? 0) + quantity,
    );
  }
  for (const [typeId, quantity] of result.availableStockQuantitiesByType ?? []) {
    if (restoredStockQuantitiesByType.has(typeId)) continue;
    availableStockQuantitiesByType.set(
      typeId,
      demandLocationsByType.has(typeId)
        ? 0
        : Math.max(availableStockQuantitiesByType.get(typeId) ?? 0, quantity),
    );
  }
  for (const [typeId, quantity] of restoredStockQuantitiesByType) {
    availableStockQuantitiesByType.set(typeId, quantity);
  }
  const blockedReactionInputTypeIds = new Set(
    result.lists.reactionJobs.flatMap((job) =>
      job.inputs.materials
        .filter((material) => material.availableQuantity < material.requiredQuantity)
        .map((material) => material.typeId),
    ),
  );
  const nonMarketUsableStockQuantitiesByType = new Map<number, number>();
  for (const item of stock) {
    if (
      item.category !== "item"
      || item.source === "marketOrder"
      || !isAvailableIndustryProductionOutput(item)
      || !isUsableIndustryProductionOutput(item)
    ) continue;
    nonMarketUsableStockQuantitiesByType.set(
      item.typeId,
      (nonMarketUsableStockQuantitiesByType.get(item.typeId) ?? 0) + item.quantity,
    );
  }
  const materialsToBuy = result.lists.materialsToBuy.map((entry) => {
    const excludedQuantity = excludedStockQuantitiesByType.get(entry.typeId) ?? 0;
    const isBlockedReactionInput = blockedReactionInputTypeIds.has(entry.typeId);
    if (excludedQuantity <= 0 && !isBlockedReactionInput) {
      const restoredAvailableStockQuantity =
        availableStockQuantitiesByType.get(entry.typeId) ?? entry.availableStockQuantity;
      const additionalAvailableQuantity = Math.min(
        Math.max(0, restoredAvailableStockQuantity - entry.availableStockQuantity),
        Math.max(
          0,
          (nonMarketUsableStockQuantitiesByType.get(entry.typeId) ?? 0)
            - entry.availableStockQuantity,
        ),
      );
      if (additionalAvailableQuantity <= 0) return entry;
      const plannedProductionQuantity = Math.max(
        0,
        entry.productionQuantity - (entry.reprocessingQuantity ?? 0),
      );
      const remainingShortage = Math.max(
        0,
        entry.requiredQuantity
          - entry.availableStockQuantity
          - additionalAvailableQuantity
          - plannedProductionQuantity,
      );
      return {
        ...entry,
        buyQuantity: Math.min(entry.buyQuantity, remainingShortage),
      };
    }
    const demandLocationId = entry.stockpileLocationId ?? entry.activityLocationId;
    const locallyAvailableStockQuantity =
      demandLocationId === undefined
        ? 0
        : (
            availableStockQuantitiesByLocationAndType.get(
              locationTypeKey(demandLocationId, entry.typeId),
            ) ?? 0
          );
    const availableStockQuantity = Math.max(
      0,
      entry.availableStockQuantity - excludedQuantity,
      locallyAvailableStockQuantity,
    );
    const plannedProductionQuantity = Math.max(
      0,
      entry.productionQuantity - (entry.reprocessingQuantity ?? 0),
    );
    return {
      ...entry,
      availableStockQuantity,
      buyQuantity: isBlockedReactionInput
        ? Math.max(0, entry.requiredQuantity - availableStockQuantity - plannedProductionQuantity)
        : Math.max(
            entry.buyQuantity,
            entry.requiredQuantity - availableStockQuantity - plannedProductionQuantity,
          ),
    };
  });
  return {
    ...result,
    lists: {
      ...result.lists,
      materialsToBuy,
    },
    availableStockQuantitiesByLocationAndType,
    availableStockQuantitiesByType,
  };
}

function restorePlanSourceCounts(result: PlanCalculation, stock: PlanStockItem[]): PlanCalculation {
  const stockSourceCountsByType = getStockSourceCountsByType(stock);
  const availableSourceCountsByType = new Map(result.availableSourceCountsByType ?? []);
  for (const [typeId, sourceCounts] of stockSourceCountsByType) {
    const mergedSourceCounts = mergePlanSourceCountsByMaximum(
      availableSourceCountsByType.get(typeId),
      sourceCounts,
    );
    if (mergedSourceCounts) availableSourceCountsByType.set(typeId, mergedSourceCounts);
  }
  return { ...result, availableSourceCountsByType };
}

function getStockSourceCountsByType(stock: PlanStockItem[]): PlanSourceCountsByType {
  const sourceCountsByType = new Map<number, PlanSourceCountsByLocation>();
  for (const stockItem of stock) {
    const locationId = getStockRootLocationId(stockItem);
    if (locationId === undefined) continue;
    const sourceCountsByLocation = sourceCountsByType.get(stockItem.typeId) ?? {};
    const sourceCounts = sourceCountsByLocation[locationId] ?? {};
    const addSource = (source: PlanSourceIcon, quantityOverride?: number) => {
      const quantity =
        quantityOverride
        ?? (source === "invention" || source === "copying"
          ? (stockItem.jobRuns ?? stockItem.quantity)
            * (source === "copying" ? (stockItem.licensedRuns ?? 1) : 1)
          : stockItem.quantity);
      sourceCounts[source] = (sourceCounts[source] ?? 0) + quantity;
    };
    if (stockItem.category === "item" && stockItem.source === "marketOrder") {
      addSource("market");
    }
    if (isIndustryProductionOutput(stockItem) && !isUsableIndustryProductionOutput(stockItem)) {
      addSource("industry", stockItem.inBuildQuantity ?? stockItem.quantity);
    }
    if (
      stockItem.inBuild
      && stockItem.category === "blueprint"
      && stockItem.blueprintRunsAtInstall !== undefined
      && stockItem.activityName === "Invention"
    ) {
      addSource("invention");
    }
    if (
      stockItem.inBuild
      && stockItem.category === "blueprint"
      && stockItem.activityName === "Copying"
    ) {
      addSource("copying");
    }
    if (Object.keys(sourceCounts).length > 0) {
      sourceCountsByLocation[locationId] = sourceCounts;
      sourceCountsByType.set(stockItem.typeId, sourceCountsByLocation);
    }
  }
  return sourceCountsByType;
}

function restorePlanResourceCounts(
  result: PlanCalculation,
  stock: PlanStockItem[],
): PlanCalculation {
  return {
    ...result,
    lists: {
      ...result.lists,
      planItems: result.lists.planItems.map((entry) => {
        if (entry.activityLocationId === undefined) return entry;
        if (entry.kind === "bpc") {
          const counts = countPlanBlueprints(stock, entry.typeId, entry.activityLocationId);
          return counts.total > 0
            ? { ...entry, bpoCount: counts.available, bposInUse: counts.inUse }
            : entry;
        }
        if (entry.kind === "reaction") {
          const counts = countPlanReactionFormulas(stock, entry.typeId, entry.activityLocationId);
          return counts.total > 0
            ? {
                ...entry,
                availableQuantity: counts.available,
                bpoCount: counts.total,
                bposInUse: counts.inUse,
              }
            : entry;
        }
        return entry;
      }),
    },
  };
}

/** Merge stockpile BPC requirements before calculating the shared shortage. */
function mergeBpcBuyEntries(entries: PlanCalculation["lists"]["bpcsToBuy"]) {
  const mergedByType = new Map<number, PlanCalculation["lists"]["bpcsToBuy"][number]>();
  for (const entry of entries) {
    const existing = mergedByType.get(entry.typeId);
    if (!existing) {
      mergedByType.set(entry.typeId, { ...entry });
      continue;
    }
    mergedByType.set(
      entry.typeId,
      {
        ...existing,
        neededQuantity: existing.neededQuantity + entry.neededQuantity,
        stockQuantity: existing.stockQuantity + entry.stockQuantity,
        stockRuns: existing.stockRuns + entry.stockRuns,
        buyQuantity: existing.buyQuantity + entry.buyQuantity,
        bpoCount: existing.bpoCount + entry.bpoCount,
        bposInUse: (existing.bposInUse ?? 0) + (entry.bposInUse ?? 0),
      },
    );
  }
  return [...mergedByType.values()].map((entry) => ({
    ...entry,
    buyQuantity: Math.max(0, entry.neededQuantity - entry.stockRuns),
  }));
}

/** Merges stockpile material requirements before calculating the shared shortage. */
function mergeMaterialBuyEntries(entries: PlanCalculation["lists"]["materialsToBuy"]) {
  return mergeMaterialEntries(
    entries,
    {
      combineAvailableStockQuantity: (existing, entry) =>
        existing.availableStockQuantity + entry.availableStockQuantity,
      combineSourceCounts: mergeMaterialSourceCounts,
      clearLocationsWhenMerged: false,
    },
  );
}

function calculateMergedMaterialBuyQuantity(
  entry: PlanCalculation["lists"]["materialsToBuy"][number],
) {
  return Math.max(
    0,
    entry.requiredQuantity
      - entry.availableStockQuantity
      - Math.max(0, entry.productionQuantity - (entry.reprocessingQuantity ?? 0)),
  );
}

function mergeMaterialRowsWithinPass(entries: PlanCalculation["lists"]["materialsToBuy"]) {
  return mergeMaterialEntries(
    entries,
    {
      combineAvailableStockQuantity: (existing, entry) =>
        Math.max(existing.availableStockQuantity, entry.availableStockQuantity),
      combineSourceCounts: mergeMaterialSourceCountsByMaximum,
      clearLocationsWhenMerged: true,
    },
  );
}

/** Defines the values whose aggregation differs between material merge contexts. */
type MaterialMergePolicy = {
  combineAvailableStockQuantity: (
    existing: PlanCalculation["lists"]["materialsToBuy"][number],
    entry: PlanCalculation["lists"]["materialsToBuy"][number],
  ) => number;
  combineSourceCounts: (
    existing: PlanSourceCountsByLocation | undefined,
    entry: PlanSourceCountsByLocation | undefined,
  ) => PlanSourceCountsByLocation | undefined;
  clearLocationsWhenMerged: boolean;
};

/** Merges material rows by type while retaining the caller's availability semantics. */
function mergeMaterialEntries(
  entries: PlanCalculation["lists"]["materialsToBuy"],
  policy: MaterialMergePolicy,
) {
  const mergedByType = new Map<number, PlanCalculation["lists"]["materialsToBuy"][number]>();
  const mergedTypes = new Set<number>();
  for (const entry of entries) {
    const existing = mergedByType.get(entry.typeId);
    if (!existing) {
      mergedByType.set(entry.typeId, { ...entry });
      continue;
    }
    mergedTypes.add(entry.typeId);
    const merged = {
      ...existing,
      quantity: existing.quantity + entry.quantity,
      requiredQuantity: existing.requiredQuantity + entry.requiredQuantity,
      stockQuantity: existing.stockQuantity + entry.stockQuantity,
      availableStockQuantity: policy.combineAvailableStockQuantity(existing, entry),
      productionQuantity: existing.productionQuantity + entry.productionQuantity,
      reprocessingQuantity:
        (existing.reprocessingQuantity ?? 0) + (entry.reprocessingQuantity ?? 0),
      buyQuantity: existing.buyQuantity + entry.buyQuantity,
      remainingProductionQuantity:
        existing.remainingProductionQuantity + entry.remainingProductionQuantity,
      availableSourceCounts: policy.combineSourceCounts(
        existing.availableSourceCounts,
        entry.availableSourceCounts,
      ),
    };
    if (policy.clearLocationsWhenMerged) {
      delete merged.activityLocationId;
      delete merged.stockpileLocationId;
    }
    mergedByType.set(entry.typeId, merged);
  }
  return [...mergedByType.values()].map((entry) =>
    mergedTypes.has(entry.typeId) && entry.reprocessingQuantity === 0 && entry.buyQuantity > 0
      ? { ...entry, buyQuantity: calculateMergedMaterialBuyQuantity(entry) }
      : entry,
  );
}

/** Adds purchases for destination shortages that remote usable stock cannot satisfy. */
function addUnfulfilledRemoteStockPurchases(
  entries: PlanCalculation["lists"]["materialsToBuy"],
  stock: PlanStockItem[],
  haulingTasks: PlanCalculation["lists"]["haulingTasks"],
  buildableTypeIds: ReadonlySet<number>,
) {
  return entries.map((entry) => {
    const locationId = entry.stockpileLocationId ?? entry.activityLocationId;
    if (
      locationId === undefined
      || entry.productionQuantity > 0
      || buildableTypeIds.has(entry.typeId)
    ) return entry;
    const localUsableStock = stock.some(
      (item) =>
        item.typeId === entry.typeId
        && getStockRootLocationId(item) === locationId
        && isAvailableIndustryProductionOutput(item)
        && isUsableIndustryProductionOutput(item),
    );
    const remoteUsableStock = stock.some(
      (item) =>
        item.typeId === entry.typeId
        && getStockRootLocationId(item) !== locationId
        && isAvailableIndustryProductionOutput(item)
        && isUsableIndustryProductionOutput(item),
    );
    if (localUsableStock || !remoteUsableStock) return entry;
    const inboundQuantity = haulingTasks
      .filter((task) => task.typeId === entry.typeId && task.toLocationId === locationId)
      .reduce((total, task) => total + task.neededQuantity, 0);
    const plannedProductionQuantity = Math.max(
      0,
      entry.productionQuantity - (entry.reprocessingQuantity ?? 0),
    );
    const unfulfilledQuantity = Math.max(
      0,
      entry.requiredQuantity - entry.stockQuantity - inboundQuantity - plannedProductionQuantity,
    );
    return unfulfilledQuantity > entry.buyQuantity
      ? { ...entry, buyQuantity: unfulfilledQuantity }
      : entry;
  });
}

function mergeMaterialSourceCounts(
  existing: PlanSourceCountsByLocation | undefined,
  entry: PlanSourceCountsByLocation | undefined,
): PlanSourceCountsByLocation | undefined {
  return mergePlanSourceCounts(existing, entry);
}

function mergeMaterialSourceCountsByMaximum(
  existing: PlanSourceCountsByLocation | undefined,
  entry: PlanSourceCountsByLocation | undefined,
): PlanSourceCountsByLocation | undefined {
  return mergePlanSourceCountsByMaximum(existing, entry);
}

function mergePlanSourceCountsByMaximum(
  existing: PlanSourceCountsByLocation | undefined,
  entry: PlanSourceCountsByLocation | undefined,
): PlanSourceCountsByLocation | undefined {
  if (!existing) return entry;
  if (!entry) return existing;
  const sourceCounts: PlanSourceCountsByLocation = {};
  for (const locationId of new Set([
    ...Object.keys(existing).map(Number),
    ...Object.keys(entry).map(Number),
  ])) {
    const existingCounts = existing[locationId] ?? {};
    const entryCounts = entry[locationId] ?? {};
    const mergedCounts: PlanSourceCounts = {};
    for (const source of ["market", "industry", "invention", "copying", "reprocessing"] as const) {
      const count = Math.max(existingCounts[source] ?? 0, entryCounts[source] ?? 0);
      if (count > 0) mergedCounts[source] = count;
    }
    if (Object.keys(mergedCounts).length > 0) sourceCounts[locationId] = mergedCounts;
  }
  return sourceCounts;
}

function mergePlanJobInputEntries(entries: PlanJobInput[]): PlanJobInput {
  const first = entries[0];
  const availableQuantity = entries.reduce((total, entry) => total + entry.availableQuantity, 0);
  const inBuildQuantity = entries.reduce((total, entry) => total + (entry.inBuildQuantity ?? 0), 0);
  const requiredQuantity = entries.reduce((total, entry) => total + entry.requiredQuantity, 0);
  const completionPercent =
    requiredQuantity <= 0
      ? 100
      : Math.min(100, Math.round((availableQuantity / requiredQuantity) * 100));
  return {
    ...first,
    availableQuantity,
    ...(inBuildQuantity > 0 ? { inBuildQuantity } : {}),
    requiredQuantity,
    completionPercent,
    status:
      requiredQuantity <= 0 || availableQuantity >= requiredQuantity
        ? "ready"
        : availableQuantity > 0
          ? "partial"
          : "blocked",
  };
}

function mergePlanJobInputs(entries: PlanJobInputs[]): PlanJobInputs {
  const blueprint = mergePlanJobInputEntries(entries.map((entry) => entry.blueprint));
  const materialsByTypeId = new Map<number, PlanJobInput[]>();
  for (const entry of entries) {
    for (const material of entry.materials) {
      const matchingMaterials = materialsByTypeId.get(material.typeId) ?? [];
      matchingMaterials.push(material);
      materialsByTypeId.set(material.typeId, matchingMaterials);
    }
  }
  const materials = [...materialsByTypeId.values()].map(mergePlanJobInputEntries);
  return summarizePlanJobInputs(
    blueprint,
    materials,
    {
      bpoCount: entries.reduce((total, entry) => total + entry.bpoCount, 0),
      bpcRuns: entries.reduce((total, entry) => total + entry.bpcRuns, 0),
    },
  );
}

type PlanJobEntry =
  | PlanCalculation["lists"]["reactionJobs"][number]
  | PlanCalculation["lists"]["manufacturingJobs"][number];

function locationTypeKey(locationId: number | undefined, typeId: number) {
  return `${locationId ?? "unlocated"}:${typeId}`;
}

/** Merges jobs that share an activity location and type. */
function mergeJobEntries<T extends PlanJobEntry>(
  entries: T[],
  keyFor: (entry: T) => string | number,
  mergeInputs: (entries: PlanJobInputs[]) => PlanJobInputs,
): T[] {
  const mergedByKey = new Map<string | number, T>();
  for (const entry of entries) {
    const key = keyFor(entry);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, { ...entry });
      continue;
    }
    mergedByKey.set(
      key,
      {
        ...existing,
        countNeeded: existing.countNeeded + entry.countNeeded,
        runsAvailable: existing.runsAvailable + entry.runsAvailable,
        totalTime: existing.totalTime + entry.totalTime,
        inputs: mergeInputs([existing.inputs, entry.inputs]),
      },
    );
  }
  return [...mergedByKey.values()];
}

/** Merges reaction jobs by reaction location and formula type. */
function mergeReactionJobs(entries: PlanCalculation["lists"]["reactionJobs"]) {
  return mergeJobEntries(
    entries,
    (entry) => locationTypeKey(entry.locationId, entry.typeId),
    mergeReactionJobInputs,
  );
}

function mergeInventionJobs(entries: PlanCalculation["lists"]["inventionJobs"]) {
  const mergedByKey = new Map<string, PlanCalculation["lists"]["inventionJobs"][number]>();
  for (const entry of entries) {
    const key = locationTypeKey(entry.locationId, entry.typeId);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, { ...entry });
      continue;
    }
    mergedByKey.set(
      key,
      {
        ...existing,
        countNeeded: existing.countNeeded + entry.countNeeded,
      },
    );
  }
  return [...mergedByKey.values()];
}

/** Merges manufacturing jobs by blueprint type. */
function mergeManufacturingJobs(entries: PlanCalculation["lists"]["manufacturingJobs"]) {
  return mergeJobEntries(
    entries,
    (entry) => locationTypeKey(entry.locationId, entry.typeId),
    mergePlanJobInputs,
  );
}

function mergeReactionJobInputs(entries: PlanJobInputs[]): PlanJobInputs {
  const merged = mergePlanJobInputs(entries);
  const blueprint = entries[0].blueprint;
  const availableQuantity = entries.reduce(
    (total, entry) => total + entry.blueprint.availableQuantity,
    0,
  );
  const mergedBlueprint: PlanJobInput = {
    ...blueprint,
    availableQuantity,
    requiredQuantity: 1,
    completionPercent: Math.min(100, availableQuantity * 100),
    status: availableQuantity > 0 ? "ready" : "blocked",
  };
  return summarizePlanJobInputs(mergedBlueprint, merged.materials);
}

/** Reconciles independently rounded reaction passes against the combined shortage. */
async function reconcileMergedReactionProduction(
  result: PlanCalculation,
): Promise<PlanCalculation> {
  const materialEntries = result.lists.materialsToBuy.filter(
    (entry) => entry.productionQuantity > 0 && (entry.reprocessingQuantity ?? 0) === 0,
  );
  const candidates = await Promise.all(
    materialEntries.map(async (entry) => ({
      entry,
      candidate: await getBuildBlueprintByProductTypeId(entry.typeId),
    })),
  );
  let planItems = result.lists.planItems;
  let materialsToBuy = result.lists.materialsToBuy;
  let reactionJobs = result.lists.reactionJobs;

  for (const { entry, candidate } of candidates) {
    if (candidate === null || candidate.activity !== "reaction") continue;
    const reactionActivity = candidate.blueprint.activities.reaction;
    if (!reactionActivity) continue;
    const product = reactionActivity.products.find(
      (productEntry) => productEntry.typeID === entry.typeId,
    );
    if (!product || product.quantity <= 0) continue;

    const shortage = Math.max(0, entry.requiredQuantity - entry.availableStockQuantity);
    const targetProductionQuantity = Math.ceil(shortage / product.quantity) * product.quantity;
    const currentProductionQuantity = Math.max(
      0,
      entry.productionQuantity - (entry.reprocessingQuantity ?? 0),
    );
    const reductionQuantity = currentProductionQuantity - targetProductionQuantity;
    if (reductionQuantity <= 0) continue;

    const runsToRemove = Math.floor(reductionQuantity / product.quantity);
    if (runsToRemove <= 0) continue;
    const formulaTypeId = candidate.blueprint._key;
    materialsToBuy = reduceMaterialProduction(materialsToBuy, entry.typeId, reductionQuantity);
    planItems = reduceMaterialProduction(planItems, entry.typeId, reductionQuantity);
    planItems = reduceReactionFormulaRuns(planItems, formulaTypeId, runsToRemove);
    reactionJobs = reduceReactionJobRuns(reactionJobs, formulaTypeId, runsToRemove);
  }

  return {
    ...result,
    lists: {
      ...result.lists,
      planItems,
      materialsToBuy,
      reactionJobs,
    },
  };
}

function reduceMaterialProduction(
  entries: Material[],
  typeId: number,
  reductionQuantity: number,
): Material[];
function reduceMaterialProduction(
  entries: PlanCalculation["lists"]["planItems"],
  typeId: number,
  reductionQuantity: number,
): PlanCalculation["lists"]["planItems"];
function reduceMaterialProduction(
  entries: Material[] | PlanCalculation["lists"]["planItems"],
  typeId: number,
  reductionQuantity: number,
) {
  const updatedEntries = entries.map((entry) => ({ ...entry }));
  let remainingReduction = reductionQuantity;
  for (let index = updatedEntries.length - 1; index >= 0 && remainingReduction > 0; index -= 1) {
    const entry = updatedEntries[index];
    if (("kind" in entry && entry.kind !== "material") || entry.typeId !== typeId) continue;
    const reducibleQuantity = Math.min(
      remainingReduction,
      Math.max(0, entry.productionQuantity - (entry.reprocessingQuantity ?? 0)),
    );
    if (reducibleQuantity <= 0) continue;
    const productionQuantity = entry.productionQuantity - reducibleQuantity;
    const buildProductionQuantity = Math.max(
      0,
      productionQuantity - (entry.reprocessingQuantity ?? 0),
    );
    updatedEntries[index] = {
      ...entry,
      productionQuantity,
      buyQuantity: Math.max(
        0,
        entry.requiredQuantity - entry.availableStockQuantity - buildProductionQuantity,
      ),
      remainingProductionQuantity: Math.max(
        0,
        entry.availableStockQuantity + buildProductionQuantity - entry.requiredQuantity,
      ),
    };
    remainingReduction -= reducibleQuantity;
  }
  return updatedEntries;
}

function reduceReactionFormulaRuns(
  entries: PlanCalculation["lists"]["planItems"],
  formulaTypeId: number,
  runsToRemove: number,
) {
  const updatedEntries = entries.map((entry) => ({ ...entry }));
  let remainingRuns = runsToRemove;
  for (let index = updatedEntries.length - 1; index >= 0 && remainingRuns > 0; index -= 1) {
    const entry = updatedEntries[index];
    if (entry.kind !== "reaction" || entry.typeId !== formulaTypeId) continue;
    const removedRuns = Math.min(remainingRuns, entry.runsNeeded);
    updatedEntries[index] = { ...entry, runsNeeded: entry.runsNeeded - removedRuns };
    remainingRuns -= removedRuns;
  }
  return updatedEntries;
}

function reduceReactionJobRuns(
  entries: PlanCalculation["lists"]["reactionJobs"],
  formulaTypeId: number,
  runsToRemove: number,
) {
  const updatedEntries = entries.map((entry) => ({ ...entry }));
  let remainingRuns = runsToRemove;
  for (let index = updatedEntries.length - 1; index >= 0 && remainingRuns > 0; index -= 1) {
    const entry = updatedEntries[index];
    if (entry.typeId !== formulaTypeId) continue;
    const removedRuns = Math.min(remainingRuns, entry.countNeeded);
    const nextCount = entry.countNeeded - removedRuns;
    const materials = entry.inputs.materials.map((input) => {
      const requiredQuantity =
        entry.countNeeded > 0
          ? Math.ceil((input.requiredQuantity * nextCount) / entry.countNeeded)
          : 0;
      const completionPercent =
        requiredQuantity <= 0
          ? 100
          : Math.min(100, Math.round((input.availableQuantity / requiredQuantity) * 100));
      const status: PlanJobInputStatus =
        requiredQuantity <= 0 || input.availableQuantity >= requiredQuantity
          ? "ready"
          : input.availableQuantity > 0
            ? "partial"
            : "blocked";
      return {
        ...input,
        requiredQuantity,
        completionPercent,
        status,
      };
    });
    updatedEntries[index] = {
      ...entry,
      countNeeded: nextCount,
      runsAvailable: Math.min(entry.runsAvailable, nextCount),
      totalTime: entry.countNeeded > 0 ? (entry.totalTime * nextCount) / entry.countNeeded : 0,
      inputs: summarizePlanJobInputs(
        entry.inputs.blueprint,
        materials,
        {
          bpoCount: entry.inputs.bpoCount,
          bpcRuns: entry.inputs.bpcRuns,
        },
      ),
    };
    remainingRuns -= removedRuns;
  }
  return updatedEntries;
}

async function mergeStockpileResults(
  results: PlanCalculation[],
  stock: PlanStockItem[],
  request: PlannerRequest,
  ledger: PlanningLedger,
): Promise<PlanCalculation> {
  const mergedHaulingTasks = mergeHaulingTasks(
    results.flatMap((result) => result.lists.haulingTasks),
  );
  const haulingTasks = capNonProductionHaulingToLedgerReservations(
    capHaulingTasksToDestinationDemand(mergedHaulingTasks, stock, results),
    ledger,
  );
  const buildableTypeIds = new Set(
    results.flatMap((result) =>
      result.lists.planItems
        .filter((entry) => entry.kind === "material" && entry.productionQuantity > 0)
        .map((entry) => entry.typeId),
    ),
  );
  const materialsToBuy = results.flatMap((result) =>
    addUnfulfilledRemoteStockPurchases(
      mergeMaterialRowsWithinPass(result.lists.materialsToBuy),
      stock,
      haulingTasks,
      buildableTypeIds,
    ),
  );
  const mergedBpcRequirements = mergeBpcBuyEntries(
    results.flatMap((result) => [...result.lists.bpcsToBuy, ...result.lists.bpcsNeeded]),
  );
  const availableSourceCountsByType: PlanSourceCountsByType = new Map();
  const availableStockQuantitiesByLocationAndType = new Map<string, number>();
  const availableStockQuantitiesByType = new Map<number, number>();
  for (const result of results) {
    for (const [typeId, sourceCounts] of result.availableSourceCountsByType ?? []) {
      const mergedSourceCounts = mergePlanSourceCounts(
        availableSourceCountsByType.get(typeId),
        sourceCounts,
      );
      if (mergedSourceCounts) availableSourceCountsByType.set(typeId, mergedSourceCounts);
    }
    for (const [key, quantity] of result.availableStockQuantitiesByLocationAndType ?? []) {
      availableStockQuantitiesByLocationAndType.set(
        key,
        (availableStockQuantitiesByLocationAndType.get(key) ?? 0) + quantity,
      );
    }
    for (const [typeId, quantity] of result.availableStockQuantitiesByType ?? []) {
      availableStockQuantitiesByType.set(
        typeId,
        (availableStockQuantitiesByType.get(typeId) ?? 0) + quantity,
      );
    }
  }
  const skillsById = new Map<number, PlanCalculation["lists"]["skillsRequired"][number]>();
  for (const result of results) {
    for (const skill of result.lists.skillsRequired) {
      const existing = skillsById.get(skill.skillId);
      if (!existing || skill.requiredLevel > existing.requiredLevel) {
        skillsById.set(skill.skillId, skill);
      }
    }
  }
  const warningByKey = new Map<string, PlanWarning>();
  for (const warning of results.flatMap((result) => result.metadata.warnings ?? [])) {
    const key = `${warning.code}:${warning.typeId}:${warning.locationId ?? "unlocated"}`;
    warningByKey.set(key, warning);
  }
  const mergedResult: PlanCalculation = {
    metadata: {
      generatedAt: new Date().toISOString(),
      unresolvedAssetCount: request.unresolvedAssetCount ?? 0,
      corporationAssetSources: [
        ...new Set(
          stock
            .filter((item) => item.ownerType === "corporation")
            .map((item) => item.ownerId)
            .filter((id): id is number => id !== undefined),
        ),
      ],
      ...(warningByKey.size > 0 ? { warnings: [...warningByKey.values()] } : {}),
    },
    lists: {
      planItems: results.flatMap((result) => result.lists.planItems),
      materialsToBuy: mergeMaterialBuyEntries(materialsToBuy),
      bpcsNeeded: mergedBpcRequirements.filter((entry) => entry.bpoCount > 0),
      bpcsToBuy: mergedBpcRequirements.filter((entry) => entry.bpoCount === 0),
      inventionJobs: mergeInventionJobs(results.flatMap((result) => result.lists.inventionJobs)),
      reactionJobs: mergeReactionJobs(results.flatMap((result) => result.lists.reactionJobs)),
      manufacturingJobs: reconcileMergedManufacturingJobInputs(
        mergeManufacturingJobs(results.flatMap((result) => result.lists.manufacturingJobs)),
        request,
      ),
      reprocessingJobs: results.flatMap((result) => result.lists.reprocessingJobs),
      skillsRequired: [...skillsById.values()],
      haulingTasks,
    },
    availableSourceCountsByType,
    availableStockQuantitiesByLocationAndType,
    availableStockQuantitiesByType,
  };
  return reconcileMergedReactionProduction(mergedResult);
}
