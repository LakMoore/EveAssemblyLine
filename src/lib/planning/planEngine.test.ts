import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlan } from "./planEngine";
import type { PlannerRequest } from "./types";

const tritaniumTypeId = 34;
const compressedVeldsparTypeId = 62516;
const amberMykoserocinTypeId = 28694;
const compressedAmberMykoserocinTypeId = 62377;
const reprocessingLocationId = 10;
const manufacturingLocationId = 20;
const sourceLocationId = 40;

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
