/** One source-lot allocation captured at the end of a planning phase. */
export type PlanningLedgerAllocation = Readonly<{
  stockIndex: number;
  stockpileIndex: number;
  quantity: number;
}>;

/** Unfulfilled demand recorded for one stockpile at the end of a planning phase. */
export type PlanningLedgerDemand = Readonly<{
  stockpileIndex: number;
  typeId: number;
  quantity: number;
}>;

/** Immutable result of one allocation phase. */
export type PlanningLedgerPhase = Readonly<{
  name: string;
  allocations: readonly PlanningLedgerAllocation[];
  remainingDemand: readonly PlanningLedgerDemand[];
}>;

/** Immutable audit trail for allocations made from the request's original stock lots. */
export type PlanningLedger = Readonly<{
  sourceQuantities: readonly number[];
  stockpileCount: number;
  phases: readonly PlanningLedgerPhase[];
}>;

/** Creates the canonical ledger used to audit stockpile allocation phases. */
export function createPlanningLedger(
  sourceQuantities: readonly number[],
  stockpileCount: number,
): PlanningLedger {
  if (!Number.isInteger(stockpileCount) || stockpileCount <= 0) {
    throw new Error("Planning ledger requires at least one stockpile.");
  }
  if (sourceQuantities.some((quantity) => !Number.isFinite(quantity) || quantity < 0)) {
    throw new Error("Planning ledger source quantities must be non-negative finite numbers.");
  }
  return Object.freeze({
    sourceQuantities: Object.freeze([...sourceQuantities]),
    stockpileCount,
    phases: Object.freeze([]),
  });
}

/** Captures immutable allocations for a completed phase and verifies lot conservation. */
export function recordPlanningLedgerPhase(
  ledger: PlanningLedger,
  name: string,
  allocationsByStockpile: ReadonlyArray<ReadonlyMap<number, number>>,
  remainingDemandByStockpile: ReadonlyArray<ReadonlyMap<number, number>>,
): PlanningLedger {
  if (
    allocationsByStockpile.length !== ledger.stockpileCount
    || remainingDemandByStockpile.length !== ledger.stockpileCount
  ) {
    throw new Error(`Planning ledger phase ${name} has an unexpected stockpile count.`);
  }
  const allocations = allocationsByStockpile.flatMap((allocations, stockpileIndex) =>
    [...allocations].map(([stockIndex, quantity]) => ({ stockIndex, stockpileIndex, quantity })),
  );
  const remainingDemand = remainingDemandByStockpile.flatMap((demand, stockpileIndex) =>
    [...demand].map(([typeId, quantity]) => ({ typeId, stockpileIndex, quantity })),
  );
  assertPlanningLedgerConservation(ledger.sourceQuantities, ledger.stockpileCount, allocations);
  assertPlanningLedgerDemand(ledger.stockpileCount, remainingDemand);
  const phase = Object.freeze({
    name,
    allocations: Object.freeze(allocations.map((allocation) => Object.freeze(allocation))),
    remainingDemand: Object.freeze(remainingDemand.map((demand) => Object.freeze(demand))),
  });
  return Object.freeze({
    ...ledger,
    phases: Object.freeze([...ledger.phases, phase]),
  });
}

/** Verifies that demand snapshots contain valid stockpile and type identifiers. */
function assertPlanningLedgerDemand(
  stockpileCount: number,
  demands: readonly PlanningLedgerDemand[],
): void {
  for (const demand of demands) {
    if (
      !Number.isInteger(demand.stockpileIndex)
      || demand.stockpileIndex < 0
      || demand.stockpileIndex >= stockpileCount
      || !Number.isInteger(demand.typeId)
      || demand.typeId <= 0
      || !Number.isFinite(demand.quantity)
      || demand.quantity < 0
    ) {
      throw new Error("Planning ledger contains invalid remaining demand.");
    }
  }
}

/** Verifies that one phase neither creates nor over-allocates any source lot. */
export function assertPlanningLedgerConservation(
  sourceQuantities: readonly number[],
  stockpileCount: number,
  allocations: readonly PlanningLedgerAllocation[],
): void {
  const allocatedByStockIndex = new Map<number, number>();
  for (const allocation of allocations) {
    if (
      !Number.isInteger(allocation.stockIndex)
      || allocation.stockIndex < 0
      || allocation.stockIndex >= sourceQuantities.length
      || !Number.isInteger(allocation.stockpileIndex)
      || allocation.stockpileIndex < 0
      || allocation.stockpileIndex >= stockpileCount
      || !Number.isFinite(allocation.quantity)
      || allocation.quantity < 0
    ) {
      throw new Error("Planning ledger contains an invalid allocation.");
    }
    allocatedByStockIndex.set(
      allocation.stockIndex,
      (allocatedByStockIndex.get(allocation.stockIndex) ?? 0) + allocation.quantity,
    );
  }
  for (const [stockIndex, allocatedQuantity] of allocatedByStockIndex) {
    if (allocatedQuantity > sourceQuantities[stockIndex]) {
      throw new Error(`Planning ledger over-allocated stock lot ${stockIndex}.`);
    }
  }
}
