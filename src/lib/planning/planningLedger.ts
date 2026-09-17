/** One source-lot allocation captured at the end of a planning phase. */
export type PlanningLedgerAllocation = Readonly<{
  stockIndex: number;
  stockpileIndex: number;
  quantity: number;
}>;

/** Immutable result of one allocation phase. */
export type PlanningLedgerPhase = Readonly<{
  name: string;
  allocations: readonly PlanningLedgerAllocation[];
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
): PlanningLedger {
  if (allocationsByStockpile.length !== ledger.stockpileCount) {
    throw new Error(`Planning ledger phase ${name} has an unexpected stockpile count.`);
  }
  const allocations = allocationsByStockpile.flatMap((allocations, stockpileIndex) =>
    [...allocations].map(([stockIndex, quantity]) => ({ stockIndex, stockpileIndex, quantity })),
  );
  assertPlanningLedgerConservation(ledger.sourceQuantities, ledger.stockpileCount, allocations);
  const phase = Object.freeze({
    name,
    allocations: Object.freeze(allocations.map((allocation) => Object.freeze(allocation))),
  });
  return Object.freeze({
    ...ledger,
    phases: Object.freeze([...ledger.phases, phase]),
  });
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
