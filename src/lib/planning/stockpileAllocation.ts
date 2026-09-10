import type { PlanningData } from "./planEngine";
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
};

export type StockpileAllocation = {
  stockpileStock: PlanStockItem[][];
  blockedInputStock: PlanStockItem[][];
};

type CalculatePlanPass = (
  request: PlannerRequest,
  planningData: PlanningData,
  options?: { locations?: PlanActivityLocations },
) => Promise<PlanCalculation>;

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
  return { demand, jobInputDemand, fullJobInputDemand };
}

/** Reserves ordinary stock globally so remote stockpiles cannot consume local lots. */
export async function allocateStockpileStock(
  request: PlannerRequest,
  stockpiles: NonNullable<PlannerRequest["stockpiles"]>,
  planningData: PlanningData,
  calculatePlanPass: CalculatePlanPass,
  futureStockIndexes = new Set<number>(),
): Promise<StockpileAllocation> {
  if (stockpiles.length === 1) {
    return {
      stockpileStock: [request.stock.map((item) => ({ ...item }))],
      blockedInputStock: [[]],
    };
  }
  const stockpileEntries = stockpiles.map((stockpile, stockpileIndex) => ({
    stockpile,
    stockpileIndex,
    activityLocationIds: stockpileActivityLocations(stockpile),
  }));
  const stockpileDemandResults = await Promise.all(
    stockpiles.map(async (stockpile) => {
      const result = await calculatePlanPass(
        {
          ...request,
          stockpiles: [],
          items: stockpile.items,
          stock: [],
          groupAssignments: stockpile.groupAssignments,
        },
        planningData,
        { locations: activityLocations(stockpile) },
      );
      const { demand, jobInputDemand, fullJobInputDemand } = getPlanDemand(
        result,
        getOrdinaryStockByTypeId(request.stock),
      );
      return {
        demand: new Map([...demand].filter(([, quantity]) => quantity > 0)),
        jobInputDemand: new Map([...jobInputDemand].filter(([, quantity]) => quantity > 0)),
        fullJobInputDemand: new Map([...fullJobInputDemand].filter(([, quantity]) => quantity > 0)),
      };
    }),
  );
  const demandByStockpile = stockpileDemandResults.map(({ demand }) => demand);
  const jobInputDemandByStockpile = stockpileDemandResults.map(
    ({ jobInputDemand }) => jobInputDemand,
  );
  const fullJobInputDemandByStockpile = stockpileDemandResults.map(
    ({ fullJobInputDemand }) => fullJobInputDemand,
  );
  let remainingDemand = demandByStockpile.map((demand) => new Map(demand));
  let remainingStock = request.stock.map((item) =>
    isAllocatableOrdinaryStock(item) ? item.quantity : 0,
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
      for (const { stockpile, stockpileIndex } of [...stockpileEntries].sort(
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
              && !isUsableIndustryProductionOutput(item)
            )
            || (
              preferActivityLocations
              && item.category !== "reactionformula"
              && stockLocationId !== undefined
              && !stockpileActivityLocations(stockpile).has(stockLocationId)
            )
            || !canUseFutureStock(index, stockpileIndex)
          ) continue;
          allocate(index, stockpileIndex, Math.min(remainingStock[index], remaining));
        }
      }
      for (const { item, index } of stockIndexes) {
        const stockLocationId = getStockRootLocationId(item);
        const localStockpiles = stockpileEntries
          .filter(
            ({ stockpile, stockpileIndex, activityLocationIds }) =>
              (remainingDemand[stockpileIndex].get(typeId) ?? 0) > 0
              && stockLocationId !== undefined
              && (item.source !== "marketOrder" || stockLocationId === stockpile.locations.stock)
              && (item.category === "reactionformula"
                ? stockLocationId === stockpile.locations.reactions
                : activityLocationIds.has(stockLocationId)),
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
      for (const { stockpile, stockpileIndex } of stockpileEntries) {
        let remaining = remainingDemand[stockpileIndex].get(typeId) ?? 0;
        if (remaining <= 0) continue;
        for (const { index } of stockIndexes) {
          if (remaining <= 0) break;
          const item = request.stock[index];
          if (!canUseFutureStock(index, stockpileIndex)) continue;
          if (
            preferActivityLocations
            && item.category !== "reactionformula"
            && getStockRootLocationId(item) !== undefined
            && !stockpileActivityLocations(stockpiles[stockpileIndex]).has(
              getStockRootLocationId(item)!,
            )
          ) continue;
          if (
            item.category === "reactionformula"
            && getStockRootLocationId(item) !== stockpiles[stockpileIndex].locations.reactions
          ) continue;
          if (
            item.source === "marketOrder"
            && getStockRootLocationId(item) !== stockpiles[stockpileIndex].locations.stock
          ) continue;
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
    fullJobInputDemandByStockpile: StockpileDemand[],
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
    const blockedJobInputDemandByStockpile = fullJobInputDemandByStockpile.map(
      (fullJobInputDemand, stockpileIndex) => {
        const installableJobInputDemand = jobInputDemandByStockpile[stockpileIndex];
        return new Map(
          [...fullJobInputDemand]
            .map(
              ([typeId, quantity]) =>
                [
                  typeId,
                  Math.max(0, quantity - (installableJobInputDemand.get(typeId) ?? 0)),
                ] as const,
            )
            .filter(([, quantity]) => quantity > 0),
        );
      },
    );
    allocateTypes(
      new Set(jobInputDemandByStockpile.flatMap((demand) => [...demand.keys()])),
      jobInputDemandByStockpile,
      true,
    );
    const allocatedJobInputDemandByStockpile = jobInputDemandByStockpile.map(
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

  const ordinaryStockpileAllocation = allocateOrdinaryStock(
    demandByStockpile,
    jobInputDemandByStockpile,
    fullJobInputDemandByStockpile,
  );
  const ordinaryStockpileStock = ordinaryStockpileAllocation.stockpileStock;
  const ordinaryStockpileResults = await Promise.all(
    stockpiles.map(async (stockpile, stockpileIndex) =>
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
  );
  const actualDemandByStockpile: StockpileDemand[] = [];
  const actualJobInputDemandByStockpile: StockpileDemand[] = [];
  const actualFullJobInputDemandByStockpile: StockpileDemand[] = [];
  for (const result of ordinaryStockpileResults) {
    const { demand, jobInputDemand, fullJobInputDemand } = getPlanDemand(
      result,
      getOrdinaryStockByTypeId(request.stock),
    );
    actualDemandByStockpile.push(demand);
    actualJobInputDemandByStockpile.push(jobInputDemand);
    actualFullJobInputDemandByStockpile.push(fullJobInputDemand);
  }
  const correctedStockpileAllocation = allocateOrdinaryStock(
    actualDemandByStockpile,
    actualJobInputDemandByStockpile,
    actualFullJobInputDemandByStockpile,
  );
  const correctedStockpileStock = correctedStockpileAllocation.stockpileStock;
  const specialDemandByStockpile: StockpileDemand[] = await Promise.all(
    stockpiles.map(async (stockpile, stockpileIndex) => {
      const result = await calculatePlanPass(
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

  const specialAllocations = allocations.map((allocation) =>
    [...allocation.entries()].filter(([stockIndex]) =>
      isBlueprintOrReactionFormula(request.stock[stockIndex]),
    ),
  );
  const finalSpecialStock = allocatedStockpileStock();
  const finalDemandByStockpile: StockpileDemand[] = [];
  const finalJobInputDemandByStockpile: StockpileDemand[] = [];
  const finalFullJobInputDemandByStockpile: StockpileDemand[] = [];
  for (const [stockpileIndex, stockpile] of stockpiles.entries()) {
    const result = await calculatePlanPass(
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
    );
    const { demand, jobInputDemand, fullJobInputDemand } = getPlanDemand(
      result,
      getOrdinaryStockByTypeId(request.stock),
    );
    finalDemandByStockpile.push(demand);
    finalJobInputDemandByStockpile.push(jobInputDemand);
    finalFullJobInputDemandByStockpile.push(fullJobInputDemand);
  }
  const finalStockpileAllocation = allocateOrdinaryStock(
    finalDemandByStockpile,
    finalJobInputDemandByStockpile,
    finalFullJobInputDemandByStockpile,
  );
  for (const [stockpileIndex, allocation] of allocations.entries()) {
    for (const [stockIndex, quantity] of specialAllocations[stockpileIndex]) {
      allocation.set(stockIndex, quantity);
    }
  }

  return {
    stockpileStock: allocatedStockpileStock(),
    blockedInputStock: finalStockpileAllocation.blockedInputStock,
  };
}
