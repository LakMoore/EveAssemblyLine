import assert from "node:assert/strict";
import test from "node:test";
import {
  createHaulItemExclusionKey,
  excludeHaulItemsFromStock,
  getMaterialDisplayQuantity,
  getMaterialOverviewSurplus,
  getMaterialSurplus,
  getMaterialBuyOrBuildQuantity,
  getNonProductionHaulingQuantity,
  groupBuyEntriesByMarketCategory,
  groupPlanItemEntriesByBuildLocation,
  mergeBuyEntries,
  mergePlanItemEntries,
  parseHaulItemExclusionKey,
  splitReactionRunAllocations,
  splitReactionJobInputs,
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

test("round-trips haul item exclusion keys", () => {
  const key = createHaulItemExclusionKey(60003760, 62553);

  assert.equal(key, "60003760:62553");
  assert.deepEqual(
    parseHaulItemExclusionKey(key),
    {
      sourceRootLocationId: 60003760,
      itemTypeId: 62553,
    },
  );
  assert.equal(parseHaulItemExclusionKey("invalid"), null);
  assert.equal(parseHaulItemExclusionKey("60003760:62553:84600"), null);
});

test("excludes every quantity from an excluded source and type", () => {
  const stock = [
    {
      typeId: 62553,
      name: "Compressed Gneiss II-Grade",
      quantity: 120430,
      rootLocationId: 60003760,
      category: "item" as const,
    },
  ];
  const exclusions = new Map([[createHaulItemExclusionKey(60003760, 62553), 1055354926818]]);

  assert.deepEqual(excludeHaulItemsFromStock(stock, exclusions), []);
});

test("splits reaction runs across floor and ceiling allocations", () => {
  assert.deepEqual(
    splitReactionRunAllocations(22, 3, 5),
    [
      {
        installs: 2,
        runs: 7,
        totalRuns: 14,
        availableBlueprints: 2,
      },
      {
        installs: 1,
        runs: 8,
        totalRuns: 8,
        availableBlueprints: 3,
      },
    ],
  );
});

test("keeps exact reaction coverage in one row", () => {
  assert.deepEqual(
    splitReactionRunAllocations(21, 3, 5),
    [
      {
        installs: 3,
        runs: 7,
        totalRuns: 21,
        availableBlueprints: 5,
      },
    ],
  );
});

test("uses exactly two rows for a mismatch regardless of install count", () => {
  const allocations = splitReactionRunAllocations(22, 4, 6);

  assert.equal(allocations.length, 2);
  assert.deepEqual(
    allocations,
    [
      {
        installs: 2,
        runs: 5,
        totalRuns: 10,
        availableBlueprints: 2,
      },
      {
        installs: 2,
        runs: 6,
        totalRuns: 12,
        availableBlueprints: 4,
      },
    ],
  );
});

test("recalculates split reaction inputs and carries availability forward", () => {
  const inputs = {
    blueprint: {
      kind: "blueprint" as const,
      typeId: 123,
      name: "Example Formula",
      availableQuantity: 2,
      requiredQuantity: 1,
      completionPercent: 100,
      status: "ready" as const,
    },
    materials: [
      {
        kind: "material" as const,
        typeId: 456,
        name: "Example Material",
        availableQuantity: 15,
        requiredQuantity: 22,
        completionPercent: 68,
        status: "partial" as const,
      },
    ],
    bpoCount: 0,
    bpcRuns: 0,
    completionPercent: 68,
    status: "partial" as const,
  };

  const firstRow = splitReactionJobInputs(inputs, 22, 14, 0);
  const secondRow = splitReactionJobInputs(inputs, 22, 8, 14);
  assert.deepEqual(
    firstRow.materials[0],
    {
      ...inputs.materials[0],
      availableQuantity: 14,
      requiredQuantity: 14,
      completionPercent: 100,
      status: "ready",
    },
  );
  assert.deepEqual(
    secondRow.materials[0],
    {
      ...inputs.materials[0],
      availableQuantity: 1,
      requiredQuantity: 8,
      completionPercent: 13,
      status: "partial",
    },
  );
});

test("gives in-production stock precedence over overlapping haul quantity", () => {
  assert.equal(getNonProductionHaulingQuantity(28, 28), 0);
  assert.equal(getNonProductionHaulingQuantity(40, 28), 12);
  assert.equal(getNonProductionHaulingQuantity(12, 28), 0);
  assert.equal(getNonProductionHaulingQuantity(12, 0), 12);
});

test("calculates material surplus from unconsumed stock and production", () => {
  assert.equal(getMaterialSurplus(0, 100), 100);
  assert.equal(getMaterialSurplus(25, 75), 100);
  assert.equal(getMaterialSurplus(-10, -5), 0);
});

test("calculates material buy or build quantity from uncovered demand", () => {
  assert.equal(getMaterialBuyOrBuildQuantity(17_628_713, 16_925_705, 0, 0), 703_008);
  assert.equal(getMaterialBuyOrBuildQuantity(7_560, 283, 7_800, 0), 7_800);
  assert.equal(getMaterialBuyOrBuildQuantity(7_240, 5_723, 2_473, 2_473), 1_517);
  assert.equal(getMaterialBuyOrBuildQuantity(500, 800, 0, 0), 0);
});

test("shows purchase quantity in the Buy view when production is also planned", () => {
  const materialEntry = material({ buildQuantity: 214_183, buyQuantity: 0 });

  assert.equal(getMaterialDisplayQuantity(materialEntry, "plan"), 214_183);
  assert.equal(getMaterialDisplayQuantity(materialEntry, "buy"), 0);
});

test("calculates overview surplus from required and available totals", () => {
  assert.equal(getMaterialOverviewSurplus(17_628_713, 16_925_705, 0, 0), 0);
  assert.equal(getMaterialOverviewSurplus(7_560, 283, 7_800, 0), 523);
  assert.equal(getMaterialOverviewSurplus(7_240, 5_723, 2_473, 2_473), 0);
  assert.equal(getMaterialOverviewSurplus(500, 800, 0, 0), 300);
});

test("merges duplicate plan types in the global view", () => {
  const rows = mergePlanItemEntries([
    material({ stockpileId: "jita", stockpileName: "Jita", buildLocationId: 60003760 }),
    material({
      stockpileId: "auner",
      stockpileName: "Auner",
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

test("keeps plan rows with the same type but different kinds", () => {
  const rows = mergePlanItemEntries([
    material({ typeId: 12345, name: "Example Item" }),
    {
      kind: "reaction",
      typeId: 12345,
      name: "Example Formula",
      runsNeeded: 2,
      availableQuantity: 0,
    },
  ]);

  assert.deepEqual(rows.map((row) => row.kind).sort(), ["material", "reaction"].sort());
  assert.equal(rows.filter((row) => row.typeId === 12345).length, 2);
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
