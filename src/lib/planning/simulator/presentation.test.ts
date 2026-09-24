import assert from "node:assert/strict";
import test from "node:test";
import { groupSimulationActivityJobs } from "./presentation";
import type { SimulationIndustryJob, SimulationJobInput } from "./types";

/** Creates a minimal simulator input for presentation aggregation tests. */
function input(requiredQuantity: number, availableNow: number): SimulationJobInput {
  return {
    typeId: 34,
    typeName: "Tritanium",
    quantityPerRun: 10,
    requiredQuantity,
    availableNow,
    availableFromHauling: 0,
    availableAfterUpstream: requiredQuantity,
    unsatisfiedQuantity: Math.max(0, requiredQuantity - availableNow),
  };
}

/** Creates a minimal simulator job for presentation aggregation tests. */
function job(jobId: string, overrides: Partial<SimulationIndustryJob> = {}): SimulationIndustryJob {
  return {
    jobId,
    activity: "manufacturing",
    stockpileId: "main",
    locationId: 20,
    productTypeId: 20185,
    productName: "Charon",
    blueprint: {
      blueprintTypeId: blueprintTypeId(jobId),
      blueprintKind: "bpc",
      runs: 1,
      materialEfficiency: 10,
      timeEfficiency: 20,
    },
    outputPerRun: 1,
    requiredRuns: 1,
    readyNowRuns: 1,
    readyAfterHaulingRuns: 1,
    readyAfterUpstreamRuns: 1,
    blockedRuns: 0,
    unscheduledRuns: 1,
    materialMultiplier: 1,
    timeMultiplier: 1,
    durationPerRunSeconds: 60,
    inputs: [input(10, 10)],
    installs: [],
    demandSources: [],
    ...overrides,
  };
}

/** Returns a distinct blueprint ID for each test job. */
function blueprintTypeId(jobId: string): number {
  return 1000 + Number(jobId.replace(/\D/g, ""));
}

void test("groups same-activity jobs by location and product and sums quantities", () => {
  const groups = groupSimulationActivityJobs([
    job("job-1", { requiredRuns: 2, readyNowRuns: 1, inputs: [input(20, 3)] }),
    job("job-2", { requiredRuns: 3, readyNowRuns: 2, inputs: [input(30, 4)] }),
    job("job-3", { locationId: 30 }),
  ]);

  assert.equal(groups.length, 2);
  const charon = groups.find((group) => group.locationId === 20);
  assert.ok(charon);
  assert.equal(charon.jobs.length, 2);
  assert.equal(charon.quantities.installableRuns, 3);
  assert.equal(charon.quantities.totalRuns, 5);
  assert.deepEqual(
    charon.quantities.inputs.map(({ typeId, availableNow, requiredQuantity }) => ({
      typeId,
      availableNow,
      requiredQuantity,
    })),
    [{ typeId: 34, availableNow: 7, requiredQuantity: 50 }],
  );
});

void test("keeps activity locations and activity kinds as separate groups", () => {
  const groups = groupSimulationActivityJobs([
    job("job-1"),
    job("job-2", { activity: "reaction" }),
    job("job-3", { locationId: 30 }),
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map(({ groupKey }) => groupKey),
    ["manufacturing:20:20185", "reaction:20:20185", "manufacturing:30:20185"],
  );
});
