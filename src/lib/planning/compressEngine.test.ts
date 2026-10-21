import assert from "node:assert/strict";
import test from "node:test";
import {
  canCoverDemand,
  compressMaterials,
  CompressionSolveError,
  maximumDemandRuns,
  type CompressionCandidate,
} from "./compressEngine";

const prices = {
  volumes: new Map([
    [34, 1],
    [35, 1],
    [62516, 1],
    [62520, 1],
    [62377, 0.1],
  ]),
  buyPrices: new Map([
    [34, 10],
    [35, 10],
    [28694, 10],
  ]),
  surplusOrders: new Map<number, { price: number; volumeRemain: number }[]>(),
};

const names = new Map([
  [34, "Tritanium"],
  [35, "Pyerite"],
  [62516, "Compressed Veldspar"],
  [62520, "Compressed Scordite"],
  [28430, "Batch Compressed Veldspar II-Grade"],
]);
const candidates: CompressionCandidate[] = [
  {
    typeId: 62516,
    name: "Compressed Veldspar",
    unitsToReprocess: 100,
    efficiency: 100,
    yields: new Map([[34, 400]]),
    price: 1,
    packagedVolume: 1,
  },
  {
    typeId: 62520,
    name: "Compressed Scordite",
    unitsToReprocess: 100,
    efficiency: 100,
    yields: new Map([
      [34, 150],
      [35, 110],
    ]),
    price: 1,
    packagedVolume: 1,
  },
];

void test("bounds mixed-output ore by its largest useful material demand", () => {
  assert.equal(
    maximumDemandRuns(
      candidates[1],
      new Map([
        [34, 301],
        [35, 110],
      ]),
    ),
    3,
  );
  assert.equal(maximumDemandRuns(candidates[1], new Map([[28694, 1]])), 0);
});

void test("skips full compression only when combined market supply cannot cover demand", () => {
  const demand = new Map([[34, 800]]);
  const candidate = {
    ...candidates[0],
    price: 1,
    packagedVolume: 1,
    maxRuns: 1,
  };
  assert.equal(canCoverDemand(demand, [candidate], 100), false);
  assert.equal(canCoverDemand(demand, [candidate, candidate], 100), true);
  assert.equal(canCoverDemand(demand, [{ ...candidate, maxRuns: 2 }], 1), false);
});

void test("compresses exact Tritanium into one compressed Veldspar", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 400 }],
    candidates,
    names,
    prices,
  );
  assert.deepEqual(
    result.toBuy,
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        quantity: 100,
        ignored: false,
        reprocessable: true,
      },
    ],
  );
  assert.deepEqual(
    result.plan,
    [
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 400,
        ignored: false,
        fromReprocessing: 400,
        surplus: 0,
      },
    ],
  );
  assert.deepEqual(result.surplus, []);
});

void test("selects exact mixed-ore quantities for Tritanium and Pyerite", async () => {
  const result = await compressMaterials(
    [
      { typeId: 34, name: "Tritanium", quantity: 150 },
      { typeId: 35, name: "Pyerite", quantity: 110 },
    ],
    candidates,
    names,
    prices,
  );
  assert.deepEqual(
    result.toBuy,
    [
      {
        typeId: 62520,
        name: "Compressed Scordite",
        quantity: 100,
        ignored: false,
        reprocessable: true,
      },
    ],
  );
  assert.deepEqual(result.surplus, []);
});

void test("excludes batch-compressed ore", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 420 }],
    [
      {
        typeId: 28430,
        name: "Batch Compressed Veldspar II-Grade",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 420]]),
      },
    ],
    names,
    prices,
  );
  assert.deepEqual(result.toBuy, [{ typeId: 34, name: "Tritanium", quantity: 420, ignored: true }]);
});

void test("keeps minerals without a matching recipe in the buy list", async () => {
  const result = await compressMaterials(
    [{ typeId: 35, name: "Pyerite", quantity: 1 }],
    candidates.slice(0, 1),
    names,
    prices,
  );
  assert.deepEqual(result.toBuy, [{ typeId: 35, name: "Pyerite", quantity: 1, ignored: true }]);
});

void test("does not ignore a compressible material when its market inputs are unavailable", async () => {
  await assert.rejects(
    compressMaterials(
      [{ typeId: 34, name: "Tritanium", quantity: 400 }],
      [],
      names,
      prices,
      new Set([34]),
    ),
    CompressionSolveError,
  );
});

void test("keeps fractional gas output instead of discarding compressed gas", async () => {
  const result = await compressMaterials(
    [{ typeId: 28694, name: "Amber Mykoserocin", quantity: 1 }],
    [
      {
        typeId: 62377,
        name: "Compressed Amber Mykoserocin",
        unitsToReprocess: 1,
        efficiency: 95,
        yields: new Map([[28694, 1]]),
        price: 1,
        packagedVolume: 0.1,
      },
    ],
    new Map([[62377, "Compressed Amber Mykoserocin"]]),
    { ...prices, volumes: new Map([...prices.volumes, [28694, 1]]) },
  );
  assert.deepEqual(
    result.toBuy,
    [
      {
        typeId: 62377,
        name: "Compressed Amber Mykoserocin",
        quantity: 2,
        ignored: false,
        reprocessable: true,
        reprocessingEfficiency: 95,
      },
    ],
  );
  assert.deepEqual(
    result.plan,
    [
      {
        typeId: 28694,
        name: "Amber Mykoserocin",
        quantity: 1,
        ignored: false,
        fromReprocessing: 1,
        surplus: 0,
      },
    ],
  );
});

void test("does not exceed a candidate's market volume limit", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 800 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 100,
        efficiency: 100,
        maxRuns: 1,
        yields: new Map([[34, 400]]),
        price: 1,
        packagedVolume: 1,
      },
    ],
    names,
    prices,
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [
      [62516, 100],
      [34, 400],
    ],
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, reprocessable }) => [typeId, reprocessable === true]),
    [
      [62516, true],
      [34, false],
    ],
  );
});

void test("uses another compressed run instead of buying a raw remainder", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 110 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 100]]),
        price: 20,
        packagedVolume: 1,
      },
    ],
    names,
    { volumes: new Map([[34, 1]]), buyPrices: new Map([[34, 1]]), surplusOrders: new Map() },
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [[62516, 2]],
  );
  assert.equal(result.metrics.purchaseCost, 40);
  assert.equal(result.metrics.purchasedVolume, 2);
  assert.deepEqual(
    result.surplus.map(({ typeId, quantity }) => [typeId, quantity]),
    [[34, 90]],
  );
});

void test("excludes candidates with zero market volume", async () => {
  await assert.rejects(
    compressMaterials(
      [{ typeId: 34, name: "Tritanium", quantity: 400 }],
      [
        {
          typeId: 62516,
          name: "Compressed Veldspar",
          unitsToReprocess: 100,
          efficiency: 100,
          maxRuns: 0,
          yields: new Map([[34, 400]]),
        },
      ],
      names,
      prices,
    ),
    CompressionSolveError,
  );
});

void test("chooses the cheaper feasible mix instead of buying excess of one ore", async () => {
  const result = await compressMaterials(
    [
      { typeId: 34, name: "Tritanium", quantity: 100 },
      { typeId: 35, name: "Pyerite", quantity: 100 },
    ],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([
          [34, 100],
          [35, 1],
        ]),
        price: 10,
        packagedVolume: 1,
      },
      {
        typeId: 62520,
        name: "Compressed Scordite",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[35, 100]]),
        price: 10,
        packagedVolume: 1,
      },
    ],
    names,
    {
      volumes: new Map([
        [34, 1],
        [35, 1],
      ]),
      buyPrices: new Map([
        [34, 2],
        [35, 2],
      ]),
      surplusOrders: new Map(),
    },
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [
      [62516, 1],
      [62520, 1],
    ],
  );
  assert.equal(result.metrics.purchasedVolume, 2);
  assert.equal(result.metrics.originalVolume, 200);
  assert.equal(result.metrics.estimatedSavings, 380);
});

void test("prefers cheaper ore despite surplus bids and respects the next lower DST load", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 130_000 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 130_000]]),
        price: 100,
        packagedVolume: 60_000,
      },
      {
        typeId: 62520,
        name: "Compressed Scordite",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([
          [34, 150_000],
          [35, 100],
        ]),
        price: 150,
        packagedVolume: 110_000,
      },
    ],
    names,
    {
      volumes: new Map([
        [34, 1],
        [62516, 60_000],
        [62520, 110_000],
      ]),
      buyPrices: new Map([[34, 2]]),
      surplusOrders: new Map([[35, [{ price: 1, volumeRemain: 100 }]]]),
    },
  );
  assert.equal(result.metrics.volumeLimit, 120_000);
  assert.equal(result.metrics.purchaseCost, 100);
  assert.equal(result.metrics.purchasedVolume, 60_000);
  assert.equal(result.metrics.surplusCredit, 0);
  assert.deepEqual(result.surplus, []);
});

void test("rejects cargo that cannot meet the next lower BR load", async () => {
  await assert.rejects(
    compressMaterials(
      [{ typeId: 34, name: "Tritanium", quantity: 15_000 }],
      [
        {
          typeId: 62516,
          name: "Compressed Veldspar",
          unitsToReprocess: 1,
          efficiency: 100,
          yields: new Map([[34, 15_000]]),
          price: 1,
          packagedVolume: 11_000,
        },
      ],
      names,
      {
        volumes: new Map([
          [34, 1],
          [62516, 11_000],
        ]),
        buyPrices: new Map([[34, 2]]),
        surplusOrders: new Map(),
      },
    ),
    CompressionSolveError,
  );
});

void test("rejects cargo equal to the original at a load boundary", async () => {
  await assert.rejects(
    compressMaterials(
      [{ typeId: 34, name: "Tritanium", quantity: 10_000 }],
      [
        {
          typeId: 62516,
          name: "Compressed Veldspar",
          unitsToReprocess: 1,
          efficiency: 100,
          yields: new Map([[34, 10_000]]),
          price: 1,
          packagedVolume: 10_000,
        },
      ],
      names,
      { volumes: new Map([[34, 1]]), buyPrices: new Map([[34, 2]]), surplusOrders: new Map() },
    ),
    CompressionSolveError,
  );
});

void test("does not count ignored demand as eligible cargo or savings", async () => {
  const result = await compressMaterials(
    [
      { typeId: 34, name: "Tritanium", quantity: 400 },
      { typeId: 35, name: "Pyerite", quantity: 1_000_000 },
    ],
    candidates.slice(0, 1),
    names,
    prices,
  );
  assert.equal(result.metrics.originalVolume, 400);
  assert.equal(result.metrics.purchasedVolume, 100);
  assert.equal(result.metrics.originalCost, 4_000);
  assert.deepEqual(
    result.toBuy.at(-1),
    { typeId: 35, name: "Pyerite", quantity: 1_000_000, ignored: true },
  );
});

void test("caps the credited surplus at actual station bid depth", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 100 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([
          [34, 100],
          [35, 500],
        ]),
        price: 80,
        packagedVolume: 1,
      },
    ],
    names,
    {
      volumes: new Map([[34, 1]]),
      buyPrices: new Map([[34, 2]]),
      surplusOrders: new Map([
        [
          35,
          [
            { price: 5, volumeRemain: 10 },
            { price: 2, volumeRemain: 20 },
          ],
        ],
      ]),
    },
  );
  assert.equal(result.surplus.find((item) => item.typeId === 35)?.quantity, 500);
  assert.equal(result.metrics.surplusCredit, 90);
  assert.equal(result.metrics.estimatedSavings, 120);
});

void test("does not buy expensive ore just to sell its surplus", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 100 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 100]]),
        price: 100,
        packagedVolume: 1,
      },
      {
        typeId: 62520,
        name: "Compressed Scordite",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([
          [34, 100],
          [35, 1_000],
        ]),
        price: 200,
        packagedVolume: 1,
      },
    ],
    names,
    {
      volumes: new Map([
        [34, 1],
        [35, 1],
      ]),
      buyPrices: new Map([[34, 10]]),
      surplusOrders: new Map([[35, [{ price: 1, volumeRemain: 1_000 }]]]),
    },
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [[62516, 1]],
  );
  assert.equal(result.metrics.purchaseCost, 100);
  assert.equal(result.metrics.surplusCredit, 0);
});

void test("minimizes surplus volume among equal-cost baskets", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 100 }],
    [
      {
        typeId: 62520,
        name: "Compressed Scordite",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([
          [34, 100],
          [35, 1_000],
        ]),
        price: 100,
        packagedVolume: 1,
      },
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 100]]),
        price: 100,
        packagedVolume: 1,
      },
    ],
    names,
    {
      volumes: new Map([
        [34, 1],
        [35, 1],
      ]),
      buyPrices: new Map([[34, 10]]),
      surplusOrders: new Map([[35, [{ price: 1, volumeRemain: 1_000 }]]]),
    },
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [[62516, 1]],
  );
  assert.deepEqual(result.surplus, []);
  assert.equal(result.metrics.purchaseCost, 100);
});

void test("does not pay more solely to reduce surplus", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 100 }],
    [
      {
        typeId: 62520,
        name: "Compressed Scordite",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 101]]),
        price: 100,
        packagedVolume: 1,
      },
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 100,
        yields: new Map([[34, 100]]),
        price: 100.01,
        packagedVolume: 1,
      },
    ],
    names,
    { volumes: new Map([[34, 1]]), buyPrices: new Map([[34, 2]]), surplusOrders: new Map() },
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId }) => typeId),
    [62520],
  );
  assert.equal(result.metrics.purchaseCost, 100);
});

void test("buys the rounded remainder when market depth limits a fractional yield", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 11 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        maxRuns: 1,
        efficiency: 95,
        yields: new Map([[34, 10]]),
        price: 10,
        packagedVolume: 1,
      },
    ],
    names,
    { volumes: new Map([[34, 1]]), buyPrices: new Map([[34, 2]]), surplusOrders: new Map() },
  );
  assert.equal(result.metrics.purchasedVolume, 3);
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [
      [62516, 1],
      [34, 2],
    ],
  );
});

void test("uses another fractional-yield run to avoid direct raw purchases", async () => {
  const result = await compressMaterials(
    [{ typeId: 34, name: "Tritanium", quantity: 11 }],
    [
      {
        typeId: 62516,
        name: "Compressed Veldspar",
        unitsToReprocess: 1,
        efficiency: 95,
        yields: new Map([[34, 10]]),
        price: 10,
        packagedVolume: 1,
      },
    ],
    names,
    { volumes: new Map([[34, 1]]), buyPrices: new Map([[34, 2]]), surplusOrders: new Map() },
  );
  assert.deepEqual(
    result.toBuy.map(({ typeId, quantity }) => [typeId, quantity]),
    [[62516, 2]],
  );
  assert.equal(result.metrics.purchasedVolume, 2);
  assert.deepEqual(
    result.surplus.map(({ typeId, quantity }) => [typeId, quantity]),
    [[34, 8]],
  );
});
