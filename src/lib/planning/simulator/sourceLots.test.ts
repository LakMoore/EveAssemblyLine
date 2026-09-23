import assert from "node:assert/strict";
import test from "node:test";
import type { SimulationContext } from "./context";
import { normalizeSimulatorInventory } from "./sourceLots";
import type { SimulationRequestV1 } from "./types";

const context = {
  types: new Map([
    [34, { _key: 34, name: { en: "Tritanium" }, groupID: 1, volume: 0.01 }],
    [100, { _key: 100, name: { en: "Blueprint" }, groupID: 2, volume: 0.01 }],
  ]),
  blueprints: {
    byBlueprintId: new Map(),
  },
  compressibleTypes: new Map(),
  typeMaterials: new Map(),
} as unknown as SimulationContext;

/** Builds a minimal normalized simulator request. */
function request(): SimulationRequestV1 {
  return {
    stockpiles: [],
    assets: [
      {
        typeId: 34,
        quantity: 10,
        rootLocationId: 20,
        ownerType: "character",
        ownerId: 7,
      },
      {
        typeId: 100,
        quantity: 1,
        rootLocationId: 20,
        blueprintPrints: [
          { itemId: 98, runs: -1, type: "bpo" },
          { itemId: 99, runs: 5, type: "bpc", me: 10, te: 20 },
        ],
      },
    ],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: {
      version: 1,
      includeSurplusForAllLocations: false,
      blockInterStockpileHauling: false,
      characters: [],
      scienceProfiles: [],
      policy: {
        inventionExpectedOutputFactor: 1.2,
        fallbackInventionSkillLevel: 3,
        decryptorTypeIdByProductBlueprintTypeId: {},
        maxGraphNodes: 100,
        maxGraphDepth: 10,
      },
    },
  };
}

void test("normalizes ordinary assets and finite blueprint runs", () => {
  const inventory = normalizeSimulatorInventory(request(), context);
  assert.equal(inventory.itemLots[0].quantity, 10);
  assert.equal(inventory.itemLots[0].ownerId, 7);
  const bpoLot = inventory.blueprintLots.find((lot) => lot.itemId === 98);
  const bpcLot = inventory.blueprintLots.find((lot) => lot.itemId === 99);
  assert.ok(bpoLot);
  assert.ok(bpcLot);
  assert.equal(bpoLot.kind, "bpo");
  assert.equal(bpoLot.runs, Number.MAX_SAFE_INTEGER);
  assert.equal(bpcLot.kind, "bpc");
  assert.equal(bpcLot.runs, 5);
  assert.equal(bpcLot.materialEfficiency, 10);
});

void test("preserves industry job status on future output lots", () => {
  const simulationRequest = request();
  if (!Array.isArray(simulationRequest.assets)) {
    throw new Error("Expected the test request to contain an asset array.");
  }
  simulationRequest.assets = [
    ...simulationRequest.assets,
    {
      typeId: 34,
      quantity: 4,
      rootLocationId: 20,
      inBuild: true,
      jobId: 123,
      activityName: "manufacturing",
      industryJobStatus: "active",
      industryJobEndDate: "2026-01-01T01:00:00.000Z",
    },
    {
      typeId: 34,
      quantity: 2,
      rootLocationId: 20,
      inBuild: true,
      jobId: 124,
      activityName: "Reactions",
      industryJobStatus: "paused",
    },
  ];

  const inventory = normalizeSimulatorInventory(simulationRequest, context);
  const futureOutput = inventory.itemLots.find(
    (lot) => lot.source === "industry-output" && lot.industryJobStatus === "active",
  );

  assert.ok(futureOutput);
  assert.equal(futureOutput.horizon, "after-upstream");
  assert.equal(futureOutput.industryJobStatus, "active");
  assert.equal(futureOutput.activity, "manufacturing");
  assert.equal(futureOutput.industryJobId, 123);
  assert.equal(futureOutput.industryJobEndDate, "2026-01-01T01:00:00.000Z");
  const pausedOutput = inventory.itemLots.find((lot) => lot.industryJobStatus === "paused");
  assert.ok(pausedOutput);
  assert.equal(pausedOutput.activity, "reaction");
});
