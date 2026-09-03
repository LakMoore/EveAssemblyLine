import {
  getBlueprintsByInventionProductId,
  getBuildBlueprintByProductTypeId,
  getCompressibleTypes,
  getGroups,
  getIndustryTargetFilters,
  getTypeMaterials,
} from "@/cache/services/sdeCache";
import { getTypes } from "@/lib/sde/loader";
import { getProductionGroupReferences, productionGroupForType } from "./productionGroups";
import {
  PlanJobInput,
  PlanJobInputs,
  PlanJobInputStatus,
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
  return ["active", "delivered", "paused", "ready"].includes(item.industryJobStatus ?? "");
}

/** Returns the stock eligible for the global view before bucket allocation. */
function getAvailableStockByTypeId(request: PlannerRequest) {
  const initialBuildTypeIds = new Set(request.items.map((item) => item.typeId));
  const availableStockByTypeId = new Map<number, number>();
  for (const item of request.stock) {
    const isMarketOrder = item.category === "item" && item.source === "marketOrder";
    const marketLocationMatches =
      request.locations?.market === undefined
      || getStockRootLocationId(item) === request.locations.market;
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

function getPreferredActivityLocationIds(locations: PlannerRequest["locations"]) {
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
  const reprocessingLocationId =
    request.locations?.reprocessing ?? request.locations?.manufacturing;
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

/** Calculates a plan after selecting only reprocessing portions that satisfy real shortages. */
export async function calculatePlan(request: PlannerRequest): Promise<PlanResult> {
  const populatedBuckets = request.buckets?.filter((bucket) => bucket.items.length > 0);
  if (populatedBuckets && populatedBuckets.length > 0) {
    return calculateBucketedPlan({ ...request, buckets: populatedBuckets });
  }
  return calculatePlanWithoutBuckets({ ...request, buckets: undefined });
}

/** Configures final-product hauling for a planning pass. */
type PlanPassOptions = {
  finalProductLocations?: Map<number, number>;
};

/** Calculates an unbucketed plan, including any prepared reprocessing allocation. */
async function calculatePlanWithoutBuckets(
  request: PlannerRequest,
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
  );
  const reprocessing = await allocatePlanReprocessing(request, preliminaryPlan);
  return calculatePlanPass(request, reprocessing, true, options);
}

/** Executes one deterministic planning pass with an optional prepared reprocessing allocation. */
async function calculatePlanPass(
  request: PlannerRequest,
  reprocessing?: ReprocessingAllocation,
  persistStockConsumption = false,
  options: PlanPassOptions = {},
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
  const [typeRecords, compressibleTypes, typeMaterials, groups, targetFilters] = await Promise.all([
    profiler.measure("typeNameBatch", () => getTypes()),
    getCompressibleTypes(),
    getTypeMaterials(),
    getGroups(),
    getIndustryTargetFilters(),
  ]);
  const productionGroups = getProductionGroupReferences(targetFilters, groups, language);
  const facilityProfilesByLocationId = new Map(
    (request.facilityProfiles ?? []).map((profile) => [profile.locationId, profile]),
  );
  const marketOrderStock = request.stock
    .filter(
      (item) =>
        item.category === "item"
        && item.source === "marketOrder"
        && (
          request.locations?.market === undefined
          || getStockRootLocationId(item) === request.locations.market
        ),
    )
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const initialMarketOrderStock = new Map(marketOrderStock);
  const standardStock = request.stock
    .filter(isAvailableIndustryProductionOutput)
    .filter((item) => item.category !== "blueprint" && item.category !== "reactionformula")
    .filter((item) => item.source !== "marketOrder")
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const stockLots: StockLot[] = request.stock
    .filter(isAvailableIndustryProductionOutput)
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
  const inStockByLocationAndType = new Map<number, Map<number, number>>();
  const initialInBuildByLocationAndType = new Map<number, Map<number, number>>();
  const industryOutputByLocationAndType = new Map<number, Map<number, number>>();
  const industryOutputByType = new Map<number, number>();
  for (const lot of stockLots) {
    const locationStock = stockByLocationAndType.get(lot.rootLocationId) ?? new Map();
    locationStock.set(lot.typeId, (locationStock.get(lot.typeId) ?? 0) + lot.quantity);
    stockByLocationAndType.set(lot.rootLocationId, locationStock);
    const inStock = lot.industryJobOutput ? undefined : inStockByLocationAndType;
    if (inStock) {
      const stockAtLocation = inStock.get(lot.rootLocationId) ?? new Map<number, number>();
      stockAtLocation.set(lot.typeId, (stockAtLocation.get(lot.typeId) ?? 0) + lot.quantity);
      inStock.set(lot.rootLocationId, stockAtLocation);
    }
    if (lot.industryJobOutput) {
      const outputAtLocation =
        industryOutputByLocationAndType.get(lot.rootLocationId) ?? new Map<number, number>();
      outputAtLocation.set(lot.typeId, (outputAtLocation.get(lot.typeId) ?? 0) + lot.quantity);
      industryOutputByLocationAndType.set(lot.rootLocationId, outputAtLocation);
      const initialOutputAtLocation =
        initialInBuildByLocationAndType.get(lot.rootLocationId) ?? new Map<number, number>();
      initialOutputAtLocation.set(
        lot.typeId,
        (initialOutputAtLocation.get(lot.typeId) ?? 0) + lot.quantity,
      );
      initialInBuildByLocationAndType.set(lot.rootLocationId, initialOutputAtLocation);
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
  const reprocessingLocationId =
    request.locations?.reprocessing ?? request.locations?.manufacturing;
  const preferredActivityLocationIds = new Set([
    ...getPreferredActivityLocationIds(request.locations),
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
  const inventionJobs = new Map<number, PlanResult["lists"]["inventionJobs"][number]>();
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
  const totalStock = new Map(standardStock);
  const initialBuildTypeIds = new Set(request.items.map((item) => item.typeId));
  for (const [typeId, quantity] of marketOrderStock) {
    if (!initialBuildTypeIds.has(typeId)) continue;
    totalStock.set(typeId, (totalStock.get(typeId) ?? 0) + quantity);
  }
  const allBlueprintStockItems = request.stock.filter((item) => item.category === "blueprint");
  const blueprintCopyStock = new Map<number, { copies: number; runs: number }>();
  const seenBlueprintPrints = new Set<number>();
  const blueprintOriginalCounts = new Map<number, number>();
  for (const bpStockItem of allBlueprintStockItems) {
    const existing = blueprintCopyStock.get(bpStockItem.typeId) ?? { copies: 0, runs: 0 };
    const prints = bpStockItem.blueprintPrints ?? [];
    const bpoCount = prints.filter((print) => print.type === "bpo").length;
    if (bpoCount > 0) {
      blueprintOriginalCounts.set(bpStockItem.typeId, bpoCount);
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
  function jobInputStatus(inputs: PlanJobInput[]): PlanJobInputStatus {
    const completionPercent = Math.min(...inputs.map((input) => input.completionPercent));
    return inputStatus(completionPercent, 100);
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
    const allInputs = [blueprintInput, ...materials];
    const completionPercent = Math.min(...allInputs.map((input) => input.completionPercent));
    return {
      blueprint: blueprintInput,
      materials,
      completionPercent,
      status: jobInputStatus(allInputs),
    };
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
    const materials = [...materialByTypeId.values()];
    const allInputs = [blueprint, ...materials];
    return {
      blueprint,
      materials,
      completionPercent: Math.min(...allInputs.map((input) => input.completionPercent)),
      status: jobInputStatus(allInputs),
    };
  }
  const usedRunsByBlueprint = new Map<number, number>();
  const consumedStock = new Map<number, number>();
  const consumedMarketOrderStock = new Set<number>();
  const buildBlacklist = new Set(request.settings.buildBlacklist);
  const buyBlacklist = new Set(request.settings.buyBlacklist);
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
      activity === "manufacturing"
        ? request.locations?.manufacturing
        : request.locations?.reactions;
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
        ...(request.locations ? { locationId: request.locations.market } : {}),
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
        if (stockConsumed > 0) {
          consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
        }
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

        const finalProductStockConsumed =
          finalProductLocationId === undefined
            ? 0
            : consumeAvailableStock(typeId, quantity, finalProductLocationId);
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
          consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
        }
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

        if (stack.has(typeId) || buildBlacklist.has(typeId) || buyBlacklist.has(typeId)) {
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
            runsAvailable: Math.min(
              existing?.runsAvailable ?? Number.MAX_SAFE_INTEGER,
              installableRuns,
            ),
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
          consumeTrackedStock(blueprint._key, 1, request.locations?.reactions);
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
      request.locations?.manufacturing,
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
        const existing = inventionJobs.get(inventingBlueprint._key);
        inventionJobs.set(
          inventingBlueprint._key,
          {
            typeId: inventingBlueprint._key,
            name: typeName(inventingBlueprint._key, "Blueprint Copy"),
            runs: (existing?.runs ?? 0) + inventionAttempts,
            ...(request.locations
              ? {
                  locationId: request.locations.manufacturing,
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
            request.locations?.manufacturing,
          );
        }
      }
    },
  );

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
  for (const bpc of bpcs.values()) bpc.name = resolvedName(bpc.typeId);
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
  const haulingTasks = [...haulingByKey.values()];
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

type BucketDemand = Map<number, number>;

function bucketActivityLocations(bucket: NonNullable<PlannerRequest["buckets"]>[number]) {
  return new Set([
    bucket.locations.manufacturing,
    bucket.locations.reactions,
    bucket.locations.reprocessing,
    bucket.locations.copying,
    bucket.locations.invention,
  ]);
}

function isBlueprintOrReactionFormula(item: PlanStockItem) {
  return item.category === "blueprint" || item.category === "reactionformula";
}

/** Reserves ordinary stock globally so a remote bucket cannot consume another bucket's local lot. */
async function allocateBucketStock(
  request: PlannerRequest,
  buckets: NonNullable<PlannerRequest["buckets"]>,
): Promise<PlanStockItem[][]> {
  const bucketDemandResults = await Promise.all(
    buckets.map(async (bucket) => {
      const result = await calculatePlanPass({
        ...request,
        buckets: undefined,
        items: bucket.items,
        stock: [],
        locations: {
          ...request.locations,
          ...bucket.locations,
          market: request.locations?.market ?? bucket.locations.stock,
        },
        groupAssignments: bucket.groupAssignments,
      });
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
          Math.max(
            demand.get(job.inputs.blueprint.typeId) ?? 0,
            job.inputs.blueprint.requiredQuantity,
          ),
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
      return {
        demand: new Map([...demand].filter(([, quantity]) => quantity > 0)),
        jobInputDemand: new Map([...jobInputDemand].filter(([, quantity]) => quantity > 0)),
      };
    }),
  );
  const demandByBucket = bucketDemandResults.map(({ demand }) => demand);
  const jobInputDemandByBucket = bucketDemandResults.map(({ jobInputDemand }) => jobInputDemand);
  let remainingDemand = demandByBucket.map((demand) => new Map(demand));
  let remainingStock = request.stock.map((item) =>
    !isBlueprintOrReactionFormula(item)
    && item.category === "item"
    && item.source !== "marketOrder"
    && isAvailableIndustryProductionOutput(item)
      ? item.quantity
      : 0,
  );
  const allocations = buckets.map(() => new Map<number, number>());
  const allocate = (stockIndex: number, bucketIndex: number, quantity: number) => {
    if (quantity <= 0) return;
    const current = allocations[bucketIndex].get(stockIndex) ?? 0;
    allocations[bucketIndex].set(stockIndex, current + quantity);
    remainingStock[stockIndex] -= quantity;
    const item = request.stock[stockIndex];
    remainingDemand[bucketIndex].set(
      item.typeId,
      Math.max(0, (remainingDemand[bucketIndex].get(item.typeId) ?? 0) - quantity),
    );
  };

  const allocateTypes = (typeIdsToAllocate: Set<number>, demandByPriority: BucketDemand[]) => {
    remainingDemand = demandByPriority.map((demand) => new Map(demand));
    for (const typeId of typeIdsToAllocate) {
      const stockIndexes = request.stock
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => {
          if (item.typeId !== typeId || remainingStock[index] <= 0) return false;
          if (item.category !== "reactionformula") return true;
          return buckets.some(
            (bucket, bucketIndex) =>
              (remainingDemand[bucketIndex].get(typeId) ?? 0) > 0
              && getStockRootLocationId(item) === bucket.locations.reactions,
          );
        });
      for (const { bucket, bucketIndex } of buckets
        .map((bucket, bucketIndex) => ({ bucket, bucketIndex }))
        .sort(
          (left, right) =>
            (remainingDemand[right.bucketIndex].get(typeId) ?? 0)
              - (remainingDemand[left.bucketIndex].get(typeId) ?? 0)
            || left.bucketIndex - right.bucketIndex,
        )) {
        const remaining = remainingDemand[bucketIndex].get(typeId) ?? 0;
        if (remaining <= 0) continue;
        for (const { item, index } of stockIndexes) {
          const stockLocationId = getStockRootLocationId(item);
          const matchingLocation =
            item.category === "reactionformula"
              ? stockLocationId === bucket.locations.reactions
              : stockLocationId === bucket.locations.stock;
          if (remainingStock[index] <= 0 || !matchingLocation) {
            continue;
          }
          allocate(index, bucketIndex, Math.min(remainingStock[index], remaining));
        }
      }
      for (const { item, index } of stockIndexes) {
        const stockLocationId = getStockRootLocationId(item);
        const localBuckets = buckets
          .map((bucket, bucketIndex) => ({ bucket, bucketIndex }))
          .filter(
            ({ bucket, bucketIndex }) =>
              (remainingDemand[bucketIndex].get(typeId) ?? 0) > 0
              && stockLocationId !== undefined
              && (item.category === "reactionformula"
                ? stockLocationId === bucket.locations.reactions
                : bucketActivityLocations(bucket).has(stockLocationId)),
          )
          .sort(
            (left, right) =>
              (remainingDemand[right.bucketIndex].get(typeId) ?? 0)
                - (remainingDemand[left.bucketIndex].get(typeId) ?? 0)
              || left.bucketIndex - right.bucketIndex,
          );
        for (const { bucketIndex } of localBuckets) {
          if (remainingStock[index] <= 0) break;
          allocate(
            index,
            bucketIndex,
            Math.min(remainingStock[index], remainingDemand[bucketIndex].get(typeId) ?? 0),
          );
        }
      }
      for (const { bucketIndex } of buckets.map((bucket, index) => ({
        bucket,
        bucketIndex: index,
      }))) {
        let remaining = remainingDemand[bucketIndex].get(typeId) ?? 0;
        if (remaining <= 0) continue;
        for (const { index } of stockIndexes) {
          if (remaining <= 0) break;
          const item = request.stock[index];
          if (
            item.category === "reactionformula"
            && getStockRootLocationId(item) !== buckets[bucketIndex].locations.reactions
          ) {
            continue;
          }
          const quantity = Math.min(remainingStock[index], remaining);
          allocate(index, bucketIndex, quantity);
          remaining -= quantity;
        }
      }
    }
  };

  const allocatedBucketStock = () =>
    buckets.map((_, bucketIndex) =>
      [...allocations[bucketIndex].entries()].map(([stockIndex, quantity]) => ({
        ...request.stock[stockIndex],
        quantity,
        ...(request.stock[stockIndex].inBuildQuantity !== undefined
          ? { inBuildQuantity: Math.min(request.stock[stockIndex].inBuildQuantity, quantity) }
          : {}),
      })),
    );

  const allocateOrdinaryStock = (
    demandByBucket: BucketDemand[],
    jobInputDemandByBucket: BucketDemand[],
  ) => {
    remainingStock = request.stock.map((item) =>
      !isBlueprintOrReactionFormula(item)
      && item.category === "item"
      && item.source !== "marketOrder"
      && isAvailableIndustryProductionOutput(item)
        ? item.quantity
        : 0,
    );
    for (const allocation of allocations) allocation.clear();
    const standingDemandByBucket = demandByBucket.map((demand, bucketIndex) => {
      const jobInputDemand = jobInputDemandByBucket[bucketIndex];
      return new Map(
        [...demand].map(([typeId, quantity]) => [
          typeId,
          Math.max(0, quantity - (jobInputDemand.get(typeId) ?? 0)),
        ]),
      );
    });
    allocateTypes(
      new Set(jobInputDemandByBucket.flatMap((demand) => [...demand.keys()])),
      jobInputDemandByBucket,
    );
    allocateTypes(
      new Set(standingDemandByBucket.flatMap((demand) => [...demand.keys()])),
      standingDemandByBucket,
    );
    return allocatedBucketStock();
  };

  const ordinaryBucketStock = allocateOrdinaryStock(demandByBucket, jobInputDemandByBucket);
  const ordinaryBucketResults = await Promise.all(
    buckets.map(async (bucket, bucketIndex) => {
      const result = await calculatePlanPass({
        ...request,
        buckets: undefined,
        items: bucket.items,
        stock: ordinaryBucketStock[bucketIndex],
        locations: {
          ...request.locations,
          ...bucket.locations,
          market: request.locations?.market ?? bucket.locations.stock,
        },
        groupAssignments: bucket.groupAssignments,
      });
      return result;
    }),
  );
  const actualDemandByBucket: BucketDemand[] = [];
  const actualJobInputDemandByBucket: BucketDemand[] = [];
  for (const result of ordinaryBucketResults) {
    const demand = new Map<number, number>();
    for (const entry of result.lists.planItems) {
      if (entry.kind === "material") {
        demand.set(
          entry.typeId,
          Math.max(
            demand.get(entry.typeId) ?? 0,
            entry.requiredQuantity,
            entry.quantity,
            entry.buyQuantity,
          ),
        );
      }
    }
    const jobInputDemand = new Map<number, number>();
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
        Math.max(
          demand.get(job.inputs.blueprint.typeId) ?? 0,
          job.inputs.blueprint.requiredQuantity,
        ),
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
    actualDemandByBucket.push(demand);
    actualJobInputDemandByBucket.push(jobInputDemand);
  }
  const correctedBucketStock = allocateOrdinaryStock(
    actualDemandByBucket,
    actualJobInputDemandByBucket,
  );
  const specialDemandByBucket: BucketDemand[] = await Promise.all(
    buckets.map(async (bucket, bucketIndex) => {
      const result = await calculatePlanPass({
        ...request,
        buckets: undefined,
        items: bucket.items,
        stock: correctedBucketStock[bucketIndex],
        locations: {
          ...request.locations,
          ...bucket.locations,
          market: request.locations?.market ?? bucket.locations.stock,
        },
        groupAssignments: bucket.groupAssignments,
      });
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
  remainingDemand = specialDemandByBucket;
  const specialTypeIds = new Set(specialDemandByBucket.flatMap((demand) => [...demand.keys()]));
  for (const [index, item] of request.stock.entries()) {
    if (isBlueprintOrReactionFormula(item) && item.source !== "marketOrder") {
      remainingStock[index] = item.quantity;
    }
  }
  allocateTypes(specialTypeIds, specialDemandByBucket);

  return allocatedBucketStock();
}

/** Calculates buckets using a globally reserved, location-aware asset pool. */
async function calculateBucketedPlan(request: PlannerRequest): Promise<PlanResult> {
  const buckets = request.buckets ?? [];
  const bucketStock = await allocateBucketStock(request, buckets);
  const bucketResults: PlanResult[] = [];
  for (const [bucketIndex, bucket] of buckets.entries()) {
    const locations = {
      ...request.locations,
      ...bucket.locations,
      market: request.locations?.market ?? bucket.locations.stock,
    };
    const finalProductLocations = new Map(
      bucket.items.map((item) => [item.typeId, bucket.locations.stock] as const),
    );
    const result = await calculatePlanWithoutBuckets(
      {
        ...request,
        buckets: undefined,
        items: bucket.items,
        stock: bucketStock[bucketIndex],
        locations,
        groupAssignments: bucket.groupAssignments,
      },
      { finalProductLocations },
    );
    const taggedResult = tagBucketResult(result, bucket);
    bucketResults.push(taggedResult);
  }
  return mergeBucketResults(bucketResults, request.stock, request);
}

function tagBucketResult(
  result: PlanResult,
  bucket: NonNullable<PlannerRequest["buckets"]>[number],
) {
  const context = {
    bucketId: bucket.id,
    bucketName: bucket.name,
    buildLocationId: bucket.locations.manufacturing,
    stockLocationId: bucket.locations.stock,
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

/** Merge bucket BPC requirements before calculating the shared shortage. */
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
  const allInputs = [blueprint, ...materials];
  const completionPercent = Math.min(...allInputs.map((input) => input.completionPercent));
  return {
    blueprint,
    materials,
    completionPercent,
    status: completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked",
  };
}

function mergeReactionJobs(entries: PlanResult["lists"]["reactionJobs"]) {
  const mergedByLocationAndType = new Map<string, PlanResult["lists"]["reactionJobs"][number]>();
  for (const entry of entries) {
    const key = `${entry.locationId ?? "unlocated"}:${entry.typeId}`;
    const existing = mergedByLocationAndType.get(key);
    if (!existing) {
      mergedByLocationAndType.set(key, { ...entry });
      continue;
    }
    const sameBucket = existing.bucketId === entry.bucketId;
    mergedByLocationAndType.set(
      key,
      {
        ...existing,
        runs: existing.runs + entry.runs,
        runsAvailable: existing.runsAvailable + entry.runsAvailable,
        totalTime: existing.totalTime + entry.totalTime,
        inputs: mergeReactionJobInputs([existing.inputs, entry.inputs]),
        ...(sameBucket
          ? {}
          : {
              bucketId: undefined,
              bucketName: undefined,
              buildLocationId: undefined,
              stockLocationId: undefined,
            }),
      },
    );
  }
  return [...mergedByLocationAndType.values()];
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
  const allInputs = [mergedBlueprint, ...merged.materials];
  const completionPercent = Math.min(...allInputs.map((input) => input.completionPercent));
  return {
    blueprint: mergedBlueprint,
    materials: merged.materials,
    completionPercent,
    status: completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked",
  };
}

function mergeBucketResults(
  results: PlanResult[],
  stock: PlanStockItem[],
  request: PlannerRequest,
): PlanResult {
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
      availableStockByTypeId: getAvailableStockByTypeId(request),
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
      bpcsNeeded: results.flatMap((result) => result.lists.bpcsNeeded),
      bpcsToBuy: mergeBpcBuyEntries(
        results.flatMap((result) => [...result.lists.bpcsToBuy, ...result.lists.bpcsNeeded]),
      ),
      inventionJobs: results.flatMap((result) => result.lists.inventionJobs),
      reactionJobs: mergeReactionJobs(results.flatMap((result) => result.lists.reactionJobs)),
      manufacturingJobs: results.flatMap((result) => result.lists.manufacturingJobs),
      reprocessingJobs: results.flatMap((result) => result.lists.reprocessingJobs),
      skillsRequired: [...skillsById.values()],
      haulingTasks: mergeHaulingTasks(results.flatMap((result) => result.lists.haulingTasks)),
    },
  };
}
