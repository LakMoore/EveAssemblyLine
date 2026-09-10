import assert from "node:assert/strict";
import test from "node:test";
import { isPlanResponse } from "./planResultStore";

const planListNames = [
  "planItems",
  "materialsToBuy",
  "bpcToCopy",
  "bpoToBuy",
  "inventionJobs",
  "reactionJobs",
  "manufacturingJobs",
  "reprocessingJobs",
  "skillsRequired",
  "haulingTasks",
] as const;

test("accepts a complete cached plan", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: {
      ...Object.fromEntries(planListNames.map((name) => [name, []])),
      planItems: { all: [], byActivityLocation: [] },
    },
  };

  assert.equal(isPlanResponse(plan), true);
});

test("rejects a cached plan with a missing output list", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: Object.fromEntries(planListNames.slice(0, -1).map((name) => [name, []])),
  };

  assert.equal(isPlanResponse(plan), false);
});

test("rejects legacy context output buckets", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: {
      ...Object.fromEntries(planListNames.map((name) => [name, []])),
      planItems: {
        all: [{ context: { stockpileId: "stockpile" } }],
        byActivityLocation: [],
      },
    },
  };

  assert.equal(isPlanResponse(plan), false);
});

test("rejects haul buckets with legacy context", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: {
      ...Object.fromEntries(planListNames.map((name) => [name, []])),
      haulingTasks: [{ fromLocationId: 1, toLocationId: 2, context: {}, items: [] }],
    },
  };

  assert.equal(isPlanResponse(plan), false);
});

test("accepts bucketed market purchase lists", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: {
      ...Object.fromEntries(planListNames.map((name) => [name, []])),
      planItems: { all: [], byActivityLocation: [] },
      materialsToBuy: [
        {
          assemblyLineGroup: "Materials",
          items: [
            {
              typeId: 34,
              typeName: "Tritanium",
              unitVolume: 0.01,
              neededQuantity: 100,
            },
          ],
        },
      ],
    },
  };

  assert.equal(isPlanResponse(plan), true);
});

test("rejects flat market purchase rows", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: {
      ...Object.fromEntries(planListNames.map((name) => [name, []])),
      planItems: { all: [], byActivityLocation: [] },
      materialsToBuy: [
        {
          typeId: 34,
          typeName: "Tritanium",
          unitVolume: 0.01,
          neededQuantity: 100,
        },
      ],
    },
  };

  assert.equal(isPlanResponse(plan), false);
});
