import assert from "node:assert/strict";
import test from "node:test";
import { solveSimulationActivity } from "./clientScheduler";
import type { SimulationIndustryJob } from "./types";

/** Creates a minimal simulator job for client scheduler tests. */
function job(
  jobId: string,
  requiredRuns: number,
  readyNowRuns: number,
  durationPerRunSeconds: number,
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
    inputs: [],
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

void test("limits each suggested install to the requested run time", () => {
  const schedules = solveSimulationActivity([job("A", 10, 10, 3600)], 1, "run-time-hours", 3);

  assert.equal(schedules.get("A")?.installs.length, 1);
  assert.equal(schedules.get("A")?.installs[0]?.runs, 3);
  assert.equal(schedules.get("A")?.timeSeconds, 10800);
});
