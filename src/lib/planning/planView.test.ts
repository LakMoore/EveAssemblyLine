import assert from "node:assert/strict";
import test from "node:test";
import {
  getNonProductionHaulingQuantity,
  groupBuyEntriesByMarketCategory,
  groupPlanItemEntriesByBuildLocation,
  mergeBuyEntries,
  mergePlanItemEntries,
  type PlanBuyEntry,
  type PlanItemEntry,
} from "./planView";

type MaterialPlanEntry = Extract<PlanItemEntry, { kind: "material" }>;
type BuyMaterialEntry = Extract<PlanBuyEntry, { requiredQuantity: number }>;
type BuyBpcEntry = Extract<PlanBuyEntry, { bpoCount: number }>;

/** Creates a material plan row for view aggregation tests. */
function material(overrides: Partial<MaterialPlanEntry> = {}): MaterialPlanEntry {
  return {
    kind: "material",
    typeId: 34,
    name: "Tritanium",
    quantity: 10,
    requiredQuantity: 10,
    stockQuantity: 0,
    availableStockQuantity: 0,
    productionQuantity: 0,
    buildQuantity: 0,
    buyQuantity: 10,
    remainingStockQuantity: 0,
    remainingProductionQuantity: 0,
    ...overrides,
  };
}

test("gives in-production stock precedence over overlapping haul quantity", () => {
  assert.equal(getNonProductionHaulingQuantity(28, 28), 0);
  assert.equal(getNonProductionHaulingQuantity(40, 28), 12);
  assert.equal(getNonProductionHaulingQuantity(12, 28), 0);
  assert.equal(getNonProductionHaulingQuantity(12, 0), 12);
});

test("merges duplicate plan types in the global view", () => {
  const rows = mergePlanItemEntries([
    material({ bucketId: "jita", bucketName: "Jita", buildLocationId: 60003760 }),
    material({
      bucketId: "auner",
      bucketName: "Auner",
      buildLocationId: 60008494,
      requiredQuantity: 5,
      quantity: 5,
      buyQuantity: 5,
    }),
    material({ typeId: 35, name: "Pyerite", requiredQuantity: 3, quantity: 3, buyQuantity: 3 }),
  ]);

  assert.deepEqual(rows.map((row) => row.typeId).sort(), [34, 35]);
  const tritanium = rows.find((row) => row.typeId === 34);
  assert.ok(tritanium);
  const tritaniumMaterial = tritanium as MaterialPlanEntry;
  assert.equal(tritaniumMaterial.requiredQuantity, 15);
  assert.equal(tritaniumMaterial.buyQuantity, 15);
});

test("preserves total global availability and calculates surplus", () => {
  const rows = mergePlanItemEntries(
    [
      material({ stockQuantity: 60, availableStockQuantity: 60, buyQuantity: 0 }),
      material({ stockQuantity: 40, availableStockQuantity: 40, buyQuantity: 0 }),
    ],
    undefined,
    { "34": 250 },
  );

  const tritanium = rows[0];
  assert(tritanium.kind === "material");
  assert.equal(tritanium.availableStockQuantity, 250);
  assert.equal(tritanium.remainingStockQuantity, 150);
  assert.equal(tritanium.remainingProductionQuantity, 0);
});

test("merges duplicate plan types separately for each build location", () => {
  const rows = groupPlanItemEntriesByBuildLocation([
    material({ buildLocationId: 60003760 }),
    material({
      buildLocationId: 60003760,
      requiredQuantity: 5,
      quantity: 5,
      buyQuantity: 5,
    }),
    material({ buildLocationId: 60008494 }),
  ]);

  assert.deepEqual([...rows.keys()].sort(), [60003760, 60008494]);
  assert.equal(rows.get(60003760)?.length, 1);
  assert.equal(rows.get(60008494)?.length, 1);
  assert.equal((rows.get(60003760)?.[0] as MaterialPlanEntry | undefined)?.requiredQuantity, 15);
  assert.equal((rows.get(60008494)?.[0] as MaterialPlanEntry | undefined)?.requiredQuantity, 10);
});

test("merges duplicate Buy material rows by type ID", () => {
  const rows = mergeBuyEntries([
    {
      typeId: 34,
      name: "Tritanium",
      quantity: 10,
      requiredQuantity: 10,
      stockQuantity: 0,
      availableStockQuantity: 0,
      productionQuantity: 0,
      buildQuantity: 0,
      buyQuantity: 10,
      remainingStockQuantity: 0,
      remainingProductionQuantity: 0,
    },
    {
      typeId: 34,
      name: "Tritanium",
      quantity: 5,
      requiredQuantity: 5,
      stockQuantity: 0,
      availableStockQuantity: 0,
      productionQuantity: 0,
      buildQuantity: 0,
      buyQuantity: 5,
      remainingStockQuantity: 0,
      remainingProductionQuantity: 0,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal((rows[0] as BuyMaterialEntry).requiredQuantity, 15);
  assert.equal(rows[0].buyQuantity, 15);
});

test("groups Buy rows by market category", () => {
  const rows = groupBuyEntriesByMarketCategory(
    [
      material({ typeId: 35, name: "Pyerite" }),
      material({ typeId: 34, name: "Tritanium" }),
      {
        typeId: 12345,
        name: "Example Blueprint",
        quantity: 1,
        neededQuantity: 1,
        stockQuantity: 0,
        stockRuns: 0,
        buyQuantity: 1,
        bpoCount: 0,
        buildTime: 1,
      },
    ],
    new Map([
      [35, "Minerals"],
      [34, "Minerals"],
      [12345, "Blueprints"],
    ]),
  );

  assert.deepEqual([...rows.keys()], ["Blueprints", "Minerals"]);
  assert.deepEqual(
    rows.get("Minerals")?.map((row) => row.name),
    ["Pyerite", "Tritanium"],
  );
});

test("merges duplicate Buy BPC rows by type ID", () => {
  const rows = mergeBuyEntries([
    {
      typeId: 12345,
      name: "Example Blueprint",
      quantity: 2,
      neededQuantity: 4,
      stockQuantity: 1,
      stockRuns: 1,
      buyQuantity: 3,
      bpoCount: 0,
      buildTime: 1,
    },
    {
      typeId: 12345,
      name: "Example Blueprint",
      quantity: 3,
      neededQuantity: 5,
      stockQuantity: 2,
      stockRuns: 2,
      buyQuantity: 3,
      bpoCount: 1,
      buildTime: 1,
    },
  ]);

  assert.equal(rows.length, 1);
  const bpc = rows[0] as BuyBpcEntry;
  assert.equal(bpc.neededQuantity, 9);
  assert.equal(bpc.stockRuns, 3);
  assert.equal(bpc.buyQuantity, 6);
  assert.equal(bpc.bpoCount, 1);
});
