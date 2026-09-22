import assert from "node:assert/strict";
import test from "node:test";
import { convertSimulationTargetTime, solveSimulationActivity } from "./clientScheduler";
import type { SimulationIndustryJob } from "./types";

/** Creates a minimal simulator job for client scheduler tests. */
function job(
  jobId: string,
  requiredRuns: number,
  readyNowRuns: number,
  durationPerRunSeconds: number,
  inputQuantitiesPerRun: number[] = [],
): SimulationIndustryJob {
  return {
    jobId,
    activity: "reaction",
    stockpileId: "main",
    locationId: 20,
    productTypeId: 16672,
    productName: jobId,
    blueprint: {
      blueprintTypeId: 46207,
      blueprintKind: "formula",
      runs: requiredRuns,
      materialEfficiency: 0,
      timeEfficiency: 0,
    },
    outputPerRun: 1,
    requiredRuns,
    readyNowRuns,
    readyAfterHaulingRuns: requiredRuns,
    readyAfterUpstreamRuns: requiredRuns,
    blockedRuns: 0,
    unscheduledRuns: requiredRuns,
    materialMultiplier: 1,
    timeMultiplier: 1,
    durationPerRunSeconds,
    inputs: inputQuantitiesPerRun.map((quantityPerRun, index) => ({
      typeId: 1000 + index,
      typeName: `Input ${index}`,
      quantityPerRun,
      requiredQuantity: quantityPerRun * requiredRuns,
      availableNow: quantityPerRun * requiredRuns,
      availableFromHauling: 0,
      availableAfterUpstream: quantityPerRun * requiredRuns,
      unsatisfiedQuantity: 0,
    })),
    installs: [],
    demandSources: [],
  };
}

void test("allocates available slots across the largest installable jobs", () => {
  const schedules = solveSimulationActivity(
    [job("A", 8, 8, 60), job("B", 3, 3, 120)],
    2,
    "available-slots",
    24,
  );

  assert.equal(schedules.get("A")?.installs.length, 1);
  assert.equal(schedules.get("B")?.installs.length, 1);
  assert.equal(schedules.get("A")?.runs, 8);
  assert.equal(schedules.get("B")?.runs, 3);
});

void test("keeps unprotected reactions on largest-job allocation", () => {
  const schedules = solveSimulationActivity(
    [job("A", 100, 100, 60), job("B", 40, 40, 60), job("C", 10, 10, 60)],
    2,
    "available-slots",
    24,
  );

  assert.equal(schedules.get("A")?.runs, 100);
  assert.equal(schedules.get("B")?.runs, 40);
  assert.equal(schedules.get("C")?.runs, 0);
});

void test("recalculates the reaction average after allocating low-run jobs", () => {
  const schedules = solveSimulationActivity(
    [job("A", 100, 100, 60), job("B", 40, 40, 60), job("C", 10, 10, 60)],
    4,
    "available-slots",
    24,
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [50, 50],
  );
  assert.deepEqual(
    schedules.get("B")?.installs.map((install) => install.runs),
    [40],
  );
  assert.deepEqual(
    schedules.get("C")?.installs.map((install) => install.runs),
    [10],
  );
});

void test("prioritizes every low-run reaction job when enough slots remain", () => {
  const schedules = solveSimulationActivity(
    [job("A", 100, 100, 60), job("B", 20, 20, 60), job("C", 10, 10, 60), job("D", 5, 5, 60)],
    4,
    "available-slots",
    24,
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [100],
  );
  assert.deepEqual(
    schedules.get("B")?.installs.map((install) => install.runs),
    [20],
  );
  assert.deepEqual(
    schedules.get("C")?.installs.map((install) => install.runs),
    [10],
  );
  assert.deepEqual(
    schedules.get("D")?.installs.map((install) => install.runs),
    [5],
  );
});

void test("respects the protected reaction minimum during average allocation", () => {
  const schedules = solveSimulationActivity(
    [job("A", 25, 25, 60, [10]), job("B", 25, 25, 60, [10]), job("C", 25, 25, 60, [10])],
    4,
    "available-slots",
    24,
    new Set(["A", "B", "C"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  const installRuns = [...schedules.values()].flatMap((schedule) =>
    schedule.installs.map((install) => install.runs),
  );
  assert.deepEqual(
    installRuns.sort((left, right) => right - left),
    [25, 25, 13, 12],
  );
  assert.ok(installRuns.every((runs) => runs >= 10));
});

void test("splits reaction runtime installs across floor and ceiling averages", () => {
  const schedules = solveSimulationActivity([job("A", 10, 10, 3600)], 4, "run-time-hours", 3);

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [3, 3, 2, 2],
  );
  assert.equal(schedules.get("A")?.runs, 10);
});

void test("converts reaction runtime days to hours before calculating runs", () => {
  const schedules = solveSimulationActivity([job("A", 25, 25, 3600)], 2, "run-time-days", 1);

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [13, 12],
  );
});

void test("keeps reaction runtime splits above the protected minimum", () => {
  const schedules = solveSimulationActivity(
    [job("A", 10, 10, 3600, [10])],
    4,
    "run-time-hours",
    3,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [5, 5],
  );
});

void test("limits each suggested install to the requested run time", () => {
  const schedules = solveSimulationActivity([job("A", 10, 10, 3600)], 1, "run-time-hours", 3);

  assert.equal(schedules.get("A")?.installs.length, 1);
  assert.equal(schedules.get("A")?.installs[0]?.runs, 3);
  assert.equal(schedules.get("A")?.timeSeconds, 10800);
});

void test("converts runtime targets between hours and days with a minimum of one", () => {
  assert.equal(convertSimulationTargetTime(2, "run-time-days", "run-time-hours"), 48);
  assert.equal(convertSimulationTargetTime(24, "run-time-hours", "run-time-days"), 1);
  assert.equal(convertSimulationTargetTime(12, "run-time-hours", "run-time-days"), 1);
  assert.equal(convertSimulationTargetTime(0, "run-time-days", "run-time-hours"), 1);
});

void test("retains character slot details for the install plan", () => {
  const schedules = solveSimulationActivity(
    [job("A", 5, 5, 3600)],
    2,
    "available-slots",
    24,
    new Set(["A"]),
    [
      { characterId: 7, availableSlots: 1 },
      { characterId: 8, availableSlots: 1 },
    ],
  );

  assert.deepEqual(
    schedules
      .get("A")
      ?.installs.map(({ characterId, slotIndex, runs }) => ({
        characterId,
        slotIndex,
        runs,
      })),
    [
      { characterId: 7, slotIndex: 0, runs: 3 },
      { characterId: 8, slotIndex: 0, runs: 2 },
    ],
  );
});

void test("protects the ME bonus by keeping reaction installs above the minimum run count", () => {
  const schedules = solveSimulationActivity(
    [job("A", 10, 10, 60, [10, 40])],
    3,
    "available-slots",
    24,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [5, 5],
  );
});

void test("allows one under-minimum install when total reaction runs are too small", () => {
  const schedules = solveSimulationActivity(
    [job("A", 3, 3, 60, [10])],
    3,
    "available-slots",
    24,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [3],
  );
});

void test("derives the ME minimum from persisted jobs without per-run input quantities", () => {
  const persistedJob = job("A", 20, 20, 60);
  persistedJob.inputs = [
    {
      typeId: 1000,
      typeName: "Input",
      requiredQuantity: 100,
      availableNow: 100,
      availableFromHauling: 0,
      availableAfterUpstream: 100,
      unsatisfiedQuantity: 0,
    },
  ];
  const schedules = solveSimulationActivity(
    [persistedJob],
    2,
    "available-slots",
    24,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [10, 10],
  );
});

void test("keeps all but one persisted-result install at the ten-run minimum", () => {
  const persistedJob = job("A", 35, 35, 60);
  persistedJob.inputs = [
    {
      typeId: 1000,
      typeName: "Input",
      requiredQuantity: 175,
      availableNow: 175,
      availableFromHauling: 0,
      availableAfterUpstream: 175,
      unsatisfiedQuantity: 0,
    },
  ];
  const schedules = solveSimulationActivity(
    [persistedJob],
    4,
    "available-slots",
    24,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [10, 10, 10, 5],
  );
});

void test("uses one install when another protected install would be under minimum", () => {
  const schedules = solveSimulationActivity(
    [job("A", 9, 9, 60, [5])],
    2,
    "available-slots",
    24,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [9],
  );
});

void test("keeps the protected minimum when runtime activities are mixed", () => {
  const manufacturingJob = job("M", 2, 2, 60);
  manufacturingJob.activity = "manufacturing";
  const schedules = solveSimulationActivity(
    [job("A", 19, 19, 3600, [5]), manufacturingJob],
    3,
    "run-time-hours",
    1,
    new Set(["A", "M"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [10, 9],
  );
});

void test("uses a protected full install and one remainder install", () => {
  const schedules = solveSimulationActivity(
    [job("A", 11, 11, 60, [5])],
    2,
    "available-slots",
    24,
    new Set(["A"]),
    [],
    {
      protectReactionMaterialBonus: true,
      reactionMaterialBonusesByLocation: new Map([[20, -2.2]]),
    },
  );

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [10, 1],
  );
});
