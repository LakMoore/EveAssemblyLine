import assert from "node:assert/strict";
import test from "node:test";
import {
  createHaulItemExclusionKey,
  excludeHaulItemsFromStock,
  parseHaulItemExclusionKey,
  splitReactionRunAllocations,
  splitReactionJobInputs,
} from "./planView";

void test("round-trips haul item exclusion keys", () => {
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

void test("excludes every quantity from an excluded source and type", () => {
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

  assert.deepEqual(
    excludeHaulItemsFromStock(
      stock,
      new Map([
        [
          createHaulItemExclusionKey(60003760, 62553),
          {
            destinationLocationId: 1055354926818,
            neededQuantity: 500,
            originalSourceQuantity: 120430,
            retainedSourceQuantity: 0,
          },
        ],
      ]),
    ),
    [],
  );
});

void test("retains local source stock while excluding a remote surplus haul", () => {
  const key = createHaulItemExclusionKey(60003760, 62553, "corporation", 7);
  const result = excludeHaulItemsFromStock(
    [
      {
        typeId: 62553,
        name: "Compressed Gneiss II-Grade",
        quantity: 120430,
        rootLocationId: 60003760,
        category: "item",
        ownerType: "corporation",
        ownerId: 7,
      },
    ],
    new Map([
      [
        key,
        {
          destinationLocationId: 1055354926818,
          neededQuantity: 500,
          originalSourceQuantity: 120430,
          retainedSourceQuantity: 100000,
          ownerType: "corporation",
          ownerId: 7,
        },
      ],
    ]),
  );

  assert.equal(result[0].quantity, 100000);
});

void test("splits reaction runs across floor and ceiling allocations", () => {
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

void test("keeps exact reaction coverage in one row", () => {
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

void test("uses exactly two rows for a mismatch regardless of install count", () => {
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

void test("recalculates split reaction inputs and carries availability forward", () => {
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
