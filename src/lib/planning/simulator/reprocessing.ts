import type { PlanStockpile } from "@/lib/planning/types";
import type { SimulationContext } from "./context";
import type { IndustrySimulationResult, SimulationUnmetDemand } from "./industrySimulation";
import type { SimulationLedgerAccount, SimulationTransaction } from "./ledger";
import type { SimulatorInventory, SimulatorItemLot } from "./sourceLots";
import type { SimulationReprocessingJob, SimulationWarning, SimulatorRequestV1 } from "./types";

/** Result of applying selected reprocessing yields to residual material demand. */
export interface ReprocessingSettlementResult {
  jobs: SimulationReprocessingJob[];
  transactions: SimulationTransaction[];
  remainingDemands: SimulationUnmetDemand[];
  warnings: SimulationWarning[];
}

interface MutableDemand extends SimulationUnmetDemand {
  quantity: number;
}

interface ReprocessingCandidate {
  lot: SimulatorItemLot;
  stockpile: PlanStockpile;
  portionSize: number;
  efficiency: number;
  yieldsPerPortion: Array<{ typeId: number; quantity: number }>;
}

interface AllocatedYield {
  typeId: number;
  quantity: number;
  allocatedQuantity: number;
  allocations: Array<{ account: SimulationLedgerAccount; quantity: number }>;
}

function typeName(context: SimulationContext, typeId: number, language = "en"): string {
  const name = context.types.get(typeId)?.name;
  return name?.[language as keyof typeof name] ?? name?.en ?? `Type ${typeId}`;
}

function efficiencyFor(
  request: SimulatorRequestV1,
  stockpile: PlanStockpile,
  typeId: number,
): number {
  return (
    stockpile.reprocessingEfficiencies?.[String(typeId)]
    ?? request.reprocessingEfficiencies?.[String(typeId)]
    ?? 50
  );
}

function yieldsForPortions(
  candidate: Pick<ReprocessingCandidate, "efficiency" | "yieldsPerPortion">,
  portions: number,
): Array<{ typeId: number; quantity: number }> {
  return candidate.yieldsPerPortion.map((material) => ({
    typeId: material.typeId,
    quantity: Math.floor((material.quantity * portions * candidate.efficiency) / 100),
  }));
}

function allocateYields(
  stockpileId: string,
  yields: readonly { typeId: number; quantity: number }[],
  demands: MutableDemand[],
): AllocatedYield[] {
  return yields.map((material) => {
    let remainingYield = material.quantity;
    let allocatedQuantity = 0;
    const allocations: AllocatedYield["allocations"] = [];
    for (const demand of demands
      .filter(
        (candidate) =>
          candidate.purpose === "material"
          && candidate.source.stockpileId === stockpileId
          && candidate.account.typeId === material.typeId
          && candidate.quantity > 0,
      )
      .sort(
        (left, right) =>
          left.account.locationId - right.account.locationId
          || left.source.demandId.localeCompare(right.source.demandId),
      )) {
      if (remainingYield <= 0) break;
      const allocated = Math.min(remainingYield, demand.quantity);
      demand.quantity -= allocated;
      remainingYield -= allocated;
      allocatedQuantity += allocated;
      allocations.push({ account: demand.account, quantity: allocated });
    }
    return { ...material, allocatedQuantity, allocations };
  });
}

function candidateScore(
  candidate: ReprocessingCandidate,
  availableQuantity: number,
  demands: readonly MutableDemand[],
): { portions: number; covered: number; surplus: number; haulVolume: number } | undefined {
  const availablePortions = Math.floor(availableQuantity / candidate.portionSize);
  if (availablePortions <= 0) return undefined;
  let usefulPortions = 0;
  for (const material of candidate.yieldsPerPortion) {
    const requirement = demands
      .filter(
        (demand) =>
          demand.purpose === "material"
          && demand.source.stockpileId === candidate.stockpile.id
          && demand.account.typeId === material.typeId,
      )
      .reduce((total, demand) => total + demand.quantity, 0);
    const perPortion = (material.quantity * candidate.efficiency) / 100;
    if (requirement > 0 && perPortion > 0) {
      usefulPortions = Math.max(usefulPortions, Math.ceil(requirement / perPortion));
    }
  }
  const portions = Math.min(availablePortions, usefulPortions);
  if (portions <= 0) return undefined;
  const yields = yieldsForPortions(candidate, portions);
  let covered = 0;
  let surplus = 0;
  for (const material of yields) {
    const requirement = demands
      .filter(
        (demand) =>
          demand.purpose === "material"
          && demand.source.stockpileId === candidate.stockpile.id
          && demand.account.typeId === material.typeId,
      )
      .reduce((total, demand) => total + demand.quantity, 0);
    covered += Math.min(requirement, material.quantity);
    surplus += Math.max(0, material.quantity - requirement);
  }
  if (covered <= 0) return undefined;
  return {
    portions,
    covered,
    surplus,
    haulVolume:
      candidate.lot.locationId === candidate.stockpile.locations.reprocessing
        ? 0
        : portions * candidate.portionSize * candidate.lot.unitVolume,
  };
}

/** Settles residual material demand from commitments and eligible unreserved owned assets. */
export function settleReprocessing(
  request: SimulatorRequestV1,
  context: SimulationContext,
  inventory: SimulatorInventory,
  industry: IndustrySimulationResult,
): ReprocessingSettlementResult {
  const demands: MutableDemand[] = industry.unmetDemands.map((demand) => ({ ...demand }));
  const jobs: SimulationReprocessingJob[] = [];
  const transactions: SimulationTransaction[] = [];
  const warnings: SimulationWarning[] = [];
  let sequence = 0;
  const stockpileById = new Map(request.stockpiles.map((stockpile) => [stockpile.id, stockpile]));
  const reservationTransactions = industry.transactions.filter(
    (transaction): transaction is Extract<SimulationTransaction, { kind: "source-reservation" }> =>
      transaction.kind === "source-reservation" && transaction.demandActivity === "reprocessing",
  );

  const createJob = (
    stockpile: PlanStockpile,
    sourceTypeId: number,
    sourceQuantity: number,
    state: "local" | "after-hauling" | "after-purchase",
    sourceLotId?: string,
    providedJobId?: string,
  ) => {
    const portionSize = Math.max(1, context.types.get(sourceTypeId)?.portionSize ?? 1);
    const portionCount = Math.floor(sourceQuantity / portionSize);
    if (portionCount <= 0) return;
    const efficiency = efficiencyFor(request, stockpile, sourceTypeId);
    const materials = context.typeMaterials.get(sourceTypeId)?.materials ?? [];
    const rawYields = materials.map((material) => ({
      typeId: material.materialTypeID,
      quantity: Math.floor((material.quantity * portionCount * efficiency) / 100),
    }));
    const allocatedYields = allocateYields(stockpile.id, rawYields, demands);
    const jobId = providedJobId ?? `reprocessing:${stockpile.id}:${sourceTypeId}:${sequence++}`;
    jobs.push({
      jobId,
      stockpileId: stockpile.id,
      locationId: stockpile.locations.reprocessing,
      sourceLotId,
      sourceTypeId,
      sourceTypeName: typeName(context, sourceTypeId, request.language),
      sourceQuantity: portionCount * portionSize,
      portionCount,
      efficiency,
      state,
      yields: allocatedYields.map((material) => ({
        typeId: material.typeId,
        quantity: material.quantity,
        allocatedQuantity: material.allocatedQuantity,
        typeName: typeName(context, material.typeId, request.language),
      })),
    });
    for (const material of allocatedYields) {
      for (const allocation of material.allocations) {
        transactions.push({
          id: `reprocessing-output:${sequence++}`,
          kind: "reprocessing-output",
          account: {
            locationId: stockpile.locations.reprocessing,
            typeId: material.typeId,
          },
          destinationAccount: allocation.account,
          quantity: allocation.quantity,
          reprocessingJobId: jobId,
        });
      }
      const surplus = material.quantity - material.allocatedQuantity;
      if (surplus > 0) {
        transactions.push({
          id: `reprocessing-surplus:${sequence++}`,
          kind: "reprocessing-output",
          account: {
            locationId: stockpile.locations.reprocessing,
            typeId: material.typeId,
          },
          quantity: surplus,
          reprocessingJobId: jobId,
        });
      }
    }
  };

  const committedByStockpileAndType = new Map<
    string,
    { stockpile: PlanStockpile; typeId: number; local: number; remote: number; purchase: number }
  >();
  for (const reservation of reservationTransactions) {
    const stockpile = stockpileById.get(reservation.stockpileId ?? "");
    if (!stockpile) continue;
    const key = `${stockpile.id}:${reservation.account.typeId}`;
    const committed = committedByStockpileAndType.get(key) ?? {
      stockpile,
      typeId: reservation.account.typeId,
      local: 0,
      remote: 0,
      purchase: 0,
    };
    if (reservation.horizon === "now") committed.local += reservation.quantity;
    else committed.remote += reservation.quantity;
    committedByStockpileAndType.set(key, committed);
  }
  for (const commitment of demands.filter(
    (demand) => demand.purpose === "reprocessing-input" && demand.quantity > 0,
  )) {
    const stockpile = stockpileById.get(commitment.source.stockpileId);
    if (!stockpile) continue;
    const key = `${stockpile.id}:${commitment.account.typeId}`;
    const committed = committedByStockpileAndType.get(key) ?? {
      stockpile,
      typeId: commitment.account.typeId,
      local: 0,
      remote: 0,
      purchase: 0,
    };
    committed.purchase += commitment.quantity;
    committedByStockpileAndType.set(key, committed);
  }
  for (const committed of committedByStockpileAndType.values()) {
    const portionSize = Math.max(1, context.types.get(committed.typeId)?.portionSize ?? 1);
    const localPortions = Math.floor(committed.local / portionSize);
    const hauledPortions = Math.floor((committed.local + committed.remote) / portionSize);
    const purchasedPortions = Math.floor(
      (committed.local + committed.remote + committed.purchase) / portionSize,
    );
    createJob(committed.stockpile, committed.typeId, localPortions * portionSize, "local");
    createJob(
      committed.stockpile,
      committed.typeId,
      (hauledPortions - localPortions) * portionSize,
      "after-hauling",
    );
    createJob(
      committed.stockpile,
      committed.typeId,
      (purchasedPortions - hauledPortions) * portionSize,
      "after-purchase",
    );
  }

  const candidates: ReprocessingCandidate[] = request.stockpiles.flatMap((stockpile) =>
    inventory.itemLots.flatMap((lot) => {
      const available = industry.allocator.remainingItemQuantity(lot.lotId);
      const materials = context.typeMaterials.get(lot.typeId)?.materials ?? [];
      const portionSize = Math.max(1, context.types.get(lot.typeId)?.portionSize ?? 1);
      return lot.eligibleForReprocessing && available >= portionSize && materials.length > 0
        ? [
            {
              lot,
              stockpile,
              portionSize,
              efficiency: efficiencyFor(request, stockpile, lot.typeId),
              yieldsPerPortion: materials.map((material) => ({
                typeId: material.materialTypeID,
                quantity: material.quantity,
              })),
            },
          ]
        : [];
    }),
  );

  for (;;) {
    const ranked = candidates
      .flatMap((candidate) => {
        const available = industry.allocator.remainingItemQuantity(candidate.lot.lotId);
        const score = candidateScore(candidate, available, demands);
        return score === undefined ? [] : [{ candidate, score }];
      })
      .sort(
        (left, right) =>
          left.score.haulVolume - right.score.haulVolume
          || left.score.surplus - right.score.surplus
          || right.score.covered - left.score.covered
          || left.candidate.lot.lotId.localeCompare(right.candidate.lot.lotId),
      );
    if (ranked.length === 0) break;
    const selected = ranked[0];
    const { candidate, score } = selected;
    const sourceQuantity = score.portions * candidate.portionSize;
    const account: SimulationLedgerAccount = {
      locationId: candidate.stockpile.locations.reprocessing,
      typeId: candidate.lot.typeId,
    };
    const jobId = `reprocessing-owned:${candidate.stockpile.id}:${candidate.lot.lotId}:${sequence}`;
    const claimed = industry.allocator.claimReprocessingLot(
      candidate.lot.lotId,
      sourceQuantity,
      candidate.stockpile.locations.reprocessing,
      account,
      jobId,
    );
    if (claimed < candidate.portionSize) {
      candidates.splice(candidates.indexOf(candidate), 1);
      continue;
    }
    createJob(
      candidate.stockpile,
      candidate.lot.typeId,
      claimed,
      candidate.lot.locationId === candidate.stockpile.locations.reprocessing
        ? "local"
        : "after-hauling",
      candidate.lot.lotId,
      jobId,
    );
  }

  return {
    jobs,
    transactions,
    remainingDemands: demands.filter((demand) => demand.quantity > 0),
    warnings,
  };
}
