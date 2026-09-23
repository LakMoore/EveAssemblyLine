import assert from "node:assert/strict";
import test from "node:test";
import { parseSimulatorRequest, simulatorRequestSchema } from "./schema";

/** Builds the smallest valid request accepted by the simulator boundary. */
function request() {
  return {
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 1,
          manufacturing: 2,
          reactions: 3,
          reprocessing: 4,
          copying: 5,
          invention: 6,
        },
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [] as unknown[],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [] as number[],
      buyBlacklist: [] as number[],
    },
    simulation: { version: 1 },
  };
}

void test("defaults the simulator policy", () => {
  const parsed = parseSimulatorRequest(request());
  assert.equal(parsed.simulation.includeSurplusForAllLocations, false);
  assert.equal(parsed.simulation.blockInterStockpileHauling, false);
  assert.equal(parsed.simulation.policy.inventionExpectedOutputFactor, 1.2);
  assert.equal(parsed.simulation.policy.fallbackInventionSkillLevel, 3);
  assert.deepEqual(parsed.simulation.characters, []);
});

void test("accepts the inter-stockpile hauling policy", () => {
  const parsed = parseSimulatorRequest({
    ...request(),
    simulation: { version: 1, blockInterStockpileHauling: true },
  });
  assert.equal(parsed.simulation.blockInterStockpileHauling, true);
});

void test("rejects fractional build quantities", () => {
  const input = request();
  input.stockpiles[0].items[0].quantity = 1.5;
  assert.equal(simulatorRequestSchema.safeParse(input).success, false);
});

void test("rejects conflicting build and buy policies", () => {
  const input = request();
  input.settings.buildBlacklist = [34];
  input.settings.buyBlacklist = [34];
  const parsed = simulatorRequestSchema.safeParse(input);
  assert.equal(parsed.success, false);
  assert.ok(!parsed.success);
  assert.match(parsed.error.issues[0].message, /both build and buy/);
});

void test("accepts stockpiles that share a physical activity location", () => {
  const input = request();
  input.stockpiles.push({
    ...input.stockpiles[0],
    id: "shared-facility",
    name: "Shared facility",
  });
  assert.equal(simulatorRequestSchema.safeParse(input).success, true);
});

void test("strips asset presentation metadata at the simulator boundary", () => {
  const parsed = parseSimulatorRequest({
    ...request(),
    assets: [
      {
        typeId: 34,
        quantity: 10,
        assembledVolume: 1,
        assemblyLineGroup: "Materials",
        category: "item",
        name: "Tritanium",
        packagedVolume: 0.01,
        sourceSystemName: "Jita",
        blueprintType: "bpo",
        sourceLocationKind: "station",
        techLevel: 1,
      },
    ],
  });
  assert.ok(Array.isArray(parsed.assets));
  const asset = parsed.assets[0];
  assert.ok(asset);
  for (const property of [
    "assembledVolume",
    "assemblyLineGroup",
    "category",
    "name",
    "packagedVolume",
    "sourceSystemName",
    "blueprintType",
    "sourceLocationKind",
    "techLevel",
  ]) {
    assert.equal(property in asset, false, property);
  }
});

void test("accepts unlimited BPO runs and rejects negative BPC runs", () => {
  const bpoInput = request();
  bpoInput.assets = [
    {
      typeId: 691,
      quantity: 1,
      locationId: 2,
      blueprintPrints: [{ itemId: 1, runs: -1, type: "bpo" }],
    },
  ];
  assert.equal(simulatorRequestSchema.safeParse(bpoInput).success, true);

  const bpcInput = request();
  bpcInput.assets = [
    {
      typeId: 691,
      quantity: 1,
      locationId: 2,
      blueprintPrints: [{ itemId: 2, runs: -1, type: "bpc" }],
    },
  ];
  assert.equal(simulatorRequestSchema.safeParse(bpcInput).success, false);
});
