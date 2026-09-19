import assert from "node:assert/strict";
import test from "node:test";
import { scheduleSimulationJobs } from "./scheduler";
import type { SimulationIndustryJob } from "./types";

/** Creates a minimal manufacturing job for scheduler tests. */
function job(
  id: string,
  blueprintItemId: number,
  durationPerRunSeconds: number,
): SimulationIndustryJob {
  return {
    jobId: id,
    activity: "manufacturing",
    stockpileId: "main",
    locationId: 20,
    productTypeId: 587,
    productName: "Rifter",
    blueprint: {
      blueprintTypeId: 691,
      blueprintItemId,
      blueprintKind: "bpo",
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
    durationPerRunSeconds,
    inputs: [],
    installs: [],
    demandSources: [],
  };
}

void test("assigns longest jobs first and serializes reuse of one blueprint", () => {
  const result = scheduleSimulationJobs(
    [job("long", 1, 100), job("same-blueprint", 1, 50), job("other", 2, 25)],
    [],
    [],
    [],
    [
      {
        characterId: 7,
        freeSlots: { manufacturing: 2, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
  );
  assert.equal(
    result.manufacturingJobs.find((candidate) => candidate.jobId === "long")?.installs.length,
    1,
  );
  assert.equal(
    result.manufacturingJobs.find((candidate) => candidate.jobId === "other")?.installs.length,
    1,
  );
  const long = result.manufacturingJobs.find((candidate) => candidate.jobId === "long");
  const reused = result.manufacturingJobs.find((candidate) => candidate.jobId === "same-blueprint");
  assert.ok(long);
  assert.ok(reused);
  assert.equal(reused.unscheduledRuns, 0);
  assert.ok(reused.installs[0].startOffsetSeconds >= long.installs[0].endOffsetSeconds);
});
