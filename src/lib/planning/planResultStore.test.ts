import assert from "node:assert/strict";
import test from "node:test";
import { simulationCalculationVersion } from "./simulator/etag";
import { isSimulationResultV2, isStoredSimulationHaulTask } from "./planResultStore";

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
      simulatorVersion: simulationCalculationVersion,
      policyVersion: 1,
      generatedAt: "2026-09-19T00:00:00.000Z",
      sdeRevision: "test-sde",
      normalizedInputHash: "result-hash",
      warningCount: 0,
      invariantViolationCount: 0,
      unresolvedAssetCount: 0,
    },
    scheduleSlots: [],
    lists: Object.fromEntries(listNames.map((name) => [name, []])),
    ledgers: [],
  };
}

void test("accepts a complete cached native simulation result", () => {
  assert.equal(isSimulationResultV2(simulationResult()), true);
});

void test("accepts cached stockpile-demand haul tasks", () => {
  const result = simulationResult();
  const stockpileDemandHaul = {
    transferId: "haul:10:34:20:character:7:stockpile-demand",
    lotId: "asset-1",
    typeId: 34,
    typeName: "Tritanium",
    quantity: 100,
    unitVolume: 0.01,
    fromLocationId: 10,
    toLocationId: 20,
    ownerType: "character",
    ownerId: 7,
    purpose: "stockpile-demand",
    demands: [{ quantity: 100 }],
  };
  (result.lists as Record<string, unknown>).haulingTasks = [stockpileDemandHaul];

  assert.equal(isStoredSimulationHaulTask(stockpileDemandHaul), true);
  assert.equal(isSimulationResultV2(result), true);
});

void test("accepts grouped BPC haul tasks and rejects invalid required runs", () => {
  const groupedBpcHaul = {
    transferId: "haul-group:10:33823:20:character:7:now:industry-input:bpc",
    sourceLots: [
      { lotId: "copy-a", quantity: 1 },
      { lotId: "copy-b", quantity: 1 },
    ],
    typeId: 33823,
    typeName: "Omnidirectional Tracking Enhancer I Blueprint",
    blueprintKind: "bpc",
    quantity: 2,
    runsNeeded: 8,
    unitVolume: 0.01,
    fromLocationId: 10,
    toLocationId: 20,
    ownerType: "character",
    ownerId: 7,
    purpose: "industry-input",
    demands: [],
  };

  assert.equal(isStoredSimulationHaulTask(groupedBpcHaul), true);
  assert.equal(isStoredSimulationHaulTask({ ...groupedBpcHaul, runsNeeded: 1.5 }), false);
  assert.equal(isStoredSimulationHaulTask({ ...groupedBpcHaul, blueprintKind: "formula" }), false);
  assert.equal(isStoredSimulationHaulTask({ ...groupedBpcHaul, sourceLots: [] }), false);
  assert.equal(isStoredSimulationHaulTask({ ...groupedBpcHaul, blueprintKind: "bpo" }), true);

  const cachedResult = simulationResult();
  (cachedResult.lists as Record<string, unknown>).haulingTasks = [groupedBpcHaul];
  assert.equal(isSimulationResultV2(cachedResult), true);

  (cachedResult.lists as Record<string, unknown>).haulingTasks = [
    { ...groupedBpcHaul, runsNeeded: 1.5 },
  ];
  assert.equal(isSimulationResultV2(cachedResult), false);
});

void test("rejects cached native results without their authoritative slot map", () => {
  const result = { ...simulationResult() } as Record<string, unknown>;
  delete result.scheduleSlots;
  assert.equal(isSimulationResultV2(result), false);
});

void test("rejects cached native results from an older calculation version", () => {
  const stale = simulationResult();
  stale.metadata.simulatorVersion = simulationCalculationVersion - 1;
  assert.equal(isSimulationResultV2(stale), false);
});

void test("rejects a v2 result with incomplete metadata", () => {
  const result = simulationResult();
  delete (result.metadata as Record<string, unknown>).sdeRevision;
  assert.equal(isSimulationResultV2(result), false);
});

void test("accepts grouped reprocessing rows and rejects legacy raw jobs", () => {
  const current = simulationResult();
  (current.lists as Record<string, unknown>).reprocessingJobs = [
    {
      groupKey: "reprocessing:10:34",
      locationId: 10,
      sourceTypeId: 34,
      sourceTypeName: "Tritanium",
      jobs: [{ depth: 1 }],
      quantities: {
        totalSourceQuantity: 100,
        immediateSourceQuantity: 50,
        afterHaulingSourceQuantity: 25,
        afterPurchaseSourceQuantity: 25,
      },
    },
  ];
  assert.equal(isSimulationResultV2(current), true);

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
  assert.equal(isSimulationResultV2(legacy), false);
});

void test("accepts canonical location ledgers and rejects ledgers without a location", () => {
  const current = {
    ...simulationResult(),
    ledgers: [{ ledgerId: "location:10", locationId: 10, balances: [] }],
  };
  assert.equal(isSimulationResultV2(current), true);

  const invalid = {
    ...simulationResult(),
    ledgers: [{ ledgerId: "location:10", balances: [] }],
  };
  assert.equal(isSimulationResultV2(invalid), false);
});

void test("rejects a native result with a missing list", () => {
  const result = simulationResult();
  delete (result.lists as Record<string, unknown>).haulingTasks;
  assert.equal(isSimulationResultV2(result), false);
});

void test("rejects cached simulator rows missing display identity", () => {
  const result = simulationResult();
  (result.lists as Record<string, unknown>).planItems = [{ typeId: 34 }];
  assert.equal(isSimulationResultV2(result), false);
});

void test("rejects scheduled jobs without depth metadata", () => {
  const result = simulationResult();
  (result.lists as Record<string, unknown>).manufacturingJobs = [
    {
      jobId: "manufacturing-job",
      productTypeId: 587,
      productName: "Rifter",
      readyNowRuns: 1,
      requiredRuns: 1,
      inputs: [],
      locationId: 10,
    },
  ];
  assert.equal(isSimulationResultV2(result), false);
});

void test("accepts a cached simulator result without diagnostic ledgers", () => {
  const result = simulationResult();
  delete (result as { ledgers?: unknown }).ledgers;
  assert.equal(isSimulationResultV2(result), true);
});

void test("accepts a simulator result without optional surplus items", () => {
  const result = simulationResult();
  delete (result.lists as Record<string, unknown>).surplusItems;
  assert.equal(isSimulationResultV2(result), true);
});
