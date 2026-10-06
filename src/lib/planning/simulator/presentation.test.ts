import assert from "node:assert/strict";
import test from "node:test";
import { groupSimulationActivityJobs, simulationRunsStartingAtT0 } from "./presentation";
import type { SimulationIndustryJob, SimulationJobInput } from "./types";

/** Creates a minimal simulator input for presentation aggregation tests. */
function input(
  requiredQuantity: number,
  availableNow: number,
  quantityPerRun = 10,
): SimulationJobInput {
  return {
    typeId: 34,
    typeName: "Tritanium",
    quantityPerRun,
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
    depth: 1,
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

void test("sums scheduled runs starting at T+0 across jobs", () => {
  const jobs = [
    job(
      "job-1",
      {
        installs: [
          {
            installId: "install-1",
            slotKey: "1:M:0",
            characterId: 1,
            slotIndex: 0,
            runs: 3,
            startOffsetSeconds: 0,
            endOffsetSeconds: 180,
            durationSeconds: 180,
            readiness: "after-upstream",
            inputs: [],
          },
          {
            installId: "install-2",
            slotKey: "1:M:1",
            characterId: 1,
            slotIndex: 1,
            runs: 2,
            startOffsetSeconds: 1,
            endOffsetSeconds: 121,
            durationSeconds: 120,
            readiness: "now",
            inputs: [],
          },
        ],
      },
    ),
    job(
      "job-2",
      {
        installs: [
          {
            installId: "install-3",
            slotKey: "2:M:0",
            characterId: 2,
            slotIndex: 0,
            runs: 4,
            startOffsetSeconds: 0,
            endOffsetSeconds: 240,
            durationSeconds: 240,
            readiness: "now",
            inputs: [],
          },
        ],
      },
    ),
  ];

  assert.equal(simulationRunsStartingAtT0(jobs), 7);
});
