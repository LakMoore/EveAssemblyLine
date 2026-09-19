import assert from "node:assert/strict";
import test from "node:test";
import type { SimulationContext } from "./context";
import { normalizeSimulatorInventory } from "./sourceLots";
import type { SimulatorRequestV1 } from "./types";

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
function request(): SimulatorRequestV1 {
  return {
    stockpiles: [],
    assets: [
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 10,
        category: "item",
        rootLocationId: 20,
        ownerType: "character",
        ownerId: 7,
      },
      {
        typeId: 100,
        name: "Blueprint",
        quantity: 1,
        category: "blueprint",
        rootLocationId: 20,
        blueprintPrints: [{ itemId: 99, runs: 5, type: "bpc", me: 10, te: 20 }],
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
  assert.equal(inventory.blueprintLots[0].runs, 5);
  assert.equal(inventory.blueprintLots[0].materialEfficiency, 10);
});
