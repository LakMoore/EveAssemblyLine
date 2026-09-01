import assert from "node:assert/strict";
import test from "node:test";
import {
  getNonProductionHaulingQuantity,
  groupPlanItemEntriesByBuildLocation,
  mergePlanItemEntries,
  type PlanItemEntry,
} from "./planView";

type MaterialPlanEntry = Extract<PlanItemEntry, { kind: "material" }>;

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
