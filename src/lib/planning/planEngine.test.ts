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
  return {
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
    stock,
    locations: {
      manufacturing: manufacturingLocationId,
      reactions: manufacturingLocationId,
      market: 30,
      reprocessing: reprocessingLocationId,
    },
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
        buckets: [
          {
            id: "haul-provenance-bucket",
            name: "Haul provenance bucket",
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

test("counts active output toward availability in bucketed plans", async () => {
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
        buckets: [
          {
            id: "bucket-1",
            name: "Bucket 1",
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

test("uses remote active output for a bucket final product", async () => {
  const result = await calculatePlan(
    request(
      150,
      [industryOutputStock("active", alternateSourceLocationId, "Manufacturing", 20)],
      {
        items: [],
        buckets: [
          {
            id: "remote-output-bucket",
            name: "Remote output bucket",
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

test("ignores empty buckets when calculating a plan", async () => {
  const stock = [industryOutputStock("active", manufacturingLocationId, "Manufacturing", 20)];
  const populatedBucket = {
    id: "populated-bucket",
    name: "Populated bucket",
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
  const emptyBucket = {
    id: "empty-bucket",
    name: "Empty bucket",
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
  const withoutEmptyBucket = await calculatePlan(
    request(0, stock, { items: [], buckets: [populatedBucket] }),
  );
  const withEmptyBucket = await calculatePlan(
    request(0, stock, { items: [], buckets: [emptyBucket, populatedBucket] }),
  );

  assert.deepEqual(
    { ...withEmptyBucket, metadata: { ...withEmptyBucket.metadata, generatedAt: "" } },
    { ...withoutEmptyBucket, metadata: { ...withoutEmptyBucket.metadata, generatedAt: "" } },
  );
});

test("falls back to top-level items when all buckets are empty", async () => {
  const buildItem = {
    typeId: tritaniumTypeId,
    name: "Tritanium",
    quantity: 10,
    me: 0,
    te: 0,
    fromCompression: false,
  };
  const emptyBucket = {
    id: "empty-bucket",
    name: "Empty bucket",
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
  const withoutEmptyBucket = await calculatePlan(
    request(0, [], { items: [buildItem], buckets: undefined }),
  );
  const withEmptyBucket = await calculatePlan(
    request(0, [], { items: [buildItem], buckets: [emptyBucket] }),
  );

  assert.deepEqual(
    { ...withEmptyBucket, metadata: { ...withEmptyBucket.metadata, generatedAt: "" } },
    { ...withoutEmptyBucket, metadata: { ...withoutEmptyBucket.metadata, generatedAt: "" } },
  );
});

test("reallocates shared stock after intermediate inventory reduces bucket demand", async () => {
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
        buckets: [
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
  const gasDemand = gasRows.find((item) => item.bucketId === "gas-demand");

  assert(gasDemand);
  assert.equal(gasDemand.buyQuantity, 0);
  assert.equal(result.metadata.availableStockByTypeId?.["16634"], 200000);
  assert.equal(
    gasRows.reduce((total, item) => total + item.buyQuantity, 0),
    0,
  );
});

test("uses reaction formulas held at a bucket's reaction location", async () => {
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
        buckets: [
          {
            id: "reaction-bucket",
            name: "Reaction bucket",
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

test("uses BPC runs held at a bucket's manufacturing location", async () => {
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
        buckets: [
          {
            id: "manufacturing-bucket",
            name: "Manufacturing bucket",
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

test("does not strand shared BPC stock in a bucket covered by item stock", async () => {
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
        buckets: [
          {
            id: "stocked-bucket",
            name: "Stocked bucket",
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
            id: "build-bucket",
            name: "Build bucket",
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
    .find((entry) => entry.bucketId === "build-bucket");

  assert(blueprint);
  assert.equal(blueprint.typeId, rifterBlueprintTypeId);
  assert.equal(blueprint.stockRuns, 68);
  assert.equal(blueprint.buyQuantity, 0);
});

test("shares BPC runs across buckets when aggregate stock covers demand", async () => {
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
        buckets: [
          {
            id: "first-bpc-bucket",
            name: "First BPC bucket",
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
            id: "second-bpc-bucket",
            name: "Second BPC bucket",
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

test("uses BPO-backed BPC runs to cover another bucket's purchase requirement", async () => {
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
        buckets: [
          {
            id: "bpo-backed-bucket",
            name: "BPO-backed bucket",
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
            id: "bpc-purchase-bucket",
            name: "BPC purchase bucket",
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

test("shares assets across buckets without merging identical destination plans", async () => {
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
        buckets: [
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
  const firstPlan = result.lists.materialsToBuy.find((item) => item.bucketId === "first");
  const secondPlan = result.lists.materialsToBuy.find((item) => item.bucketId === "second");

  assert.ok(firstPlan);
  assert.ok(secondPlan);
  assert.equal(firstPlan.stockQuantity, 100);
  assert.equal(firstPlan.buyQuantity, 0);
  assert.equal(secondPlan.stockQuantity, 50);
  assert.equal(secondPlan.buyQuantity, 50);
  assert.equal(secondPlan.stockLocationId, 11);
  assert.equal(
    result.lists.haulingTasks.find(
      (task) => task.bucketId === "second" && task.itemTypeId === tritaniumTypeId,
    )?.fromLocationId,
    sourceLocationId,
  );
});

test("reserves a bucket's local assets before remote buckets can use them", async () => {
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
        buckets: [
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
  const remote = result.lists.materialsToBuy.find((item) => item.bucketId === "remote");
  const local = result.lists.materialsToBuy.find((item) => item.bucketId === "local");

  assert.ok(remote);
  assert.ok(local);
  assert.equal(remote.stockQuantity, 0);
  assert.equal(remote.buyQuantity, 100);
  assert.equal(local.stockQuantity, 100);
  assert.equal(local.buyQuantity, 0);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) => task.bucketId === "local" && task.fromLocationId === 21 && task.toLocationId === 11,
    ),
    true,
  );
});

test("reserves stock for manufacturing inputs before direct bucket demand", async () => {
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
        buckets: [
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
    (item) => item.bucketId === "standing-stock" && item.typeId === tritaniumTypeId,
  );
  const manufacturingStock = result.lists.materialsToBuy.find(
    (item) => item.bucketId === "manufacturing" && item.typeId === tritaniumTypeId,
  );
  const manufacturingJob = result.lists.manufacturingJobs.find(
    (job) => job.bucketId === "manufacturing" && job.typeId === rifterBlueprintTypeId,
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

test("reserves fuel blocks for reaction inputs before direct bucket demand", async () => {
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
        buckets: [
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
    (item) => item.bucketId === "fuel-stock" && item.typeId === heliumFuelBlockTypeId,
  );
  const reactionJob = result.lists.reactionJobs.find(
    (job) => job.bucketId === "fuel-reaction" && job.typeId === fuelReactionFormulaTypeId,
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
        buckets: [
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

test("hauls ready manufactured stock to the bucket stock location", async () => {
  const result = await calculatePlan(
    request(
      0,
      [industryOutputStock("ready", manufacturingLocationId)],
      {
        items: [],
        buckets: [
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

test("reserves final-location stock before build-location output for a bucket", async () => {
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
        buckets: [
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
        buckets: [
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
        buckets: [
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
    request(100, [industryOutputStock("ready", sourceLocationId)]),
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
        buckets: [
          {
            id: "first-reaction-bucket",
            name: "First reaction bucket",
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
            id: "second-reaction-bucket",
            name: "Second reaction bucket",
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
  assert.equal(reactionJob.bucketId, undefined);
});

test("allocates reaction formulas at the reaction location to bucket jobs", async () => {
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
        buckets: [
          {
            id: "first-formula-bucket",
            name: "First formula bucket",
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
            id: "second-formula-bucket",
            name: "Second formula bucket",
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
  assert.equal(tritanium.availableStockQuantity, 0);
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

test("shares future materials from compressed purchases across buckets", async () => {
  const result = await calculatePlan(
    request(
      0,
      [],
      {
        items: [],
        reprocessingEfficiencies: { [compressedVeldsparTypeId]: 100 },
        buckets: [
          {
            id: "compressed-inputs",
            name: "Compressed inputs",
            kind: "special",
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
    (material) => material.typeId === tritaniumTypeId && material.bucketId === "manufacturing",
  );
  const compressed = result.lists.materialsToBuy.find(
    (material) =>
      material.typeId === compressedVeldsparTypeId && material.bucketId === "compressed-inputs",
  );

  assert(tritanium);
  assert(compressed);
  assert.equal(tritanium.stockQuantity, 400);
  assert.equal(tritanium.buyQuantity, 0);
  assert.equal(compressed.buyQuantity, 100);
  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.bucketId === "manufacturing"
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
