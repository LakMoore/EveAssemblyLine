import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlanningLedgerConservation,
  createPlanningLedger,
  getFinalPlanningLedgerTransfers,
  recordPlanningLedgerPhase,
  type PlanningLedgerAllocation,
} from "./planningLedger";

type AllocationScenario = {
  sourceQuantities: number[];
  sourceLots: Parameters<typeof createPlanningLedger>[1];
  allocationsByStockpile: Map<number, number>[];
  stockpileDestinationLocationIds: number[];
};

/** Builds a scenario where two stockpiles share a single located stock lot. */
function createSharedStockScenario(): AllocationScenario {
  return {
    sourceQuantities: [80, 30],
    sourceLots: [
      { typeId: 34, sourceLocationId: 100 },
      { typeId: 35, sourceLocationId: 200 },
    ],
    allocationsByStockpile: [
      new Map([[0, 50]]),
      new Map([
        [0, 30],
        [1, 30],
      ]),
    ],
    stockpileDestinationLocationIds: [300, 400],
  };
}

/** Builds a balanced multi-stockpile scenario from source quantities and a rotation offset. */
function createRotatedAllocationScenario(
  sourceQuantities: number[],
  stockpileCount: number,
  rotation: number,
): AllocationScenario {
  const allocationsByStockpile = Array.from(
    { length: stockpileCount },
    () => new Map<number, number>(),
  );
  for (const [stockIndex, quantity] of sourceQuantities.entries()) {
    const stockpileIndex = (stockIndex + rotation) % stockpileCount;
    allocationsByStockpile[stockpileIndex].set(stockIndex, quantity);
  }
  return {
    sourceQuantities,
    sourceLots: sourceQuantities.map((_, stockIndex) => ({ typeId: stockIndex + 1 })),
    allocationsByStockpile,
    stockpileDestinationLocationIds: Array.from(
      { length: stockpileCount },
      (_, stockpileIndex) => stockpileIndex + 100,
    ),
  };
}

/** Flattens mutable test allocations into the ledger's immutable value shape. */
function flattenAllocations(
  allocationsByStockpile: ReadonlyArray<ReadonlyMap<number, number>>,
  sourceLots: Parameters<typeof createPlanningLedger>[1],
  stockpileDestinationLocationIds: readonly number[],
): PlanningLedgerAllocation[] {
  return allocationsByStockpile.flatMap((allocations, stockpileIndex) =>
    [...allocations].map(([stockIndex, quantity]) => ({
      stockIndex,
      stockpileIndex,
      quantity,
      ...sourceLots[stockIndex],
      destinationLocationId: stockpileDestinationLocationIds[stockpileIndex],
      purpose: "stockpile-reservation" as const,
    })),
  );
}

void test("captures independent immutable phase outputs", () => {
  const scenario = createSharedStockScenario();
  const ledger = createPlanningLedger(
    scenario.sourceQuantities,
    scenario.sourceLots,
    scenario.stockpileDestinationLocationIds,
  );
  const recorded = recordPlanningLedgerPhase(
    ledger,
    "ordinary",
    scenario.allocationsByStockpile,
    [new Map([[34, 20]]), new Map([[35, 10]])],
  );

  scenario.sourceQuantities[0] = 0;
  scenario.allocationsByStockpile[0].set(0, 1);

  assert.deepEqual(recorded.sourceQuantities, [80, 30]);
  assert.deepEqual(
    recorded.phases[0].allocations,
    [
      {
        stockIndex: 0,
        stockpileIndex: 0,
        quantity: 50,
        typeId: 34,
        sourceLocationId: 100,
        destinationLocationId: 300,
        purpose: "stockpile-reservation",
      },
      {
        stockIndex: 0,
        stockpileIndex: 1,
        quantity: 30,
        typeId: 34,
        sourceLocationId: 100,
        destinationLocationId: 400,
        purpose: "stockpile-reservation",
      },
      {
        stockIndex: 1,
        stockpileIndex: 1,
        quantity: 30,
        typeId: 35,
        sourceLocationId: 200,
        destinationLocationId: 400,
        purpose: "stockpile-reservation",
      },
    ],
  );
  assert.deepEqual(
    recorded.phases[0].remainingDemand,
    [
      { stockpileIndex: 0, typeId: 34, quantity: 20 },
      { stockpileIndex: 1, typeId: 35, quantity: 10 },
    ],
  );
  assert.equal(Object.isFrozen(recorded), true);
  assert.equal(Object.isFrozen(recorded.phases[0]), true);
  assert.equal(Object.isFrozen(recorded.phases[0].allocations), true);
  assert.deepEqual(getFinalPlanningLedgerTransfers(recorded), recorded.phases[0].allocations);
});

void test("rejects allocations that exceed an original source lot", () => {
  assert.throws(
    () =>
      assertPlanningLedgerConservation(
        [10],
        2,
        [
          { stockIndex: 0, stockpileIndex: 0, quantity: 6 },
          { stockIndex: 0, stockpileIndex: 1, quantity: 5 },
        ],
      ),
    /over-allocated stock lot 0/,
  );
});

void test("preserves conservation across generated stockpile allocation scenarios", () => {
  const sourceQuantities = [1, 2, 5, 13, 21, 34];
  for (const stockpileCount of [1, 2, 3]) {
    for (let rotation = 0; rotation < stockpileCount; rotation += 1) {
      const scenario = createRotatedAllocationScenario(sourceQuantities, stockpileCount, rotation);
      const ledger = recordPlanningLedgerPhase(
        createPlanningLedger(
          scenario.sourceQuantities,
          scenario.sourceLots,
          scenario.stockpileDestinationLocationIds,
        ),
        `generated-${stockpileCount}-${rotation}`,
        scenario.allocationsByStockpile,
        Array.from({ length: stockpileCount }, () => new Map()),
      );
      assert.deepEqual(
        ledger.phases[0].allocations,
        flattenAllocations(
          scenario.allocationsByStockpile,
          scenario.sourceLots,
          scenario.stockpileDestinationLocationIds,
        ),
      );
    }
  }
});
