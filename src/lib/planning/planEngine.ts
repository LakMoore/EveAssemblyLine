import {
  getBlueprintsByInventionProductId,
  getBuildBlueprintByProductTypeId,
  getCompressibleTypes,
  getTypeMaterials,
} from "@/cache/services/sdeCache";
import { getTypes } from "@/lib/sde/loader";
import { PlannerRequest, PlanResult, PlanSourceCounts, PlanSourceIcon } from "./types";
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
  volumePerUnit: number;
};

function getStockRootLocationId(item: PlannerRequest["stock"][number]) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
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
  private readonly enabled = process.env.DEBUG_PLAN === "1";

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
  const preliminaryPlan = await calculatePlanPass({
    ...request,
    items: request.items.filter((item) => !item.fromCompression),
  });
  const reprocessing = await allocatePlanReprocessing(request, preliminaryPlan);
  return calculatePlanPass(request, reprocessing);
}

/** Executes one deterministic planning pass with an optional prepared reprocessing allocation. */
async function calculatePlanPass(
  request: PlannerRequest,
  reprocessing?: ReprocessingAllocation,
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
  const [typeRecords, compressibleTypes, typeMaterials] = await Promise.all([
    profiler.measure("typeNameBatch", () => getTypes()),
    getCompressibleTypes(),
    getTypeMaterials(),
  ]);
  const marketOrderStock = request.stock
    .filter((item) => item.category === "item" && item.source === "marketOrder")
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const standardStock = request.stock
    .filter((item) => item.category !== "blueprint" && item.category !== "reactionformula")
    .filter((item) => item.source !== "marketOrder")
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const stockLots: StockLot[] = request.stock
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
      volumePerUnit: item.isPackaged
        ? (
            typeRecords.get(item.typeId)?.packagedVolume
            ?? typeRecords.get(item.typeId)?.volume
            ?? 0
          )
        : (typeRecords.get(item.typeId)?.volume ?? 0),
    }));
  const stockByLocationAndType = new Map<number, Map<number, number>>();
  for (const lot of stockLots) {
    const locationStock = stockByLocationAndType.get(lot.rootLocationId) ?? new Map();
    locationStock.set(lot.typeId, (locationStock.get(lot.typeId) ?? 0) + lot.quantity);
    stockByLocationAndType.set(lot.rootLocationId, locationStock);
  }
  const haulingByKey = new Map<string, PlanResult["lists"]["haulingTasks"][number]>();
  const reprocessingLocationId =
    request.locations?.reprocessing ?? request.locations?.manufacturing;
  const preferredActivityLocationIds = getPreferredActivityLocationIds(request.locations);
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
    haulingByKey.set(key, task);
  }
  function consumeTrackedStock(
    typeId: number,
    quantity: number,
    destinationRootLocationId: number | undefined,
  ) {
    let remaining = quantity;
    const candidateLots = stockLots
      .filter((lot) => lot.typeId === typeId && lot.quantity > 0)
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
  function getRunsAvailable(
    blueprint: NonNullable<
      Awaited<ReturnType<typeof getBuildBlueprintByProductTypeId>>
    >["blueprint"],
    activity: "manufacturing" | "reaction",
    locationId: number | undefined,
  ) {
    if (locationId === undefined) return 0;
    const materials = blueprint.activities[activity]?.materials ?? [];
    if (materials.length === 0) return 0;
    const locationStock = stockByLocationAndType.get(locationId) ?? new Map();
    return Math.min(
      ...materials.map((material) =>
        Math.floor((locationStock.get(material.typeID) ?? 0) / material.quantity),
      ),
    );
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
      const standardAvailable = standardStock.get(typeId) ?? 0;
      const standardConsumed = Math.min(standardAvailable, quantity - marketConsumed);
      if (standardConsumed > 0) {
        consumeTrackedStock(typeId, standardConsumed, reprocessingLocationId);
        const remainingStandard = standardAvailable - standardConsumed;
        if (remainingStandard > 0) standardStock.set(typeId, remainingStandard);
        else standardStock.delete(typeId);
      }
    }
  }

  const materials = new Map<number, Material>();
  const bpcs = new Map<number, PlanResult["lists"]["bpcsNeeded"][number]>();
  const reactionFormulas = new Map<number, PlanResult["lists"]["planItems"][number]>();
  const manufacturingJobs = new Map<number, PlanResult["lists"]["manufacturingJobs"][number]>();
  const reactionJobs = new Map<number, PlanResult["lists"]["reactionJobs"][number]>();
  const inventionJobs = new Map<number, PlanResult["lists"]["inventionJobs"][number]>();
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
    if (stockItem.inBuild && stockItem.category === "item") {
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
  const reactionFormulaCounts = new Map<number, number>();
  const availableReactionFormulas = request.stock.filter(
    (item) => item.category === "reactionformula",
  );
  for (const item of availableReactionFormulas) {
    reactionFormulaCounts.set(
      item.typeId,
      (reactionFormulaCounts.get(item.typeId) ?? 0) + item.quantity,
    );
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
    consumeAvailableStock = true,
    activityRootLocationId?: number,
  ) {
    return profiler.measure(
      "addMaterial",
      async () => {
        const stockAvailable = standardStock.get(typeId) ?? 0;
        const stockConsumed = consumeAvailableStock ? Math.min(stockAvailable, quantity) : 0;
        if (stockConsumed > 0) {
          consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
          consumeTrackedStock(typeId, stockConsumed, activityRootLocationId);
        }
        const remainingStock = stockAvailable - stockConsumed;
        if (remainingStock > 0) standardStock.set(typeId, remainingStock);
        else if (stockConsumed > 0) standardStock.delete(typeId);
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
  ) {
    let phase = "stock";
    let activity = "unknown";
    const requestedQuantity = quantity;
    return profiler.measure(
      "expand",
      async () => {
        if (quantity <= 0) return;

        const standardAvailable = standardStock.get(typeId) ?? 0;
        const standardConsumed = Math.min(standardAvailable, quantity);
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
          consumeTrackedStock(typeId, standardConsumed, activityRootLocationId);
        }
        if (stockConsumed > 0) {
          if (standardConsumed > 0) {
            const remainingStandard = standardAvailable - standardConsumed;
            if (remainingStandard > 0) standardStock.set(typeId, remainingStandard);
            else standardStock.delete(typeId);
          }
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
          manufacturingJobs.set(
            blueprint._key,
            {
              typeId: blueprint._key,
              name: typeName(blueprint._key, `${fallbackName} Blueprint`),
              runs: (existing?.runs ?? 0) + runsNeeded,
              runsAvailable: Math.min(
                existing?.runsAvailable ?? Number.MAX_SAFE_INTEGER,
                getRunsAvailable(blueprint, "manufacturing", request.locations?.manufacturing),
                runsNeeded,
              ),
              totalTime:
                (existing?.totalTime ?? 0)
                + blueprint.activities.manufacturing!.time
                  * (1 - efficiency.te / 100)
                  * manufacturingTimeMultiplier
                  * manufacturingSkillTimeMultiplier
                  * runsNeeded,
              ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
            },
          );
          phase = "manufacturing materials";
          await profiler.measure(
            "expand.materials",
            async () => {
              for (const material of blueprint.activities.manufacturing?.materials ?? []) {
                const materialQuantity = Math.ceil(
                  material.quantity * runsNeeded * (1 - efficiency.me / 100),
                );
                await expand(
                  material.typeID,
                  materialQuantity,
                  typeName(material.typeID, `Type ${material.typeID}`),
                  nextStack,
                  defaultEfficiency,
                  false,
                  request.locations?.manufacturing,
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
        reactionJobs.set(
          blueprint._key,
          {
            typeId: blueprint._key,
            name: typeName(blueprint._key, `${fallbackName} Reaction Formula`),
            runs: (existing?.runs ?? 0) + runsNeeded,
            runsAvailable: Math.min(
              existing?.runsAvailable ?? Number.MAX_SAFE_INTEGER,
              getRunsAvailable(blueprint, "reaction", request.locations?.reactions),
              runsNeeded,
            ),
            totalTime:
              (existing?.totalTime ?? 0)
              + blueprint.activities.reaction!.time
                * (1 - efficiency.te / 100)
                * reactionTimeMultiplier
                * reactionSkillTimeMultiplier
                * runsNeeded,
            ...(request.locations ? { locationId: request.locations.reactions } : {}),
          },
        );
        const existingFormula = reactionFormulas.get(blueprint._key);
        const formulaCount = reactionFormulaCounts.get(blueprint._key) ?? 0;
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
            request.locations?.reactions,
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
                material.quantity * runsNeeded,
                typeName(material.typeID, `Type ${material.typeID}`),
                nextStack,
                defaultEfficiency,
                false,
                request.locations?.reactions,
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
