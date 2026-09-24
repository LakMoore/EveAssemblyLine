import assert from "node:assert/strict";
import test from "node:test";
import { isPlanResponse, isSimulationResultV1 } from "./planResultStore";

const listNames = [
  "warnings",
  "planItems",
  "surplusItems",
  "haulingTasks",
  "materialsToBuy",
  "bpoToBuy",
  "reprocessingJobs",
  "bpcToCopy",
  "inventionJobs",
  "reactionJobs",
  "manufacturingJobs",
  "skillsRequired",
] as const;

function simulationResult() {
  return {
    metadata: {
      simulatorVersion: 1,
      generatedAt: "2026-09-19T00:00:00.000Z",
      normalizedInputHash: "result-hash",
    },
    lists: Object.fromEntries(listNames.map((name) => [name, []])),
    ledgers: [],
  };
}

void test("accepts a complete cached native simulation result", () => {
  assert.equal(isSimulationResultV1(simulationResult()), true);
});

void test("accepts grouped reprocessing rows and rejects legacy raw jobs", () => {
  const current = simulationResult();
  (current.lists as Record<string, unknown>).reprocessingJobs = [
    {
      groupKey: "reprocessing:10:34",
      locationId: 10,
      sourceTypeId: 34,
      sourceTypeName: "Tritanium",
      quantities: {
        totalSourceQuantity: 100,
        immediateSourceQuantity: 50,
        afterHaulingSourceQuantity: 25,
        afterPurchaseSourceQuantity: 25,
      },
    },
  ];
  assert.equal(isSimulationResultV1(current), true);

  const legacy = simulationResult();
  (legacy.lists as Record<string, unknown>).reprocessingJobs = [
    {
      jobId: "reprocessing:main:34:0",
      locationId: 10,
      sourceTypeId: 34,
      sourceTypeName: "Tritanium",
      sourceQuantity: 100,
    },
  ];
  assert.equal(isSimulationResultV1(legacy), false);
});

void test("accepts canonical location ledgers and rejects ledgers without a location", () => {
  const current = {
    ...simulationResult(),
    ledgers: [{ ledgerId: "location:10", locationId: 10, balances: [] }],
  };
  assert.equal(isSimulationResultV1(current), true);

  const invalid = {
    ...simulationResult(),
    ledgers: [{ ledgerId: "location:10", balances: [] }],
  };
  assert.equal(isSimulationResultV1(invalid), false);
});

void test("accepts a complete cached legacy plan response", () => {
  assert.equal(
    isPlanResponse({
      metadata: { generatedAt: "2026-09-19T00:00:00.000Z" },
      lists: {
        planItems: { all: [], byActivityLocation: [] },
        materialsToBuy: [],
        bpcToCopy: [],
        bpoToBuy: [],
        inventionJobs: [],
        reactionJobs: [],
        manufacturingJobs: [],
        reprocessingJobs: [],
        skillsRequired: [],
        haulingTasks: [],
      },
    }),
    true,
  );
});

void test("rejects a cached legacy planner response", () => {
  assert.equal(
    isSimulationResultV1({
      metadata: { generatedAt: "2026-09-19T00:00:00.000Z" },
      lists: { planItems: { all: [], byActivityLocation: [] } },
    }),
    false,
  );
});

void test("rejects cached plan items without the required result arrays", () => {
  assert.equal(
    isPlanResponse({
      metadata: { generatedAt: "2026-09-19T00:00:00.000Z" },
      lists: {
        planItems: { all: {} },
        materialsToBuy: [],
        bpcToCopy: [],
        bpoToBuy: [],
        inventionJobs: [],
        reactionJobs: [],
        manufacturingJobs: [],
        reprocessingJobs: [],
        skillsRequired: [],
        haulingTasks: [],
      },
    }),
    false,
  );
});

void test("rejects a native result with a missing list", () => {
  const result = simulationResult();
  delete (result.lists as Record<string, unknown>).haulingTasks;
  assert.equal(isSimulationResultV1(result), false);
});

void test("rejects cached simulator rows missing display identity", () => {
  const result = simulationResult();
  (result.lists as Record<string, unknown>).planItems = [{ typeId: 34 }];
  assert.equal(isSimulationResultV1(result), false);
});

void test("accepts a cached simulator result without diagnostic ledgers", () => {
  const result = simulationResult();
  delete (result as { ledgers?: unknown }).ledgers;
  assert.equal(isSimulationResultV1(result), true);
});

void test("accepts a simulator result without optional surplus items", () => {
  const result = simulationResult();
  delete (result.lists as Record<string, unknown>).surplusItems;
  assert.equal(isSimulationResultV1(result), true);
});
