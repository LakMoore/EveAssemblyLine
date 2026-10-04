import assert from "node:assert/strict";
import test from "node:test";
import { scheduleSimulationJobs } from "./scheduler";
import type { SimulationCopyJob, SimulationIndustryJob, SimulationInventionJob } from "./types";

/** Creates a minimal manufacturing job for scheduler tests. */
function job(
  id: string,
  blueprintItemId: number,
  durationPerRunSeconds: number,
): SimulationIndustryJob {
  return {
    jobId: id,
    depth: 1,
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

const systemIdsByLocation = new Map<number, number>([
  [20, 30_000_142],
  [60, 30_000_142],
]);

void test("assigns longest jobs first and serializes reuse of one blueprint", () => {
  const result = scheduleSimulationJobs(
    [job("long", 1, 100), job("same-blueprint", 1, 50), job("other", 2, 25)],
    [],
    [],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 2, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
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
  assert.equal(long.installs[0].installId, "install:long:7:0");
  assert.equal(reused.unscheduledRuns, 0);
  assert.ok(reused.installs[0].startOffsetSeconds >= long.installs[0].endOffsetSeconds);
});

void test("applies character timing relative to the shared skill baseline", () => {
  const reactionJob: SimulationIndustryJob = {
    ...job("reaction-character-timing", 2, 100),
    activity: "reaction",
  };
  const result = scheduleSimulationJobs(
    [job("character-timing", 1, 100)],
    [reactionJob],
    [],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 1, science: 0 },
        timeMultipliers: { manufacturing: 0.6, reactions: 0.5, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
    { manufacturing: 0.8, reactions: 0.4 },
  );

  assert.equal(result.manufacturingJobs[0].installs[0].durationSeconds, 75);
  assert.equal(result.reactionJobs[0].installs[0].durationSeconds, 125);
});

void test("schedules located reaction formulas without item IDs", () => {
  const formulaJob = (id: string, sourceLocationId?: number): SimulationIndustryJob => ({
    ...job(id, 1, 100),
    activity: "reaction",
    blueprint: {
      blueprintTypeId: 691,
      blueprintKind: "formula",
      ...(sourceLocationId === undefined ? {} : { sourceLocationId }),
      runs: Number.MAX_SAFE_INTEGER,
      materialEfficiency: 0,
      timeEfficiency: 0,
    },
  });
  const result = scheduleSimulationJobs(
    [],
    [
      formulaJob("local-formula", 20),
      formulaJob("remote-formula", 60),
      formulaJob("missing-formula"),
    ],
    [],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 1, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );

  assert.equal(
    result.reactionJobs.find((candidate) => candidate.jobId === "local-formula")?.installs.length,
    1,
  );
  assert.equal(
    result.reactionJobs.find((candidate) => candidate.jobId === "remote-formula")?.installs.length,
    0,
  );
  assert.equal(
    result.reactionJobs.find((candidate) => candidate.jobId === "missing-formula")?.installs.length,
    0,
  );
});

void test("requires industry characters to meet each job's exact skill levels", () => {
  const levelTwoJob = job("skill-level-two", 1, 100);
  const levelThreeJob = job("skill-level-three", 2, 100);
  const result = scheduleSimulationJobs(
    [levelTwoJob, levelThreeJob],
    [],
    [],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 2, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: { "3406": 2 },
      },
      {
        characterId: 8,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 2, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: { "3406": 1 },
      },
    ],
    systemIdsByLocation,
    undefined,
    [
      { jobId: levelTwoJob.jobId, skillId: 3406, requiredLevel: 2 },
      { jobId: levelThreeJob.jobId, skillId: 3406, requiredLevel: 3 },
    ],
  );

  assert.equal(result.manufacturingJobs[0].installs[0]?.characterId, 7);
  assert.equal(result.manufacturingJobs[1].installs.length, 0);
  assert.match(result.manufacturingJobs[1].noTimingReason ?? "", /required activity skills/i);
});

void test("requires science characters to meet invention skill levels", () => {
  const invention: SimulationInventionJob = {
    jobId: "skill-gated-invention",
    depth: 1,
    stockpileId: "main",
    locationId: 20,
    sourceBlueprintTypeId: 1,
    outputBlueprintTypeId: 2,
    attempts: 1,
    successProbability: 1,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 1,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 100,
    inputs: [],
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 1 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: { "3406": 1 },
      },
    ],
    systemIdsByLocation,
    undefined,
    [{ jobId: invention.jobId, skillId: 3406, requiredLevel: 2 }],
  );

  assert.equal(result.inventionJobs[0].assignments.length, 0);
  assert.match(result.inventionJobs[0].noTimingReason ?? "", /required activity skills/i);
});

void test("splits reaction installs by the configured duration and delays dependents", () => {
  const reaction: SimulationIndustryJob = {
    ...job("split-reaction", 1, 1_800),
    activity: "reaction",
    requiredRuns: 5,
    readyNowRuns: 5,
    readyAfterHaulingRuns: 5,
    readyAfterUpstreamRuns: 5,
  };
  const manufacturing: SimulationIndustryJob = {
    ...job("after-split-reaction", 2, 60),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [
      {
        typeId: 4312,
        typeName: "Reaction product",
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
            sourceJobId: reaction.jobId,
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 1, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
    { manufacturing: 1, reactions: 1 },
    [],
    1,
  );
  const scheduledReaction = result.reactionJobs[0];
  const scheduledManufacturing = result.manufacturingJobs[0];
  const finalReactionInstall = scheduledReaction.installs.at(-1);

  assert.ok(finalReactionInstall);
  assert.deepEqual(
    scheduledReaction.installs.map((install) => install.runs),
    [2, 2, 1],
  );
  assert.deepEqual(
    scheduledReaction.installs.map((install) => install.durationSeconds),
    [3_600, 3_600, 1_800],
  );
  assert.equal(scheduledReaction.unscheduledRuns, 0);
  assert.ok(
    scheduledManufacturing.installs[0].startOffsetSeconds >= finalReactionInstall.endOffsetSeconds,
  );
});

void test("aligns every activity start to the next 12-hour boundary", () => {
  const reaction: SimulationIndustryJob = {
    ...job("aligned-reaction", 1, 100),
    activity: "reaction",
    blueprint: {
      blueprintTypeId: 691,
      blueprintKind: "formula",
      sourceLocationId: 20,
      runs: Number.MAX_SAFE_INTEGER,
      materialEfficiency: 0,
      timeEfficiency: 0,
    },
  };
  const manufacturing: SimulationIndustryJob = {
    ...job("aligned-manufacturing", 2, 50),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [
      {
        typeId: 4312,
        typeName: "Reaction product",
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
            sourceJobId: reaction.jobId,
          },
        ],
      },
    ],
  };
  const copy: SimulationCopyJob = {
    jobId: "aligned-copy",
    depth: 1,
    stockpileId: "main",
    locationId: 20,
    blueprintTypeId: 691,
    sourceBlueprintItemId: 10,
    copies: 1,
    licensedRunsPerCopy: 1,
    totalLicensedRuns: 1,
    durationSeconds: 60,
    inputs: [],
    assignments: [],
    unscheduledCopies: 1,
  };
  const invention: SimulationInventionJob = {
    jobId: "aligned-invention",
    depth: 1,
    stockpileId: "main",
    locationId: 20,
    sourceBlueprintTypeId: 691,
    outputBlueprintTypeId: 692,
    attempts: 1,
    successProbability: 1,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 1,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 60,
    inputs: [],
    assignments: [],
    unscheduledAttempts: 1,
  };
  const result = scheduleSimulationJobs(
    [manufacturing],
    [reaction],
    [invention],
    [copy],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 1, science: 1 },
        inFlightJobs: [{ jobId: 99, activity: "invention", remainingSeconds: 120, slotIndex: 1 }],
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  const startOffsets = [
    result.reactionJobs[0].installs[0].startOffsetSeconds,
    result.manufacturingJobs[0].installs[0].startOffsetSeconds,
    result.copyJobs[0].assignments[0].startOffsetSeconds,
    result.inventionJobs[0].assignments[0].startOffsetSeconds,
  ];

  assert.ok(startOffsets.every((offset) => offset % (12 * 60 * 60) === 0));
  assert.equal(result.reactionJobs[0].installs[0].startOffsetSeconds, 0);
  assert.equal(result.manufacturingJobs[0].installs[0].startOffsetSeconds, 12 * 60 * 60);
  assert.equal(result.copyJobs[0].assignments[0].startOffsetSeconds, 0);
  assert.equal(result.inventionJobs[0].assignments[0].startOffsetSeconds, 12 * 60 * 60);
});

void test("prefers the earliest eligible slot start before projected finish", () => {
  const firstJob = job("a-job", 1, 10 * 60 * 60);
  const secondJob = job("b-job", 2, 10 * 60 * 60);
  const result = scheduleSimulationJobs(
    [firstJob, secondJob],
    [],
    [],
    [],
    [
      {
        characterId: 1,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 2, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
      {
        characterId: 2,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 0 },
        inFlightJobs: [
          { jobId: 900, activity: "manufacturing", remainingSeconds: 43_200, slotIndex: 0 },
        ],
        timeMultipliers: { manufacturing: 0.5, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );

  assert.equal(result.manufacturingJobs[0].installs[0].characterId, 1);
  assert.equal(result.manufacturingJobs[0].installs[0].startOffsetSeconds, 0);
  assert.equal(result.manufacturingJobs[0].installs[0].endOffsetSeconds, 72_000);
  assert.equal(result.manufacturingJobs[1].installs[0].characterId, 2);
  assert.equal(result.manufacturingJobs[1].installs[0].startOffsetSeconds, 43_200);
  assert.equal(result.manufacturingJobs[1].installs[0].endOffsetSeconds, 61_200);
});

void test("preserves the slot index assigned to each in-flight job", () => {
  const result = scheduleSimulationJobs(
    [job("fixed-in-flight-slot", 1, 60 * 60)],
    [],
    [],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 0 },
        inFlightJobs: [
          { jobId: 901, activity: "manufacturing", remainingSeconds: 86_400, slotIndex: 0 },
          { jobId: 902, activity: "manufacturing", remainingSeconds: 120, slotIndex: 1 },
        ],
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );

  assert.equal(result.manufacturingJobs[0].installs[0].slotIndex, 1);
});

void test("backfills a ready-now job before a future booking on the same slot", () => {
  const delayedJob = {
    ...job("a-delayed", 1, 3600),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    readyAfterUpstreamRuns: 1,
    inputs: [
      {
        typeId: 34,
        typeName: "Tritanium",
        requiredQuantity: 1,
        availableNow: 0,
        availableFromHauling: 0,
        availableAfterUpstream: 1,
        unsatisfiedQuantity: 0,
        upstreamReservations: [
          {
            activity: "manufacturing" as const,
            quantity: 1,
            state: "in-production" as const,
            sourceJobId: 900,
          },
        ],
      },
    ],
  };
  const readyJob = job("b-ready", 1, 3600);
  const result = scheduleSimulationJobs(
    [delayedJob, readyJob],
    [],
    [],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 0, science: 0 },
        inFlightJobs: [
          {
            jobId: 900,
            activity: "manufacturing",
            remainingSeconds: 3 * 24 * 60 * 60,
            slotIndex: 1,
          },
        ],
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  const scheduledDelayedJob = result.manufacturingJobs.find(
    (candidate) => candidate.jobId === "a-delayed",
  );
  const scheduledReadyJob = result.manufacturingJobs.find(
    (candidate) => candidate.jobId === "b-ready",
  );

  assert.ok(scheduledDelayedJob);
  assert.ok(scheduledReadyJob);
  assert.equal(scheduledDelayedJob.installs[0].startOffsetSeconds, 3 * 24 * 60 * 60);
  assert.equal(scheduledReadyJob.installs[0].startOffsetSeconds, 0);
  assert.equal(scheduledReadyJob.installs[0].slotIndex, 0);
});

void test("prefers the earlier-open slot when shared blueprint timing equalizes starts", () => {
  const blueprintJob = job("blueprint-owner", 10, 10 * 60 * 60);
  const waitingJob = job("blueprint-waiter", 10, 60 * 60);
  const result = scheduleSimulationJobs(
    [blueprintJob, waitingJob],
    [],
    [],
    [],
    [
      {
        characterId: 1,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 2, reactions: 1, copying: 1, invention: 1 },
        skillLevels: { "10": 1 },
      },
      {
        characterId: 2,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 0 },
        inFlightJobs: [
          { jobId: 900, activity: "manufacturing", remainingSeconds: 43_200, slotIndex: 0 },
        ],
        timeMultipliers: { manufacturing: 0.5, reactions: 1, copying: 1, invention: 1 },
        skillLevels: { "10": 1 },
      },
      {
        characterId: 3,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: { "20": 1 },
      },
    ],
    systemIdsByLocation,
    undefined,
    [
      { jobId: "blueprint-owner", skillId: 20, requiredLevel: 1 },
      { jobId: "blueprint-waiter", skillId: 10, requiredLevel: 1 },
    ],
  );
  const scheduledWaiter = result.manufacturingJobs.find(
    (scheduledJob) => scheduledJob.jobId === "blueprint-waiter",
  );

  assert.ok(scheduledWaiter);
  assert.equal(scheduledWaiter.installs[0].characterId, 1);
  assert.equal(scheduledWaiter.installs[0].startOffsetSeconds, 43_200);
  assert.equal(scheduledWaiter.installs[0].endOffsetSeconds, 50_400);
});

void test("propagates the deepest consumer depth across matching product locations", () => {
  const inputFrom = (sourceJobId: string) => ({
    typeId: 34,
    typeName: "Tritanium",
    requiredQuantity: 1,
    availableNow: 0,
    availableFromHauling: 0,
    availableAfterUpstream: 1,
    unsatisfiedQuantity: 0,
    upstreamReservations: [
      { activity: "manufacturing" as const, quantity: 1, state: "planned" as const, sourceJobId },
    ],
  });
  const orca = {
    ...job("orca", 1, 100),
    productTypeId: 45_000,
    blueprint: {
      ...job("orca-blueprint", 1, 100).blueprint,
      blueprintTypeId: 9000,
      blueprintKind: "bpc" as const,
    },
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [inputFrom("part-a")],
  };
  const charon = {
    ...job("charon", 2, 100),
    productTypeId: 45_001,
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [inputFrom("charon-component")],
  };
  const charonComponent = {
    ...job("charon-component", 3, 100),
    productTypeId: 400,
    readyNowRuns: 0,
    readyAfterHaulingRuns: 0,
    inputs: [inputFrom("part-b")],
  };
  const partA = { ...job("part-a", 4, 100), productTypeId: 500 };
  const partB = { ...job("part-b", 5, 100), productTypeId: 500 };
  const invention: SimulationInventionJob = {
    jobId: "orca-invention",
    depth: 1,
    stockpileId: "main",
    locationId: 20,
    sourceBlueprintTypeId: 9001,
    outputBlueprintTypeId: 9000,
    attempts: 1,
    successProbability: 1,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 1,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 100,
    inputs: [inputFrom("source-copy")],
    assignments: [],
    unscheduledAttempts: 1,
  };
  const copy: SimulationCopyJob = {
    jobId: "source-copy",
    depth: 1,
    stockpileId: "main",
    locationId: 20,
    blueprintTypeId: 9001,
    sourceBlueprintItemId: 9002,
    sourceBlueprintLocationId: 20,
    copies: 1,
    licensedRunsPerCopy: 1,
    totalLicensedRuns: 1,
    durationSeconds: 100,
    inputs: [],
    assignments: [],
    unscheduledCopies: 1,
  };
  const result = scheduleSimulationJobs(
    [orca, charon, charonComponent, partA, partB],
    [],
    [invention],
    [copy],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 10, reactions: 0, science: 1 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  const depthsByJobId = new Map(
    result.manufacturingJobs.map((scheduledJob) => [scheduledJob.jobId, scheduledJob.depth]),
  );

  assert.equal(depthsByJobId.get("orca"), 1);
  assert.equal(depthsByJobId.get("charon"), 1);
  assert.equal(depthsByJobId.get("charon-component"), 2);
  assert.equal(depthsByJobId.get("part-a"), 3);
  assert.equal(depthsByJobId.get("part-b"), 3);
  assert.equal(result.inventionJobs[0].depth, 2);
  assert.equal(result.copyJobs[0].depth, 3);
  assert.equal(result.copyJobs[0].assignments[0].startOffsetSeconds, 0);
  assert.equal(result.inventionJobs[0].assignments[0].startOffsetSeconds, 43_200);
  assert.equal(
    result.manufacturingJobs.find((scheduledJob) => scheduledJob.jobId === "charon-component")
      ?.installs[0].startOffsetSeconds,
    43_200,
  );
  assert.equal(
    result.manufacturingJobs.find((scheduledJob) => scheduledJob.jobId === "charon")?.installs[0]
      .startOffsetSeconds,
    86_400,
  );
});

void test("schedules missing non-haulable inputs at T+1d", () => {
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 2, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  assert.equal(result.manufacturingJobs[0].installs[0].startOffsetSeconds, 86_400);
  assert.equal(result.manufacturingJobs[0].unscheduledRuns, 0);
  assert.equal(
    result.warnings.some((warning) => warning.code === "missing-capacity"),
    false,
  );
});

void test("allows hauling planned upstream output when calculating downstream timing", () => {
  const downstream: SimulationIndustryJob = {
    ...job("downstream", 2, 300),
    locationId: 60,
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 2, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  const upstreamInstall = result.manufacturingJobs.find((item) => item.jobId === "upstream")
    ?.installs[0];
  const downstreamInstall = result.manufacturingJobs.find((item) => item.jobId === "downstream")
    ?.installs[0];
  assert.ok(upstreamInstall);
  assert.ok(downstreamInstall);
  assert.notEqual(
    result.manufacturingJobs.find((item) => item.jobId === "upstream")?.locationId,
    result.manufacturingJobs.find((item) => item.jobId === "downstream")?.locationId,
  );
  assert.ok(downstreamInstall.startOffsetSeconds >= upstreamInstall.endOffsetSeconds);
});

void test("blocks timing when existing input assets need hauling", () => {
  const blocked = {
    ...job("remote-existing-input", 1, 60),
    readyNowRuns: 0,
    readyAfterHaulingRuns: 1,
    inputs: [
      {
        typeId: 34,
        typeName: "Tritanium",
        requiredQuantity: 10,
        availableNow: 0,
        availableFromHauling: 10,
        availableAfterUpstream: 10,
        unsatisfiedQuantity: 0,
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 0, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );

  assert.equal(result.manufacturingJobs[0].installs.length, 0);
  assert.match(
    result.manufacturingJobs[0].noTimingReason ?? "",
    /existing input assets must be hauled/i,
  );
});

void test("allows planned industry output to be hauled when timing science work", () => {
  const upstream = { ...job("remote-science-upstream", 1, 600), locationId: 20 };
  const invention: SimulationInventionJob = {
    jobId: "remote-science-downstream",
    depth: 1,
    stockpileId: "main",
    locationId: 60,
    sourceBlueprintTypeId: 11620,
    outputBlueprintTypeId: 11808,
    attempts: 1,
    successProbability: 0.5,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 0.95,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 60,
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
            activity: "manufacturing",
            quantity: 1,
            state: "planned",
            sourceJobId: upstream.jobId,
          },
        ],
      },
    ],
    assignments: [],
    unscheduledAttempts: 1,
  };
  const result = scheduleSimulationJobs(
    [upstream],
    [],
    [invention],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 0, science: 1 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  const upstreamEnd = result.manufacturingJobs[0].installs[0].endOffsetSeconds;
  assert.ok(result.inventionJobs[0].assignments[0].startOffsetSeconds >= upstreamEnd);
  assert.equal(result.inventionJobs[0].noTimingReason, undefined);
});

void test("reports why science timing is blocked by remote existing assets", () => {
  const invention: SimulationInventionJob = {
    jobId: "remote-science-input",
    depth: 1,
    stockpileId: "main",
    locationId: 60,
    sourceBlueprintTypeId: 11620,
    outputBlueprintTypeId: 11808,
    attempts: 1,
    successProbability: 0.5,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 0.95,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 60,
    inputs: [
      {
        typeId: 20417,
        typeName: "Datacore",
        requiredQuantity: 1,
        availableNow: 0,
        availableFromHauling: 1,
        availableAfterUpstream: 1,
        unsatisfiedQuantity: 0,
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 1 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );

  assert.deepEqual(result.inventionJobs[0].assignments, []);
  assert.match(result.inventionJobs[0].noTimingReason ?? "", /datacore assets must be hauled/i);
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 1, reactions: 1, science: 0 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  assert.ok(
    result.manufacturingJobs[0].installs[0].startOffsetSeconds
      >= result.reactionJobs[0].installs[0].endOffsetSeconds,
  );
});

void test("enforces wormhole and K-space location rules for all scheduled activities", () => {
  const profiles = [31_000_001, 31_000_002, 30_000_001, 30_000_002].map((systemId, index) => ({
    characterId: index + 1,
    systemId,
    freeSlots: { manufacturing: 1, reactions: 1, science: 1 },
    timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
    skillLevels: {},
  }));
  const manufacturingJobs = [
    { ...job("manufacturing-wh-a", 1, 60), locationId: 101 },
    { ...job("manufacturing-kspace", 2, 60), locationId: 103 },
  ];
  const reactionJobs = [
    { ...job("reaction-wh-b", 3, 60), activity: "reaction" as const, locationId: 102 },
    { ...job("reaction-kspace", 4, 60), activity: "reaction" as const, locationId: 104 },
  ];
  const copyJob: SimulationCopyJob = {
    jobId: "copy-wh-a",
    depth: 1,
    stockpileId: "main",
    locationId: 101,
    blueprintTypeId: 1001,
    sourceBlueprintItemId: 5001,
    sourceBlueprintLocationId: 101,
    copies: 1,
    licensedRunsPerCopy: 1,
    totalLicensedRuns: 1,
    durationSeconds: 60,
    inputs: [],
    assignments: [],
    unscheduledCopies: 1,
  };
  const inventionJob: SimulationInventionJob = {
    jobId: "invention-kspace",
    depth: 1,
    stockpileId: "main",
    locationId: 104,
    sourceBlueprintTypeId: 11620,
    outputBlueprintTypeId: 11808,
    attempts: 1,
    successProbability: 0.5,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 0.95,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 60,
    inputs: [],
    assignments: [],
    unscheduledAttempts: 1,
  };
  const locationSystemIdsById = new Map([
    [101, 31_000_001],
    [102, 31_000_002],
    [103, 30_000_001],
    [104, 30_000_002],
  ]);

  const result = scheduleSimulationJobs(
    manufacturingJobs,
    reactionJobs,
    [inventionJob],
    [copyJob],
    profiles,
    locationSystemIdsById,
  );

  assert.equal(result.manufacturingJobs[0].installs[0]?.characterId, 1);
  assert.ok([3, 4].includes(result.manufacturingJobs[1].installs[0]?.characterId ?? 0));
  assert.equal(result.reactionJobs[0].installs[0]?.characterId, 2);
  assert.ok([3, 4].includes(result.reactionJobs[1].installs[0]?.characterId ?? 0));
  assert.equal(result.copyJobs[0].assignments[0]?.characterId, 1);
  assert.ok([3, 4].includes(result.inventionJobs[0].assignments[0]?.characterId ?? 0));
});

void test("schedules an invention attempt with missing materials at T+1d", () => {
  const invention: SimulationInventionJob = {
    jobId: "invention",
    depth: 1,
    stockpileId: "main",
    locationId: 60,
    sourceBlueprintTypeId: 11620,
    outputBlueprintTypeId: 11808,
    attempts: 1,
    successProbability: 0.5,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 0.95,
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
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 1 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );
  assert.equal(result.inventionJobs[0].assignments[0].startOffsetSeconds, 86_400);
  assert.equal(
    result.warnings.some((warning) => warning.code === "missing-capacity"),
    false,
  );
});

void test("reuses all activity slots after currently active jobs complete", () => {
  const invention: SimulationInventionJob = {
    jobId: "invention-first",
    depth: 1,
    stockpileId: "main",
    locationId: 60,
    sourceBlueprintTypeId: 11620,
    outputBlueprintTypeId: 11808,
    attempts: 1,
    successProbability: 0.5,
    runsPerSuccess: 1,
    requiredOutputRuns: 1,
    targetSuccessProbability: 0.95,
    expectedOutputCopies: 1,
    expectedOutputRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
    skillSource: "request",
    durationSeconds: 60,
    inputs: [],
    assignments: [],
    unscheduledAttempts: 1,
  };
  const reactionJob = { ...job("reaction-first", 3, 60), activity: "reaction" as const };
  const result = scheduleSimulationJobs(
    [job("manufacturing-first", 1, 60), job("manufacturing-second", 2, 60)],
    [reactionJob],
    [invention, { ...invention, jobId: "invention-second" }],
    [],
    [
      {
        characterId: 7,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 0, reactions: 0, science: 0 },
        inFlightJobs: [
          { jobId: 801, activity: "manufacturing", remainingSeconds: 120, slotIndex: 0 },
          { jobId: 802, activity: "reaction", remainingSeconds: 240, slotIndex: 0 },
          { jobId: 803, activity: "copying", remainingSeconds: 60, slotIndex: 0 },
        ],
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    systemIdsByLocation,
  );

  assert.equal(result.manufacturingJobs[0].installs[0].startOffsetSeconds, 43_200);
  assert.equal(result.manufacturingJobs[1].installs[0].startOffsetSeconds, 86_400);
  assert.equal(result.reactionJobs[0].installs[0].startOffsetSeconds, 43_200);
  assert.equal(result.inventionJobs[0].assignments[0].startOffsetSeconds, 43_200);
  assert.equal(result.inventionJobs[1].assignments[0].startOffsetSeconds, 86_400);
});
