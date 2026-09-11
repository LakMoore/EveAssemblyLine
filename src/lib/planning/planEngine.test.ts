import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlan, calculatePlanCalculation, toPlanResponse } from "./planEngine";
import type { IndustryJobStatus, PlannerRequest } from "./types";

const tritaniumTypeId = 34;
const heliumFuelBlockTypeId = 4247;
const compressedVeldsparTypeId = 62516;
const amberMykoserocinTypeId = 28694;
const compressedAmberMykoserocinTypeId = 62377;
const rifterTypeId = 587;
const rifterBlueprintTypeId = 691;
const capRechargerTypeId = 2032;
const capRechargerBlueprintTypeId = 2033;
const capRechargerInventionBlueprintTypeId = 1196;
const highEnergyPhysicsDatacoreTypeId = 20411;
const quantumPhysicsDatacoreTypeId = 20414;
const amarrShuttleTypeId = 31462;
const amarrShuttleBlueprintTypeId = 31463;
const sharedTritaniumProductTypeId = 586;
const sharedTritaniumBlueprintTypeId = 690;
const reactionProductTypeId = 16672;
const reactionFormulaTypeId = 46207;
const oxyOrganicSolventsTypeId = 57454;
const oxyOrganicSolventsFormulaTypeId = 57491;
const hydrocarbonsTypeId = 16633;
const atmosphericGasesTypeId = 16634;
const oxygenFuelBlockTypeId = 4312;
const fuelReactionProductTypeId = 16659;
const fuelReactionFormulaTypeId = 46167;
const reprocessingLocationId = 10;
const manufacturingLocationId = 20;
const sourceLocationId = 40;
const alternateSourceLocationId = 50;

/** Creates the smallest planner request needed for reprocessing integration tests. */
function request(
  quantity: number,
  stock: PlannerRequest["stock"],
  options: Partial<PlannerRequest> = {},
): PlannerRequest {
  const items = options.items ?? [
    {
      typeId: tritaniumTypeId,
      name: "Tritanium",
      quantity,
      me: 0,
      te: 0,
      fromCompression: false,
    },
  ];
  const stockpiles = options.stockpiles ?? [
    {
      id: "test-stockpile",
      name: "Test stockpile",
      locations: {
        stock: manufacturingLocationId,
        manufacturing: manufacturingLocationId,
        reactions: manufacturingLocationId,
        reprocessing: reprocessingLocationId,
        copying: manufacturingLocationId,
        invention: manufacturingLocationId,
      },
      ...(options.groupAssignments ? { groupAssignments: options.groupAssignments } : {}),
      items,
    },
  ];
  return {
    items,
    stock,
    stockpiles,
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: true,
      allCorporationSellOrdersAsStock: true,
      myCorporationSellOrdersAsStock: true,
      buildBlacklist: [],
      buyBlacklist: [],
      defaultMe: 10,
      defaultTe: 20,
    },
    ...options,
  };
}

/** Creates one located compressed-stock row. */
function compressedStock(quantity: number): PlannerRequest["stock"][number] {
  return {
    typeId: compressedVeldsparTypeId,
    name: "Compressed Veldspar",
    quantity,
    category: "item",
    rootLocationId: sourceLocationId,
  };
}

function industryOutputStock(
  status: IndustryJobStatus,
  rootLocationId: number,
  activityName = "Manufacturing",
  quantity = 100,
): PlannerRequest["stock"][number] {
  return {
    typeId: tritaniumTypeId,
    name: "Tritanium",
    quantity,
    category: "item",
    locationId: rootLocationId,
    rootLocationId,
    inBuild: true,
    inBuildQuantity: quantity,
    jobId: 123,
    activityName,
    industryJobStatus: status,
  };
}

test("build blacklist forces a buildable item to be purchased", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        settings: {
          ...request(0, []).settings,
          buildBlacklist: [rifterTypeId],
        },
      },
    ),
  );

  const rifter = result.lists.materialsToBuy.find((item) => item.typeId === rifterTypeId);
  assert(rifter);
  assert.equal(rifter.requiredQuantity, 1);
  assert.equal(rifter.buyQuantity, 1);
  assert.equal(
    result.lists.manufacturingJobs.some((job) => job.typeId === rifterBlueprintTypeId),
    false,
  );
});

test("reports the explicit unresolved asset count", async () => {
  const result = await calculatePlanCalculation(
    request(
      1,
      [{ ...compressedStock(1), ownerType: "character", ownerId: 101 }],
      {
        unresolvedAssetCount: 3,
      },
    ),
  );

  assert.equal(result.metadata.unresolvedAssetCount, 3);
});

test("returns aggregate material purchases in the plan response", async () => {
  const planRequest = request(
    33_750,
    [
      {
        typeId: tritaniumTypeId,
        name: "Tritanium",
        quantity: 33_300,
        category: "item",
        rootLocationId: manufacturingLocationId,
      },
    ],
  );
  const result = await calculatePlanCalculation(planRequest);
  const purchases = result.lists.materialsToBuy.filter((entry) => entry.typeId === tritaniumTypeId);

  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].requiredQuantity, 33_750);
  assert.equal(purchases[0].availableStockQuantity, 33_300);
  assert.equal(purchases[0].buyQuantity, 450);
  assert.equal("name" in purchases[0], false);
  assert.equal("assemblyLineGroup" in purchases[0], false);

  const response = await toPlanResponse(result);
  assert.deepEqual(
    response.lists.materialsToBuy,
    [
      {
        assemblyLineGroup: response.lists.materialsToBuy[0].assemblyLineGroup,
        items: [
          {
            typeId: tritaniumTypeId,
            typeName: "Tritanium",
            unitVolume: response.lists.materialsToBuy[0].items[0].unitVolume,
            neededQuantity: 450,
          },
        ],
      },
    ],
  );
  assert.equal(Object.values(response.lists.materialsToBuy[0].items[0]).length, 4);
  assert.equal(typeof response.lists.materialsToBuy[0].assemblyLineGroup, "string");

  const publicResponse = await calculatePlan(planRequest);
  assert.equal("bpcsNeeded" in publicResponse.lists, false);
  assert.equal("bpcsToBuy" in publicResponse.lists, false);
  assert.equal(publicResponse.lists.materialsToBuy[0].items[0].neededQuantity, 450);
});

test("uses location buckets in the plan response", async () => {
  const result = await calculatePlanCalculation(
    request(
      1,
      [],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const response = await toPlanResponse(result);
  const planBucket = response.lists.planItems.byActivityLocation.find(
    (bucket) => bucket.locationId === manufacturingLocationId,
  );
  const manufacturingBucket = response.lists.manufacturingJobs.find(
    (bucket) => bucket.items.length > 0,
  );

  assert(planBucket);
  assert(manufacturingBucket);
  assert.equal(planBucket.locationId, manufacturingLocationId);
  assert.equal(manufacturingBucket.locationId, manufacturingLocationId);
  assert.equal("context" in planBucket, false);
  assert.equal("context" in manufacturingBucket, false);
  assert.equal("activityLocationId" in planBucket.items[0]!, false);
  assert.equal("stockpileId" in manufacturingBucket.items[0]!, false);
});

test("assigns direct final-product demand to the stockpile location", async () => {
  const result = await calculatePlanCalculation(
    request(
      25,
      [],
      {
        stockpiles: [
          {
            id: "finished-product",
            name: "Finished product",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 25,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const material = result.lists.planItems.find(
    (item) => item.kind === "material" && item.typeId === tritaniumTypeId,
  );

  assert(material?.kind === "material");
  assert.equal(material.activityLocationId, undefined);
  assert.equal(material.stockpileLocationId, sourceLocationId);
});

test("keeps same-type activity and stockpile demands in separate rows", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: tritaniumTypeId,
            name: "Tritanium",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "split-demand",
            name: "Split demand",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const tritaniumRows = result.lists.planItems.filter(
    (item) => item.kind === "material" && item.typeId === tritaniumTypeId,
  );

  assert.equal(tritaniumRows.length, 2);
  assert(
    tritaniumRows.some(
      (item) =>
        item.activityLocationId === manufacturingLocationId
        && item.stockpileLocationId === undefined,
    ),
  );
  assert(
    tritaniumRows.some(
      (item) =>
        item.activityLocationId === undefined && item.stockpileLocationId === sourceLocationId,
    ),
  );

  const response = await toPlanResponse(result);
  const activityBucket = response.lists.planItems.byActivityLocation.find(
    (bucket) => bucket.locationId === manufacturingLocationId,
  );
  const stockpileBucket = response.lists.planItems.byActivityLocation.find(
    (bucket) => bucket.locationId === sourceLocationId,
  );
  assert(activityBucket);
  assert(stockpileBucket);
  assert.equal(activityBucket.items.filter((item) => item.typeId === tritaniumTypeId).length, 1);
  assert.equal(stockpileBucket.items.filter((item) => item.typeId === tritaniumTypeId).length, 1);
});

test("filters available source counts by plan-item location", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 20),
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 30,
          category: "item",
          source: "marketOrder",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: tritaniumTypeId,
            name: "Tritanium",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "source-count-locations",
            name: "Source count locations",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const response = await toPlanResponse(result);
  const allTritanium = response.lists.planItems.all.find((item) => item.typeId === tritaniumTypeId);
  const activityTritanium = response.lists.planItems.byActivityLocation
    .find((bucket) => bucket.locationId === manufacturingLocationId)
    ?.items.find((item) => item.typeId === tritaniumTypeId);
  const stockpileTritanium = response.lists.planItems.byActivityLocation
    .find((bucket) => bucket.locationId === sourceLocationId)
    ?.items.find((item) => item.typeId === tritaniumTypeId);

  assert(allTritanium);
  assert(activityTritanium);
  assert(stockpileTritanium);
  assert.equal(allTritanium.availableQuantity, 50);
  assert.equal(activityTritanium.availableQuantity, 20);
  assert.equal(stockpileTritanium.availableQuantity, 30);
  assert.deepEqual(
    allTritanium.availableSourceCounts,
    {
      [manufacturingLocationId]: { industry: 20 },
      [sourceLocationId]: { market: 30 },
    },
  );
  assert.deepEqual(
    activityTritanium.availableSourceCounts,
    {
      [manufacturingLocationId]: { industry: 20 },
    },
  );
  assert.deepEqual(
    stockpileTritanium.availableSourceCounts,
    {
      [sourceLocationId]: { market: 30 },
    },
  );
});

test("filters hauling quantities by plan-item destination location", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 2,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "first-haul-destination",
            name: "First haul destination",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-haul-destination",
            name: "Second haul destination",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: alternateSourceLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: reprocessingLocationId,
              copying: alternateSourceLocationId,
              invention: alternateSourceLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const response = await toPlanResponse(result);
  const firstBucket = response.lists.planItems.byActivityLocation.find(
    (bucket) => bucket.locationId === manufacturingLocationId,
  );
  const secondBucket = response.lists.planItems.byActivityLocation.find(
    (bucket) => bucket.locationId === alternateSourceLocationId,
  );
  const firstTritanium = firstBucket?.items.find((item) => item.typeId === tritaniumTypeId);
  const secondTritanium = secondBucket?.items.find((item) => item.typeId === tritaniumTypeId);

  assert(firstTritanium);
  assert(secondTritanium);
  assert.equal(firstTritanium.haulingQuantity, 1);
  assert.equal(secondTritanium.haulingQuantity, 1);
});

test("buy blacklist keeps a buildable item on the manufacturing path", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        settings: {
          ...request(0, []).settings,
          buyBlacklist: [rifterTypeId],
        },
      },
    ),
  );

  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  assert(job);
  assert.equal(job.countNeeded, 1);
  const rifter = result.lists.materialsToBuy.find((item) => item.typeId === rifterTypeId);
  assert(rifter);
  assert.equal(rifter.buyQuantity, 0);
});

test("uses co-located corporation material stock for manufacturing", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 57450,
          name: "Electro-Neural Signaller",
          quantity: 3,
          category: "item",
          rootLocationId: manufacturingLocationId,
          locationId: 123456,
          ownerType: "corporation",
          ownerId: 202,
          corporationSource: {
            rootLocationId: manufacturingLocationId,
            locationFlag: "CorpSAG3",
            containerItemIds: [123456],
          },
        },
      ],
      {
        items: [
          {
            typeId: 37605,
            name: "Test final product",
            quantity: 3,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const material = result.lists.materialsToBuy.find((entry) => entry.typeId === 57450);

  assert(material);
  assert.equal(material.stockQuantity, 0);
  assert.equal(material.buyQuantity, 0);
});

test("plans invention attempts and materials for a missing T2 BPC", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: capRechargerTypeId,
            name: "Cap Recharger II",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );

  const inventionJob = result.lists.inventionJobs.find(
    (job) => job.typeId === capRechargerInventionBlueprintTypeId,
  );
  assert(inventionJob);
  assert.equal(inventionJob.countNeeded, 3);
  assert.equal(inventionJob.locationId, manufacturingLocationId);

  for (const typeId of [highEnergyPhysicsDatacoreTypeId, quantumPhysicsDatacoreTypeId]) {
    const datacore = result.lists.materialsToBuy.find((item) => item.typeId === typeId);
    assert(datacore);
    assert.equal(datacore.requiredQuantity, 6);
    assert.equal(datacore.buyQuantity, 6);
  }
  assert.equal(
    result.lists.bpcsToBuy.some((blueprint) => blueprint.typeId === capRechargerBlueprintTypeId),
    false,
  );
  assert.equal(
    result.lists.skillsRequired.some((skill) => skill.skillId === 23087),
    true,
  );
  const requiredSkills = new Map(
    result.lists.skillsRequired.map((skill) => [skill.skillId, skill.requiredLevel]),
  );
  assert.equal(requiredSkills.get(3402), 5);
  assert.equal(requiredSkills.get(3413), 5);
  assert.equal(requiredSkills.get(21718), 2);
  assert.equal(requiredSkills.get(3432), 3);
  assert.equal(requiredSkills.get(3426), 5);
});

test("merges invention jobs by location and blueprint type", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [],
        stockpiles: [
          {
            id: "first",
            name: "First destination",
            locations: {
              stock: 10,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: capRechargerTypeId,
                name: "Cap Recharger II",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second",
            name: "Second destination",
            locations: {
              stock: 11,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: capRechargerTypeId,
                name: "Cap Recharger II",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "third",
            name: "Third destination",
            locations: {
              stock: 12,
              manufacturing: alternateSourceLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: alternateSourceLocationId,
              copying: alternateSourceLocationId,
              invention: alternateSourceLocationId,
            },
            items: [
              {
                typeId: capRechargerTypeId,
                name: "Cap Recharger II",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.deepEqual(
    result.lists.inventionJobs.map(({ locationId, typeId, countNeeded }) => ({
      locationId,
      typeId,
      countNeeded,
    })),
    [
      {
        locationId: manufacturingLocationId,
        typeId: capRechargerInventionBlueprintTypeId,
        countNeeded: 6,
      },
      {
        locationId: alternateSourceLocationId,
        typeId: capRechargerInventionBlueprintTypeId,
        countNeeded: 3,
      },
    ],
  );
});

test("uses an available T2 BPC without scheduling invention", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: capRechargerBlueprintTypeId,
          name: "Cap Recharger II Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9100, type: "bpc", runs: 1 }],
        },
      ],
      {
        items: [
          {
            typeId: capRechargerTypeId,
            name: "Cap Recharger II",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );

  assert.deepEqual(result.lists.inventionJobs, []);
  const blueprint = result.lists.planItems.find(
    (item) => item.kind === "bpc" && item.typeId === capRechargerBlueprintTypeId,
  );
  assert(blueprint && blueprint.kind === "bpc");
  assert.equal(blueprint.stockRuns, 1);
  assert.equal(blueprint.buyQuantity, 0);
});

test("reports BPO count and BPC runs separately for manufacturing", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          blueprintType: "bpo",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint Copy",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9101, type: "bpc", runs: 7 }],
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );

  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  assert(job);
  assert.equal(job.inputs.bpoCount, 1);
  assert.equal(job.inputs.bpcRuns, 7);
});

test("applies assigned manufacturing group facility modifiers", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        groupAssignments: { smallShips: alternateSourceLocationId },
        facilityProfiles: [
          {
            locationId: alternateSourceLocationId,
            sizeId: 1,
            buildTypeGroups: {
              smallShips: {
                manufacturingMaterialMultiplier: 0.9,
                manufacturingMaterialPercentage: 10,
                manufacturingTimeMultiplier: 0.8,
                manufacturingTimePercentage: 20,
                reactionMaterialMultiplier: 1,
                reactionMaterialPercentage: 0,
                reactionTimeMultiplier: 1,
                reactionTimePercentage: 0,
              },
            },
          },
        ],
      },
    ),
  );
  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  assert(job);
  assert.equal(job.locationId, alternateSourceLocationId);
  assert.equal(job.totalTime, 4_800);
  const tritanium = job.inputs.materials.find((input) => input.typeId === tritaniumTypeId);
  assert(tritanium);
  assert.equal(tritanium.requiredQuantity, 28_800);
  const tritaniumPlanItem = result.lists.planItems.find(
    (item) => item.kind === "material" && item.typeId === tritaniumTypeId,
  );
  assert(tritaniumPlanItem?.kind === "material");
  assert.equal(tritaniumPlanItem.activityLocationId, alternateSourceLocationId);
});

test("requires one unit of manufacturing material per run after bonuses", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: 21019,
            name: "Capital Capacitor Battery",
            quantity: 27,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        groupAssignments: { capitalComponents: alternateSourceLocationId },
        facilityProfiles: [
          {
            locationId: alternateSourceLocationId,
            sizeId: 1,
            buildTypeGroups: {
              capitalComponents: {
                manufacturingMaterialMultiplier: 0.9,
                manufacturingMaterialPercentage: 10,
                manufacturingTimeMultiplier: 1,
                manufacturingTimePercentage: 0,
                reactionMaterialMultiplier: 1,
                reactionMaterialPercentage: 0,
                reactionTimeMultiplier: 1,
                reactionTimePercentage: 0,
              },
            },
          },
        ],
      },
    ),
  );
  const job = result.lists.manufacturingJobs.find((entry) => entry.typeId === 21020);
  assert(job);
  const powerCore = job.inputs.materials.find((input) => input.typeId === 2872);
  assert(powerCore);
  assert.equal(powerCore.requiredQuantity, 27);
  const powerCoreMaterial = result.lists.materialsToBuy.find((item) => item.typeId === 2872);
  assert(powerCoreMaterial);
  assert.equal(powerCoreMaterial.requiredQuantity, 27);
});

test("applies assigned reaction group facility modifiers", async () => {
  const result = await calculatePlanCalculation(
    request(
      20,
      [
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 16657,
          name: "Reaction Material A",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 16661,
          name: "Reaction Material B",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 4051,
          name: "Reaction Material C",
          quantity: 5,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: reactionProductTypeId,
            name: "Reaction Product",
            quantity: 20,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        groupAssignments: { compositeReactions: alternateSourceLocationId },
        facilityProfiles: [
          {
            locationId: alternateSourceLocationId,
            sizeId: 1,
            buildTypeGroups: {
              compositeReactions: {
                manufacturingMaterialMultiplier: 1,
                manufacturingMaterialPercentage: 0,
                manufacturingTimeMultiplier: 1,
                manufacturingTimePercentage: 0,
                reactionMaterialMultiplier: 0.5,
                reactionMaterialPercentage: 50,
                reactionTimeMultiplier: 0.75,
                reactionTimePercentage: 25,
              },
            },
          },
        ],
      },
    ),
  );
  const job = result.lists.reactionJobs.find((entry) => entry.typeId === reactionFormulaTypeId);
  assert(job);
  assert.equal(job.locationId, alternateSourceLocationId);
  assert.equal(job.totalTime, 8_100);
  assert.deepEqual(
    job.inputs.materials.map((input) => [input.typeId, input.requiredQuantity]),
    [
      [4051, 3],
      [16657, 50],
      [16661, 50],
    ],
  );
  const reactionMaterial = result.lists.planItems.find(
    (item) => item.kind === "material" && item.typeId === 16657,
  );
  assert(reactionMaterial?.kind === "material");
  assert.equal(reactionMaterial.activityLocationId, alternateSourceLocationId);
  assert.deepEqual(
    result.lists.skillsRequired.find((skill) => skill.skillId === 45746),
    {
      skillId: 45746,
      name: "Reactions",
      requiredLevel: 3,
    },
  );
});

test("allocates reaction material at an assigned reaction facility", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 4247,
          name: "Helium Fuel Block",
          quantity: 5,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 16633,
          name: "Hydrocarbons",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 16636,
          name: "Reaction Material B",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "other-reaction",
            name: "Other reaction",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: fuelReactionProductTypeId,
                name: "Fuel Reaction Product",
                quantity: 200,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "mino-order",
            name: "Mino order",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            groupAssignments: { compositeReactions: alternateSourceLocationId },
            items: [
              {
                typeId: fuelReactionProductTypeId,
                name: "Fuel Reaction Product",
                quantity: 200,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const material = result.lists.materialsToBuy.find((item) => item.typeId === 16636);

  assert(material);
  assert.equal(material.stockQuantity, 100);
  assert.equal(material.buyQuantity, 100);
});

test("combines global facility and skill time multipliers", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        facilityTimeMultipliers: { manufacturing: 0.8, reactions: 1 },
        skillTimeMultipliers: { manufacturing: 0.5, reactions: 1 },
      },
    ),
  );
  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  assert(job);
  assert.equal(job.totalTime, 2_400);
});

test("uses output from an active industry job as committed availability", async () => {
  const result = await calculatePlanCalculation(
    request(100, [industryOutputStock("active", manufacturingLocationId)]),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(tritanium);
  assert.equal(tritanium.stockQuantity, 0);
  assert.equal(tritanium.availableStockQuantity, 100);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal((tritanium.availableSourceCounts?.[manufacturingLocationId] ?? {}).industry, 100);
  assert.deepEqual(result.lists.haulingTasks, []);
});

test("reports aggregate industry source counts for multiple active outputs", async () => {
  const result = await calculatePlanCalculation(
    request(
      570,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 402,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 37),
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 37),
      ],
    ),
  );
  const response = await toPlanResponse(result);
  const tritanium = response.lists.planItems.all.find((item) => item.typeId === tritaniumTypeId);

  assert(tritanium);
  assert.equal(tritanium.availableQuantity, 476);
  assert.deepEqual(
    tritanium.availableSourceCounts,
    {
      [manufacturingLocationId]: { industry: 74 },
    },
  );
});

test("restores industry source counts across multiple stockpiles", async () => {
  const stockpile = (id: string, locationId: number, quantity: number) => ({
    id,
    name: id,
    locations: {
      stock: locationId,
      manufacturing: locationId,
      reactions: locationId,
      reprocessing: reprocessingLocationId,
      copying: locationId,
      invention: locationId,
    },
    items: [
      {
        typeId: tritaniumTypeId,
        name: "Tritanium",
        quantity,
        me: 0,
        te: 0,
        fromCompression: false,
      },
    ],
  });
  const result = await calculatePlanCalculation(
    request(
      684,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 402,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 37),
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 37),
      ],
      {
        stockpiles: [
          stockpile("primary", manufacturingLocationId, 570),
          stockpile("secondary", sourceLocationId, 114),
        ],
      },
    ),
  );
  const response = await toPlanResponse(result);
  const tritanium = response.lists.planItems.all.find((item) => item.typeId === tritaniumTypeId);

  assert(tritanium);
  assert.equal(tritanium.availableQuantity, 476);
  assert.deepEqual(
    tritanium.availableSourceCounts,
    {
      [manufacturingLocationId]: { industry: 74 },
    },
  );
});

test("does not count cancelled or reverted industry output as available stock", async () => {
  for (const status of ["cancelled", "reverted"] as const) {
    const result = await calculatePlanCalculation(
      request(100, [industryOutputStock(status, manufacturingLocationId)]),
    );
    const tritanium = result.lists.materialsToBuy.find(
      (material) => material.typeId === tritaniumTypeId,
    );

    assert(tritanium);
    assert.equal(tritanium.availableStockQuantity, 0);
    assert.equal(tritanium.buyQuantity, 100);
  }
});

test("uses paused industry output for demand but not installable job inputs", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [industryOutputStock("paused", manufacturingLocationId, "Manufacturing", 32_000)],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );

  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );
  assert(tritanium);
  assert.equal(tritanium.availableStockQuantity, 32_000);
  assert.equal(tritanium.buyQuantity, 0);
  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  assert(job);
  const tritaniumInput = job.inputs.materials.find((input) => input.typeId === tritaniumTypeId);
  assert(tritaniumInput);
  assert.equal(tritaniumInput.availableQuantity, 0);
  assert.equal(tritaniumInput.status, "blocked");
});

test("deduplicates repeated blueprint print IDs when counting BPC runs", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 2,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9000, type: "bpc", runs: 1 }],
        },
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 2,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9000, type: "bpc", runs: 1 }],
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 2,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );

  const blueprint = result.lists.planItems.find(
    (item) => item.kind === "bpc" && item.typeId === rifterBlueprintTypeId,
  );
  assert(blueprint && blueprint.kind === "bpc");
  assert.equal(blueprint.stockRuns, 1);
  assert.equal(blueprint.buyQuantity, 1);
});

test("counts physical stock and active output toward plan availability", async () => {
  const result = await calculatePlanCalculation(
    request(
      150,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 130,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 20),
      ],
    ),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(tritanium);
  assert.equal(tritanium.availableStockQuantity, 150);
  assert.equal(tritanium.stockQuantity, 130);
  assert.equal(tritanium.productionQuantity, 0);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal((tritanium.availableSourceCounts?.[manufacturingLocationId] ?? {}).industry, 20);
});

test("tracks production-origin haul quantity separately from stock haul quantity", async () => {
  const result = await calculatePlanCalculation(
    request(
      110,
      [
        industryOutputStock("ready", manufacturingLocationId, "Manufacturing", 100),
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 10,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "haul-provenance-stockpile",
            name: "Haul provenance stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 110,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const tritaniumHauls = result.lists.haulingTasks.filter(
    (task) => task.typeId === tritaniumTypeId,
  );

  const productionHaul = tritaniumHauls.find(
    (task) => task.fromLocationId === manufacturingLocationId,
  );
  const stockHaul = tritaniumHauls.find(
    (task) => task.fromLocationId === alternateSourceLocationId,
  );

  assert(productionHaul);
  assert(stockHaul);
  assert.equal(productionHaul.neededQuantity, 100);
  assert.equal(productionHaul.source, "production");
  assert.equal(stockHaul.neededQuantity, 10);
  assert.equal(stockHaul.source, undefined);
});

test("counts active output toward availability in stockpiled plans", async () => {
  const result = await calculatePlanCalculation(
    request(
      150,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 130,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 20),
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "stockpile-1",
            name: "Stockpile 1",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 150,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const tritanium = result.lists.planItems
    .filter((entry) => entry.kind === "material")
    .find((material) => material.typeId === tritaniumTypeId);

  assert(tritanium);
  assert.equal(tritanium.availableStockQuantity, 150);
  assert.equal(tritanium.productionQuantity, 0);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal((tritanium.availableSourceCounts?.[manufacturingLocationId] ?? {}).industry, 20);
});

test("allocates matching market orders and active output across stockpiles", async () => {
  const locations = (stock: number) => ({
    stock,
    manufacturing: manufacturingLocationId,
    reactions: manufacturingLocationId,
    reprocessing: reprocessingLocationId,
    copying: manufacturingLocationId,
    invention: manufacturingLocationId,
  });
  const stockpile = (id: string, stock: number) => ({
    id,
    name: id,
    locations: locations(stock),
    items: [
      {
        typeId: tritaniumTypeId,
        name: "Tritanium",
        quantity: 1_000_000,
        me: 0,
        te: 0,
        fromCompression: false,
      },
    ],
  });
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 221_407,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        industryOutputStock("active", manufacturingLocationId, "Manufacturing", 380_000),
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 1_031_667,
          category: "item",
          source: "marketOrder",
          sourceLocationId: alternateSourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: tritaniumTypeId,
            name: "Tritanium",
            quantity: 3_000_000,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          stockpile("stockpile-one", sourceLocationId),
          stockpile("stockpile-two", manufacturingLocationId),
          stockpile("stockpile-three", alternateSourceLocationId),
        ],
      },
    ),
  );
  const tritanium = result.lists.planItems
    .filter((entry) => entry.kind === "material")
    .filter((material) => material.typeId === tritaniumTypeId);

  assert.equal(
    tritanium.reduce((total, material) => total + material.requiredQuantity, 0),
    3_000_000,
  );
  assert.equal(
    tritanium.reduce((total, material) => total + material.availableStockQuantity, 0),
    1_601_407,
  );
  assert.equal(
    tritanium.reduce((total, material) => total + material.buyQuantity, 0),
    1_398_593,
  );
});

test("uses remote active output for a stockpile final product", async () => {
  const result = await calculatePlanCalculation(
    request(
      150,
      [industryOutputStock("active", alternateSourceLocationId, "Manufacturing", 20)],
      {
        items: [],
        stockpiles: [
          {
            id: "remote-output-stockpile",
            name: "Remote output stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 150,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const tritanium = result.lists.planItems
    .filter((entry) => entry.kind === "material")
    .find((material) => material.typeId === tritaniumTypeId);

  assert(tritanium);
  assert.equal(tritanium.stockQuantity, 0);
  assert.equal(tritanium.availableStockQuantity, 20);
  assert.equal((tritanium.availableSourceCounts?.[alternateSourceLocationId] ?? {}).industry, 20);
  assert.deepEqual(result.lists.haulingTasks, []);
});

test("ignores empty stockpiles when calculating a plan", async () => {
  const stock = [industryOutputStock("active", manufacturingLocationId, "Manufacturing", 20)];
  const populatedStockpile = {
    id: "populated-stockpile",
    name: "Populated stockpile",
    locations: {
      stock: sourceLocationId,
      manufacturing: manufacturingLocationId,
      reactions: manufacturingLocationId,
      reprocessing: reprocessingLocationId,
      copying: manufacturingLocationId,
      invention: manufacturingLocationId,
    },
    items: [
      {
        typeId: tritaniumTypeId,
        name: "Tritanium",
        quantity: 150,
        me: 0,
        te: 0,
        fromCompression: false,
      },
    ],
  };
  const emptyStockpile = {
    id: "empty-stockpile",
    name: "Empty stockpile",
    locations: {
      stock: 41,
      manufacturing: 21,
      reactions: 22,
      reprocessing: 23,
      copying: 24,
      invention: 25,
    },
    items: [],
  };
  const withoutEmptyStockpile = await calculatePlanCalculation(
    request(0, stock, { items: [], stockpiles: [populatedStockpile] }),
  );
  const withEmptyStockpile = await calculatePlanCalculation(
    request(0, stock, { items: [], stockpiles: [emptyStockpile, populatedStockpile] }),
  );

  assert.deepEqual(
    { ...withEmptyStockpile, metadata: { ...withEmptyStockpile.metadata, generatedAt: "" } },
    { ...withoutEmptyStockpile, metadata: { ...withoutEmptyStockpile.metadata, generatedAt: "" } },
  );
});

test("requires a populated stockpile for plan calculation", async () => {
  await assert.rejects(
    () => calculatePlanCalculation(request(10, [], { stockpiles: [] })),
    /at least one populated stockpile/,
  );
});

test("reallocates shared stock after intermediate inventory reduces stockpile demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 16633,
          name: "Hydrocarbons",
          quantity: 200000,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: 16634,
          name: "Atmospheric Gases",
          quantity: 200000,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: 4312,
          name: "Oxygen Fuel Block",
          quantity: 100,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: 57454,
          name: "Oxy-Organic Solvents",
          quantity: 100,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "intermediate-stock",
            name: "Intermediate stock",
            locations: {
              stock: reprocessingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: 57454,
                name: "Oxy-Organic Solvents",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "gas-demand",
            name: "Gas demand",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: 57454,
                name: "Oxy-Organic Solvents",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const gasRows = result.lists.materialsToBuy.filter((item) => item.typeId === 16634);

  assert.equal(gasRows.length, 1);
  assert.equal(gasRows[0].buyQuantity, 0);
  assert.equal(
    gasRows.reduce((total, item) => total + item.buyQuantity, 0),
    0,
  );
});

test("reallocates material stock after reaction formulas are reserved", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 16636,
          name: "Silicates",
          quantity: 1_000_000,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: 57494,
          name: "Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: 4312,
          name: "Oxygen Fuel Block",
          quantity: 25_000,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: 16634,
          name: "Atmospheric Gases",
          quantity: 1_500_000,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "formula-stockpile",
            name: "Formula stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: 57457,
                name: "Reaction Product",
                quantity: 1_000_000,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "other-stockpile",
            name: "Other stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [],
          },
        ],
      },
    ),
  );
  const silicates = result.lists.materialsToBuy.find((item) => item.typeId === 16636);

  assert(silicates);
  assert.equal(silicates.buyQuantity, 0);
  assert.equal(silicates.stockQuantity > 0, true);
});

test("reports full located stock beyond the quantity allocated to stockpile demand", async () => {
  const stockpiles = ["first", "second"].map((id) => ({
    id,
    name: id,
    locations: {
      stock: manufacturingLocationId,
      manufacturing: manufacturingLocationId,
      reactions: manufacturingLocationId,
      reprocessing: reprocessingLocationId,
      copying: manufacturingLocationId,
      invention: manufacturingLocationId,
    },
    items: [
      {
        typeId: rifterTypeId,
        name: "Rifter",
        quantity: 1,
        me: 0,
        te: 0,
        fromCompression: false,
      },
    ],
  }));
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 100_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      { stockpiles },
    ),
  );
  const response = await toPlanResponse(result);
  const planItem = response.lists.planItems.byActivityLocation
    .find((bucket) => bucket.locationId === manufacturingLocationId)
    ?.items.find((item) => item.typeId === tritaniumTypeId);

  assert(planItem && planItem.kind === "material");
  assert.equal(planItem.availableQuantity, 100_000);
  assert.equal(planItem.surplusQuantity, 36_000);
});

test("uses reaction formulas held at a stockpile's reaction location", async () => {
  const result = await calculatePlanCalculation(
    request(
      20,
      [
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: reprocessingLocationId,
        },
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 3,
          category: "reactionformula",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: reactionProductTypeId,
            name: "Reaction Product",
            quantity: 20,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "reaction-stockpile",
            name: "Reaction stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: reactionProductTypeId,
                name: "Reaction Product",
                quantity: 20,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const reactionJob = result.lists.reactionJobs.find((job) => job.typeId === reactionFormulaTypeId);

  assert(reactionJob);
  assert.equal(reactionJob.inputs.blueprint.availableQuantity, 1);
  assert.equal(reactionJob.inputs.blueprint.requiredQuantity, 1);
  assert.equal(reactionJob.inputs.blueprint.status, "ready");
  const reactionFormula = result.lists.planItems.find(
    (entry) => entry.kind === "reaction" && entry.typeId === reactionFormulaTypeId,
  );
  assert(reactionFormula && reactionFormula.kind === "reaction");
  assert.equal(reactionFormula.availableQuantity, 1);
  assert.equal(
    result.lists.materialsToBuy.some((item) => item.typeId === reactionFormulaTypeId),
    false,
  );
});

test("reports total and in-use reaction formulas without collapsing availability", async () => {
  const result = await calculatePlanCalculation(
    request(
      20,
      [
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 28,
          category: "reactionformula",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 54,
          category: "reactionformula",
          rootLocationId: alternateSourceLocationId,
          inUse: true,
        },
      ],
      {
        items: [
          {
            typeId: reactionProductTypeId,
            name: "Reaction Product",
            quantity: 20,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "reaction-counts",
            name: "Reaction counts",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: reactionProductTypeId,
                name: "Reaction Product",
                quantity: 20,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const reactionFormula = result.lists.planItems.find(
    (entry) => entry.kind === "reaction" && entry.typeId === reactionFormulaTypeId,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (entry) => entry.typeId === reactionFormulaTypeId,
  );

  assert(reactionFormula && reactionFormula.kind === "reaction");
  assert(reactionJob);
  assert.equal(reactionFormula.availableQuantity, 28);
  assert.equal(reactionFormula.bpoCount, 82);
  assert.equal(reactionFormula.bposInUse, 54);
  assert.equal(reactionJob.inputs.blueprint.availableQuantity, 28);

  const response = await toPlanResponse(result);
  const responseFormula = response.lists.planItems.all.find(
    (entry) => entry.kind === "reaction" && entry.typeId === reactionFormulaTypeId,
  );
  assert(responseFormula && responseFormula.kind === "reaction");
  assert.equal(responseFormula.availableQuantity, 28);
  assert.equal(responseFormula.bpoCount, 82);
  assert.equal(responseFormula.bposInUse, 54);
});

test("uses BPC runs held at a stockpile's manufacturing location", async () => {
  const result = await calculatePlanCalculation(
    request(
      1,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9005, type: "bpc", runs: 68 }],
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "manufacturing-stockpile",
            name: "Manufacturing stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const blueprint = result.lists.planItems
    .filter((entry) => entry.kind === "bpc")
    .find((entry) => entry.typeId === rifterBlueprintTypeId);

  assert(blueprint);
  assert.equal(blueprint.stockRuns, 68);
  assert.equal(blueprint.buyQuantity, 0);
});

test("does not strand shared BPC stock in a stockpile covered by item stock", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterTypeId,
          name: "Rifter",
          quantity: 1,
          category: "item",
          rootLocationId: 10,
        },
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: sourceLocationId,
          blueprintPrints: [{ itemId: 9006, type: "bpc", runs: 68 }],
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "stocked-stockpile",
            name: "Stocked stockpile",
            locations: {
              stock: 10,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "build-stockpile",
            name: "Build stockpile",
            locations: {
              stock: 11,
              manufacturing: 21,
              reactions: 21,
              reprocessing: 21,
              copying: 21,
              invention: 21,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const blueprint = result.lists.planItems
    .filter((entry) => entry.kind === "bpc")
    .find((entry) => entry.typeId === rifterBlueprintTypeId);

  assert(blueprint);
  assert.equal(blueprint.typeId, rifterBlueprintTypeId);
  assert.equal(blueprint.activityLocationId, 21);
  assert.equal(blueprint.stockRuns, 68);
  assert.equal(blueprint.buyQuantity, 0);
});

test("shares BPC runs across stockpiles when aggregate stock covers demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: sourceLocationId,
          blueprintPrints: [{ itemId: 9007, type: "bpc", runs: 68 }],
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "first-bpc-stockpile",
            name: "First BPC stockpile",
            locations: {
              stock: 10,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-bpc-stockpile",
            name: "Second BPC stockpile",
            locations: {
              stock: 11,
              manufacturing: 21,
              reactions: 21,
              reprocessing: 21,
              copying: 21,
              invention: 21,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.deepEqual(
    result.lists.bpcsToBuy
      .filter((entry) => entry.typeId === rifterBlueprintTypeId && entry.buyQuantity > 0)
      .map((entry) => ({
        neededQuantity: entry.neededQuantity,
        stockRuns: entry.stockRuns,
        buyQuantity: entry.buyQuantity,
        bpoCount: entry.bpoCount,
      })),
    [],
  );
});

test("uses BPO-backed BPC runs to cover another stockpile's purchase requirement", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: sourceLocationId,
          blueprintPrints: [
            { itemId: 9008, type: "bpo", runs: -1 },
            { itemId: 9009, type: "bpc", runs: 1105 },
          ],
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "bpo-backed-stockpile",
            name: "BPO-backed stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 303,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "bpc-purchase-stockpile",
            name: "BPC purchase stockpile",
            locations: {
              stock: 11,
              manufacturing: 21,
              reactions: 21,
              reprocessing: 21,
              copying: 21,
              invention: 21,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.equal(
    result.lists.bpcsToBuy.some(
      (entry) => entry.typeId === rifterBlueprintTypeId && entry.buyQuantity > 0,
    ),
    false,
  );
});

test("shares assets across stockpiles without merging identical destination plans", async () => {
  const firstActivityLocationId = manufacturingLocationId;
  const secondActivityLocationId = 21;
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 100,
          category: "item",
          rootLocationId: firstActivityLocationId,
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 50,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "first",
            name: "First destination",
            locations: {
              stock: 10,
              manufacturing: firstActivityLocationId,
              reactions: firstActivityLocationId,
              reprocessing: firstActivityLocationId,
              copying: firstActivityLocationId,
              invention: firstActivityLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second",
            name: "Second destination",
            locations: {
              stock: 11,
              manufacturing: secondActivityLocationId,
              reactions: secondActivityLocationId,
              reprocessing: secondActivityLocationId,
              copying: secondActivityLocationId,
              invention: secondActivityLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const material = result.lists.materialsToBuy.find((item) => item.typeId === tritaniumTypeId);

  assert.ok(material);
  assert.equal(material.stockQuantity, 150);
  assert.equal(material.buyQuantity, 50);
  const sharedHaul = result.lists.haulingTasks.find(
    (task) => task.typeId === tritaniumTypeId && task.fromLocationId === sourceLocationId,
  );
  assert(sharedHaul);
  assert.equal(sharedHaul.fromLocationId, sourceLocationId);
});

test("reports transferred stock as local availability", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 300,
          category: "item",
          rootLocationId: 21,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "remote-stock",
            name: "Remote stock",
            locations: {
              stock: 21,
              manufacturing: 21,
              reactions: 21,
              reprocessing: 21,
              copying: 21,
              invention: 21,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 200,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "local-demand",
            name: "Local demand",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const response = await toPlanResponse(result);
  const localPlanItem = response.lists.planItems.byActivityLocation
    .find((bucket) => bucket.locationId === manufacturingLocationId)
    ?.items.find((item) => item.typeId === tritaniumTypeId);
  const material = result.lists.materialsToBuy.find((entry) => entry.typeId === tritaniumTypeId);
  const transfer = result.lists.haulingTasks.find(
    (task) => task.typeId === tritaniumTypeId && task.toLocationId === manufacturingLocationId,
  );

  assert(localPlanItem);
  assert(material);
  assert(transfer);
  assert.equal(localPlanItem.availableQuantity, 100);
  assert.equal(localPlanItem.neededQuantity, 0);
  assert.equal(material.stockQuantity, 300);
  assert.equal(material.buyQuantity, 0);
  assert.equal(transfer.neededQuantity, 100);
});

test("hauls all remote stock needed for future material demand", async () => {
  const materialTypeId = 57457;
  const sourceLocationId = 1055354982663;
  const destinationLocationId = 1055354926818;
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: materialTypeId,
          name: "Reinforced Carbon Fiber",
          quantity: 88200,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: 37605,
            name: "Mino",
            quantity: 3,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "future-remote-material",
            name: "Future remote material",
            locations: {
              stock: destinationLocationId,
              manufacturing: destinationLocationId,
              reactions: sourceLocationId,
              reprocessing: sourceLocationId,
              copying: destinationLocationId,
              invention: destinationLocationId,
            },
            items: [
              {
                typeId: 37605,
                name: "Mino",
                quantity: 3,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const transfer = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === materialTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === destinationLocationId,
  );

  assert(transfer);
  assert.equal(transfer.neededQuantity, 88200);

  const response = await toPlanResponse(result);
  const allViewMaterial = response.lists.planItems.all.find(
    (item) => item.typeId === materialTypeId,
  );
  const destinationViewMaterial = response.lists.planItems.byActivityLocation
    .find((bucket) => bucket.locationId === destinationLocationId)
    ?.items.find((item) => item.typeId === materialTypeId);

  assert(allViewMaterial);
  assert(destinationViewMaterial);
  assert.equal(allViewMaterial.availableQuantity, 88200);
  assert.equal(destinationViewMaterial.availableQuantity, 88200);
});

test("reserves a stockpile's local assets before remote stockpiles can use them", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 100,
          category: "item",
          rootLocationId: 21,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "remote",
            name: "Remote destination",
            locations: {
              stock: 10,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "local",
            name: "Local destination",
            locations: {
              stock: 11,
              manufacturing: 21,
              reactions: 21,
              reprocessing: 21,
              copying: 21,
              invention: 21,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const material = result.lists.materialsToBuy.find((item) => item.typeId === tritaniumTypeId);

  assert.ok(material);
  assert.equal(material.stockQuantity, 100);
  assert.equal(material.buyQuantity, 100);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) => task.fromLocationId === 21 && task.toLocationId === 11,
    ),
    true,
  );
});

test("does not transfer partially stocked finished products between stockpiles", async () => {
  const finishedProductTypeId = 57457;
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: finishedProductTypeId,
          name: "Reinforced Carbon Fiber",
          quantity: 80,
          category: "item",
          rootLocationId: sourceLocationId,
          inBuild: true,
          inBuildQuantity: 80,
          jobId: 5745701,
          activityName: "Reactions",
          industryJobStatus: "ready",
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "partially-stocked-source",
            name: "Partially stocked source",
            locations: {
              stock: sourceLocationId,
              manufacturing: sourceLocationId,
              reactions: sourceLocationId,
              reprocessing: sourceLocationId,
              copying: sourceLocationId,
              invention: sourceLocationId,
            },
            items: [
              {
                typeId: finishedProductTypeId,
                name: "Reinforced Carbon Fiber",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "remote-destination",
            name: "Remote destination",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: alternateSourceLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: alternateSourceLocationId,
              copying: alternateSourceLocationId,
              invention: alternateSourceLocationId,
            },
            items: [
              {
                typeId: finishedProductTypeId,
                name: "Reinforced Carbon Fiber",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.typeId === finishedProductTypeId
        && task.fromLocationId === sourceLocationId
        && task.toLocationId === alternateSourceLocationId,
    ),
    false,
  );
});

test("caps finished-product transfers at the source stockpile overage", async () => {
  const finishedProductTypeId = 57457;
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: finishedProductTypeId,
          name: "Reinforced Carbon Fiber",
          quantity: 140,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "overstocked-source",
            name: "Overstocked source",
            locations: {
              stock: sourceLocationId,
              manufacturing: sourceLocationId,
              reactions: sourceLocationId,
              reprocessing: sourceLocationId,
              copying: sourceLocationId,
              invention: sourceLocationId,
            },
            items: [
              {
                typeId: finishedProductTypeId,
                name: "Reinforced Carbon Fiber",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "remote-destination",
            name: "Remote destination",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: alternateSourceLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: alternateSourceLocationId,
              copying: alternateSourceLocationId,
              invention: alternateSourceLocationId,
            },
            items: [
              {
                typeId: finishedProductTypeId,
                name: "Reinforced Carbon Fiber",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const transfer = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === finishedProductTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === alternateSourceLocationId,
  );

  assert(transfer);
  assert.equal(transfer.neededQuantity, 40);
});

test("uses activity-location stock before stockpile stock-location stock", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 39,
          name: "Zydrine",
          quantity: 1150,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 39,
          name: "Zydrine",
          quantity: 1150,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 8682,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 486,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 24,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: 205,
            name: "Nova Cruise Missile",
            quantity: 575,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "local-materials",
            name: "Local materials",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: 205,
                name: "Nova Cruise Missile",
                quantity: 575,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const zydrine = result.lists.materialsToBuy.find((material) => material.typeId === 39);

  assert(zydrine);
  assert(zydrine.stockQuantity > 0);
  assert.equal(zydrine.buyQuantity, 0);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.typeId === 39
        && task.fromLocationId === sourceLocationId
        && task.toLocationId === manufacturingLocationId,
    ),
    false,
  );
});

test("keeps activity stock for another demand before hauling it away", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 39,
          name: "Zydrine",
          quantity: 1150,
          category: "item",
          rootLocationId: 40,
        },
        {
          typeId: 39,
          name: "Zydrine",
          quantity: 244079,
          category: "item",
          rootLocationId: 20,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "multi-activity",
            name: "Multi-activity",
            locations: {
              stock: 20,
              manufacturing: 20,
              reactions: 40,
              reprocessing: 20,
              copying: 20,
              invention: 20,
            },
            items: [
              {
                typeId: 37605,
                name: "Keepstar",
                quantity: 3,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.deepEqual(
    result.lists.haulingTasks.filter((task) => task.typeId === 39),
    [],
  );
});

test("reserves stock for manufacturing inputs before direct stockpile demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 32000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 6000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 2500,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 500,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "standing-stock",
            name: "Standing stock",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 32000,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "manufacturing",
            name: "Manufacturing",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const material = result.lists.materialsToBuy.find((item) => item.typeId === tritaniumTypeId);
  const manufacturingJob = result.lists.manufacturingJobs.find(
    (job) => job.locationId === manufacturingLocationId && job.typeId === rifterBlueprintTypeId,
  );

  assert(material);
  assert(manufacturingJob);
  assert.equal(material.stockQuantity, 32000);
  assert.equal(material.buyQuantity, 32000);
  const tritaniumInput = manufacturingJob.inputs.materials.find(
    (input) => input.typeId === tritaniumTypeId,
  );
  assert(tritaniumInput);
  assert.equal(tritaniumInput.availableQuantity, 32000);
  assert.equal(tritaniumInput.status, "ready");
});

test("does not reserve blocked manufacturing inputs before reaction demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 1000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 46158,
          name: "Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 4312,
          name: "Oxygen Fuel Block",
          quantity: 5,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 30371,
          name: "Reaction Material A",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 30370,
          name: "Reaction Material B",
          quantity: 200,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9014, type: "bpo", runs: -1 }],
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "blocked-manufacturing",
            name: "Blocked manufacturing",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "reaction",
            name: "Reaction",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: alternateSourceLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: alternateSourceLocationId,
              copying: alternateSourceLocationId,
              invention: alternateSourceLocationId,
            },
            items: [
              {
                typeId: 30303,
                name: "Reaction Product",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const manufacturingJob = result.lists.manufacturingJobs.find(
    (job) => job.locationId === manufacturingLocationId && job.typeId === rifterBlueprintTypeId,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.locationId === alternateSourceLocationId && job.typeId === 46158,
  );
  const tritaniumHaul = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === tritaniumTypeId
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === alternateSourceLocationId,
  );

  assert(manufacturingJob);
  assert(reactionJob);
  assert.equal(manufacturingJob.runsAvailable, 0);
  assert(tritaniumHaul);
  assert.equal(tritaniumHaul.neededQuantity, 1000);
});

test("hauls remote Isogen surplus when destination manufacturing is blocked", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 37,
          name: "Isogen",
          quantity: 1000,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "blocked-isogen",
            name: "Blocked Isogen",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "other-manufacturing",
            name: "Other manufacturing",
            locations: {
              stock: sourceLocationId,
              manufacturing: sourceLocationId,
              reactions: sourceLocationId,
              reprocessing: reprocessingLocationId,
              copying: sourceLocationId,
              invention: sourceLocationId,
            },
            items: [
              {
                typeId: amarrShuttleTypeId,
                name: "Amarr Shuttle",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const isogen = result.lists.materialsToBuy.find((item) => item.typeId === 37);
  const manufacturingJob = result.lists.manufacturingJobs.find(
    (job) => job.locationId === manufacturingLocationId && job.typeId === rifterBlueprintTypeId,
  );

  assert(isogen);
  assert(manufacturingJob);
  assert.equal(manufacturingJob.runsAvailable, 0);
  assert.equal(isogen.buyQuantity, 0);
  const isogenHaul = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === 37
      && task.fromLocationId === alternateSourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );
  assert(isogenHaul);
  assert.equal(isogenHaul.neededQuantity, 500);
});

test("hauls remote mexallon for a reaction after blocked capital manufacturing", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 21018,
          name: "Capital Armor Plates Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9020, type: "bpo", runs: -1 }],
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 1_350_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 2870,
          name: "Capital Armor Plate Material",
          quantity: 150,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 34,
          name: "Tritanium",
          quantity: 1_350_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 4_725_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 360_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 38,
          name: "Nocxium",
          quantity: 36_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 39,
          name: "Zydrine",
          quantity: 18_450,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 46160,
          name: "Fullerene Intercalated Graphite Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 4246,
          name: "Helium Fuel Block",
          quantity: 5,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 30371,
          name: "Reaction Material A",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
        {
          typeId: 30372,
          name: "Reaction Material B",
          quantity: 100,
          category: "item",
          rootLocationId: alternateSourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: 21017,
            name: "Capital Armor Plates",
            quantity: 30,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: 30305,
            name: "Fullerene Intercalated Graphite",
            quantity: 120,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        stockpiles: [
          {
            id: "capital-reaction",
            name: "Capital reaction",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: 21017,
                name: "Capital Armor Plates",
                quantity: 30,
                me: 0,
                te: 0,
                fromCompression: false,
              },
              {
                typeId: 30305,
                name: "Fullerene Intercalated Graphite",
                quantity: 120,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const manufacturingJob = result.lists.manufacturingJobs.find((job) => job.typeId === 21018);
  const mexallonHaul = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === 36
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === alternateSourceLocationId,
  );

  assert(manufacturingJob);
  assert.equal(manufacturingJob.runsAvailable, 0);
  assert(mexallonHaul);
  assert.equal(mexallonHaul.neededQuantity, 600);
});

test("reserves fuel blocks for reaction inputs before direct stockpile demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: heliumFuelBlockTypeId,
          name: "Helium Fuel Block",
          quantity: 5,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 16633,
          name: "Reaction Material A",
          quantity: 100,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 16636,
          name: "Reaction Material B",
          quantity: 100,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: fuelReactionFormulaTypeId,
          name: "Fuel Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "fuel-stock",
            name: "Fuel stock",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: heliumFuelBlockTypeId,
                name: "Helium Fuel Block",
                quantity: 5,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "fuel-reaction",
            name: "Fuel reaction",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: fuelReactionProductTypeId,
                name: "Fuel Reaction Product",
                quantity: 200,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const directFuel = result.lists.materialsToBuy.find(
    (item) => item.typeId === heliumFuelBlockTypeId,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.locationId === manufacturingLocationId && job.typeId === fuelReactionFormulaTypeId,
  );

  assert(directFuel);
  assert(reactionJob);
  assert.equal(directFuel.stockQuantity, 5);
  assert.equal(directFuel.buyQuantity, 0);
  assert.equal(directFuel.productionQuantity > 0, true);
  const fuelInput = reactionJob.inputs.materials.find(
    (input) => input.typeId === heliumFuelBlockTypeId,
  );
  assert(fuelInput);
  assert.equal(fuelInput.availableQuantity, 5);
  assert.equal(fuelInput.status, "ready");
  assert.equal(reactionJob.inputs.status, "ready");
});

test("combines haul tasks with the same type and route", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 64000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 12000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 5000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 1000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "first-route",
            name: "First destination",
            locations: {
              stock: 10,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-route",
            name: "Second destination",
            locations: {
              stock: 11,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const matchingHauls = result.lists.haulingTasks.filter(
    (task) =>
      task.typeId === tritaniumTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );

  assert.equal(matchingHauls.length, 1);
  assert.equal(matchingHauls[0]?.neededQuantity, 64000);
});

test("merges shared haul routes across ownership sources", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 32000,
          category: "item",
          rootLocationId: sourceLocationId,
          ownerType: "character",
          ownerId: 101,
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 32000,
          category: "item",
          rootLocationId: sourceLocationId,
          ownerType: "corporation",
          ownerId: 202,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 12000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 5000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 1000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "owned-route",
            name: "Owned route",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 2,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  const tritaniumHauls = result.lists.haulingTasks.filter(
    (task) =>
      task.typeId === tritaniumTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );

  assert.equal(tritaniumHauls.length, 2);
  assert.equal(
    tritaniumHauls.find((task) => task.ownerType === "character")?.neededQuantity,
    32000,
  );
  assert.equal(
    tritaniumHauls.find((task) => task.ownerType === "corporation")?.neededQuantity,
    32000,
  );

  const response = await toPlanResponse(result);
  const buckets = response.lists.haulingTasks
    .filter(
      (entry) =>
        entry.fromLocationId === sourceLocationId && entry.toLocationId === manufacturingLocationId,
    )
    .filter((entry) => entry.items.some((item) => item.typeId === tritaniumTypeId));
  assert.equal(buckets.length, 2);
  const characterBucket = buckets.find((entry) => entry.ownerType === "character");
  const corporationBucket = buckets.find((entry) => entry.ownerType === "corporation");
  assert(characterBucket);
  assert(corporationBucket);
  assert.equal(characterBucket.ownerId, 101);
  assert.equal(corporationBucket.ownerId, 202);
  assert.equal("context" in characterBucket, false);
  assert.equal("context" in corporationBucket, false);
  assert.equal(
    characterBucket.items.find((item) => item.typeId === tritaniumTypeId)?.neededQuantity,
    32000,
  );
  assert.equal(
    corporationBucket.items.find((item) => item.typeId === tritaniumTypeId)?.neededQuantity,
    32000,
  );
});

test("hauls ready manufactured stock to the stockpile stock location", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [industryOutputStock("ready", manufacturingLocationId)],
      {
        items: [],
        stockpiles: [
          {
            id: "finished",
            name: "Finished stock",
            locations: {
              stock: reprocessingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const outputHaul = result.lists.haulingTasks.find((task) => task.typeId === tritaniumTypeId);

  assert(outputHaul);
  assert.equal(outputHaul.fromLocationId, manufacturingLocationId);
  assert.equal(outputHaul.toLocationId, reprocessingLocationId);
  assert.equal(outputHaul.neededQuantity, 100);
});

test("hauls ordinary final-product stock to the stockpile stock location", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 100,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "ordinary-final-stock",
            name: "Ordinary final stock",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const outputHaul = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === tritaniumTypeId
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === sourceLocationId,
  );

  assert(outputHaul);
  assert.equal(outputHaul.neededQuantity, 100);
});

test("reserves final-location stock before build-location output for a stockpile", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        industryOutputStock("delivered", manufacturingLocationId),
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 122,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "final-stock-priority",
            name: "Final stock priority",
            locations: {
              stock: reprocessingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 150,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const outputHaul = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === tritaniumTypeId
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === reprocessingLocationId,
  );

  assert(outputHaul);
  assert.equal(outputHaul.neededQuantity, 28);
});

test("does not move final-destination stock to the manufacturing location", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: heliumFuelBlockTypeId,
          name: "Helium Fuel Block",
          quantity: 100,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "fuel-stock",
            name: "Fuel stock",
            locations: {
              stock: reprocessingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: reprocessingLocationId,
              invention: reprocessingLocationId,
            },
            items: [
              {
                typeId: heliumFuelBlockTypeId,
                name: "Helium Fuel Block",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.deepEqual(result.lists.haulingTasks, []);
});

test("plans input delivery and ready output delivery as separate hauls", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterTypeId,
          name: "Rifter",
          quantity: 1,
          category: "item",
          rootLocationId: manufacturingLocationId,
          inBuild: true,
          inBuildQuantity: 1,
          jobId: 123,
          activityName: "Manufacturing",
          industryJobStatus: "ready",
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 32000,
          category: "item",
          rootLocationId: sourceLocationId,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 6000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 2500,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 500,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "two-leg",
            name: "Two leg plan",
            locations: {
              stock: reprocessingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 2,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const inputHaul = result.lists.haulingTasks.find(
    (task) =>
      task.typeId === tritaniumTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );
  const outputHauls = result.lists.haulingTasks.filter(
    (task) =>
      task.typeId === rifterTypeId
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === reprocessingLocationId,
  );

  assert(inputHaul);
  assert.equal(inputHaul.neededQuantity, 32000);
  assert.equal(
    outputHauls.reduce((total, task) => total + task.neededQuantity, 0),
    1,
  );
});

test("uses sell orders only from the selected market location", async () => {
  const result = await calculatePlanCalculation(
    request(
      100,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 100,
          category: "item",
          source: "marketOrder",
          rootLocationId: sourceLocationId,
        },
      ],
    ),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(tritanium);
  assert.equal(tritanium.stockQuantity, 0);
  assert.equal(tritanium.buyQuantity, 100);
});

test("uses ready and delivered manufacturing and reaction output locally", async () => {
  for (const status of ["ready", "delivered"] as const) {
    for (const activityName of ["Manufacturing", "Reactions"]) {
      const result = await calculatePlanCalculation(
        request(100, [industryOutputStock(status, manufacturingLocationId, activityName)]),
      );
      const tritanium = result.lists.materialsToBuy.find(
        (material) => material.typeId === tritaniumTypeId,
      );

      assert(tritanium);
      assert.equal(tritanium.stockQuantity, 100);
      assert.equal(tritanium.buyQuantity, 0);
      assert.equal(tritanium.availableSourceCounts, undefined);
      assert.deepEqual(result.lists.haulingTasks, []);
    }
  }
});

test("does not use remote active output as a future job input", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [industryOutputStock("active", sourceLocationId)],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(tritanium);
  assert.equal(tritanium.stockQuantity, 0);
  assert.equal(tritanium.availableStockQuantity, 100);
  assert.equal(tritanium.buyQuantity, 31900);
  assert.equal(
    result.lists.manufacturingJobs[0]?.inputs.materials.find(
      (material) => material.typeId === tritaniumTypeId,
    )?.availableQuantity,
    0,
  );
  assert.deepEqual(result.lists.haulingTasks, []);
});

test("reports manufacturing blueprint and material inputs", async () => {
  const result = await calculatePlanCalculation(
    request(
      1,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9001, type: "bpo", runs: -1 }],
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 32_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  assert(job);
  assert.equal(job.inputs.blueprint.availableQuantity, 1);
  assert.equal(job.inputs.blueprint.requiredQuantity, 1);
  const tritanium = job.inputs.materials.find((input) => input.typeId === tritaniumTypeId);
  assert(tritanium);
  assert.equal(tritanium.availableQuantity, 32_000);
  assert.equal(tritanium.requiredQuantity, 32_000);
  assert.equal(tritanium.completionPercent, 100);
});

test("requires buying copies when the owned BPO is in use", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          inUse: true,
          blueprintPrints: [{ itemId: 9002, type: "bpo", runs: -1 }],
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 1,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const entry = result.lists.bpcsToBuy.find((item) => item.typeId === rifterBlueprintTypeId);
  assert(entry);
  assert.equal(entry.bpoCount, 0);
  assert.equal(entry.bposInUse, 1);
  assert.equal(entry.buyQuantity, 1);

  const response = await toPlanResponse(result);
  assert.equal("bpcsNeeded" in response.lists, false);
  assert.equal("bpcsToBuy" in response.lists, false);
  assert.equal(response.lists.bpcToCopy.length, 0);
  assert.deepEqual(
    response.lists.bpoToBuy,
    [
      {
        assemblyLineGroup: response.lists.bpoToBuy[0].assemblyLineGroup,
        items: [
          {
            typeId: rifterBlueprintTypeId,
            typeName: "Rifter Blueprint",
            unitVolume: entry.unitVolume,
            neededQuantity: 1,
            bpoCount: 1,
            bposInUse: 1,
          },
        ],
      },
    ],
  );
});

test("routes all runs to copying when an available BPO has no print metadata", async () => {
  const requiredRuns = 11;
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          blueprintType: "bpo",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: requiredRuns,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const copyEntry = result.lists.bpcsNeeded.find((entry) => entry.typeId === rifterBlueprintTypeId);
  assert(copyEntry);
  assert.equal(copyEntry.bpoCount, 1);
  assert.equal(copyEntry.neededQuantity, requiredRuns);
  assert.equal(copyEntry.stockRuns, 0);
  assert.equal(
    result.lists.bpcsToBuy.some((entry) => entry.typeId === rifterBlueprintTypeId),
    false,
  );
  const response = await toPlanResponse(result);
  assert.deepEqual(
    response.lists.bpcToCopy,
    [
      {
        locationId: manufacturingLocationId,
        items: [
          {
            typeId: rifterBlueprintTypeId,
            typeName: "Rifter Blueprint",
            unitVolume: copyEntry.unitVolume,
            neededQuantity: copyEntry.buyQuantity,
            bpoCount: copyEntry.bpoCount + (copyEntry.bposInUse ?? 0),
            bposInUse: copyEntry.bposInUse ?? 0,
          },
        ],
      },
    ],
  );
  assert.equal(Object.keys(response.lists.bpcToCopy[0]?.items[0] ?? {}).length, 6);
});

test("reports installable runs for 10 Rifters and 10 Amarr Shuttles", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9010, type: "bpo", runs: -1 }],
        },
        {
          typeId: amarrShuttleBlueprintTypeId,
          name: "Amarr Shuttle Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9011, type: "bpo", runs: -1 }],
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 160_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 60_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 25_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 5_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 25618,
          name: "Amarr Shuttle Material 1",
          quantity: 50,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 25611,
          name: "Amarr Shuttle Material 2",
          quantity: 60,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 25620,
          name: "Amarr Shuttle Material 3",
          quantity: 80,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 11486,
          name: "Amarr Shuttle Material 4",
          quantity: 10,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 10,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: amarrShuttleTypeId,
            name: "Amarr Shuttle",
            quantity: 10,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const rifterJob = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );
  const shuttleJob = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === amarrShuttleBlueprintTypeId,
  );

  assert(rifterJob);
  assert(shuttleJob);
  assert.equal(rifterJob.countNeeded, 10);
  assert.equal(rifterJob.runsAvailable, 5);
  const tritanium = rifterJob.inputs.materials.find((input) => input.typeId === tritaniumTypeId);
  assert(tritanium);
  assert.equal(tritanium.requiredQuantity, 320_000);
  assert.equal(tritanium.availableQuantity, 160_000);
  assert.equal(tritanium.completionPercent, 50);
  assert.equal(rifterJob.inputs.status, "partial");
  assert.equal(shuttleJob.inputs.status, "ready");
});

test("reserves only installable runs before the next manufacturing step", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9012, type: "bpo", runs: -1 }],
        },
        {
          typeId: sharedTritaniumBlueprintTypeId,
          name: "Shared Tritanium Product Blueprint",
          quantity: 1,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [{ itemId: 9013, type: "bpo", runs: -1 }],
        },
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 160_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 35,
          name: "Pyerite",
          quantity: 126_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 36,
          name: "Mexallon",
          quantity: 52_500,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 37,
          name: "Isogen",
          quantity: 10_500,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 10,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: sharedTritaniumProductTypeId,
            name: "Shared Tritanium Product",
            quantity: 10,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const sharedMaterialJob = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === sharedTritaniumBlueprintTypeId,
  );

  assert(sharedMaterialJob);
  assert.equal(sharedMaterialJob.runsAvailable, 0);
  const tritanium = sharedMaterialJob.inputs.materials.find(
    (input) => input.typeId === tritaniumTypeId,
  );
  assert(tritanium);
  assert.equal(tritanium.availableQuantity, 0);
});

test("reports total available BPC runs for manufacturing inputs", async () => {
  const result = await calculatePlanCalculation(
    request(
      88,
      [
        {
          typeId: rifterBlueprintTypeId,
          name: "Rifter Blueprint",
          quantity: 3,
          category: "blueprint",
          rootLocationId: manufacturingLocationId,
          blueprintPrints: [
            { itemId: 9002, type: "bpc", runs: 30 },
            { itemId: 9003, type: "bpc", runs: 29 },
            { itemId: 9004, type: "bpc", runs: 29 },
          ],
        },
      ],
      {
        items: [
          {
            typeId: rifterTypeId,
            name: "Rifter",
            quantity: 88,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const job = result.lists.manufacturingJobs.find(
    (entry) => entry.typeId === rifterBlueprintTypeId,
  );

  assert(job);
  assert.equal(job.inputs.blueprint.availableQuantity, 88);
  assert.equal(job.inputs.blueprint.requiredQuantity, 88);
  assert.equal(job.inputs.blueprint.completionPercent, 100);
});

test("reports reaction formula and material inputs", async () => {
  const result = await calculatePlanCalculation(
    request(
      20,
      [
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 16657,
          name: "Reaction Material A",
          quantity: 100,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 16661,
          name: "Reaction Material B",
          quantity: 100,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 4051,
          name: "Reaction Material C",
          quantity: 5,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: reactionProductTypeId,
            name: "Reaction Product",
            quantity: 20,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const job = result.lists.reactionJobs.find((entry) => entry.typeId === reactionFormulaTypeId);
  assert(job);
  assert.equal(job.inputs.blueprint.availableQuantity, 1);
  assert.equal(job.inputs.blueprint.requiredQuantity, 1);
  assert.equal(job.inputs.materials.length, 3);
  assert.equal(
    job.inputs.materials.every((input) => input.completionPercent === 100),
    true,
  );
  assert.equal(job.inputs.status, "ready");
});

test("builds Carbon Polymers through its reaction formula", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: fuelReactionFormulaTypeId,
          name: "Carbon Polymers Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: heliumFuelBlockTypeId,
          name: "Helium Fuel Block",
          quantity: 845,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: hydrocarbonsTypeId,
          name: "Hydrocarbons",
          quantity: 16_900,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 16636,
          name: "Silicates",
          quantity: 16_900,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: fuelReactionProductTypeId,
            name: "Carbon Polymers",
            quantity: 33_800,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const carbonPurchase = result.lists.materialsToBuy.find(
    (material) => material.typeId === fuelReactionProductTypeId,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.typeId === fuelReactionFormulaTypeId,
  );

  assert(carbonPurchase);
  assert.equal(carbonPurchase.buyQuantity, 0);
  assert(reactionJob);
  assert.equal(reactionJob.countNeeded, 169);
  assert.equal(reactionJob.inputs.status, "ready");
});

test("does not buy a buildable reaction product when output rounding covers demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: 57493,
          name: "Reinforced Carbon Fiber Reaction Formula",
          quantity: 1,
          category: "reactionformula",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 57453,
          name: "Carbon Fiber",
          quantity: 214_200,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 57454,
          name: "Oxy-Organic Solvents",
          quantity: 1_071,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: 57455,
          name: "Thermosetting Polymer",
          quantity: 214_200,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "rounded-reaction-output",
            name: "Rounded reaction output",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: manufacturingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: 57457,
                name: "Reinforced Carbon Fiber",
                quantity: 214_183,
                me: 0,
                te: 0,
                fromCompression: false,
              },
              {
                typeId: 57457,
                name: "Reinforced Carbon Fiber",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const material = result.lists.materialsToBuy.find((entry) => entry.typeId === 57457);

  assert(material);
  assert.equal(material.requiredQuantity, 214_184);
  assert.equal(material.productionQuantity, 214_200);
  assert.equal(material.buyQuantity, 0);
});

test("accumulates installable reaction runs across repeated expansions", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: oxyOrganicSolventsFormulaTypeId,
          name: "Oxy-Organic Solvents Reaction Formula",
          quantity: 4,
          category: "reactionformula",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: hydrocarbonsTypeId,
          name: "Hydrocarbons",
          quantity: 5_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: atmosphericGasesTypeId,
          name: "Atmospheric Gases",
          quantity: 5_000,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: oxygenFuelBlockTypeId,
          name: "Oxygen Fuel Block",
          quantity: 10,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: oxyOrganicSolventsTypeId,
            name: "Oxy-Organic Solvents",
            quantity: 20,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: oxyOrganicSolventsTypeId,
            name: "Oxy-Organic Solvents",
            quantity: 20,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ),
  );
  const job = result.lists.reactionJobs.find(
    (entry) => entry.typeId === oxyOrganicSolventsFormulaTypeId,
  );

  assert(job);
  assert.equal(job.countNeeded, 4);
  assert.equal(job.runsAvailable, 2);
});

test("merges reaction jobs by reaction location and formula type", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [],
        stockpiles: [
          {
            id: "first-reaction-stockpile",
            name: "First reaction stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: reactionProductTypeId,
                name: "Reaction Product",
                quantity: 20,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-reaction-stockpile",
            name: "Second reaction stockpile",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: reactionProductTypeId,
                name: "Reaction Product",
                quantity: 20,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.equal(
    result.lists.reactionJobs.filter(
      (job) => job.typeId === reactionFormulaTypeId && job.locationId === manufacturingLocationId,
    ).length,
    1,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.typeId === reactionFormulaTypeId && job.locationId === manufacturingLocationId,
  );
  assert(reactionJob);
  assert.equal(reactionJob.inputs.blueprint.availableQuantity, 0);
  assert.equal(reactionJob.inputs.blueprint.requiredQuantity, 1);
  assert.equal(reactionJob.inputs.materials.length, 3);
  assert.equal("stockpileId" in reactionJob, false);
  const response = await toPlanResponse(result);
  const reactionPlanItems = response.lists.planItems.byActivityLocation
    .find((bucket) => bucket.locationId === manufacturingLocationId)
    ?.items.filter((entry) => entry.typeId === reactionFormulaTypeId);
  assert(reactionPlanItems);
  assert.equal(reactionPlanItems.length, 1);
  const reactionPlanItem = reactionPlanItems[0];
  assert(reactionPlanItem);
  assert.equal(reactionPlanItem.kind, "reaction");
  assert.equal(
    response.lists.planItems.all.filter((entry) => entry.typeId === reactionFormulaTypeId).length,
    1,
  );
});

test("merges manufacturing jobs by blueprint type across stockpiles", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [],
        stockpiles: [
          {
            id: "first-manufacturing-stockpile",
            name: "First manufacturing stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-manufacturing-stockpile",
            name: "Second manufacturing stockpile",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  const manufacturingJobs = result.lists.manufacturingJobs.filter(
    (job) => job.typeId === rifterBlueprintTypeId,
  );
  assert.equal(manufacturingJobs.length, 1);
  const manufacturingJob = manufacturingJobs[0];
  assert(manufacturingJob);
  assert.equal(manufacturingJob.countNeeded, 2);
  assert.equal(manufacturingJob.locationId, manufacturingLocationId);
  assert.equal("stockpileId" in manufacturingJob, false);
  assert.equal("buildLocationId" in manufacturingJob, false);
});

test("keeps manufacturing jobs separate across build locations", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [],
        stockpiles: [
          {
            id: "first-location-stockpile",
            name: "First location stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-location-stockpile",
            name: "Second location stockpile",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: alternateSourceLocationId,
              reactions: alternateSourceLocationId,
              reprocessing: reprocessingLocationId,
              copying: alternateSourceLocationId,
              invention: alternateSourceLocationId,
            },
            items: [
              {
                typeId: rifterTypeId,
                name: "Rifter",
                quantity: 1,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  assert.deepEqual(
    result.lists.manufacturingJobs
      .filter((job) => job.typeId === rifterBlueprintTypeId)
      .map((job) => [job.locationId, job.countNeeded]),
    [
      [manufacturingLocationId, 1],
      [alternateSourceLocationId, 1],
    ],
  );
});

test("allocates reaction formulas at the reaction location to stockpile jobs", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: reactionFormulaTypeId,
          name: "Reaction Formula",
          quantity: 14,
          category: "reactionformula",
          rootLocationId: manufacturingLocationId,
        },
      ],
      {
        items: [],
        stockpiles: [
          {
            id: "first-formula-stockpile",
            name: "First formula stockpile",
            locations: {
              stock: sourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: reactionProductTypeId,
                name: "Reaction Product",
                quantity: 20,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
          {
            id: "second-formula-stockpile",
            name: "Second formula stockpile",
            locations: {
              stock: alternateSourceLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: reactionProductTypeId,
                name: "Reaction Product",
                quantity: 20,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );

  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.typeId === reactionFormulaTypeId && job.locationId === manufacturingLocationId,
  );
  assert(reactionJob);
  assert.equal(reactionJob.inputs.blueprint.availableQuantity, 2);
  assert.equal(reactionJob.inputs.blueprint.requiredQuantity, 1);
  const reactionPlanItem = result.lists.planItems.find(
    (entry) => entry.kind === "reaction" && entry.typeId === reactionFormulaTypeId,
  );
  assert(reactionPlanItem && reactionPlanItem.kind === "reaction");
  assert.equal(reactionPlanItem.availableQuantity, 14);
  assert.equal(reactionPlanItem.bpoCount, 14);
  assert.equal(reactionPlanItem.bposInUse, 0);

  const response = await toPlanResponse(result);
  const responsePlanItem = response.lists.planItems.all.find(
    (entry) => entry.kind === "reaction" && entry.typeId === reactionFormulaTypeId,
  );
  assert(responsePlanItem && responsePlanItem.kind === "reaction");
  assert.equal(responsePlanItem.availableQuantity, 14);
  assert.equal(responsePlanItem.bpoCount, 14);
  assert.equal(responsePlanItem.bposInUse, 0);
});

test("does not reprocess or haul compressed stock when direct materials cover demand", async () => {
  const result = await calculatePlanCalculation(
    request(
      400,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 400,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        compressedStock(250),
      ],
      { reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 } },
    ),
  );

  assert.deepEqual(result.lists.haulingTasks, []);
});

test("hauls only complete compressed portions needed by the plan", async () => {
  const result = await calculatePlanCalculation(
    request(
      500,
      [compressedStock(250)],
      {
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
      },
    ),
  );
  const refineryHaul = result.lists.haulingTasks.find(
    (task) => task.typeId === compressedVeldsparTypeId,
  );

  assert.equal(refineryHaul?.neededQuantity, 200);
  assert.equal(refineryHaul.fromLocationId, sourceLocationId);
  assert.equal(refineryHaul.toLocationId, reprocessingLocationId);
  assert.equal(
    result.lists.haulingTasks.some((task) => task.typeId === tritaniumTypeId),
    false,
  );
  assert.deepEqual(result.lists.reprocessingJobs, []);
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );
  assert(tritanium);
  assert.equal(tritanium.availableStockQuantity, 800);
  assert.equal(tritanium.productionQuantity, 800);
  const compressedVeldspar = result.lists.planItems.find(
    (item) => item.kind === "material" && item.typeId === compressedVeldsparTypeId,
  );
  assert(compressedVeldspar?.kind === "material");
  assert.equal(compressedVeldspar.requiredQuantity, 200);
  assert.equal(compressedVeldspar.availableStockQuantity, 250);
});

test("hauls Gneiss when remote direct stock leaves a material shortage", async () => {
  const compressedGneissTypeId = 62553;
  const result = await calculatePlanCalculation(
    request(
      0,
      [
        {
          typeId: compressedGneissTypeId,
          name: "Compressed Gneiss II-Grade",
          quantity: 120_400,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: 37,
            name: "Isogen",
            quantity: 6_004,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        reprocessingEfficiencies: { [compressedGneissTypeId]: 52.75 },
      },
    ),
  );
  const isogen = result.lists.materialsToBuy.find((material) => material.typeId === 37);
  const gneissHaul = result.lists.haulingTasks.find(
    (task) => task.typeId === compressedGneissTypeId,
  );

  assert(isogen);
  assert(gneissHaul);
  assert.equal(isogen.buyQuantity, 0);
  assert.equal(isogen.productionQuantity, 6_203);
  assert.equal(gneissHaul.neededQuantity, 1_400);
  assert.equal(gneissHaul.fromLocationId, sourceLocationId);
  assert.equal(gneissHaul.toLocationId, reprocessingLocationId);
});

test("lists only selected stock already at the refinery for immediate reprocessing", async () => {
  const result = await calculatePlanCalculation(
    request(
      500,
      [{ ...compressedStock(100), rootLocationId: reprocessingLocationId }, compressedStock(150)],
      { reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 } },
    ),
  );

  assert.equal(result.lists.reprocessingJobs[0]?.countNeeded, 100);
  assert.equal(result.lists.reprocessingJobs[0]?.locationId, reprocessingLocationId);
  assert.equal(
    result.lists.haulingTasks.find(
      (task) =>
        task.typeId === compressedVeldsparTypeId && task.toLocationId === reprocessingLocationId,
    )?.neededQuantity,
    100,
  );
});

test("credits committed compressed purchases before considering owned stock", async () => {
  const result = await calculatePlanCalculation(
    request(
      800,
      [compressedStock(100)],
      {
        items: [
          ...request(800, []).items,
          {
            typeId: compressedVeldsparTypeId,
            name: "Compressed Veldspar",
            quantity: 500,
            me: 0,
            te: 0,
            fromCompression: true,
          },
        ],
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
      },
    ),
  );
  const purchase = result.lists.materialsToBuy.find(
    (material) => material.typeId === compressedVeldsparTypeId,
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(purchase);
  assert(tritanium);
  assert.equal(purchase.requiredQuantity, 500);
  assert.equal(purchase.buyQuantity, 500);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal(tritanium.productionQuantity, 2_000);
  assert.equal(
    result.lists.haulingTasks.some((task) => task.typeId === compressedVeldsparTypeId),
    false,
  );
});

test("shares future materials from compressed purchases across stockpiles", async () => {
  const result = await calculatePlanCalculation(
    request(
      0,
      [],
      {
        items: [],
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 50 },
        stockpiles: [
          {
            id: "compressed-inputs",
            name: "Compressed inputs",
            kind: "special",
            reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
            locations: {
              stock: reprocessingLocationId,
              manufacturing: reprocessingLocationId,
              reactions: reprocessingLocationId,
              reprocessing: reprocessingLocationId,
              copying: reprocessingLocationId,
              invention: reprocessingLocationId,
            },
            items: [
              {
                typeId: compressedVeldsparTypeId,
                name: "Compressed Veldspar",
                quantity: 100,
                me: 0,
                te: 0,
                fromCompression: true,
              },
            ],
          },
          {
            id: "manufacturing",
            name: "Manufacturing",
            locations: {
              stock: manufacturingLocationId,
              manufacturing: manufacturingLocationId,
              reactions: manufacturingLocationId,
              reprocessing: reprocessingLocationId,
              copying: manufacturingLocationId,
              invention: manufacturingLocationId,
            },
            items: [
              {
                typeId: tritaniumTypeId,
                name: "Tritanium",
                quantity: 400,
                me: 0,
                te: 0,
                fromCompression: false,
              },
            ],
          },
        ],
      },
    ),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );
  const compressed = result.lists.materialsToBuy.find(
    (material) => material.typeId === compressedVeldsparTypeId,
  );

  assert(tritanium);
  assert(compressed);
  assert.equal(tritanium.stockQuantity, 400);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal(compressed.buyQuantity, 100);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.typeId === tritaniumTypeId
        && task.fromLocationId === reprocessingLocationId
        && task.toLocationId === manufacturingLocationId,
    ),
    true,
  );
});

test("retains an incomplete committed purchase without crediting an unusable portion", async () => {
  const result = await calculatePlanCalculation(
    request(
      400,
      [],
      {
        items: [
          ...request(400, []).items,
          {
            typeId: compressedVeldsparTypeId,
            name: "Compressed Veldspar",
            quantity: 50,
            me: 0,
            te: 0,
            fromCompression: true,
          },
        ],
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
      },
    ),
  );
  const purchase = result.lists.materialsToBuy.find(
    (material) => material.typeId === compressedVeldsparTypeId,
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(purchase);
  assert(tritanium);
  assert.equal(purchase.requiredQuantity, 50);
  assert.equal(purchase.buyQuantity, 50);
  assert.equal(tritanium.buyQuantity, 400);
});

test("uses owned reprocessable stock after committed purchases leave a shortage", async () => {
  const result = await calculatePlanCalculation(
    request(
      800,
      [compressedStock(100)],
      {
        items: [
          ...request(800, []).items,
          {
            typeId: compressedVeldsparTypeId,
            name: "Compressed Veldspar",
            quantity: 100,
            me: 0,
            te: 0,
            fromCompression: true,
          },
        ],
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
      },
    ),
  );
  const purchase = result.lists.materialsToBuy.find(
    (material) => material.typeId === compressedVeldsparTypeId,
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(purchase);
  assert(tritanium);
  assert.equal(purchase.requiredQuantity, 200);
  assert.equal(purchase.stockQuantity, 100);
  assert.equal(purchase.buyQuantity, 100);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal(tritanium.productionQuantity, 800);
  assert.equal(
    result.lists.haulingTasks.find((task) => task.typeId === compressedVeldsparTypeId)
      ?.neededQuantity,
    100,
  );
});

test("credits aggregate fractional gas output against the raw material buy quantity", async () => {
  const result = await calculatePlanCalculation(
    request(
      100,
      [],
      {
        items: [
          {
            typeId: amberMykoserocinTypeId,
            name: "Amber Mykoserocin",
            quantity: 100,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: compressedAmberMykoserocinTypeId,
            name: "Compressed Amber Mykoserocin",
            quantity: 106,
            me: 0,
            te: 0,
            fromCompression: true,
          },
        ],
        reprocessingEfficiencies: { [compressedAmberMykoserocinTypeId]: 95 },
      },
    ),
  );
  const compressedGas = result.lists.materialsToBuy.find(
    (material) => material.typeId === compressedAmberMykoserocinTypeId,
  );
  const rawGas = result.lists.materialsToBuy.find(
    (material) => material.typeId === amberMykoserocinTypeId,
  );

  assert(compressedGas);
  assert(rawGas);
  assert.equal(compressedGas.buyQuantity, 106);
  assert.equal(rawGas.productionQuantity, 100);
  assert.equal(rawGas.buyQuantity, 0);
});

test("makes refinery compressed stock available as reprocessed material", async () => {
  const result = await calculatePlanCalculation(
    request(
      100,
      [
        {
          typeId: compressedAmberMykoserocinTypeId,
          name: "Compressed Amber Mykoserocin",
          quantity: 106,
          category: "item",
          rootLocationId: reprocessingLocationId,
        },
      ],
      {
        items: [
          {
            typeId: amberMykoserocinTypeId,
            name: "Amber Mykoserocin",
            quantity: 100,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        reprocessingEfficiencies: { [compressedAmberMykoserocinTypeId]: 95 },
      },
    ),
  );
  const rawGas = result.lists.materialsToBuy.find(
    (material) => material.typeId === amberMykoserocinTypeId,
  );

  assert(rawGas);
  assert.equal(rawGas.availableStockQuantity, 100);
  assert.equal((rawGas.availableSourceCounts?.[reprocessingLocationId] ?? {}).reprocessing, 100);
  assert.equal(rawGas.buyQuantity, 0);
});

test("consumes owned compressed gas surplus and hauls it to the refinery", async () => {
  const result = await calculatePlanCalculation(
    request(
      7_240,
      [
        {
          typeId: amberMykoserocinTypeId,
          name: "Amber Mykoserocin",
          quantity: 3_250,
          category: "item",
          rootLocationId: manufacturingLocationId,
        },
        {
          typeId: compressedAmberMykoserocinTypeId,
          name: "Compressed Amber Mykoserocin",
          quantity: 2_748,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      {
        items: [
          {
            typeId: amberMykoserocinTypeId,
            name: "Amber Mykoserocin",
            quantity: 7_240,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        reprocessingEfficiencies: { [compressedAmberMykoserocinTypeId]: 90 },
      },
    ),
  );
  const rawGas = result.lists.materialsToBuy.find(
    (material) => material.typeId === amberMykoserocinTypeId,
  );
  const compressedGas = result.lists.materialsToBuy.find(
    (material) => material.typeId === compressedAmberMykoserocinTypeId,
  );
  const compressedHaul = result.lists.haulingTasks.find(
    (task) => task.typeId === compressedAmberMykoserocinTypeId,
  );

  assert(rawGas);
  assert(compressedGas);
  assert(compressedHaul);
  assert.equal(rawGas.productionQuantity, 2_473);
  assert.equal(rawGas.buyQuantity, 1_517);
  assert.equal(compressedGas.requiredQuantity, 2_748);
  assert.equal(compressedGas.stockQuantity, 2_748);
  assert.equal(compressedGas.buyQuantity, 0);
  assert.equal(compressedHaul.neededQuantity, 2_748);
  assert.equal(compressedHaul.fromLocationId, sourceLocationId);
  assert.equal(compressedHaul.toLocationId, reprocessingLocationId);
});

test("falls back to 50 percent when no efficiency snapshot is supplied", async () => {
  const result = await calculatePlanCalculation(request(300, [compressedStock(250)]));
  const refineryHaul = result.lists.haulingTasks.find(
    (task) => task.typeId === compressedVeldsparTypeId,
  );

  assert.equal(refineryHaul?.neededQuantity, 200);
});

test("reserves compressed stock that is required directly by the plan", async () => {
  const result = await calculatePlanCalculation(
    request(
      400,
      [compressedStock(200)],
      {
        items: [
          ...request(400, []).items,
          {
            typeId: compressedVeldsparTypeId,
            name: "Compressed Veldspar",
            quantity: 100,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
      },
    ),
  );
  const compressedHauls = result.lists.haulingTasks.filter(
    (task) => task.typeId === compressedVeldsparTypeId,
  );

  assert.equal(
    compressedHauls.find((task) => task.toLocationId === reprocessingLocationId)?.neededQuantity,
    100,
  );
  assert.equal(
    compressedHauls.find((task) => task.toLocationId === manufacturingLocationId)?.neededQuantity,
    100,
  );
});

test("applies demand-limited allocation to metal scraps", async () => {
  const metalScrapsTypeId = 15331;
  const result = await calculatePlanCalculation(
    request(
      300,
      [
        {
          typeId: metalScrapsTypeId,
          name: "Metal Scraps",
          quantity: 3,
          category: "item",
          rootLocationId: sourceLocationId,
        },
      ],
      { reprocessingEfficiencies: { [metalScrapsTypeId]: 100 } },
    ),
  );
  const refineryHaul = result.lists.haulingTasks.find((task) => task.typeId === metalScrapsTypeId);

  assert.equal(refineryHaul?.neededQuantity, 1);
});
