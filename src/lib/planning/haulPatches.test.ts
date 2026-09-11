import assert from "node:assert/strict";
import test from "node:test";
import type { HaulPatch, PlanCalculation, PlanStockItem } from "./types";
import { applyHaulPatches, createHaulPatchesForTask, invalidateHaulPatches } from "./haulPatches";

const patch: HaulPatch = {
  key: "10:20:34:character:101",
  typeId: 34,
  typeName: "Tritanium",
  unitVolume: 0.01,
  neededQuantity: 80,
  fromLocationId: 10,
  toLocationId: 20,
  ownerType: "character",
  ownerId: 101,
  assetsLastModified: "2026-01-01T00:00:00.000Z",
};

function stockItem(overrides: Partial<PlanStockItem> = {}): PlanStockItem {
  return {
    typeId: 34,
    name: "Tritanium",
    quantity: 100,
    rootLocationId: 10,
    category: "item",
    ownerType: "character",
    ownerId: 101,
    ...overrides,
  };
}

void test("moves stock between locations without creating negative quantities", () => {
  const result = applyHaulPatches(
    [stockItem(), stockItem({ quantity: 30, ownerId: 202 })],
    [patch],
  );

  assert.deepEqual(
    result.map(({ quantity, rootLocationId, ownerId }) => ({ quantity, rootLocationId, ownerId })),
    [
      { quantity: 20, rootLocationId: 10, ownerId: 101 },
      { quantity: 30, rootLocationId: 10, ownerId: 202 },
      { quantity: 80, rootLocationId: 20, ownerId: 101 },
    ],
  );
});

void test("caps a patch at available owner stock", () => {
  const result = applyHaulPatches([stockItem({ quantity: 25 })], [patch]);

  assert.deepEqual(
    result.map(({ quantity, rootLocationId }) => ({ quantity, rootLocationId })),
    [{ quantity: 25, rootLocationId: 20 }],
  );
});

void test("splits a mixed-owner haul into owner-specific patches", () => {
  const task = {
    typeId: 34,
    typeName: "Tritanium",
    unitVolume: 0.01,
    neededQuantity: 100,
    fromLocationId: 10,
    toLocationId: 20,
  } as PlanCalculation["lists"]["haulingTasks"][number];
  const patches = createHaulPatchesForTask(
    task,
    [
      stockItem({ quantity: 40 }),
      stockItem({ quantity: 60, ownerType: "corporation", ownerId: 202 }),
    ],
    [],
  );

  assert.deepEqual(
    patches.map(({ ownerType, ownerId, neededQuantity }) => ({
      ownerType,
      ownerId,
      neededQuantity,
    })),
    [
      { ownerType: "character", ownerId: 101, neededQuantity: 40 },
      { ownerType: "corporation", ownerId: 202, neededQuantity: 60 },
    ],
  );
});

void test("invalidates only after the matching owner asset snapshot advances", () => {
  const statuses = [
    {
      characterId: 101,
      assets: { status: "fresh" as const, hasBody: true, lastModified: "2026-01-01T00:00:00.000Z" },
    },
  ];

  assert.equal(invalidateHaulPatches([patch], statuses).length, 1);
  assert.equal(
    invalidateHaulPatches(
      [patch],
      [
        {
          ...statuses[0],
          assets: { ...statuses[0].assets, lastModified: "2026-01-02T00:00:00.000Z" },
        },
      ],
    ).length,
    0,
  );
});
