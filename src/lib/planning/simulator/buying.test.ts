import assert from "node:assert/strict";
import test from "node:test";
import { SimulationAllocator } from "./allocator";
import { settleBuying } from "./buying";
import type { SimulationContext } from "./context";
import type { IndustrySimulationResult, SimulationUnmetDemand } from "./industrySimulation";
import type { SimulatorInventory } from "./sourceLots";
import type { SimulationRequestV1 } from "./types";

const request = {
  language: "en",
  stockpiles: [],
  assets: [],
  settings: {
    includeCorporationAssets: true,
    personalSellOrdersAsStock: false,
    allCorporationSellOrdersAsStock: false,
    myCorporationSellOrdersAsStock: false,
    buildBlacklist: [],
    buyBlacklist: [35],
  },
  simulation: {
    version: 1,
    includeSurplusForAllLocations: false,
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
} satisfies SimulationRequestV1;

const context = {
  types: new Map([
    [34, { _key: 34, name: { en: "Tritanium" }, volume: 0.01 }],
    [35, { _key: 35, name: { en: "Pyerite" }, volume: 0.01 }],
  ]),
  groups: new Map(),
  marketGroups: new Map(),
} as unknown as SimulationContext;

const inventory: SimulatorInventory = {
  itemLots: [],
  blueprintLots: [],
  unresolvedLotCount: 0,
};

function demand(
  typeId: number,
  quantity: number,
  locationId: number,
  blockedByBuyBlacklist = false,
): SimulationUnmetDemand {
  return {
    account: { locationId, typeId },
    quantity,
    source: {
      demandId: `${typeId}:${locationId}`,
      stockpileId: "main",
      materialTypeId: typeId,
      productTypeId: typeId,
      productQuantity: quantity,
      plannedQuantity: quantity,
      requiredNow: quantity,
      reserved: 0,
      destinationLocationId: locationId,
      activity: "manufacturing",
    },
    blockedByBuyBlacklist,
    purpose: "material",
  };
}

void test("aggregates allowed purchases and warns for blocked residual demand", () => {
  const industry: IndustrySimulationResult = {
    transactions: [],
    manufacturingJobs: [],
    reactionJobs: [],
    inventionJobs: [],
    copyJobs: [],
    unmetDemands: [],
    blueprintPurchases: [],
    skillsRequired: [],
    warnings: [],
    allocator: new SimulationAllocator(inventory, []),
  };
  const result = settleBuying(
    request,
    context,
    industry,
    [demand(34, 5, 20), demand(34, 7, 30), demand(35, 11, 20, true)],
  );
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].quantity, 12);
  assert.equal(result.materials[0].destinations.length, 2);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].typeId, 35);
});
