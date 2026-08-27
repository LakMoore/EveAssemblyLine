import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateReprocessing,
  type ReprocessingCandidate,
  reprocessCommittedPurchases,
} from "./reprocessStock";

function candidate(overrides: Partial<ReprocessingCandidate> = {}): ReprocessingCandidate {
  return {
    typeId: 62516,
    availableQuantity: 1_000,
    portionSize: 100,
    efficiency: 100,
    yields: new Map([[34, 400]]),
    source: "owned",
    volumePerUnit: 0.01,
    ...overrides,
  };
}

test("does not allocate reprocessable stock without a material shortage", () => {
  const result = allocateReprocessing(new Map(), [candidate()]);

  assert.deepEqual(result.consumedOwned, new Map());
  assert.deepEqual(result.producedMaterials, new Map());
});

test("allocates only the complete portions needed to cover a shortage", () => {
  const result = allocateReprocessing(new Map([[34, 500]]), [candidate()]);

  assert.deepEqual(result.consumedOwned, new Map([[62516, 200]]));
  assert.deepEqual(result.producedMaterials, new Map([[34, 800]]));
  assert.deepEqual(result.remainingRequirements, new Map([[34, 0]]));
});

test("uses mixed yields to satisfy several shortages", () => {
  const result = allocateReprocessing(
    new Map([
      [34, 150],
      [35, 110],
    ]),
    [
      candidate({
        typeId: 62520,
        yields: new Map([
          [34, 150],
          [35, 110],
        ]),
      }),
    ],
  );

  assert.deepEqual(result.consumedOwned, new Map([[62520, 100]]));
  assert.deepEqual(
    result.producedMaterials,
    new Map([
      [34, 150],
      [35, 110],
    ]),
  );
});

test("prefers stock already at the reprocessing location", () => {
  const result = allocateReprocessing(
    new Map([[34, 400]]),
    [
      candidate({ typeId: 62520, volumePerUnit: 0.005 }),
      candidate({ quantityAtReprocessingLocation: 100 }),
    ],
  );

  assert.deepEqual(result.consumedOwned, new Map([[62516, 100]]));
  assert.deepEqual(result.readyToReprocess, new Map([[62516, 100]]));
});

test("rescores candidates after exhausting locally held portions", () => {
  const result = allocateReprocessing(
    new Map([[34, 800]]),
    [
      candidate({ quantityAtReprocessingLocation: 100, volumePerUnit: 1 }),
      candidate({ typeId: 62520, volumePerUnit: 0.005 }),
    ],
  );

  assert.deepEqual(
    result.consumedOwned,
    new Map([
      [62516, 100],
      [62520, 100],
    ]),
  );
});

test("prioritizes owned candidates when mixed sources are supplied", () => {
  const result = allocateReprocessing(
    new Map([[34, 1_000]]),
    [
      candidate({ availableQuantity: 200 }),
      candidate({ typeId: 62520, availableQuantity: 1_000, source: "purchase" }),
    ],
  );

  assert.deepEqual(result.consumedOwned, new Map([[62516, 200]]));
  assert.deepEqual(result.consumedPurchases, new Map([[62520, 100]]));
});

test("reprocesses every complete portion of a committed purchase", () => {
  const result = reprocessCommittedPurchases([
    candidate({ availableQuantity: 250, source: "purchase" }),
  ]);

  assert.deepEqual(result.purchased, new Map([[62516, 250]]));
  assert.deepEqual(result.producedMaterials, new Map([[34, 800]]));
});

test("aggregates fractional gas yields before rounding to whole units", () => {
  const gas = candidate({
    typeId: 62377,
    availableQuantity: 106,
    portionSize: 1,
    efficiency: 95,
    yields: new Map([[28694, 1]]),
    source: "purchase",
  });

  const committed = reprocessCommittedPurchases([gas]);
  const allocated = allocateReprocessing(new Map([[28694, 100]]), [{ ...gas, source: "owned" }]);

  assert.deepEqual(committed.producedMaterials, new Map([[28694, 100]]));
  assert.deepEqual(allocated.consumedOwned, new Map([[62377, 106]]));
  assert.deepEqual(allocated.producedMaterials, new Map([[28694, 100]]));
  assert.deepEqual(allocated.remainingRequirements, new Map([[28694, 0]]));
});
