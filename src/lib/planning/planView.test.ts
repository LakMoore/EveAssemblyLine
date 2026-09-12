import assert from "node:assert/strict";
import test from "node:test";
import {
  createHaulItemExclusionKey,
  applyHaulItemExclusionsToPlan,
  parseHaulItemExclusionKey,
  toPlanHaulExclusions,
  splitReactionRunAllocations,
  splitReactionJobInputs,
} from "./planView";

void test("round-trips haul item exclusion keys", () => {
  const key = createHaulItemExclusionKey(60003760, 62553, 1055354926818);

  assert.equal(key, "60003760:62553:1055354926818");
  assert.deepEqual(
    parseHaulItemExclusionKey(key),
    {
      sourceRootLocationId: 60003760,
      itemTypeId: 62553,
      destinationLocationId: 1055354926818,
    },
  );
  assert.equal(parseHaulItemExclusionKey("invalid"), null);
  assert.equal(parseHaulItemExclusionKey("60003760:62553:84600:corporation"), null);
});

void test("converts route-scoped exclusions for the planner request", () => {
  const key = createHaulItemExclusionKey(60003760, 62553, 1055354926818, "corporation", 7);

  assert.deepEqual(
    toPlanHaulExclusions(
      new Map([[key, { neededQuantity: 500, ownerType: "corporation", ownerId: 7 }]]),
    ),
    [
      {
        typeId: 62553,
        fromLocationId: 60003760,
        toLocationId: 1055354926818,
        ownerType: "corporation",
        ownerId: 7,
      },
    ],
  );
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

void test("reconciles excluded cached haul quantities by destination", () => {
  const excludedKey = createHaulItemExclusionKey(40, 34, 20);
  const material = (
    requiredQuantity: number,
    availableQuantity: number,
    haulingQuantity: number,
  ) => ({
    typeId: 34,
    typeName: "Tritanium",
    unitVolume: 0.01,
    kind: "material" as const,
    requiredQuantity,
    availableQuantity,
    neededQuantity: 0,
    surplusQuantity: 0,
    haulingQuantity,
  });
  const plan = {
    lists: {
      haulingTasks: [
        {
          fromLocationId: 40,
          toLocationId: 20,
          items: [{ typeId: 34, typeName: "Tritanium", unitVolume: 0.01, neededQuantity: 42 }],
        },
        {
          fromLocationId: 40,
          toLocationId: 50,
          items: [{ typeId: 34, typeName: "Tritanium", unitVolume: 0.01, neededQuantity: 8 }],
        },
      ],
      planItems: {
        all: [material(50, 0, 50)],
        byActivityLocation: [
          { locationId: 20, items: [material(42, 42, 42)] },
          { locationId: 50, items: [material(8, 8, 8)] },
        ],
      },
    },
  } as Parameters<typeof applyHaulItemExclusionsToPlan>[0];
  const reconciled = applyHaulItemExclusionsToPlan(
    plan,
    new Map([[excludedKey, { neededQuantity: 42 }]]),
  );
  const firstDestination = reconciled.lists.planItems.byActivityLocation[0].items[0];
  const secondDestination = reconciled.lists.planItems.byActivityLocation[1].items[0];
  assert.equal(reconciled.lists.planItems.all[0].haulingQuantity, 8);
  assert.equal(firstDestination.availableQuantity, 0);
  assert.equal(firstDestination.neededQuantity, 42);
  assert.equal(firstDestination.haulingQuantity, 0);
  assert.equal(secondDestination.availableQuantity, 8);
  assert.equal(secondDestination.haulingQuantity, 8);
});
