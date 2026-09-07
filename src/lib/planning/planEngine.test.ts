import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlan } from "./planEngine";
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
  const stockpiles = Object.prototype.hasOwnProperty.call(options, "stockpiles")
    ? options.stockpiles
    : [
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
  const result = await calculatePlan(
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
  assert.equal(rifter.buyQuantity, 1);
  assert.equal(rifter.buildQuantity, 0);
  assert.equal(
    result.lists.manufacturingJobs.some((job) => job.typeId === rifterBlueprintTypeId),
    false,
  );
});

test("reports the explicit unresolved asset count", async () => {
  const result = await calculatePlan(
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

test("buy blacklist keeps a buildable item on the manufacturing path", async () => {
  const result = await calculatePlan(
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
  assert.equal(job.runs, 1);
  const rifter = result.lists.materialsToBuy.find((item) => item.typeId === rifterTypeId);
  assert(rifter);
  assert.equal(rifter.buyQuantity, 0);
  assert.equal(rifter.buildQuantity, 1);
});

test("plans invention attempts and materials for a missing T2 BPC", async () => {
  const result = await calculatePlan(
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
  assert.equal(inventionJob.runs, 3);
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
  const result = await calculatePlan(
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
    result.lists.inventionJobs.map(({ locationId, typeId, runs }) => ({
      locationId,
      typeId,
      runs,
    })),
    [
      {
        locationId: manufacturingLocationId,
        typeId: capRechargerInventionBlueprintTypeId,
        runs: 6,
      },
      {
        locationId: alternateSourceLocationId,
        typeId: capRechargerInventionBlueprintTypeId,
        runs: 3,
      },
    ],
  );
});

test("uses an available T2 BPC without scheduling invention", async () => {
  const result = await calculatePlan(
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

test("applies assigned manufacturing group facility modifiers", async () => {
  const result = await calculatePlan(
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
});

test("applies assigned reaction group facility modifiers", async () => {
  const result = await calculatePlan(
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
  assert.deepEqual(
    result.lists.skillsRequired.find((skill) => skill.skillId === 45746),
    {
      skillId: 45746,
      name: "Reactions",
      requiredLevel: 3,
    },
  );
});

test("combines global facility and skill time multipliers", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
    request(100, [industryOutputStock("active", manufacturingLocationId)]),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(tritanium);
  assert.equal(tritanium.stockQuantity, 0);
  assert.equal(tritanium.availableStockQuantity, 100);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal(tritanium.availableSourceCounts?.industry, 100);
  assert.deepEqual(result.lists.haulingTasks, []);
});

test("does not count cancelled or reverted industry output as available stock", async () => {
  for (const status of ["cancelled", "reverted"] as const) {
    const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  assert.equal(tritanium.availableSourceCounts?.industry, 20);
});

test("tracks production-origin haul quantity separately from stock haul quantity", async () => {
  const result = await calculatePlan(
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
    (task) => task.itemTypeId === tritaniumTypeId,
  );

  const productionHaul = tritaniumHauls.find(
    (task) => task.fromLocationId === manufacturingLocationId,
  );
  const stockHaul = tritaniumHauls.find(
    (task) => task.fromLocationId === alternateSourceLocationId,
  );

  assert(productionHaul);
  assert(stockHaul);
  assert.equal(productionHaul.quantity, 100);
  assert.equal(productionHaul.productionQuantity, 100);
  assert.equal(stockHaul.quantity, 10);
  assert.equal(stockHaul.productionQuantity, undefined);
});

test("counts active output toward availability in stockpiled plans", async () => {
  const result = await calculatePlan(
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
  assert.equal(tritanium.availableSourceCounts?.industry, 20);
});

test("uses remote active output for a stockpile final product", async () => {
  const result = await calculatePlan(
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
  assert.equal(tritanium.availableSourceCounts?.industry, 20);
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
  const withoutEmptyStockpile = await calculatePlan(
    request(0, stock, { items: [], stockpiles: [populatedStockpile] }),
  );
  const withEmptyStockpile = await calculatePlan(
    request(0, stock, { items: [], stockpiles: [emptyStockpile, populatedStockpile] }),
  );

  assert.deepEqual(
    { ...withEmptyStockpile, metadata: { ...withEmptyStockpile.metadata, generatedAt: "" } },
    { ...withoutEmptyStockpile, metadata: { ...withoutEmptyStockpile.metadata, generatedAt: "" } },
  );
});

test("falls back to top-level items when all stockpiles are empty", async () => {
  const buildItem = {
    typeId: tritaniumTypeId,
    name: "Tritanium",
    quantity: 10,
    me: 0,
    te: 0,
    fromCompression: false,
  };
  const emptyStockpile = {
    id: "empty-stockpile",
    name: "Empty stockpile",
    locations: {
      stock: sourceLocationId,
      manufacturing: manufacturingLocationId,
      reactions: manufacturingLocationId,
      reprocessing: reprocessingLocationId,
      copying: manufacturingLocationId,
      invention: manufacturingLocationId,
    },
    items: [],
  };
  const withoutEmptyStockpile = await calculatePlan(
    request(0, [], { items: [buildItem], stockpiles: undefined }),
  );
  const withEmptyStockpile = await calculatePlan(
    request(0, [], { items: [buildItem], stockpiles: [emptyStockpile] }),
  );

  assert.deepEqual(
    { ...withEmptyStockpile, metadata: { ...withEmptyStockpile.metadata, generatedAt: "" } },
    { ...withoutEmptyStockpile, metadata: { ...withoutEmptyStockpile.metadata, generatedAt: "" } },
  );
});

test("reallocates shared stock after intermediate inventory reduces stockpile demand", async () => {
  const result = await calculatePlan(
    request(
      0,
      [
        {
          typeId: 16634,
          name: "Atmospheric Gases",
          quantity: 200000,
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
  const gasDemand = gasRows.find((item) => item.stockpileId === "gas-demand");

  assert(gasDemand);
  assert.equal(gasDemand.buyQuantity, 0);
  assert.equal(result.metadata.availableStockByTypeId?.["16634"], 200000);
  assert.equal(
    gasRows.reduce((total, item) => total + item.buyQuantity, 0),
    0,
  );
});

test("uses reaction formulas held at a stockpile's reaction location", async () => {
  const result = await calculatePlan(
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

test("uses BPC runs held at a stockpile's manufacturing location", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
    .find((entry) => entry.stockpileId === "build-stockpile");

  assert(blueprint);
  assert.equal(blueprint.typeId, rifterBlueprintTypeId);
  assert.equal(blueprint.stockRuns, 68);
  assert.equal(blueprint.buyQuantity, 0);
});

test("shares BPC runs across stockpiles when aggregate stock covers demand", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  const firstBuildLocationId = manufacturingLocationId;
  const secondBuildLocationId = 21;
  const result = await calculatePlan(
    request(
      0,
      [
        {
          typeId: tritaniumTypeId,
          name: "Tritanium",
          quantity: 100,
          category: "item",
          rootLocationId: firstBuildLocationId,
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
              manufacturing: firstBuildLocationId,
              reactions: firstBuildLocationId,
              reprocessing: firstBuildLocationId,
              copying: firstBuildLocationId,
              invention: firstBuildLocationId,
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
              manufacturing: secondBuildLocationId,
              reactions: secondBuildLocationId,
              reprocessing: secondBuildLocationId,
              copying: secondBuildLocationId,
              invention: secondBuildLocationId,
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
  const firstPlan = result.lists.materialsToBuy.find((item) => item.stockpileId === "first");
  const secondPlan = result.lists.materialsToBuy.find((item) => item.stockpileId === "second");

  assert.ok(firstPlan);
  assert.ok(secondPlan);
  assert.equal(firstPlan.stockQuantity, 100);
  assert.equal(firstPlan.buyQuantity, 0);
  assert.equal(secondPlan.stockQuantity, 50);
  assert.equal(secondPlan.buyQuantity, 50);
  assert.equal(secondPlan.stockLocationId, 11);
  assert.equal(
    result.lists.haulingTasks.find(
      (task) => task.stockpileId === "second" && task.itemTypeId === tritaniumTypeId,
    )?.fromLocationId,
    sourceLocationId,
  );
});

test("reserves a stockpile's local assets before remote stockpiles can use them", async () => {
  const result = await calculatePlan(
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
  const remote = result.lists.materialsToBuy.find((item) => item.stockpileId === "remote");
  const local = result.lists.materialsToBuy.find((item) => item.stockpileId === "local");

  assert.ok(remote);
  assert.ok(local);
  assert.equal(remote.stockQuantity, 0);
  assert.equal(remote.buyQuantity, 100);
  assert.equal(local.stockQuantity, 100);
  assert.equal(local.buyQuantity, 0);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.stockpileId === "local" && task.fromLocationId === 21 && task.toLocationId === 11,
    ),
    true,
  );
});

test("uses activity-location stock before stockpile stock-location stock", async () => {
  const result = await calculatePlan(
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
        task.itemTypeId === 39
        && task.fromLocationId === sourceLocationId
        && task.toLocationId === manufacturingLocationId,
    ),
    false,
  );
});

test("keeps activity stock for another demand before hauling it away", async () => {
  const result = await calculatePlan(
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
    result.lists.haulingTasks.filter((task) => task.itemTypeId === 39),
    [],
  );
});

test("reserves stock for manufacturing inputs before direct stockpile demand", async () => {
  const result = await calculatePlan(
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
  const standingStock = result.lists.materialsToBuy.find(
    (item) => item.stockpileId === "standing-stock" && item.typeId === tritaniumTypeId,
  );
  const manufacturingStock = result.lists.materialsToBuy.find(
    (item) => item.stockpileId === "manufacturing" && item.typeId === tritaniumTypeId,
  );
  const manufacturingJob = result.lists.manufacturingJobs.find(
    (job) => job.stockpileId === "manufacturing" && job.typeId === rifterBlueprintTypeId,
  );

  assert(standingStock);
  assert(manufacturingStock);
  assert(manufacturingJob);
  assert.equal(standingStock.stockQuantity, 0);
  assert.equal(standingStock.buyQuantity, 32000);
  assert.equal(manufacturingStock.stockQuantity, 32000);
  assert.equal(manufacturingStock.buyQuantity, 0);
  const tritaniumInput = manufacturingJob.inputs.materials.find(
    (input) => input.typeId === tritaniumTypeId,
  );
  assert(tritaniumInput);
  assert.equal(tritaniumInput.availableQuantity, 32000);
  assert.equal(tritaniumInput.status, "ready");
});

test("reserves fuel blocks for reaction inputs before direct stockpile demand", async () => {
  const result = await calculatePlan(
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
    (item) => item.stockpileId === "fuel-stock" && item.typeId === heliumFuelBlockTypeId,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.stockpileId === "fuel-reaction" && job.typeId === fuelReactionFormulaTypeId,
  );

  assert(directFuel);
  assert(reactionJob);
  assert.equal(directFuel.stockQuantity, 0);
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
  const result = await calculatePlan(
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
      task.itemTypeId === tritaniumTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );

  assert.equal(matchingHauls.length, 1);
  assert.equal(matchingHauls[0]?.quantity, 64000);
});

test("keeps hauling ownership separate for shared routes", async () => {
  const result = await calculatePlan(
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
      task.itemTypeId === tritaniumTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );

  assert.deepEqual(
    tritaniumHauls.map((task) => ({
      ownerType: task.ownerType,
      ownerId: task.ownerId,
      quantity: task.quantity,
    })),
    [
      { ownerType: "character", ownerId: 101, quantity: 32000 },
      { ownerType: "corporation", ownerId: 202, quantity: 32000 },
    ],
  );
});

test("hauls ready manufactured stock to the stockpile stock location", async () => {
  const result = await calculatePlan(
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
  const outputHaul = result.lists.haulingTasks.find((task) => task.itemTypeId === tritaniumTypeId);

  assert(outputHaul);
  assert.equal(outputHaul.fromLocationId, manufacturingLocationId);
  assert.equal(outputHaul.toLocationId, reprocessingLocationId);
  assert.equal(outputHaul.quantity, 100);
});

test("reserves final-location stock before build-location output for a stockpile", async () => {
  const result = await calculatePlan(
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
      task.itemTypeId === tritaniumTypeId
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === reprocessingLocationId,
  );

  assert(outputHaul);
  assert.equal(outputHaul.quantity, 28);
});

test("does not move final-destination stock to the manufacturing location", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
      task.itemTypeId === tritaniumTypeId
      && task.fromLocationId === sourceLocationId
      && task.toLocationId === manufacturingLocationId,
  );
  const outputHauls = result.lists.haulingTasks.filter(
    (task) =>
      task.itemTypeId === rifterTypeId
      && task.fromLocationId === manufacturingLocationId
      && task.toLocationId === reprocessingLocationId,
  );

  assert(inputHaul);
  assert.equal(inputHaul.quantity, 32000);
  assert.equal(
    outputHauls.reduce((total, task) => total + task.quantity, 0),
    1,
  );
});

test("uses sell orders only from the selected market location", async () => {
  const result = await calculatePlan(
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
      const result = await calculatePlan(
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

test("does not use industry output at another location as a future job input", async () => {
  const result = await calculatePlan(
    request(100, [industryOutputStock("ready", sourceLocationId)], { stockpiles: undefined }),
  );
  const tritanium = result.lists.materialsToBuy.find(
    (material) => material.typeId === tritaniumTypeId,
  );

  assert(tritanium);
  assert.equal(tritanium.stockQuantity, 0);
  assert.equal(tritanium.buyQuantity, 100);
  assert.deepEqual(result.lists.haulingTasks, []);
});

test("does not use remote active output as a future job input", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
});

test("routes all runs to copying when an available BPO has no print metadata", async () => {
  const requiredRuns = 11;
  const result = await calculatePlan(
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
});

test("reports installable runs for 10 Rifters and 10 Amarr Shuttles", async () => {
  const result = await calculatePlan(
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
  assert.equal(rifterJob.runs, 10);
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
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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

test("accumulates installable reaction runs across repeated expansions", async () => {
  const result = await calculatePlan(
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
  assert.equal(job.runs, 4);
  assert.equal(job.runsAvailable, 2);
});

test("merges reaction jobs by reaction location and formula type", async () => {
  const result = await calculatePlan(
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
  assert.equal(reactionJob.stockpileId, undefined);
});

test("merges manufacturing jobs by blueprint type across stockpiles", async () => {
  const result = await calculatePlan(
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
  assert.equal(manufacturingJob.runs, 2);
  assert.equal(manufacturingJob.stockpileId, undefined);
  assert.equal(manufacturingJob.buildLocationId, undefined);
});

test("keeps manufacturing jobs separate across build locations", async () => {
  const result = await calculatePlan(
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
      .map((job) => [job.locationId, job.runs]),
    [
      [manufacturingLocationId, 1],
      [alternateSourceLocationId, 1],
    ],
  );
});

test("allocates reaction formulas at the reaction location to stockpile jobs", async () => {
  const result = await calculatePlan(
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
  assert.equal(reactionJob.inputs.blueprint.availableQuantity, 1);
  assert.equal(reactionJob.inputs.blueprint.requiredQuantity, 1);
  const reactionPlanItem = result.lists.planItems.find(
    (entry) => entry.kind === "reaction" && entry.typeId === reactionFormulaTypeId,
  );
  assert(reactionPlanItem && reactionPlanItem.kind === "reaction");
  assert.equal(reactionPlanItem.availableQuantity, 1);
});

test("does not reprocess or haul compressed stock when direct materials cover demand", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
    request(
      500,
      [compressedStock(250)],
      {
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
      },
    ),
  );
  const refineryHaul = result.lists.haulingTasks.find(
    (task) => task.itemTypeId === compressedVeldsparTypeId,
  );

  assert.equal(refineryHaul?.quantity, 200);
  assert.equal(refineryHaul.fromLocationId, sourceLocationId);
  assert.equal(refineryHaul.toLocationId, reprocessingLocationId);
  assert.equal(
    result.lists.haulingTasks.some((task) => task.itemTypeId === tritaniumTypeId),
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

test("lists only selected stock already at the refinery for immediate reprocessing", async () => {
  const result = await calculatePlan(
    request(
      500,
      [{ ...compressedStock(100), rootLocationId: reprocessingLocationId }, compressedStock(150)],
      { reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 } },
    ),
  );

  assert.equal(result.lists.reprocessingJobs[0]?.quantity, 100);
  assert.equal(result.lists.reprocessingJobs[0]?.locationId, reprocessingLocationId);
  assert.equal(
    result.lists.haulingTasks.find(
      (task) =>
        task.itemTypeId === compressedVeldsparTypeId
        && task.toLocationId === reprocessingLocationId,
    )?.quantity,
    100,
  );
});

test("credits committed compressed purchases before considering owned stock", async () => {
  const result = await calculatePlan(
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
    result.lists.haulingTasks.some((task) => task.itemTypeId === compressedVeldsparTypeId),
    false,
  );
});

test("shares future materials from compressed purchases across stockpiles", async () => {
  const result = await calculatePlan(
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
    (material) => material.typeId === tritaniumTypeId && material.stockpileId === "manufacturing",
  );
  const compressed = result.lists.materialsToBuy.find(
    (material) =>
      material.typeId === compressedVeldsparTypeId && material.stockpileId === "compressed-inputs",
  );

  assert(tritanium);
  assert(compressed);
  assert.equal(tritanium.stockQuantity, 400);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal(compressed.buyQuantity, 100);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.stockpileId === "manufacturing"
        && task.itemTypeId === tritaniumTypeId
        && task.fromLocationId === reprocessingLocationId
        && task.toLocationId === manufacturingLocationId,
    ),
    true,
  );
});

test("retains an incomplete committed purchase without crediting an unusable portion", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
    result.lists.haulingTasks.find((task) => task.itemTypeId === compressedVeldsparTypeId)
      ?.quantity,
    100,
  );
});

test("credits aggregate fractional gas output against the raw material buy quantity", async () => {
  const result = await calculatePlan(
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
  const result = await calculatePlan(
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
  assert.equal(rawGas.availableSourceCounts?.reprocessing, 100);
  assert.equal(rawGas.buyQuantity, 0);
  assert.equal(result.metadata.availableStockByTypeId?.[String(amberMykoserocinTypeId)], 100);
});

test("falls back to 50 percent when no efficiency snapshot is supplied", async () => {
  const result = await calculatePlan(request(300, [compressedStock(250)]));
  const refineryHaul = result.lists.haulingTasks.find(
    (task) => task.itemTypeId === compressedVeldsparTypeId,
  );

  assert.equal(refineryHaul?.quantity, 200);
});

test("reserves compressed stock that is required directly by the plan", async () => {
  const result = await calculatePlan(
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
    (task) => task.itemTypeId === compressedVeldsparTypeId,
  );

  assert.equal(
    compressedHauls.find((task) => task.toLocationId === reprocessingLocationId)?.quantity,
    100,
  );
  assert.equal(
    compressedHauls.find((task) => task.toLocationId === manufacturingLocationId)?.quantity,
    100,
  );
});

test("applies demand-limited allocation to metal scraps", async () => {
  const metalScrapsTypeId = 15331;
  const result = await calculatePlan(
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
  const refineryHaul = result.lists.haulingTasks.find(
    (task) => task.itemTypeId === metalScrapsTypeId,
  );

  assert.equal(refineryHaul?.quantity, 1);
});
