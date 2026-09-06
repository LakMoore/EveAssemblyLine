import {
  getBlueprintsByInventionProductId,
  getBuildBlueprintByProductTypeId,
  getCompressibleTypes,
  getGroups,
  getIndustryTargetFilters,
  getSkillPrerequisites,
  getTypeMaterials,
} from "@/cache/services/sdeCache";
import { getTypes } from "@/lib/sde/loader";
import { getProductionGroupReferences, productionGroupForType } from "./productionGroups";
import {
  PlanJobInput,
  PlanJobInputs,
  PlanJobInputStatus,
  PlanActivityLocations,
  PlannerRequest,
  PlanResult,
  PlanSourceCounts,
  PlanSourceIcon,
  PlanStockItem,
} from "./types";
import {
  allocateReprocessing,
  type ReprocessingAllocation,
  type ReprocessingCandidate,
  reprocessCommittedPurchases,
  specialReprocessableTypeIds,
} from "./reprocessStock";

type Material = PlanResult["lists"]["materialsToBuy"][number];
type Efficiency = { me: number; te: number };
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
function summarizePlanJobInputs(blueprint: PlanJobInput, materials: PlanJobInput[]): PlanJobInputs {
  const allInputs = [blueprint, ...materials];
  const completionPercent = Math.min(...allInputs.map((input) => input.completionPercent));
  return {
    blueprint,
    materials,
    completionPercent,
    status: completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked",
  };
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

function getStockRootLocationId(item: PlannerRequest["stock"][number]) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

function isIndustryProductionOutput(item: PlannerRequest["stock"][number]) {
  const activity = item.activityName?.toLowerCase();
  return (
    item.inBuild === true
    && item.jobId !== undefined
    && item.category === "item"
    && (activity === "manufacturing" || activity === "reactions" || activity === "reaction")
  );
}

function isUsableIndustryProductionOutput(item: PlannerRequest["stock"][number]) {
  if (!isIndustryProductionOutput(item)) return true;
  return item.industryJobStatus === "ready" || item.industryJobStatus === "delivered";
}

function isAvailableIndustryProductionOutput(item: PlannerRequest["stock"][number]) {
  if (!isIndustryProductionOutput(item)) return true;
  return item.industryJobStatus !== "cancelled" && item.industryJobStatus !== "reverted";
}

/** Returns the stock eligible for the global view before stockpile allocation. */
function getAvailableStockByTypeId(
  request: PlannerRequest,
  stockpiles: PlannerRequest["stockpiles"],
) {
  const initialBuildTypeIds = new Set(request.items.map((item) => item.typeId));
  const marketLocationIds = new Set(stockpiles?.map((stockpile) => stockpile.locations.stock));
  const availableStockByTypeId = new Map<number, number>();
  for (const item of request.stock) {
    const isMarketOrder = item.category === "item" && item.source === "marketOrder";
    const marketLocationMatches =
      marketLocationIds.size === 0 || marketLocationIds.has(getStockRootLocationId(item) ?? -1);
    if (
      item.category === "item"
      && isMarketOrder
      && marketLocationMatches
      && initialBuildTypeIds.has(item.typeId)
    ) {
      availableStockByTypeId.set(
        item.typeId,
        (availableStockByTypeId.get(item.typeId) ?? 0) + item.quantity,
      );
      continue;
    }
    if (
      !isMarketOrder
      && isAvailableIndustryProductionOutput(item)
      && item.category !== "blueprint"
      && item.category !== "reactionformula"
    ) {
      availableStockByTypeId.set(
        item.typeId,
        (availableStockByTypeId.get(item.typeId) ?? 0) + item.quantity,
      );
    }
  }
  return Object.fromEntries(availableStockByTypeId);
}

function getPreferredActivityLocationIds(locations: PlanActivityLocations | undefined) {
  return new Set(
    [locations?.manufacturing, locations?.reactions, locations?.reprocessing].filter(
      (locationId): locationId is number => locationId !== undefined,
    ),
  );
}

type ProfileEntry = { count: number; totalMs: number; maxMs: number };

class PlanProfiler {
  private readonly entries = new Map<string, ProfileEntry>();
  private readonly enabled =
    process.env.NODE_ENV === "development" && process.env.DEBUG_PLAN === "1";

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
function clampEfficiency(value: number, maximum: number) {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** Builds bounded owned-stock and purchase candidates for demand-limited reprocessing. */
async function allocatePlanReprocessing(
  request: PlannerRequest,
  preliminaryPlan: PlanResult,
  locations: PlanActivityLocations | undefined,
): Promise<ReprocessingAllocation> {
  const [types, compressibleTypes, typeMaterials] = await Promise.all([
    getTypes(),
    getCompressibleTypes(),
    getTypeMaterials(),
  ]);
  const reprocessableTypeIds = new Set([
    ...compressibleTypes.values(),
    ...specialReprocessableTypeIds,
  ]);
  const requiredMaterials = new Map(
    preliminaryPlan.lists.materialsToBuy
      .filter((material) => material.buyQuantity > 0)
      .map((material) => [material.typeId, material.buyQuantity]),
  );
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
    const availableQuantity = Math.max(0, quantity - (reservedDirectStock.get(typeId) ?? 0));
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

/** Converts committed compressed purchases in special stockpiles into future available stock. */
async function getFutureCompressedMaterialStock(
  request: PlannerRequest,
  stockpiles: NonNullable<PlannerRequest["stockpiles"]>,
): Promise<PlanStockItem[]> {
  const [types, typeMaterials] = await Promise.all([getTypes(), getTypeMaterials()]);
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

/** Calculates a plan after selecting only reprocessing portions that satisfy real shortages. */
export async function calculatePlan(request: PlannerRequest): Promise<PlanResult> {
  const populatedStockpiles = request.stockpiles?.filter((stockpile) => stockpile.items.length > 0);
  if (populatedStockpiles && populatedStockpiles.length > 0) {
    return calculateStockpilePlan({ ...request, stockpiles: populatedStockpiles });
  }
  return calculatePlanWithoutStockpiles({ ...request, stockpiles: undefined }, undefined);
}

/** Configures final-product hauling for a planning pass. */
type PlanPassOptions = {
  finalProductLocations?: Map<number, number>;
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

/** Calculates a plan without stockpiles, including prepared reprocessing allocation. */
async function calculatePlanWithoutStockpiles(
  request: PlannerRequest,
  locations: PlanActivityLocations | undefined,
  options: PlanPassOptions = {},
): Promise<PlanResult> {
  const preliminaryPlan = await calculatePlanPass(
    {
      ...request,
      items: request.items.filter((item) => !item.fromCompression),
    },
    undefined,
    false,
    options,
    locations,
  );
  const reprocessing = await allocatePlanReprocessing(request, preliminaryPlan, locations);
  return calculatePlanPass(request, reprocessing, true, options, locations);
}

/** Executes one deterministic planning pass with an optional prepared reprocessing allocation. */
async function calculatePlanPass(
  request: PlannerRequest,
  reprocessing?: ReprocessingAllocation,
  persistStockConsumption = false,
  options: PlanPassOptions = {},
  locations?: PlanActivityLocations,
): Promise<PlanResult> {
  const profiler = new PlanProfiler();
  const startedAt = performance.now();
  profiler.count("calculatePlan");
  const fallbackByTypeId = new Map<number, string>();
  function typeName(typeId: number, fallback: string) {
    fallbackByTypeId.set(typeId, fallback);
    return fallback;
  }
  const language = request.language ?? "en";
  const [typeRecords, compressibleTypes, typeMaterials, groups, targetFilters, skillPrerequisites] =
    await Promise.all([
      profiler.measure("typeNameBatch", () => getTypes()),
      getCompressibleTypes(),
      getTypeMaterials(),
      getGroups(),
      getIndustryTargetFilters(),
      getSkillPrerequisites(),
    ]);
  const productionGroups = getProductionGroupReferences(targetFilters, groups, language);
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
    .filter((item): item is typeof item & { rootLocationId: number } =>
      Number.isInteger(getStockRootLocationId(item)),
    )
    .map((item) => ({
      typeId: item.typeId,
      quantity: item.quantity,
      rootLocationId: getStockRootLocationId(item)!,
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
    }));
  const stockByLocationAndType = new Map<number, Map<number, number>>();
  const industryOutputByLocationAndType = new Map<number, Map<number, number>>();
  const industryOutputByType = new Map<number, number>();
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
  const jobAvailableByLocationAndType = new Map(
    [...stockByLocationAndType].map(([locationId, quantities]) => [
      locationId,
      new Map(quantities),
    ]),
  );
  const haulingByKey = new Map<string, PlanResult["lists"]["haulingTasks"][number]>();
  const reprocessingLocationId = locations?.reprocessing ?? locations?.manufacturing;
  const preferredActivityLocationIds = new Set([
    ...getPreferredActivityLocationIds(locations),
    ...(options.finalProductLocations?.values() ?? []),
  ]);
  function addHauling(
    lot: StockLot,
    quantity: number,
    destinationRootLocationId: number | undefined,
  ) {
    if (
      quantity <= 0
      || destinationRootLocationId === undefined
      || !preferredActivityLocationIds.has(destinationRootLocationId)
      || lot.rootLocationId === destinationRootLocationId
    ) return;
    const key = `${lot.typeId}:${lot.rootLocationId}:${destinationRootLocationId}`;
    const existing = haulingByKey.get(key);
    const task = existing ?? {
      itemTypeId: lot.typeId,
      name: `Type ${lot.typeId}`,
      quantity: 0,
      volume: 0,
      fromLocationId: lot.rootLocationId,
      toLocationId: destinationRootLocationId,
      ownerType: lot.ownerType,
      ownerId: lot.ownerId,
    };
    task.quantity += quantity;
    task.volume += quantity * lot.volumePerUnit;
    if (lot.industryJobOutput) {
      task.productionQuantity = (task.productionQuantity ?? 0) + quantity;
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
    const candidateLots = stockLots
      .filter((lot) => lot.typeId === typeId && lot.quantity > 0)
      .filter((lot) => (source === "inBuild" ? lot.industryJobOutput : !lot.industryJobOutput))
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
  function reserveJobInputAvailability(
    inputs: PlanJobInputs,
    requestedRuns: number,
    locationId: number | undefined,
  ) {
    const installableRuns = getInstallableRuns(inputs, requestedRuns);
    if (installableRuns <= 0 || locationId === undefined) return;
    for (const material of inputs.materials) {
      const available = getLocationQuantity(
        jobAvailableByLocationAndType,
        locationId,
        material.typeId,
      );
      if (available <= 0) continue;
      const reserved = Math.min(
        available,
        Math.ceil((material.requiredQuantity * installableRuns) / requestedRuns),
      );
      const remaining = available - reserved;
      const quantities = jobAvailableByLocationAndType.get(locationId);
      if (remaining > 0) quantities?.set(material.typeId, remaining);
      else quantities?.delete(material.typeId);
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
    const inBuildAvailable = allowRemoteInBuild
      ? totalInBuild
      : getInBuildStock(typeId, destinationRootLocationId);
    const inStockAvailable = Math.max(0, totalAvailable - totalInBuild);
    const consumed = Math.min(quantity, inStockAvailable + inBuildAvailable);
    if (consumed <= 0) return 0;

    const inStockConsumed = Math.min(consumed, inStockAvailable);
    const inBuildConsumed = consumed - inStockConsumed;
    const remainingTotal = totalAvailable - consumed;
    if (remainingTotal > 0) standardStock.set(typeId, remainingTotal);
    else standardStock.delete(typeId);
    if (inStockConsumed > 0) {
      consumeTrackedStock(typeId, inStockConsumed, destinationRootLocationId, "inStock");
    }
    if (inBuildConsumed > 0) {
      let remainingInBuild = inBuildConsumed;
      const outputLots = stockLots
        .filter((lot) => lot.typeId === typeId && lot.industryJobOutput && lot.quantity > 0)
        .filter((lot) => allowRemoteInBuild || lot.rootLocationId === destinationRootLocationId)
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
  const demandOnlyOutputByType = request.stock
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

  const materials = new Map<number, Material>();
  const bpcs = new Map<number, PlanResult["lists"]["bpcsNeeded"][number]>();
  const reactionFormulas = new Map<number, PlanResult["lists"]["planItems"][number]>();
  const manufacturingJobs = new Map<number, PlanResult["lists"]["manufacturingJobs"][number]>();
  const reactionJobs = new Map<number, PlanResult["lists"]["reactionJobs"][number]>();
  const inventionJobs = new Map<string, PlanResult["lists"]["inventionJobs"][number]>();
  const jobInputsByBlueprint = new Map<number, PlanJobInputs>();
  const requiredSkillLevels = new Map<number, number>();
  const inventedBpcTypeIds = new Set<number>();
  const producedParts = new Map(reprocessing?.producedMaterials ?? []);
  const sourceCountsByTypeId = new Map<number, Map<PlanSourceIcon, number>>();
  for (const stockItem of request.stock) {
    const sourceCounts =
      sourceCountsByTypeId.get(stockItem.typeId) ?? new Map<PlanSourceIcon, number>();
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
    if (sourceCounts.size > 0) sourceCountsByTypeId.set(stockItem.typeId, sourceCounts);
  }
  function sourceMetadata(typeId: number) {
    const counts = sourceCountsByTypeId.get(typeId);
    if (!counts) return undefined;
    return {
      icons: [...counts.keys()],
      counts: Object.fromEntries(counts) as PlanSourceCounts,
    };
  }
  const totalStock = aggregateQuantitiesByTypeId(
    request.stock
      .filter(isAvailableIndustryProductionOutput)
      .filter((item) => item.category !== "blueprint" && item.category !== "reactionformula")
      .filter((item) => item.source !== "marketOrder"),
  );
  const initialBuildTypeIds = new Set(request.items.map((item) => item.typeId));
  for (const [typeId, quantity] of marketOrderStock) {
    if (!initialBuildTypeIds.has(typeId)) continue;
    totalStock.set(typeId, (totalStock.get(typeId) ?? 0) + quantity);
  }
  const allBlueprintStockItems = request.stock.filter((item) => item.category === "blueprint");
  const blueprintCopyStock = new Map<number, { copies: number; runs: number }>();
  const seenBlueprintPrints = new Set<number>();
  const blueprintOriginalCounts = new Map<number, number>();
  const blueprintInUseCounts = new Map<number, number>();
  for (const bpStockItem of allBlueprintStockItems) {
    const existing = blueprintCopyStock.get(bpStockItem.typeId) ?? { copies: 0, runs: 0 };
    const prints = bpStockItem.blueprintPrints ?? [];
    const bpoPrints = prints.filter((print) => print.type === "bpo");
    const totalBpoCount =
      bpStockItem.blueprintType === "bpo" ? bpStockItem.quantity : bpoPrints.length;
    const bposInUse = bpStockItem.inUse ? totalBpoCount : 0;
    const availableBpoCount = totalBpoCount - bposInUse;
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
    const uniquePrints = prints.filter((print) => {
      if (seenBlueprintPrints.has(print.itemId)) return false;
      seenBlueprintPrints.add(print.itemId);
      return true;
    });
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
  for (const item of availableReactionFormulas) {
    const locationId = getStockRootLocationId(item);
    if (locationId === undefined) continue;
    const formulasAtLocation =
      reactionFormulaStockByLocation.get(locationId) ?? new Map<number, number>();
    formulasAtLocation.set(item.typeId, (formulasAtLocation.get(item.typeId) ?? 0) + item.quantity);
    reactionFormulaStockByLocation.set(locationId, formulasAtLocation);
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
  ): PlanJobInput {
    return {
      kind,
      typeId,
      name,
      availableQuantity,
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
  ): PlanJobInputs {
    const activityData = blueprint.activities[activity];
    const materials = (activityData?.materials ?? []).map((material) => {
      const requiredQuantity =
        activity === "manufacturing"
          ? Math.ceil(material.quantity * runs * (1 - efficiency.me / 100))
          : material.quantity * runs;
      const adjustedRequiredQuantity = Math.ceil(requiredQuantity * materialMultiplier);
      const availableQuantity = getLocationQuantity(
        jobAvailableByLocationAndType,
        locationId,
        material.typeID,
      );
      return inputItem(
        "material",
        material.typeID,
        typeName(material.typeID, `Type ${material.typeID}`),
        availableQuantity,
        adjustedRequiredQuantity,
      );
    });
    const bpoCount = blueprintOriginalCounts.get(blueprint._key) ?? 0;
    const copyStock = blueprintCopyStock.get(blueprint._key);
    const availableBlueprintQuantity =
      activity === "reaction"
        ? getLocationQuantity(reactionFormulaStockByLocation, locationId, blueprint._key) > 0
          ? 1
          : 0
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
    return summarizePlanJobInputs(blueprintInput, materials);
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
    );
    return summarizePlanJobInputs(blueprint, [...materialByTypeId.values()]);
  }
  const usedRunsByBlueprint = new Map<number, number>();
  const consumedMarketOrderStock = new Set<number>();
  const buildBlacklist = new Set(request.settings.buildBlacklist);
  const buildBlueprintsByTypeId = new Map<
    number,
    ReturnType<typeof getBuildBlueprintByProductTypeId>
  >();
  const defaultEfficiency: Efficiency = {
    me: clampEfficiency(request.settings.defaultMe, 10),
    te: clampEfficiency(request.settings.defaultTe, 20),
  };
  const manufacturingTimeMultiplier = request.facilityTimeMultipliers?.manufacturing ?? 1;
  const reactionTimeMultiplier = request.facilityTimeMultipliers?.reactions ?? 1;
  const manufacturingSkillTimeMultiplier = request.skillTimeMultipliers?.manufacturing ?? 1;
  const reactionSkillTimeMultiplier = request.skillTimeMultipliers?.reactions ?? 1;

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
      const skillId = pending.pop()!;
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

  function updateMaterial(typeId: number, fallbackName: string, update: Partial<Material>) {
    const existing = materials.get(typeId);
    materials.set(
      typeId,
      {
        typeId,
        name: typeName(typeId, fallbackName),
        quantity: existing?.quantity ?? 0,
        requiredQuantity: existing?.requiredQuantity ?? 0,
        stockQuantity: existing?.stockQuantity ?? 0,
        availableStockQuantity: existing?.availableStockQuantity ?? totalStock.get(typeId) ?? 0,
        productionQuantity: existing?.productionQuantity ?? 0,
        buildQuantity: existing?.buildQuantity ?? 0,
        buyQuantity: existing?.buyQuantity ?? 0,
        remainingStockQuantity: existing?.remainingStockQuantity ?? 0,
        remainingProductionQuantity: existing?.remainingProductionQuantity ?? 0,
        fromMarketOrder: existing?.fromMarketOrder || consumedMarketOrderStock.has(typeId),
        availableSourceCounts: existing?.availableSourceCounts ?? sourceMetadata(typeId)?.counts,
        ...update,
        ...(locations ? { locationId: locations.market } : {}),
      },
    );
  }

  for (const [typeId, quantity] of reprocessing?.producedMaterials ?? []) {
    updateMaterial(typeId, `Type ${typeId}`, { productionQuantity: quantity });
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
      `Type ${typeId}`,
      {
        quantity: consumedPurchases,
        requiredQuantity: consumedOwned + consumedPurchases,
        stockQuantity: consumedOwned,
        availableStockQuantity: ownedQuantity,
        buyQuantity: consumedPurchases,
        remainingStockQuantity: Math.max(0, ownedQuantity - consumedOwned),
        imageVariation: "icon",
      },
    );
  }

  async function addMaterial(
    typeId: number,
    quantity: number,
    fallbackName: string,
    demandAlreadyRecorded = false,
    imageVariation: "icon" | "bp" | "bpc" = "icon",
    useAvailableStock = true,
    activityRootLocationId?: number,
  ) {
    return profiler.measure(
      "addMaterial",
      async () => {
        const stockConsumed = useAvailableStock
          ? consumeAvailableStock(typeId, quantity, activityRootLocationId)
          : 0;
        const remainingStock = standardStock.get(typeId) ?? 0;
        const existing = materials.get(typeId);
        updateMaterial(
          typeId,
          fallbackName,
          {
            quantity: (existing?.quantity ?? 0) + quantity - stockConsumed,
            requiredQuantity:
              (existing?.requiredQuantity ?? 0) + (demandAlreadyRecorded ? 0 : quantity),
            stockQuantity:
              (existing?.stockQuantity ?? 0) + (demandAlreadyRecorded ? 0 : stockConsumed),
            buyQuantity: (existing?.buyQuantity ?? 0) + quantity - stockConsumed,
            remainingStockQuantity: remainingStock,
            imageVariation,
          },
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
  ) {
    let phase = "stock";
    let activity = "unknown";
    const requestedQuantity = quantity;
    return profiler.measure(
      "expand",
      async () => {
        if (quantity <= 0) return;

        quantity -= consumeDemandOnlyOutput(typeId, quantity);
        const finalProductStockConsumed =
          finalProductLocationId === undefined
            ? 0
            : consumeAvailableStock(typeId, quantity, finalProductLocationId, true);
        const standardConsumed =
          finalProductStockConsumed
          + consumeAvailableStock(
            typeId,
            quantity - finalProductStockConsumed,
            activityRootLocationId,
            false,
            finalProductLocationId,
          );
        const marketAvailable = allowMarketOrderStock ? (marketOrderStock.get(typeId) ?? 0) : 0;
        const marketConsumed = Math.min(marketAvailable, quantity - standardConsumed);
        const stockConsumed = standardConsumed + marketConsumed;
        updateMaterial(
          typeId,
          fallbackName,
          {
            requiredQuantity: (materials.get(typeId)?.requiredQuantity ?? 0) + requestedQuantity,
            stockQuantity: (materials.get(typeId)?.stockQuantity ?? 0) + stockConsumed,
          },
        );
        if (stockConsumed > 0) {
          if (marketConsumed > 0) {
            const remainingMarket = marketAvailable - marketConsumed;
            if (remainingMarket > 0) marketOrderStock.set(typeId, remainingMarket);
            else marketOrderStock.delete(typeId);
            consumedMarketOrderStock.add(typeId);
          }
          quantity -= stockConsumed;
          updateMaterial(
            typeId,
            fallbackName,
            {
              remainingStockQuantity:
                (standardStock.get(typeId) ?? 0) + (marketOrderStock.get(typeId) ?? 0),
              ...(marketConsumed > 0 ? { fromMarketOrder: true } : {}),
            },
          );
        }
        if (quantity <= 0) return;

        const available = producedParts.get(typeId) ?? 0;
        const consumed = Math.min(available, quantity);
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
            fallbackName,
            false,
            "icon",
            true,
            activityRootLocationId,
          );
          return;
        }

        phase = "blueprint lookup";
        let buildBlueprint = buildBlueprintsByTypeId.get(typeId);
        if (!buildBlueprintsByTypeId.has(typeId)) {
          buildBlueprint = profiler.measure(
            "expand.buildBlueprintLookup",
            () => getBuildBlueprintByProductTypeId(typeId),
            () => ({ typeId }),
          );
          buildBlueprintsByTypeId.set(typeId, buildBlueprint);
        }
        const candidate = await buildBlueprint;
        const blueprint = candidate?.blueprint;

        if (!blueprint) {
          await addMaterial(
            typeId,
            quantity,
            fallbackName,
            true,
            "icon",
            true,
            activityRootLocationId,
          );
          return;
        }

        updateMaterial(
          typeId,
          fallbackName,
          {
            buildQuantity: (materials.get(typeId)?.buildQuantity ?? 0) + quantity,
          },
        );

        activity = candidate.activity;
        const profile = activityProfile(typeId, candidate.activity);
        const activityLocationId = profile.locationId;
        const productQuantity =
          candidate.activity === "manufacturing"
            ? candidate.blueprint.activities.manufacturing!.products!.find(
                (product) => product.typeID === typeId,
              )!.quantity
            : candidate.blueprint.activities.reaction!.products!.find(
                (product) => product.typeID === typeId,
              )!.quantity;
        const runsNeeded = Math.ceil(quantity / productQuantity);
        const producedQuantity = runsNeeded * productQuantity;
        updateMaterial(
          typeId,
          fallbackName,
          {
            productionQuantity: (materials.get(typeId)?.productionQuantity ?? 0) + producedQuantity,
          },
        );
        const surplus = producedQuantity - quantity;
        if (surplus > 0) producedParts.set(typeId, (producedParts.get(typeId) ?? 0) + surplus);
        const nextStack = new Set(stack).add(typeId);

        let remainingRuns = runsNeeded;
        const copyStock = blueprintCopyStock.get(blueprint._key);
        const alreadyUsedRuns = usedRunsByBlueprint.get(blueprint._key) ?? 0;
        const availableRuns = Math.max(0, (copyStock?.runs ?? 0) - alreadyUsedRuns);
        const runsFromStock = Math.min(remainingRuns, availableRuns);
        remainingRuns -= runsFromStock;
        usedRunsByBlueprint.set(blueprint._key, alreadyUsedRuns + runsFromStock);

        if (activity === "manufacturing") {
          addRequiredSkills(blueprint.activities.manufacturing?.skills);
          const existing = manufacturingJobs.get(blueprint._key);
          const existingInputs = jobInputsByBlueprint.get(blueprint._key);
          const jobInputs = createJobInputs(
            "manufacturing",
            blueprint,
            runsNeeded,
            efficiency,
            activityLocationId,
            profile.materialMultiplier,
          );
          const installableRuns = getInstallableRuns(jobInputs, runsNeeded);
          reserveJobInputAvailability(jobInputs, runsNeeded, activityLocationId);
          const mergedJobInputs = mergeJobInputs(
            existingInputs,
            jobInputs,
            (blueprintOriginalCounts.get(blueprint._key) ?? 0) > 0,
          );
          jobInputsByBlueprint.set(blueprint._key, mergedJobInputs);
          manufacturingJobs.set(
            blueprint._key,
            {
              typeId: blueprint._key,
              name: typeName(blueprint._key, `${fallbackName} Blueprint`),
              runs: (existing?.runs ?? 0) + runsNeeded,
              runsAvailable: Math.min(
                existing?.runsAvailable ?? Number.MAX_SAFE_INTEGER,
                installableRuns,
              ),
              totalTime:
                (existing?.totalTime ?? 0)
                + blueprint.activities.manufacturing!.time
                  * (1 - efficiency.te / 100)
                  * profile.timeMultiplier
                  * manufacturingSkillTimeMultiplier
                  * runsNeeded,
              inputs: mergedJobInputs,
              ...(activityLocationId !== undefined ? { locationId: activityLocationId } : {}),
            },
          );
          phase = "manufacturing materials";
          await profiler.measure(
            "expand.materials",
            async () => {
              for (const material of blueprint.activities.manufacturing?.materials ?? []) {
                const materialQuantity = Math.ceil(
                  material.quantity
                    * runsNeeded
                    * (1 - efficiency.me / 100)
                    * profile.materialMultiplier,
                );
                await expand(
                  material.typeID,
                  materialQuantity,
                  typeName(material.typeID, `Type ${material.typeID}`),
                  nextStack,
                  defaultEfficiency,
                  false,
                  activityLocationId,
                );
              }
            },
          );
          const bpoCount = blueprintOriginalCounts.get(blueprint._key) ?? 0;
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
              name: typeName(blueprint._key, `${fallbackName} Blueprint`),
              quantity: (bpcs.get(blueprint._key)?.quantity ?? 0) + runsNeeded,
              neededQuantity: (bpcs.get(blueprint._key)?.neededQuantity ?? 0) + runsNeeded,
              stockQuantity: copyStock?.copies ?? 0,
              stockRuns: copyStock?.runs ?? 0,
              availableSourceCounts: sourceMetadata(blueprint._key)?.counts,
              bpoCount,
              bposInUse: blueprintInUseCounts.get(blueprint._key) ?? 0,
              buildTime: blueprint.activities.copying?.time ?? 0,
              buyQuantity: (bpcs.get(blueprint._key)?.buyQuantity ?? 0) + bpcBuyQuantity,
            },
          );
          return;
        }

        addRequiredSkills(blueprint.activities.reaction?.skills);
        const existing = reactionJobs.get(blueprint._key);
        const existingInputs = jobInputsByBlueprint.get(blueprint._key);
        const jobInputs = createJobInputs(
          "reaction",
          blueprint,
          runsNeeded,
          efficiency,
          activityLocationId,
          profile.materialMultiplier,
        );
        const installableRuns = getInstallableRuns(jobInputs, runsNeeded);
        reserveJobInputAvailability(jobInputs, runsNeeded, activityLocationId);
        const mergedJobInputs = mergeJobInputs(existingInputs, jobInputs, false);
        jobInputsByBlueprint.set(blueprint._key, mergedJobInputs);
        reactionJobs.set(
          blueprint._key,
          {
            typeId: blueprint._key,
            name: typeName(blueprint._key, `${fallbackName} Reaction Formula`),
            runs: (existing?.runs ?? 0) + runsNeeded,
            runsAvailable: (existing?.runsAvailable ?? 0) + installableRuns,
            totalTime:
              (existing?.totalTime ?? 0)
              + blueprint.activities.reaction!.time
                * (1 - efficiency.te / 100)
                * profile.timeMultiplier
                * reactionSkillTimeMultiplier
                * runsNeeded,
            inputs: mergedJobInputs,
            ...(activityLocationId !== undefined ? { locationId: activityLocationId } : {}),
          },
        );
        const existingFormula = reactionFormulas.get(blueprint._key);
        const formulaCount =
          getLocationQuantity(reactionFormulaStockByLocation, activityLocationId, blueprint._key)
          > 0
            ? 1
            : 0;
        reactionFormulas.set(
          blueprint._key,
          {
            kind: "reaction",
            typeId: blueprint._key,
            name: typeName(blueprint._key, `${fallbackName} Formula`),
            runsNeeded:
              (existingFormula && existingFormula.kind === "reaction"
                ? existingFormula.runsNeeded
                : 0) + runsNeeded,
            availableQuantity: formulaCount,
          },
        );
        if (runsNeeded > 0 && formulaCount === 0) {
          await addMaterial(
            blueprint._key,
            1,
            `${fallbackName} Formula`,
            false,
            "bpc",
            true,
            activityLocationId,
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
              await expand(
                material.typeID,
                Math.ceil(material.quantity * runsNeeded * profile.materialMultiplier),
                typeName(material.typeID, `Type ${material.typeID}`),
                nextStack,
                defaultEfficiency,
                false,
                activityLocationId,
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
    const finalProductLocationId = options.finalProductLocations?.get(item.typeId);
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
        const jobKey = locationTypeKey(locations?.manufacturing, inventingBlueprint._key);
        const existing = inventionJobs.get(jobKey);
        inventionJobs.set(
          jobKey,
          {
            typeId: inventingBlueprint._key,
            name: typeName(inventingBlueprint._key, "Blueprint Copy"),
            runs: (existing?.runs ?? 0) + inventionAttempts,
            ...(locations
              ? {
                  locationId: locations.manufacturing,
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
            name: typeName(inventingBlueprint._key, "Blueprint Copy"),
            quantity: (sourceBpc?.quantity ?? 0) + inventionAttempts,
            neededQuantity: sourceNeededQuantity,
            stockQuantity: sourceBpc?.stockQuantity ?? 0,
            stockRuns: sourceBpc?.stockRuns ?? 0,
            availableSourceCounts: sourceMetadata(inventingBlueprint._key)?.counts,
            bpoCount: sourceBpoCount,
            bposInUse: blueprintInUseCounts.get(inventingBlueprint._key) ?? 0,
            buildTime: inventingBlueprint.activities.copying?.time ?? 0,
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
            typeName(material.typeID, `Type ${material.typeID}`),
            false,
            "icon",
            true,
            locations?.manufacturing,
          );
        }
      }
    },
  );

  addSkillPrerequisites();

  for (const material of materials.values()) {
    material.remainingProductionQuantity = producedParts.get(material.typeId) ?? 0;
  }

  const resolvedName = (typeId: number) => {
    const name = typeRecords.get(typeId)?.name;
    return name?.[language] ?? name?.en ?? fallbackByTypeId.get(typeId) ?? `Type ${typeId}`;
  };
  const resolveJobInputs = (inputs: PlanJobInputs) => {
    inputs.blueprint.name = resolvedName(inputs.blueprint.typeId);
    for (const material of inputs.materials) material.name = resolvedName(material.typeId);
  };
  const skillsRequired: PlanResult["lists"]["skillsRequired"] = [...requiredSkillLevels]
    .map(([skillId, requiredLevel]) => ({
      skillId,
      name: resolvedName(skillId),
      requiredLevel,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const material of materials.values()) material.name = resolvedName(material.typeId);
  for (const bpc of bpcs.values()) bpc.name = resolvedName(bpc.typeId);
  for (const job of manufacturingJobs.values()) job.name = resolvedName(job.typeId);
  for (const job of reactionJobs.values()) job.name = resolvedName(job.typeId);
  for (const job of manufacturingJobs.values()) resolveJobInputs(job.inputs);
  for (const job of reactionJobs.values()) resolveJobInputs(job.inputs);
  for (const job of inventionJobs.values()) job.name = resolvedName(job.typeId);
  for (const formula of reactionFormulas.values()) formula.name = resolvedName(formula.typeId);
  const reprocessingJobs: PlanResult["lists"]["reprocessingJobs"] =
    reprocessingLocationId === undefined
      ? []
      : [...(reprocessing?.readyToReprocess ?? [])].map(([typeId, quantity]) => ({
          typeId,
          name: resolvedName(typeId),
          quantity,
          efficiency: request.reprocessingEfficiencies?.[String(typeId)] ?? 50,
          locationId: reprocessingLocationId,
        }));

  const localDemandByLocationAndType = new Map<string, number>();
  for (const job of [...manufacturingJobs.values(), ...reactionJobs.values()]) {
    if (job.locationId === undefined) continue;
    for (const input of job.inputs.materials) {
      const key = `${job.locationId}:${input.typeId}`;
      localDemandByLocationAndType.set(
        key,
        (localDemandByLocationAndType.get(key) ?? 0) + input.requiredQuantity,
      );
    }
  }
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
      const key = `${task.fromLocationId}:${task.itemTypeId}`;
      const outboundCapacity = outboundCapacityByLocationAndType.get(key);
      if (outboundCapacity === undefined || task.quantity <= outboundCapacity) return task;
      const retainedQuantity = Math.max(0, outboundCapacity);
      const removedQuantity = task.quantity - retainedQuantity;
      const volumePerUnit = task.volume / task.quantity;
      task.quantity = retainedQuantity;
      task.volume = retainedQuantity * volumePerUnit;
      if (task.productionQuantity !== undefined) {
        task.productionQuantity = Math.max(0, task.productionQuantity - removedQuantity);
        if (task.productionQuantity === 0) delete task.productionQuantity;
      }
      outboundCapacityByLocationAndType.set(key, 0);
      return task;
    })
    .filter((task) => task.quantity > 0);

  const materialsToBuy = [...materials.values()];
  const bpcRequirements = [...bpcs.values()];
  const bpcsNeeded = bpcRequirements.filter(
    (bpc) => !inventedBpcTypeIds.has(bpc.typeId) && bpc.bpoCount > 0,
  );
  const bpcsToBuy = bpcRequirements.filter(
    (bpc) => !inventedBpcTypeIds.has(bpc.typeId) && bpc.bpoCount === 0,
  );
  const planItems: PlanResult["lists"]["planItems"] = [
    ...materialsToBuy.map((material) => ({ kind: "material" as const, ...material })),
    ...[...bpcs.values()].map((bpc) => ({ kind: "bpc" as const, ...bpc })),
    ...reactionFormulas.values(),
  ];
  for (const task of haulingTasks) task.name = resolvedName(task.itemTypeId);
  const result = {
    metadata: {
      generatedAt: new Date().toISOString(),
      unresolvedAssetCount: request.stock.length,
      availableStockByTypeId: Object.fromEntries(totalStock),
      corporationAssetSources: [
        ...new Set(
          request.stock
            .filter((stock) => stock.ownerType === "corporation")
            .map((stock) => stock.ownerId)
            .filter((id): id is number => id !== undefined),
        ),
      ],
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

type StockpileDemand = Map<number, number>;
type StockpileDemandResult = {
  demand: StockpileDemand;
  jobInputDemand: StockpileDemand;
};

function stockpileActivityLocations(stockpile: NonNullable<PlannerRequest["stockpiles"]>[number]) {
  return new Set([
    stockpile.locations.manufacturing,
    stockpile.locations.reactions,
    stockpile.locations.reprocessing,
    stockpile.locations.copying,
    stockpile.locations.invention,
  ]);
}

function isBlueprintOrReactionFormula(item: PlanStockItem) {
  return item.category === "blueprint" || item.category === "reactionformula";
}

/** Extracts the material and job-input demand used to reserve shared stock. */
function getPlanDemand(result: PlanResult): StockpileDemandResult {
  const demand = new Map<number, number>();
  const jobInputDemand = new Map<number, number>();
  for (const material of result.lists.materialsToBuy) {
    demand.set(
      material.typeId,
      Math.max(
        demand.get(material.typeId) ?? 0,
        material.requiredQuantity,
        material.quantity,
        material.buyQuantity,
      ),
    );
  }
  for (const job of [...result.lists.manufacturingJobs, ...result.lists.reactionJobs]) {
    for (const material of job.inputs.materials) {
      jobInputDemand.set(
        material.typeId,
        (jobInputDemand.get(material.typeId) ?? 0) + material.requiredQuantity,
      );
    }
  }
  for (const job of result.lists.reactionJobs) {
    demand.set(
      job.inputs.blueprint.typeId,
      Math.max(demand.get(job.inputs.blueprint.typeId) ?? 0, job.inputs.blueprint.requiredQuantity),
    );
  }
  for (const blueprint of result.lists.bpcsToBuy) {
    demand.set(
      blueprint.typeId,
      Math.max(
        demand.get(blueprint.typeId) ?? 0,
        blueprint.neededQuantity,
        blueprint.buyQuantity,
        1,
      ),
    );
  }
  for (const [typeId, quantity] of jobInputDemand) {
    demand.set(typeId, Math.max(demand.get(typeId) ?? 0, quantity));
  }
  return { demand, jobInputDemand };
}

/** Reserves ordinary stock globally so a remote stockpile cannot consume another stockpile's local lot. */
async function allocateStockpileStock(
  request: PlannerRequest,
  stockpiles: NonNullable<PlannerRequest["stockpiles"]>,
  futureStockIndexes = new Set<number>(),
): Promise<PlanStockItem[][]> {
  if (stockpiles.length === 1) {
    return [request.stock.map((item) => ({ ...item }))];
  }
  const stockpileDemandResults = await Promise.all(
    stockpiles.map(async (stockpile) => {
      const result = await calculatePlanPass(
        {
          ...request,
          stockpiles: undefined,
          items: stockpile.items,
          stock: [],
          groupAssignments: stockpile.groupAssignments,
        },
        undefined,
        false,
        {},
        activityLocations(stockpile),
      );
      const { demand, jobInputDemand } = getPlanDemand(result);
      return {
        demand: new Map([...demand].filter(([, quantity]) => quantity > 0)),
        jobInputDemand: new Map([...jobInputDemand].filter(([, quantity]) => quantity > 0)),
      };
    }),
  );
  const demandByStockpile = stockpileDemandResults.map(({ demand }) => demand);
  const jobInputDemandByStockpile = stockpileDemandResults.map(
    ({ jobInputDemand }) => jobInputDemand,
  );
  let remainingDemand = demandByStockpile.map((demand) => new Map(demand));
  let remainingStock = request.stock.map((item) =>
    !isBlueprintOrReactionFormula(item)
    && item.category === "item"
    && item.source !== "marketOrder"
    && isUsableIndustryProductionOutput(item)
      ? item.quantity
      : 0,
  );
  const allocations = stockpiles.map(() => new Map<number, number>());
  const canUseFutureStock = (stockIndex: number, stockpileIndex: number) =>
    stockpiles[stockpileIndex].kind !== "special" || !futureStockIndexes.has(stockIndex);
  const allocate = (stockIndex: number, stockpileIndex: number, quantity: number) => {
    if (quantity <= 0) return;
    const current = allocations[stockpileIndex].get(stockIndex) ?? 0;
    allocations[stockpileIndex].set(stockIndex, current + quantity);
    remainingStock[stockIndex] -= quantity;
    const item = request.stock[stockIndex];
    remainingDemand[stockpileIndex].set(
      item.typeId,
      Math.max(0, (remainingDemand[stockpileIndex].get(item.typeId) ?? 0) - quantity),
    );
  };

  const allocateTypes = (
    typeIdsToAllocate: Set<number>,
    demandByPriority: StockpileDemand[],
    preferActivityLocations = false,
  ) => {
    remainingDemand = demandByPriority.map((demand) => new Map(demand));
    for (const typeId of typeIdsToAllocate) {
      const stockIndexes = request.stock
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => {
          if (item.typeId !== typeId || remainingStock[index] <= 0) return false;
          if (item.category !== "reactionformula") return true;
          return stockpiles.some(
            (stockpile, stockpileIndex) =>
              (remainingDemand[stockpileIndex].get(typeId) ?? 0) > 0
              && getStockRootLocationId(item) === stockpile.locations.reactions,
          );
        });
      for (const { stockpile, stockpileIndex } of stockpiles
        .map((stockpile, stockpileIndex) => ({ stockpile, stockpileIndex }))
        .sort(
          (left, right) =>
            (remainingDemand[right.stockpileIndex].get(typeId) ?? 0)
              - (remainingDemand[left.stockpileIndex].get(typeId) ?? 0)
            || left.stockpileIndex - right.stockpileIndex,
        )) {
        const remaining = remainingDemand[stockpileIndex].get(typeId) ?? 0;
        if (remaining <= 0) continue;
        for (const { item, index } of stockIndexes) {
          const stockLocationId = getStockRootLocationId(item);
          const matchingLocation =
            item.category === "reactionformula"
              ? stockLocationId === stockpile.locations.reactions
              : stockLocationId === stockpile.locations.stock;
          if (
            remainingStock[index] <= 0
            || !matchingLocation
            || (
              preferActivityLocations
              && item.category !== "reactionformula"
              && stockLocationId !== undefined
              && !stockpileActivityLocations(stockpile).has(stockLocationId)
            )
            || !canUseFutureStock(index, stockpileIndex)
          ) {
            continue;
          }
          allocate(index, stockpileIndex, Math.min(remainingStock[index], remaining));
        }
      }
      for (const { item, index } of stockIndexes) {
        const stockLocationId = getStockRootLocationId(item);
        const localStockpiles = stockpiles
          .map((stockpile, stockpileIndex) => ({ stockpile, stockpileIndex }))
          .filter(
            ({ stockpile, stockpileIndex }) =>
              (remainingDemand[stockpileIndex].get(typeId) ?? 0) > 0
              && stockLocationId !== undefined
              && (item.category === "reactionformula"
                ? stockLocationId === stockpile.locations.reactions
                : stockpileActivityLocations(stockpile).has(stockLocationId)),
          )
          .sort(
            (left, right) =>
              (remainingDemand[right.stockpileIndex].get(typeId) ?? 0)
                - (remainingDemand[left.stockpileIndex].get(typeId) ?? 0)
              || left.stockpileIndex - right.stockpileIndex,
          );
        for (const { stockpileIndex } of localStockpiles) {
          if (remainingStock[index] <= 0) break;
          if (!canUseFutureStock(index, stockpileIndex)) continue;
          allocate(
            index,
            stockpileIndex,
            Math.min(remainingStock[index], remainingDemand[stockpileIndex].get(typeId) ?? 0),
          );
        }
      }
      for (const { stockpileIndex } of stockpiles.map((stockpile, index) => ({
        stockpile,
        stockpileIndex: index,
      }))) {
        let remaining = remainingDemand[stockpileIndex].get(typeId) ?? 0;
        if (remaining <= 0) continue;
        for (const { index } of stockIndexes) {
          if (remaining <= 0) break;
          const item = request.stock[index];
          if (!canUseFutureStock(index, stockpileIndex)) continue;
          if (
            item.category === "reactionformula"
            && getStockRootLocationId(item) !== stockpiles[stockpileIndex].locations.reactions
          ) {
            continue;
          }
          const quantity = Math.min(remainingStock[index], remaining);
          allocate(index, stockpileIndex, quantity);
          remaining -= quantity;
        }
      }
    }
  };

  const allocatedStockpileStock = () =>
    stockpiles.map((_, stockpileIndex) =>
      [...allocations[stockpileIndex].entries()].map(([stockIndex, quantity]) => ({
        ...request.stock[stockIndex],
        quantity,
        ...(request.stock[stockIndex].inBuildQuantity !== undefined
          ? { inBuildQuantity: Math.min(request.stock[stockIndex].inBuildQuantity, quantity) }
          : {}),
      })),
    );

  const allocateOrdinaryStock = (
    demandByStockpile: StockpileDemand[],
    jobInputDemandByStockpile: StockpileDemand[],
  ) => {
    remainingStock = request.stock.map((item) =>
      !isBlueprintOrReactionFormula(item)
      && item.category === "item"
      && item.source !== "marketOrder"
      && isUsableIndustryProductionOutput(item)
        ? item.quantity
        : 0,
    );
    for (const allocation of allocations) allocation.clear();
    const standingDemandByStockpile = demandByStockpile.map((demand, stockpileIndex) => {
      const jobInputDemand = jobInputDemandByStockpile[stockpileIndex];
      return new Map(
        [...demand].map(([typeId, quantity]) => [
          typeId,
          Math.max(0, quantity - (jobInputDemand.get(typeId) ?? 0)),
        ]),
      );
    });
    allocateTypes(
      new Set(jobInputDemandByStockpile.flatMap((demand) => [...demand.keys()])),
      jobInputDemandByStockpile,
      true,
    );
    allocateTypes(
      new Set(standingDemandByStockpile.flatMap((demand) => [...demand.keys()])),
      standingDemandByStockpile,
    );
    const remainingDemandOnlyOutput = request.stock.map((item) =>
      !isBlueprintOrReactionFormula(item)
      && item.category === "item"
      && item.source !== "marketOrder"
      && isAvailableIndustryProductionOutput(item)
      && !isUsableIndustryProductionOutput(item)
        ? item.quantity
        : 0,
    );
    for (const [stockIndex, item] of request.stock.entries()) {
      if (remainingDemandOnlyOutput[stockIndex] <= 0) continue;
      const stockpileIndexes = stockpiles
        .map((stockpile, stockpileIndex) => ({ stockpile, stockpileIndex }))
        .filter(
          ({ stockpileIndex }) => (demandByStockpile[stockpileIndex].get(item.typeId) ?? 0) > 0,
        )
        .sort(
          (left, right) =>
            (demandByStockpile[right.stockpileIndex].get(item.typeId) ?? 0)
              - (demandByStockpile[left.stockpileIndex].get(item.typeId) ?? 0)
            || left.stockpileIndex - right.stockpileIndex,
        );
      for (const { stockpileIndex } of stockpileIndexes) {
        const demand = demandByStockpile[stockpileIndex].get(item.typeId) ?? 0;
        if (demand <= 0 || remainingDemandOnlyOutput[stockIndex] <= 0) continue;
        const quantity = Math.min(remainingDemandOnlyOutput[stockIndex], demand);
        const current = allocations[stockpileIndex].get(stockIndex) ?? 0;
        allocations[stockpileIndex].set(stockIndex, current + quantity);
        remainingDemandOnlyOutput[stockIndex] -= quantity;
        demandByStockpile[stockpileIndex].set(item.typeId, demand - quantity);
      }
    }
    return allocatedStockpileStock();
  };

  const ordinaryStockpileStock = allocateOrdinaryStock(
    demandByStockpile,
    jobInputDemandByStockpile,
  );
  const ordinaryStockpileResults = await Promise.all(
    stockpiles.map(async (stockpile, stockpileIndex) => {
      const result = await calculatePlanPass(
        {
          ...request,
          stockpiles: undefined,
          items: stockpile.items,
          stock: ordinaryStockpileStock[stockpileIndex],
          reprocessingEfficiencies:
            stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
          groupAssignments: stockpile.groupAssignments,
        },
        undefined,
        false,
        {},
        activityLocations(stockpile),
      );
      return result;
    }),
  );
  const actualDemandByStockpile: StockpileDemand[] = [];
  const actualJobInputDemandByStockpile: StockpileDemand[] = [];
  for (const result of ordinaryStockpileResults) {
    const { demand, jobInputDemand } = getPlanDemand(result);
    actualDemandByStockpile.push(demand);
    actualJobInputDemandByStockpile.push(jobInputDemand);
  }
  const correctedStockpileStock = allocateOrdinaryStock(
    actualDemandByStockpile,
    actualJobInputDemandByStockpile,
  );
  const specialDemandByStockpile: StockpileDemand[] = await Promise.all(
    stockpiles.map(async (stockpile, stockpileIndex) => {
      const result = await calculatePlanPass(
        {
          ...request,
          stockpiles: undefined,
          items: stockpile.items,
          stock: correctedStockpileStock[stockpileIndex],
          reprocessingEfficiencies:
            stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
          groupAssignments: stockpile.groupAssignments,
        },
        undefined,
        false,
        {},
        activityLocations(stockpile),
      );
      const demand = new Map<number, number>();
      for (const entry of result.lists.planItems) {
        if (entry.kind === "bpc") {
          demand.set(entry.typeId, Math.max(demand.get(entry.typeId) ?? 0, entry.neededQuantity));
        }
        else if (entry.kind === "reaction" && entry.availableQuantity <= 0) {
          demand.set(entry.typeId, Math.max(demand.get(entry.typeId) ?? 0, 1));
        }
      }
      for (const job of result.lists.reactionJobs) {
        demand.set(
          job.inputs.blueprint.typeId,
          Math.max(
            demand.get(job.inputs.blueprint.typeId) ?? 0,
            job.inputs.blueprint.requiredQuantity,
          ),
        );
      }
      return demand;
    }),
  );
  remainingDemand = specialDemandByStockpile;
  const specialTypeIds = new Set(specialDemandByStockpile.flatMap((demand) => [...demand.keys()]));
  for (const [index, item] of request.stock.entries()) {
    if (isBlueprintOrReactionFormula(item) && item.source !== "marketOrder") {
      remainingStock[index] = item.quantity;
    }
  }
  allocateTypes(specialTypeIds, specialDemandByStockpile);

  return allocatedStockpileStock();
}

/** Calculates stockpiles using a globally reserved, location-aware asset pool. */
async function calculateStockpilePlan(request: PlannerRequest): Promise<PlanResult> {
  const stockpiles = request.stockpiles ?? [];
  const futureCompressedMaterialStock = await getFutureCompressedMaterialStock(request, stockpiles);
  const planningRequest =
    futureCompressedMaterialStock.length > 0
      ? { ...request, stock: [...request.stock, ...futureCompressedMaterialStock] }
      : request;
  const futureStockIndexes = new Set(
    futureCompressedMaterialStock.map((_, index) => request.stock.length + index),
  );
  const stockpileStock = await allocateStockpileStock(
    planningRequest,
    stockpiles,
    futureStockIndexes,
  );
  const stockpileResults: PlanResult[] = [];
  for (const [stockpileIndex, stockpile] of stockpiles.entries()) {
    const locations = activityLocations(stockpile);
    const finalProductLocations = new Map(
      stockpile.items.map((item) => [item.typeId, stockpile.locations.stock] as const),
    );
    const result = await calculatePlanWithoutStockpiles(
      {
        ...planningRequest,
        stockpiles: undefined,
        items: stockpile.items,
        stock: stockpileStock[stockpileIndex],
        reprocessingEfficiencies:
          stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
        groupAssignments: stockpile.groupAssignments,
      },
      locations,
      { finalProductLocations },
    );
    const taggedResult = tagStockpileResult(result, stockpile);
    stockpileResults.push(taggedResult);
  }
  return mergeStockpileResults(stockpileResults, request.stock, request);
}

function tagStockpileResult(
  result: PlanResult,
  stockpile: NonNullable<PlannerRequest["stockpiles"]>[number],
) {
  const context = {
    stockpileId: stockpile.id,
    stockpileName: stockpile.name,
    buildLocationId: stockpile.locations.manufacturing,
    stockLocationId: stockpile.locations.stock,
  };
  return {
    ...result,
    lists: {
      ...result.lists,
      planItems: result.lists.planItems.map((entry) => ({ ...entry, ...context })),
      materialsToBuy: result.lists.materialsToBuy.map((entry) => ({ ...entry, ...context })),
      bpcsNeeded: result.lists.bpcsNeeded.map((entry) => ({ ...entry, ...context })),
      bpcsToBuy: result.lists.bpcsToBuy.map((entry) => ({ ...entry, ...context })),
      inventionJobs: result.lists.inventionJobs.map((entry) => ({ ...entry, ...context })),
      reactionJobs: result.lists.reactionJobs.map((entry) => ({ ...entry, ...context })),
      manufacturingJobs: result.lists.manufacturingJobs.map((entry) => ({ ...entry, ...context })),
      reprocessingJobs: result.lists.reprocessingJobs.map((entry) => ({ ...entry, ...context })),
      skillsRequired: result.lists.skillsRequired,
      haulingTasks: result.lists.haulingTasks.map((entry) => ({ ...entry, ...context })),
    },
  };
}

function mergeHaulingTasks(tasks: PlanResult["lists"]["haulingTasks"]) {
  const mergedByRoute = new Map<string, PlanResult["lists"]["haulingTasks"][number]>();
  for (const task of tasks) {
    const key = `${task.itemTypeId}:${task.fromLocationId}:${task.toLocationId}`;
    const existing = mergedByRoute.get(key);
    if (existing) {
      existing.quantity += task.quantity;
      existing.volume += task.volume;
      const productionQuantity =
        (existing.productionQuantity ?? 0) + (task.productionQuantity ?? 0);
      if (productionQuantity > 0) existing.productionQuantity = productionQuantity;
      continue;
    }
    mergedByRoute.set(key, { ...task });
  }
  return [...mergedByRoute.values()];
}

/** Merge stockpile BPC requirements before calculating the shared shortage. */
function mergeBpcBuyEntries(entries: PlanResult["lists"]["bpcsToBuy"]) {
  const mergedByType = new Map<number, PlanResult["lists"]["bpcsToBuy"][number]>();
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
        quantity: existing.quantity + entry.quantity,
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

function mergePlanJobInputEntries(entries: PlanJobInput[]): PlanJobInput {
  const first = entries[0];
  const availableQuantity = entries.reduce((total, entry) => total + entry.availableQuantity, 0);
  const requiredQuantity = entries.reduce((total, entry) => total + entry.requiredQuantity, 0);
  const completionPercent =
    requiredQuantity <= 0
      ? 100
      : Math.min(100, Math.round((availableQuantity / requiredQuantity) * 100));
  return {
    ...first,
    availableQuantity,
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
  return summarizePlanJobInputs(blueprint, materials);
}

type PlanJobEntry =
  | PlanResult["lists"]["reactionJobs"][number]
  | PlanResult["lists"]["manufacturingJobs"][number];

function locationTypeKey(locationId: number | undefined, typeId: number) {
  return `${locationId ?? "unlocated"}:${typeId}`;
}

/** Merges jobs that share a planning key while preserving stockpile context only when unambiguous. */
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
    const sameStockpile = existing.stockpileId === entry.stockpileId;
    mergedByKey.set(
      key,
      {
        ...existing,
        runs: existing.runs + entry.runs,
        runsAvailable: existing.runsAvailable + entry.runsAvailable,
        totalTime: existing.totalTime + entry.totalTime,
        inputs: mergeInputs([existing.inputs, entry.inputs]),
        ...(sameStockpile
          ? {}
          : {
              stockpileId: undefined,
              stockpileName: undefined,
              buildLocationId: undefined,
              stockLocationId: undefined,
            }),
      },
    );
  }
  return [...mergedByKey.values()];
}

/** Merges reaction jobs by reaction location and formula type. */
function mergeReactionJobs(entries: PlanResult["lists"]["reactionJobs"]) {
  return mergeJobEntries(
    entries,
    (entry) => locationTypeKey(entry.locationId, entry.typeId),
    mergeReactionJobInputs,
  );
}

function mergeInventionJobs(entries: PlanResult["lists"]["inventionJobs"]) {
  const mergedByKey = new Map<string, PlanResult["lists"]["inventionJobs"][number]>();
  for (const entry of entries) {
    const key = locationTypeKey(entry.locationId, entry.typeId);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, { ...entry });
      continue;
    }
    const sameStockpile = existing.stockpileId === entry.stockpileId;
    mergedByKey.set(
      key,
      {
        ...existing,
        runs: existing.runs + entry.runs,
        ...(sameStockpile
          ? {}
          : {
              stockpileId: undefined,
              stockpileName: undefined,
              buildLocationId: undefined,
              stockLocationId: undefined,
            }),
      },
    );
  }
  return [...mergedByKey.values()];
}

/** Merges manufacturing jobs by blueprint type. */
function mergeManufacturingJobs(entries: PlanResult["lists"]["manufacturingJobs"]) {
  return mergeJobEntries(entries, (entry) => entry.typeId, mergePlanJobInputs);
}

function mergeReactionJobInputs(entries: PlanJobInputs[]): PlanJobInputs {
  const merged = mergePlanJobInputs(entries);
  const blueprint = entries[0].blueprint;
  const availableQuantity = entries.some((entry) => entry.blueprint.availableQuantity > 0) ? 1 : 0;
  const mergedBlueprint: PlanJobInput = {
    ...blueprint,
    availableQuantity,
    requiredQuantity: 1,
    completionPercent: availableQuantity * 100,
    status: availableQuantity > 0 ? "ready" : "blocked",
  };
  return summarizePlanJobInputs(mergedBlueprint, merged.materials);
}

function mergeStockpileResults(
  results: PlanResult[],
  stock: PlanStockItem[],
  request: PlannerRequest,
): PlanResult {
  const mergedBpcRequirements = mergeBpcBuyEntries(
    results.flatMap((result) => [...result.lists.bpcsToBuy, ...result.lists.bpcsNeeded]),
  );
  const skillsById = new Map<number, PlanResult["lists"]["skillsRequired"][number]>();
  for (const result of results) {
    for (const skill of result.lists.skillsRequired) {
      const existing = skillsById.get(skill.skillId);
      if (!existing || skill.requiredLevel > existing.requiredLevel) {
        skillsById.set(skill.skillId, skill);
      }
    }
  }
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      unresolvedAssetCount: stock.length,
      availableStockByTypeId: getAvailableStockByTypeId(request, request.stockpiles),
      corporationAssetSources: [
        ...new Set(
          stock
            .filter((item) => item.ownerType === "corporation")
            .map((item) => item.ownerId)
            .filter((id): id is number => id !== undefined),
        ),
      ],
    },
    lists: {
      planItems: results.flatMap((result) => result.lists.planItems),
      materialsToBuy: results.flatMap((result) => result.lists.materialsToBuy),
      bpcsNeeded: mergedBpcRequirements.filter((entry) => entry.bpoCount > 0),
      bpcsToBuy: mergedBpcRequirements.filter((entry) => entry.bpoCount === 0),
      inventionJobs: mergeInventionJobs(results.flatMap((result) => result.lists.inventionJobs)),
      reactionJobs: mergeReactionJobs(results.flatMap((result) => result.lists.reactionJobs)),
      manufacturingJobs: mergeManufacturingJobs(
        results.flatMap((result) => result.lists.manufacturingJobs),
      ),
      reprocessingJobs: results.flatMap((result) => result.lists.reprocessingJobs),
      skillsRequired: [...skillsById.values()],
      haulingTasks: mergeHaulingTasks(results.flatMap((result) => result.lists.haulingTasks)),
    },
  };
}
