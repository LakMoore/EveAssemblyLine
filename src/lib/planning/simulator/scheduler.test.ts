import assert from "node:assert/strict";
import test from "node:test";
import { scheduleSimulationJobs } from "./scheduler";
import type { SimulationIndustryJob, SimulationInventionJob } from "./types";

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

void test("does not timestamp an install whose inputs still need purchase", () => {
  const blocked: SimulationIndustryJob = {
    ...job("blocked", 1, 100),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    readyAfterUpstreamRuns: 0,
    blockedRuns: 1,
    inputs: [
      {
        typeId: 34,
        typeName: "Tritanium",
        requiredQuantity: 1,
        availableNow: 0,
        availableFromHauling: 0,
        availableAfterUpstream: 0,
        unsatisfiedQuantity: 1,
      },
    ],
  };
  const result = scheduleSimulationJobs(
    [blocked],
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
  assert.deepEqual(result.manufacturingJobs[0].installs, []);
  assert.equal(result.manufacturingJobs[0].unscheduledRuns, 1);
  assert.equal(
    result.warnings.some((warning) => warning.code === "missing-capacity"),
    false,
  );
});

void test("starts downstream work after its planned upstream output completes", () => {
  const downstream: SimulationIndustryJob = {
    ...job("downstream", 2, 300),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [
      {
        typeId: 4312,
        typeName: "Component",
        requiredQuantity: 6,
        availableNow: 0,
        availableFromHauling: 0,
        availableAfterUpstream: 6,
        unsatisfiedQuantity: 0,
        upstreamReservations: [
          {
            activity: "manufacturing",
            quantity: 6,
            state: "planned",
            sourceJobId: "upstream",
          },
        ],
      },
    ],
  };
  const result = scheduleSimulationJobs(
    [downstream, job("upstream", 1, 900)],
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
  const upstreamInstall = result.manufacturingJobs.find((item) => item.jobId === "upstream")
    ?.installs[0];
  const downstreamInstall = result.manufacturingJobs.find((item) => item.jobId === "downstream")
    ?.installs[0];
  assert.ok(upstreamInstall);
  assert.ok(downstreamInstall);
  assert.ok(downstreamInstall.startOffsetSeconds >= upstreamInstall.endOffsetSeconds);
});

void test("schedules a reaction before manufacturing that consumes its output", () => {
  const reaction: SimulationIndustryJob = { ...job("reaction", 1, 600), activity: "reaction" };
  const manufacturing: SimulationIndustryJob = {
    ...job("manufacturing", 2, 300),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [
      {
        typeId: 4312,
        typeName: "Component",
        requiredQuantity: 1,
        availableNow: 0,
        availableFromHauling: 0,
        availableAfterUpstream: 1,
        unsatisfiedQuantity: 0,
        upstreamReservations: [
          {
            activity: "reaction",
            quantity: 1,
            state: "planned",
            sourceJobId: "reaction",
          },
        ],
      },
    ],
  };
  const result = scheduleSimulationJobs(
    [manufacturing],
    [reaction],
    [],
    [],
    [
      {
        characterId: 7,
        freeSlots: { manufacturing: 1, reactions: 1, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
  );
  assert.ok(
    result.manufacturingJobs[0].installs[0].startOffsetSeconds
      >= result.reactionJobs[0].installs[0].endOffsetSeconds,
  );
});

void test("does not timestamp an invention attempt with missing materials", () => {
  const invention: SimulationInventionJob = {
    jobId: "invention",
    stockpileId: "main",
    locationId: 60,
    sourceBlueprintTypeId: 11620,
    outputBlueprintTypeId: 11808,
    attempts: 1,
    successProbability: 0.5,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetExpectedRuns: 1.2,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 600,
    inputs: [
      {
        typeId: 20417,
        typeName: "Datacore",
        requiredQuantity: 1,
        availableNow: 0,
        availableFromHauling: 0,
        availableAfterUpstream: 0,
        unsatisfiedQuantity: 1,
      },
    ],
    assignments: [],
    unscheduledAttempts: 1,
  };
  const result = scheduleSimulationJobs(
    [],
    [],
    [invention],
    [],
    [
      {
        characterId: 7,
        freeSlots: { manufacturing: 0, reactions: 0, science: 1 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
  );
  assert.deepEqual(result.inventionJobs[0].assignments, []);
  assert.equal(
    result.warnings.some((warning) => warning.code === "missing-capacity"),
    false,
  );
});
