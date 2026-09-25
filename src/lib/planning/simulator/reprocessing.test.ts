import assert from "node:assert/strict";
import test from "node:test";
import { SimulationAllocator } from "./allocator";
import { settleBuying } from "./buying";
import type { SimulationContext } from "./context";
import type { IndustrySimulationResult } from "./industrySimulation";
import type { SimulationLedgerAccount } from "./ledger";
import { groupReprocessingJobs, settleReprocessing } from "./reprocessing";
import type { SimulatorInventory } from "./sourceLots";
import type { SimulationReprocessingJob, SimulationRequestV1 } from "./types";

const materialAccount: SimulationLedgerAccount = {
  locationId: 20,
  typeId: 34,
};

const inventory: SimulatorInventory = {
  itemLots: [
    {
      lotId: "ore",
      typeId: 100,
      name: "Compressed Ore",
      quantity: 100,
      locationId: 40,
      unitVolume: 0.01,
      horizon: "now",
      source: "asset",
      eligibleForReprocessing: true,
    },
  ],
  blueprintLots: [],
  unresolvedLotCount: 0,
};

const request: SimulationRequestV1 = {
  stockpiles: [
    {
      id: "main",
      name: "Main",
      locations: {
        stock: 10,
        manufacturing: 20,
        reactions: 30,
        reprocessing: 40,
        copying: 50,
        invention: 60,
      },
      reprocessingEfficiencies: { "100": 50 },
      items: [],
    },
  ],
  assets: [],
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
    simulateSurplus: false,
    blockInterStockpileHauling: false,
    haulingAllocationMode: "local-first",
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

const context = {
  types: new Map([
    [
      100,
      { _key: 100, name: { en: "Compressed Ore" }, groupID: 1, volume: 0.01, portionSize: 100 },
    ],
    [34, { _key: 34, name: { en: "Tritanium" }, groupID: 2, volume: 0.01 }],
  ]),
  typeMaterials: new Map([
    [100, { _key: 100, materials: [{ materialTypeID: 34, quantity: 400 }] }],
  ]),
} as unknown as SimulationContext;

/** Creates a minimal reprocessing job for simulator aggregation tests. */
function reprocessingJob(
  jobId: string,
  state: SimulationReprocessingJob["state"],
  overrides: Partial<SimulationReprocessingJob> = {},
): SimulationReprocessingJob {
  return {
    jobId,
    stockpileId: "main",
    locationId: 40,
    sourceLotId: jobId,
    sourceTypeId: 100,
    sourceTypeName: "Compressed Ore",
    sourceQuantity: 100,
    portionCount: 1,
    efficiency: 50,
    state,
    yields: [],
    ...overrides,
  };
}

void test("allocates complete reprocessing portions and keeps surplus out of Buy", () => {
  const allocator = new SimulationAllocator(inventory, []);
  const industry: IndustrySimulationResult = {
    transactions: [
      {
        id: "demand",
        kind: "demand",
        account: materialAccount,
        quantity: 150,
        source: {
          demandId: "source",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 150,
          plannedQuantity: 150,
          requiredNow: 150,
          reserved: 0,
          destinationLocationId: 20,
          activity: "manufacturing",
        },
      },
    ],
    manufacturingJobs: [],
    reactionJobs: [],
    inventionJobs: [],
    copyJobs: [],
    unmetDemands: [
      {
        account: materialAccount,
        quantity: 150,
        source: {
          demandId: "source",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 150,
          plannedQuantity: 150,
          requiredNow: 150,
          reserved: 0,
          destinationLocationId: 20,
          activity: "manufacturing",
        },
        blockedByBuyBlacklist: false,
        purpose: "material",
      },
    ],
    blueprintPurchases: [],
    skillsRequired: [],
    warnings: [],
    allocator,
  };
  const reprocessing = settleReprocessing(request, context, inventory, industry);
  assert.equal(reprocessing.jobs.length, 1);
  assert.equal(reprocessing.jobs[0].portionCount, 1);
  assert.equal(reprocessing.jobs[0].yields[0].quantity, 200);
  assert.equal(reprocessing.jobs[0].yields[0].allocatedQuantity, 150);
  assert.deepEqual(
    reprocessing.groups[0]?.quantities,
    {
      totalSourceQuantity: 100,
      immediateSourceQuantity: 100,
      afterHaulingSourceQuantity: 0,
      afterPurchaseSourceQuantity: 0,
    },
  );
  assert.deepEqual(reprocessing.remainingDemands, []);
  const buying = settleBuying(request, context, industry, reprocessing.remainingDemands);
  assert.deepEqual(buying.materials, []);
});

void test("groups reprocessing jobs by location and source type and sums horizons", () => {
  const groups = groupReprocessingJobs([
    reprocessingJob("local", "local"),
    reprocessingJob("local-two", "local", { sourceQuantity: 25 }),
    reprocessingJob("hauled", "after-hauling", { sourceQuantity: 50 }),
    reprocessingJob("purchased", "after-purchase", { sourceQuantity: 25 }),
    reprocessingJob("other-type", "local", { sourceTypeId: 101, sourceTypeName: "Other Ore" }),
    reprocessingJob("other-location", "local", { locationId: 50 }),
  ]);

  assert.equal(groups.length, 3);
  const compressedOre = groups.find(
    (group) => group.locationId === 40 && group.sourceTypeId === 100,
  );
  assert.ok(compressedOre);
  assert.deepEqual(
    compressedOre.quantities,
    {
      totalSourceQuantity: 200,
      immediateSourceQuantity: 125,
      afterHaulingSourceQuantity: 50,
      afterPurchaseSourceQuantity: 25,
    },
  );
});

void test("does not use market-order lots for reprocessing", () => {
  const marketOrderInventory: SimulatorInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[0], source: "market-order" }],
  };
  const allocator = new SimulationAllocator(marketOrderInventory, []);
  const industry: IndustrySimulationResult = {
    transactions: [],
    manufacturingJobs: [],
    reactionJobs: [],
    inventionJobs: [],
    copyJobs: [],
    unmetDemands: [
      {
        account: materialAccount,
        quantity: 150,
        source: {
          demandId: "source",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 150,
          plannedQuantity: 150,
          requiredNow: 150,
          reserved: 0,
          destinationLocationId: 20,
          activity: "manufacturing",
        },
        blockedByBuyBlacklist: false,
        purpose: "material",
      },
    ],
    blueprintPurchases: [],
    skillsRequired: [],
    warnings: [],
    allocator,
  };

  const reprocessing = settleReprocessing(request, context, marketOrderInventory, industry);

  assert.deepEqual(reprocessing.jobs, []);
  assert.equal(reprocessing.remainingDemands[0]?.quantity, 150);
});
