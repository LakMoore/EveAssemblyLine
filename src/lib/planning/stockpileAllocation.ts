import type { PlanningData } from "./planEngine";
import { getBuildBlueprintByProductTypeId } from "@/cache/services/sdeCache";
import type { RequestProfiler } from "@/lib/server/profiling";
import {
  createPlanningLedger,
  recordPlanningLedgerPhase,
  type PlanningLedger,
} from "./planningLedger";
import type {
  PlanActivityLocations,
  PlanCalculation,
  PlanStockItem,
  PlannerRequest,
} from "./types";
import {
  getStockRootLocationId,
  isAvailableIndustryProductionOutput,
  isBlueprintOrReactionFormula,
  isUsableIndustryProductionOutput,
} from "./stockPolicies";

type Stockpile = NonNullable<PlannerRequest["stockpiles"]>[number];
type StockpileDemand = Map<number, number>;
type StockpileDemandResult = {
  demand: StockpileDemand;
  jobInputDemand: StockpileDemand;
  fullJobInputDemand: StockpileDemand;
  reactionJobInputDemand: StockpileDemand;
};

export type StockpileAllocation = {
  stockpileStock: PlanStockItem[][];
  blockedInputStock: PlanStockItem[][];
  ledger: PlanningLedger;
};

type CalculatePlanPass = (
  request: PlannerRequest,
  planningData: PlanningData,
  options?: { locations?: PlanActivityLocations },
) => Promise<PlanCalculation>;

function measureProfiled<T>(
  profiler: RequestProfiler | undefined,
  section: string,
  operation: () => Promise<T>,
): Promise<T> {
  return profiler?.measure(section, operation) ?? operation();
}

function activityLocations(stockpile: Stockpile): PlanActivityLocations {
  return {
    manufacturing: stockpile.locations.manufacturing,
    reactions: stockpile.locations.reactions,
    reprocessing: stockpile.locations.reprocessing,
    copying: stockpile.locations.copying,
    invention: stockpile.locations.invention,
    market: stockpile.locations.stock,
  };
}

function stockpileActivityLocations(stockpile: Stockpile) {
  return new Set([
    stockpile.locations.manufacturing,
    stockpile.locations.reactions,
    stockpile.locations.reprocessing,
    stockpile.locations.copying,
    stockpile.locations.invention,
    ...Object.values(stockpile.groupAssignments ?? {}),
  ]);
}

function isAllocatableOrdinaryStock(item: PlanStockItem) {
  return (
    !isBlueprintOrReactionFormula(item)
    && item.category === "item"
    && (item.source === "marketOrder" || isAvailableIndustryProductionOutput(item))
  );
}

function getOrdinaryStockByTypeId(stock: PlanStockItem[]) {
  const quantities = new Map<number, number>();
  for (const item of stock) {
    if (!isAllocatableOrdinaryStock(item)) continue;
    quantities.set(item.typeId, (quantities.get(item.typeId) ?? 0) + item.quantity);
  }
  return quantities;
}

function getInstallableInputQuantity(
  job:
    | PlanCalculation["lists"]["manufacturingJobs"][number]
    | PlanCalculation["lists"]["reactionJobs"][number],
  requiredQuantity: number,
  availableStockByTypeId: ReadonlyMap<number, number>,
) {
  if (job.countNeeded <= 0 || requiredQuantity <= 0) return 0;
  const materialInputs = job.inputs.materials.filter((input) => input.requiredQuantity > 0);
  const installableRuns = materialInputs.length
    ? Math.min(
        job.countNeeded,
        ...materialInputs.map((input) =>
          Math.floor(
            ((availableStockByTypeId.get(input.typeId) ?? 0) * job.countNeeded)
              / input.requiredQuantity,
          ),
        ),
      )
    : job.countNeeded;
  if (installableRuns <= 0) return 0;
  return Math.min(
    requiredQuantity,
    Math.ceil((requiredQuantity * installableRuns) / job.countNeeded),
  );
}

/** Extracts the material and job-input demand used to reserve shared stock. */
export function getPlanDemand(
  result: PlanCalculation,
  availableStockByTypeId = new Map<number, number>(),
): StockpileDemandResult {
  const demand = new Map<number, number>();
  const jobInputDemand = new Map<number, number>();
  const fullJobInputDemand = new Map<number, number>();
  const reactionJobInputDemand = new Map<number, number>();
  for (const material of result.lists.materialsToBuy) {
    const materialDemand = Math.max(
      material.requiredQuantity,
      material.quantity,
      material.buyQuantity,
    );
    demand.set(material.typeId, (demand.get(material.typeId) ?? 0) + materialDemand);
  }
  for (const job of [...result.lists.manufacturingJobs, ...result.lists.reactionJobs]) {
    for (const material of job.inputs.materials) {
      fullJobInputDemand.set(
        material.typeId,
        (fullJobInputDemand.get(material.typeId) ?? 0) + material.requiredQuantity,
      );
      const installableQuantity = getInstallableInputQuantity(
        job,
        material.requiredQuantity,
        availableStockByTypeId,
      );
      jobInputDemand.set(
        material.typeId,
        (jobInputDemand.get(material.typeId) ?? 0) + installableQuantity,
      );
    }
  }
  for (const job of result.lists.reactionJobs) {
    for (const material of job.inputs.materials) {
      reactionJobInputDemand.set(
        material.typeId,
        (reactionJobInputDemand.get(material.typeId) ?? 0) + material.requiredQuantity,
      );
    }
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
  return { demand, jobInputDemand, fullJobInputDemand, reactionJobInputDemand };
}

/** Reserves ordinary stock globally so remote stockpiles cannot consume local lots. */
export async function allocateStockpileStock(
  request: PlannerRequest,
  stockpiles: NonNullable<PlannerRequest["stockpiles"]>,
  planningData: PlanningData,
  calculatePlanPass: CalculatePlanPass,
  futureStockIndexes = new Set<number>(),
  profiler?: RequestProfiler,
): Promise<StockpileAllocation> {
  let ledger = createPlanningLedger(
    request.stock.map((item) => item.quantity),
    request.stock.map((item) => ({
      typeId: item.typeId,
      ...(getStockRootLocationId(item) !== undefined
        ? { sourceLocationId: getStockRootLocationId(item) }
        : {}),
      ...(item.ownerType !== undefined ? { ownerType: item.ownerType } : {}),
      ...(item.ownerId !== undefined ? { ownerId: item.ownerId } : {}),
    })),
    stockpiles.map((stockpile) => stockpile.locations.stock),
  );
  if (stockpiles.length === 1) {
    ledger = recordPlanningLedgerPhase(
      ledger,
      "single-stockpile",
      [new Map(request.stock.map((item, index) => [index, item.quantity]))],
      [new Map()],
    );
    return {
      stockpileStock: [request.stock.map((item) => ({ ...item }))],
      blockedInputStock: [[]],
      ledger,
    };
  }
  const stockpileEntries = stockpiles.map((stockpile, stockpileIndex) => ({
    stockpile,
    stockpileIndex,
    activityLocationIds: stockpileActivityLocations(stockpile),
  }));
  const stockIndexesByTypeId = new Map<number, { item: PlanStockItem; index: number }[]>();
  for (const [index, item] of request.stock.entries()) {
    const stockIndexes = stockIndexesByTypeId.get(item.typeId) ?? [];
    stockIndexes.push({ item, index });
    stockIndexesByTypeId.set(item.typeId, stockIndexes);
  }
  const reprocessableTypeIdsByMaterial = new Map<number, number[]>();
  const reprocessableTypeIds = new Set([
    ...planningData.compressibleTypes.values(),
    ...planningData.compressibleTypes.keys(),
  ]);
  for (const reprocessableTypeId of reprocessableTypeIds) {
    for (const material of planningData.typeMaterials.get(reprocessableTypeId)?.materials ?? []) {
      const sourceTypeIds = reprocessableTypeIdsByMaterial.get(material.materialTypeID) ?? [];
      sourceTypeIds.push(reprocessableTypeId);
      reprocessableTypeIdsByMaterial.set(material.materialTypeID, sourceTypeIds);
    }
  }
  const stockpileDemandResults = await measureProfiled(
    profiler,
    "initialDemandPasses",
    () =>
      Promise.all(
        stockpiles.map(async (stockpile, stockpileIndex) => {
          const result = await measureProfiled(
            profiler,
            `initialDemandPass.${stockpileIndex}`,
            () =>
              calculatePlanPass(
                {
                  ...request,
                  stockpiles: [],
                  items: stockpile.items,
                  stock: [],
                  groupAssignments: stockpile.groupAssignments,
                },
                planningData,
                { locations: activityLocations(stockpile) },
              ),
          );
          const { demand, jobInputDemand, fullJobInputDemand, reactionJobInputDemand } =
            getPlanDemand(result, getOrdinaryStockByTypeId(request.stock));
          return {
            demand: new Map([...demand].filter(([, quantity]) => quantity > 0)),
            jobInputDemand: new Map([...jobInputDemand].filter(([, quantity]) => quantity > 0)),
            fullJobInputDemand: new Map(
              [...fullJobInputDemand].filter(([, quantity]) => quantity > 0),
            ),
            reactionJobInputDemand: new Map(
              [...reactionJobInputDemand].filter(([, quantity]) => quantity > 0),
            ),
          };
        }),
      ),
  );
  const demandByStockpile = stockpileDemandResults.map(({ demand }) => demand);
  const jobInputDemandByStockpile = stockpileDemandResults.map(
    ({ jobInputDemand }) => jobInputDemand,
  );
  const fullJobInputDemandByStockpile = stockpileDemandResults.map(
    ({ fullJobInputDemand }) => fullJobInputDemand,
  );
  const reactionJobInputDemandByStockpile = stockpileDemandResults.map(
    ({ reactionJobInputDemand }) => reactionJobInputDemand,
  );
  const fullJobInputTypeIds = new Set(
    fullJobInputDemandByStockpile.flatMap((demand) => [...demand.keys()]),
  );
  const buildableTypeIds = new Set(
    (
      await measureProfiled(
        profiler,
        "resolveBuildableTypes",
        () =>
          Promise.all(
            [...fullJobInputTypeIds].map(async (typeId) => {
              const candidate = await getBuildBlueprintByProductTypeId(typeId);
              return candidate?.blueprint ? typeId : undefined;
            }),
          ),
      )
    ).filter((typeId): typeId is number => typeId !== undefined),
  );
  let remainingDemand = demandByStockpile.map((demand) => new Map(demand));
  let remainingStock = request.stock.map((item) =>
    isAllocatableOrdinaryStock(item) ? item.quantity : 0,
  );
  const allocations = stockpiles.map(() => new Map<number, number>());
  const canUseFutureStock = (stockIndex: number, stockpileIndex: number) =>
    stockpiles[stockpileIndex].kind !== "special" || !futureStockIndexes.has(stockIndex);
  const canUseStockForStockpile = (item: PlanStockItem, stockpileIndex: number) => {
    const sourceLocationId = getStockRootLocationId(item);
    if (sourceLocationId === undefined) return true;
    const destinationLocationId = stockpiles[stockpileIndex].locations.stock;
    if (sourceLocationId === destinationLocationId) return true;
    return !(request.haulExclusions ?? []).some(
      (exclusion) =>
        exclusion.typeId === item.typeId
        && exclusion.fromLocationId === sourceLocationId
        && exclusion.toLocationId === destinationLocationId
        && (
          exclusion.ownerType === undefined
          || (exclusion.ownerType === item.ownerType && exclusion.ownerId === item.ownerId)
        ),
    );
  };
  const allocate = (
    stockIndex: number,
    stockpileIndex: number,
    quantity: number,
    demandTypeId = request.stock[stockIndex].typeId,
    demandQuantity = quantity,
  ) => {
    if (quantity <= 0) return;
    const current = allocations[stockpileIndex].get(stockIndex) ?? 0;
    allocations[stockpileIndex].set(stockIndex, current + quantity);
    remainingStock[stockIndex] -= quantity;
    remainingDemand[stockpileIndex].set(
      demandTypeId,
      Math.max(0, (remainingDemand[stockpileIndex].get(demandTypeId) ?? 0) - demandQuantity),
    );
  };

  const allocationFor = (
    stockTypeId: number,
    demandTypeId: number,
    stockpileIndex: number,
    availableQuantity: number,
  ) => {
    const remainingQuantity = remainingDemand[stockpileIndex].get(demandTypeId) ?? 0;
    if (remainingQuantity <= 0 || availableQuantity <= 0) return undefined;
    if (stockTypeId === demandTypeId) {
      const quantity = Math.min(availableQuantity, remainingQuantity);
      return { quantity, demandQuantity: quantity };
    }
    const type = planningData.types.get(stockTypeId);
    const material = planningData.typeMaterials
      .get(stockTypeId)
      ?.materials?.find((candidate) => candidate.materialTypeID === demandTypeId);
    const portionSize = type?.portionSize ?? 1;
    const efficiency =
      stockpiles[stockpileIndex].reprocessingEfficiencies?.[String(stockTypeId)]
      ?? request.reprocessingEfficiencies?.[String(stockTypeId)]
      ?? 50;
    const outputPerPortion = ((material?.quantity ?? 0) * efficiency) / 100;
    if (portionSize <= 0 || outputPerPortion <= 0) return undefined;
    const availablePortions = Math.floor(availableQuantity / portionSize);
    const requiredPortions = Math.ceil(remainingQuantity / outputPerPortion);
    const portions = Math.min(availablePortions, requiredPortions);
    if (portions <= 0) return undefined;
    return {
      quantity: portions * portionSize,
      demandQuantity: Math.min(remainingQuantity, Math.floor(portions * outputPerPortion)),
    };
  };

  const isReprocessableSourceForDemand = (stockTypeId: number, demandTypeId: number) =>
    stockTypeId !== demandTypeId
    && (planningData.typeMaterials.get(stockTypeId)?.materials ?? []).some(
      (material) => material.materialTypeID === demandTypeId,
    );

  const allocateTypes = (
    typeIdsToAllocate: Set<number>,
    demandByPriority: StockpileDemand[],
    preferActivityLocations = false,
  ) => {
    const allocationPairs = [
      ...[...typeIdsToAllocate].map((typeId) => ({
        stockTypeId: typeId,
        demandTypeId: typeId,
      })),
      ...[...typeIdsToAllocate].flatMap((demandTypeId) => {
        const compressedTypeId = planningData.compressibleTypes.get(demandTypeId);
        const reprocessableTypeIds = new Set([
          ...(compressedTypeId === undefined ? [] : [compressedTypeId]),
          ...(reprocessableTypeIdsByMaterial.get(demandTypeId) ?? []),
        ]);
        return [...reprocessableTypeIds].map((stockTypeId) => ({ stockTypeId, demandTypeId }));
      }),
    ];
    remainingDemand = demandByPriority.map((demand) => new Map(demand));
    for (const { stockTypeId, demandTypeId } of allocationPairs) {
      const stockIndexes = (stockIndexesByTypeId.get(stockTypeId) ?? []).filter(
        ({ item, index }) => {
          if (item.typeId !== stockTypeId || remainingStock[index] <= 0) return false;
          if (item.category !== "reactionformula") return true;
          return stockpiles.some(
            (stockpile, stockpileIndex) =>
              (remainingDemand[stockpileIndex].get(demandTypeId) ?? 0) > 0
              && getStockRootLocationId(item) === stockpile.locations.reactions,
          );
        },
      );
      for (const { stockpile, stockpileIndex } of [...stockpileEntries].sort(
        (left, right) =>
          (remainingDemand[right.stockpileIndex].get(demandTypeId) ?? 0)
            - (remainingDemand[left.stockpileIndex].get(demandTypeId) ?? 0)
          || left.stockpileIndex - right.stockpileIndex,
      )) {
        let remaining = remainingDemand[stockpileIndex].get(demandTypeId) ?? 0;
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
            || !canUseStockForStockpile(item, stockpileIndex)
            || (
              preferActivityLocations
              && item.category !== "reactionformula"
              && !isUsableIndustryProductionOutput(item)
            )
            || (
              preferActivityLocations
              && item.category !== "reactionformula"
              && stockLocationId !== undefined
              && !stockpileEntries[stockpileIndex].activityLocationIds.has(stockLocationId)
            )
            || !canUseFutureStock(index, stockpileIndex)
          ) continue;
          const allocation = allocationFor(
            stockTypeId,
            demandTypeId,
            stockpileIndex,
            remainingStock[index],
          );
          if (!allocation) continue;
          allocate(
            index,
            stockpileIndex,
            allocation.quantity,
            demandTypeId,
            allocation.demandQuantity,
          );
          remaining -= allocation.demandQuantity;
          if (remaining <= 0) break;
        }
      }
      for (const { item, index } of stockIndexes) {
        const stockLocationId = getStockRootLocationId(item);
        const localStockpiles = stockpileEntries
          .filter(
            ({ stockpile, stockpileIndex, activityLocationIds }) =>
              (remainingDemand[stockpileIndex].get(demandTypeId) ?? 0) > 0
              && stockLocationId !== undefined
              && (item.source !== "marketOrder" || stockLocationId === stockpile.locations.stock)
              && (item.category === "reactionformula"
                ? stockLocationId === stockpile.locations.reactions
                : activityLocationIds.has(stockLocationId)),
          )
          .sort(
            (left, right) =>
              (remainingDemand[right.stockpileIndex].get(demandTypeId) ?? 0)
                - (remainingDemand[left.stockpileIndex].get(demandTypeId) ?? 0)
              || left.stockpileIndex - right.stockpileIndex,
          );
        for (const { stockpileIndex } of localStockpiles) {
          if (remainingStock[index] <= 0) break;
          if (!canUseFutureStock(index, stockpileIndex)) continue;
          const allocation = allocationFor(
            stockTypeId,
            demandTypeId,
            stockpileIndex,
            remainingStock[index],
          );
          if (!allocation) continue;
          allocate(
            index,
            stockpileIndex,
            allocation.quantity,
            demandTypeId,
            allocation.demandQuantity,
          );
        }
      }
      for (const { stockpile, stockpileIndex } of stockpileEntries) {
        let remaining = remainingDemand[stockpileIndex].get(demandTypeId) ?? 0;
        if (remaining <= 0) continue;
        for (const { index } of stockIndexes) {
          if (remaining <= 0) break;
          const item = request.stock[index];
          if (!canUseFutureStock(index, stockpileIndex)) continue;
          const itemRootLocationId = getStockRootLocationId(item);
          if (
            !canUseStockForStockpile(item, stockpileIndex)
            || (
              preferActivityLocations
              && item.category !== "reactionformula"
              && itemRootLocationId !== undefined
              && !stockpileEntries[stockpileIndex].activityLocationIds.has(itemRootLocationId)
              && !isReprocessableSourceForDemand(stockTypeId, demandTypeId)
            )
            || (
              item.category === "reactionformula"
              && getStockRootLocationId(item) !== stockpiles[stockpileIndex].locations.reactions
            )
            || (
              item.source === "marketOrder"
              && getStockRootLocationId(item) !== stockpiles[stockpileIndex].locations.stock
            )
          ) continue;
          const allocation = allocationFor(
            stockTypeId,
            demandTypeId,
            stockpileIndex,
            remainingStock[index],
          );
          if (!allocation) continue;
          allocate(
            index,
            stockpileIndex,
            allocation.quantity,
            demandTypeId,
            allocation.demandQuantity,
          );
          remaining -= allocation.demandQuantity;
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
    fullJobInputDemandByStockpile: StockpileDemand[],
    reactionJobInputDemandByStockpile: StockpileDemand[],
  ) => {
    remainingStock = request.stock.map((item) =>
      isAllocatableOrdinaryStock(item) ? item.quantity : 0,
    );
    for (const allocation of allocations) allocation.clear();
    const standingDemandByStockpile = demandByStockpile.map((demand, stockpileIndex) => {
      const fullJobInputDemand = fullJobInputDemandByStockpile[stockpileIndex];
      return new Map(
        [...demand].map(([typeId, quantity]) => [
          typeId,
          Math.max(0, quantity - (fullJobInputDemand.get(typeId) ?? 0)),
        ]),
      );
    });
    const reservableJobInputDemandByStockpile = jobInputDemandByStockpile.map(
      (demand, stockpileIndex) => {
        const reservableDemand = new Map(demand);
        const reactionJobInputDemand = reactionJobInputDemandByStockpile[stockpileIndex];
        for (const [typeId, quantity] of fullJobInputDemandByStockpile[stockpileIndex]) {
          if (!buildableTypeIds.has(typeId) && !reactionJobInputDemand.has(typeId)) continue;
          reservableDemand.set(typeId, Math.max(reservableDemand.get(typeId) ?? 0, quantity));
        }
        return reservableDemand;
      },
    );
    allocateTypes(
      new Set(reservableJobInputDemandByStockpile.flatMap((demand) => [...demand.keys()])),
      reservableJobInputDemandByStockpile,
      true,
    );
    const allocatedJobInputDemandByStockpile = reservableJobInputDemandByStockpile.map(
      (demand, stockpileIndex) =>
        new Map(
          [...demand].map(([typeId, quantity]) => [
            typeId,
            Math.max(0, quantity - (remainingDemand[stockpileIndex].get(typeId) ?? 0)),
          ]),
        ),
    );
    allocateTypes(
      new Set(standingDemandByStockpile.flatMap((demand) => [...demand.keys()])),
      standingDemandByStockpile,
    );
    const blockedInputStock = stockpiles.map(() => [] as PlanStockItem[]);
    const remainingRemoteDemand = remainingDemand.map((demand) => new Map(demand));
    for (const [stockpileIndex, demand] of fullJobInputDemandByStockpile.entries()) {
      for (const [typeId, quantity] of demand) {
        const allocatedQuantity =
          allocatedJobInputDemandByStockpile[stockpileIndex].get(typeId) ?? 0;
        const blockedQuantity = Math.max(0, quantity - allocatedQuantity);
        if (blockedQuantity > 0) {
          remainingRemoteDemand[stockpileIndex].set(
            typeId,
            Math.max(remainingRemoteDemand[stockpileIndex].get(typeId) ?? 0, blockedQuantity),
          );
        }
        else {
          remainingRemoteDemand[stockpileIndex].delete(typeId);
        }
      }
    }
    for (const [stockIndex, item] of request.stock.entries()) {
      let surplusQuantity = remainingStock[stockIndex];
      if (surplusQuantity <= 0) continue;
      const candidates = stockpileEntries
        .filter(
          ({ stockpileIndex }) => (remainingRemoteDemand[stockpileIndex].get(item.typeId) ?? 0) > 0,
        )
        .sort((left, right) => {
          const leftIsRemote = Number(
            getStockRootLocationId(item) !== left.stockpile.locations.stock,
          );
          const rightIsRemote = Number(
            getStockRootLocationId(item) !== right.stockpile.locations.stock,
          );
          return (
            rightIsRemote - leftIsRemote
            || (remainingRemoteDemand[right.stockpileIndex].get(item.typeId) ?? 0)
              - (remainingRemoteDemand[left.stockpileIndex].get(item.typeId) ?? 0)
            || left.stockpileIndex - right.stockpileIndex
          );
        });
      for (const destination of candidates) {
        if (surplusQuantity <= 0) break;
        const demand = remainingRemoteDemand[destination.stockpileIndex].get(item.typeId) ?? 0;
        const quantity = Math.min(surplusQuantity, demand);
        blockedInputStock[destination.stockpileIndex].push({ ...item, quantity });
        remainingRemoteDemand[destination.stockpileIndex].set(item.typeId, demand - quantity);
        surplusQuantity -= quantity;
      }
    }
    const remainingDemandOnlyOutput = request.stock.map((item) =>
      !isBlueprintOrReactionFormula(item)
      && item.category === "item"
      && item.source !== "marketOrder"
      && isAvailableIndustryProductionOutput(item)
      && !isUsableIndustryProductionOutput(item)
      && !isAllocatableOrdinaryStock(item)
        ? item.quantity
        : 0,
    );
    for (const [stockIndex, item] of request.stock.entries()) {
      if (remainingDemandOnlyOutput[stockIndex] <= 0) continue;
      const stockpileIndexes = stockpileEntries
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
    return { stockpileStock: allocatedStockpileStock(), blockedInputStock };
  };

  const ordinaryStockpileAllocation = await measureProfiled(
    profiler,
    "ordinaryAllocation",
    async () =>
      allocateOrdinaryStock(
        demandByStockpile,
        jobInputDemandByStockpile,
        fullJobInputDemandByStockpile,
        reactionJobInputDemandByStockpile,
      ),
  );
  ledger = recordPlanningLedgerPhase(ledger, "ordinary", allocations, remainingDemand);
  const ordinaryStockpileStock = ordinaryStockpileAllocation.stockpileStock;
  const ordinaryStockpileResults = await measureProfiled(
    profiler,
    "ordinaryPasses",
    () =>
      Promise.all(
        stockpiles.map(async (stockpile, stockpileIndex) =>
          measureProfiled(
            profiler,
            `ordinaryPass.${stockpileIndex}`,
            () =>
              calculatePlanPass(
                {
                  ...request,
                  stockpiles: [],
                  items: stockpile.items,
                  stock: ordinaryStockpileStock[stockpileIndex],
                  reprocessingEfficiencies:
                    stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
                  groupAssignments: stockpile.groupAssignments,
                },
                planningData,
                { locations: activityLocations(stockpile) },
              ),
          ),
        ),
      ),
  );
  const actualDemandByStockpile: StockpileDemand[] = [];
  const actualJobInputDemandByStockpile: StockpileDemand[] = [];
  const actualFullJobInputDemandByStockpile: StockpileDemand[] = [];
  const ordinaryReactionJobInputDemandByStockpile: StockpileDemand[] = [];
  for (const result of ordinaryStockpileResults) {
    const { demand, jobInputDemand, fullJobInputDemand, reactionJobInputDemand } = getPlanDemand(
      result,
      getOrdinaryStockByTypeId(request.stock),
    );
    actualDemandByStockpile.push(demand);
    actualJobInputDemandByStockpile.push(jobInputDemand);
    actualFullJobInputDemandByStockpile.push(fullJobInputDemand);
    ordinaryReactionJobInputDemandByStockpile.push(reactionJobInputDemand);
  }
  const correctedStockpileAllocation = await measureProfiled(
    profiler,
    "correctedAllocation",
    async () =>
      allocateOrdinaryStock(
        actualDemandByStockpile,
        actualJobInputDemandByStockpile,
        actualFullJobInputDemandByStockpile,
        ordinaryReactionJobInputDemandByStockpile,
      ),
  );
  ledger = recordPlanningLedgerPhase(ledger, "corrected", allocations, remainingDemand);
  const correctedStockpileStock = correctedStockpileAllocation.stockpileStock;
  const specialDemandByStockpile: StockpileDemand[] = await measureProfiled(
    profiler,
    "specialPasses",
    () =>
      Promise.all(
        stockpiles.map(async (stockpile, stockpileIndex) => {
          const result = await measureProfiled(
            profiler,
            `specialPass.${stockpileIndex}`,
            () =>
              calculatePlanPass(
                {
                  ...request,
                  stockpiles: [],
                  items: stockpile.items,
                  stock: correctedStockpileStock[stockpileIndex],
                  reprocessingEfficiencies:
                    stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
                  groupAssignments: stockpile.groupAssignments,
                },
                planningData,
                { locations: activityLocations(stockpile) },
              ),
          );
          const demand = new Map<number, number>();
          for (const entry of result.lists.planItems) {
            if (entry.kind === "bpc") {
              demand.set(
                entry.typeId,
                Math.max(demand.get(entry.typeId) ?? 0, entry.neededQuantity),
              );
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
      ),
  );
  const specialTypeIds = new Set(specialDemandByStockpile.flatMap((demand) => [...demand.keys()]));
  for (const [index, item] of request.stock.entries()) {
    if (isBlueprintOrReactionFormula(item) && item.source !== "marketOrder") {
      remainingStock[index] = item.quantity;
    }
  }
  allocateTypes(specialTypeIds, specialDemandByStockpile);
  ledger = recordPlanningLedgerPhase(ledger, "special", allocations, remainingDemand);

  const specialAllocations = allocations.map((allocation) =>
    [...allocation.entries()].filter(([stockIndex]) =>
      isBlueprintOrReactionFormula(request.stock[stockIndex]),
    ),
  );
  const finalSpecialStock = allocatedStockpileStock();
  const finalDemandByStockpile: StockpileDemand[] = [];
  const finalJobInputDemandByStockpile: StockpileDemand[] = [];
  const finalFullJobInputDemandByStockpile: StockpileDemand[] = [];
  const finalReactionJobInputDemandByStockpile: StockpileDemand[] = [];
  await measureProfiled(
    profiler,
    "finalPasses",
    async () => {
      for (const [stockpileIndex, stockpile] of stockpiles.entries()) {
        const result = await measureProfiled(
          profiler,
          `finalPass.${stockpileIndex}`,
          () =>
            calculatePlanPass(
              {
                ...request,
                stockpiles: [],
                items: stockpile.items,
                stock: finalSpecialStock[stockpileIndex],
                reprocessingEfficiencies:
                  stockpile.reprocessingEfficiencies ?? request.reprocessingEfficiencies,
                groupAssignments: stockpile.groupAssignments,
              },
              planningData,
              { locations: activityLocations(stockpile) },
            ),
        );
        const { demand, jobInputDemand, fullJobInputDemand, reactionJobInputDemand } =
          getPlanDemand(result, getOrdinaryStockByTypeId(request.stock));
        finalDemandByStockpile.push(demand);
        finalJobInputDemandByStockpile.push(jobInputDemand);
        finalFullJobInputDemandByStockpile.push(fullJobInputDemand);
        finalReactionJobInputDemandByStockpile.push(reactionJobInputDemand);
      }
    },
  );
  const finalStockpileAllocation = await measureProfiled(
    profiler,
    "finalAllocation",
    async () =>
      allocateOrdinaryStock(
        finalDemandByStockpile,
        finalJobInputDemandByStockpile,
        finalFullJobInputDemandByStockpile,
        finalReactionJobInputDemandByStockpile,
      ),
  );
  for (const [stockpileIndex, allocation] of allocations.entries()) {
    for (const [stockIndex, quantity] of specialAllocations[stockpileIndex]) {
      allocation.set(stockIndex, quantity);
    }
  }
  ledger = recordPlanningLedgerPhase(ledger, "final", allocations, remainingDemand);

  return {
    stockpileStock: allocatedStockpileStock(),
    blockedInputStock: finalStockpileAllocation.blockedInputStock,
    ledger,
  };
}
