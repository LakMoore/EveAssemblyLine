import assert from "node:assert/strict";
import test from "node:test";
import {
  convertSimulationTargetTime,
  simulationManufacturingInstallPlan,
  scheduledSimulationActivity,
  simulationReactionFormulaKey,
  solveSimulationActivity,
  summarizeClientSimulationInstalls,
} from "./clientScheduler";
import { simulationReactionFormulaAvailability } from "./reactionFormulaAvailability";
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
    depth: 1,
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

void test("uses scheduler installs starting at T+0 for schedule-mode suggestions", () => {
  const scheduledJob = {
    ...job("A", 8, 8, 60),
    installs: [
      {
        installId: "now",
        characterId: 42,
        slotIndex: 3,
        runs: 5,
        startOffsetSeconds: 0,
        endOffsetSeconds: 300,
        durationSeconds: 300,
        readiness: "after-upstream" as const,
        inputs: [],
      },
      {
        installId: "later",
        characterId: 43,
        slotIndex: 1,
        runs: 3,
        startOffsetSeconds: 300,
        endOffsetSeconds: 480,
        durationSeconds: 180,
        readiness: "now" as const,
        inputs: [],
      },
    ],
  };
  const excludedJob = {
    ...job("B", 2, 2, 60),
    installs: [scheduledJob.installs[0]],
  };
  const schedules = scheduledSimulationActivity([scheduledJob, excludedJob], new Set(["A"]));

  assert.deepEqual(
    schedules.get("A"),
    {
      installs: [
        {
          installId: "now",
          characterId: 42,
          slotIndex: 3,
          runs: 5,
          durationSeconds: 300,
        },
      ],
      runs: 5,
      timeSeconds: 300,
    },
  );
  assert.deepEqual(schedules.get("B"), { installs: [], runs: 0, timeSeconds: 0 });
});

void test("uses only canonical installs in Schedule mode", () => {
  const scheduledJob = {
    ...job("A", 8, 8, 60),
    installs: [
      {
        installId: "server-install",
        characterId: 42,
        slotIndex: 3,
        runs: 5,
        startOffsetSeconds: 0,
        endOffsetSeconds: 300,
        durationSeconds: 300,
        readiness: "now" as const,
        inputs: [],
      },
    ],
  };
  const localSchedule = {
    installs: [
      {
        installId: "client-install:A:0",
        runs: 8,
        durationSeconds: 480,
        characterId: 42,
        slotIndex: 0,
      },
    ],
    runs: 8,
    timeSeconds: 480,
  };

  assert.deepEqual(
    simulationManufacturingInstallPlan(scheduledJob, localSchedule, "schedule"),
    [
      {
        install: {
          installId: "server-install",
          runs: 5,
          durationSeconds: 300,
          characterId: 42,
          slotIndex: 3,
        },
        trackCompletion: false,
      },
    ],
  );
});

void test("appends unassigned local virtual installs in total and installable modes", () => {
  const scheduledJob = {
    ...job("A", 8, 8, 60),
    installs: [
      {
        installId: "server-install",
        characterId: 42,
        slotIndex: 3,
        runs: 5,
        startOffsetSeconds: 0,
        endOffsetSeconds: 300,
        durationSeconds: 300,
        readiness: "now" as const,
        inputs: [],
      },
    ],
  };
  const localSchedule = {
    installs: [
      {
        installId: "client-install:A:0",
        runs: 8,
        durationSeconds: 480,
        characterId: 42,
        slotIndex: 0,
      },
    ],
    runs: 8,
    timeSeconds: 480,
  };

  for (const displayMode of ["total", "installable"] as const) {
    const details = simulationManufacturingInstallPlan(scheduledJob, localSchedule, displayMode);

    assert.equal(details.length, 2);
    assert.equal(details[0].install.characterId, 42);
    assert.equal(details[0].trackCompletion, false);
    assert.equal(details[1].install.installId, "client-install:A:0");
    assert.equal(details[1].install.characterId, undefined);
    assert.equal(details[1].install.slotIndex, undefined);
    assert.equal(details[1].trackCompletion, true);
  }
});

void test("keeps short reactions in one install and uses spare slots for long reactions", () => {
  const schedules = solveSimulationActivity(
    [job("long", 100, 100, 3600), job("few-runs", 8, 8, 3600), job("short-time", 1000, 1000, 60)],
    5,
    "available-slots",
    24,
  );

  assert.equal(schedules.get("long")?.installs.length, 3);
  assert.equal(schedules.get("few-runs")?.installs.length, 1);
  assert.equal(schedules.get("short-time")?.installs.length, 1);
});

void test("does not schedule more installs than available reaction formulas", () => {
  const schedules = solveSimulationActivity(
    [job("A", 100, 100, 3600), job("B", 50, 50, 3600)],
    4,
    "available-slots",
    24,
    new Set(["A", "B"]),
    [],
    {
      availableReactionFormulaCountsByLocationAndType: new Map([
        [simulationReactionFormulaKey(20, 46207), 1],
      ]),
    },
  );

  assert.equal(
    [...schedules.values()].reduce((total, schedule) => total + schedule.installs.length, 0),
    1,
  );
  assert.equal(schedules.get("A")?.runs, 100);
  assert.equal(schedules.get("B")?.runs, 0);
});

void test("caps local reaction installs at visible formulas minus in-use formulas", () => {
  const industryJobs = Array.from(
    { length: 33 },
    (_, index) =>
      ({
        activity: "Reaction",
        status: "active",
        ownerType: "character",
        ownerId: 1,
        jobId: index + 1,
        facilityId: 20,
        blueprintTypeId: 46207,
      }) as const,
  );
  const availability = simulationReactionFormulaAvailability(
    [
      {
        category: "reactionformula",
        name: "Formula A",
        quantity: 35,
        typeId: 46207,
        locationId: 20,
      },
    ],
    industryJobs,
  );
  const schedules = solveSimulationActivity(
    [job("A", 100, 100, 3600), job("B", 100, 100, 3600)],
    4,
    "available-slots",
    24,
    new Set(["A", "B"]),
    [],
    {
      availableReactionFormulaCountsByLocationAndType: availability.availableByLocationAndType,
    },
  );
  const key = simulationReactionFormulaKey(20, 46207);

  assert.equal(availability.visibleByLocationAndType.get(key), 35);
  assert.equal(availability.inUseByLocationAndType.get(key), 33);
  assert.equal(availability.availableByLocationAndType.get(key), 2);
  assert.equal(
    [...schedules.values()].reduce((total, schedule) => total + schedule.installs.length, 0),
    2,
  );
});

void test("splits a fractional per-install average into exact integer-run batches", () => {
  const summary = summarizeClientSimulationInstalls([
    { installId: "first", runs: 10, durationSeconds: 3600 },
    { installId: "second", runs: 11, durationSeconds: 7200 },
  ]);

  assert.deepEqual(
    summary,
    {
      count: 2,
      totalRuns: 21,
      batches: [
        {
          runsPerInstall: 11,
          installCount: 1,
          estimatedDurationSecondsPerInstall: 5657.142857142858,
        },
        {
          runsPerInstall: 10,
          installCount: 1,
          estimatedDurationSecondsPerInstall: 5142.857142857143,
        },
      ],
    },
  );
});

void test("keeps an integer per-install average in one batch", () => {
  const summary = summarizeClientSimulationInstalls([
    { installId: "first", runs: 10, durationSeconds: 3600 },
    { installId: "second", runs: 10, durationSeconds: 3600 },
  ]);

  assert.deepEqual(
    summary.batches,
    [{ runsPerInstall: 10, installCount: 2, estimatedDurationSecondsPerInstall: 3600 }],
  );
});

void test("reports no suggested work when there are no generated installs", () => {
  assert.deepEqual(
    summarizeClientSimulationInstalls([]),
    {
      count: 0,
      totalRuns: 0,
      batches: [],
    },
  );
});

void test("does not subtract unrelated in-flight jobs from available formulas", () => {
  const availability = simulationReactionFormulaAvailability(
    [
      { category: "reactionformula", name: "Formula A", quantity: 2, typeId: 100, locationId: 10 },
      { category: "reactionformula", name: "Formula B", quantity: 1, typeId: 200, locationId: 20 },
    ],
    [
      {
        activity: "Reaction",
        status: "active",
        ownerType: "character",
        ownerId: 1,
        jobId: 11,
        facilityId: 20,
        blueprintTypeId: 200,
      },
      {
        activity: "Reaction",
        status: "paused",
        ownerType: "character",
        ownerId: 1,
        jobId: 12,
        facilityId: 30,
        blueprintTypeId: 300,
      },
    ],
  );

  assert.equal(
    availability.availableByLocationAndType.get(simulationReactionFormulaKey(10, 100)),
    2,
  );
  assert.equal(
    availability.availableByLocationAndType.get(simulationReactionFormulaKey(20, 200)),
    0,
  );
  assert.equal(availability.visibleByLocationAndType.get(simulationReactionFormulaKey(10, 100)), 2);
  assert.equal(availability.visibleByLocationAndType.get(simulationReactionFormulaKey(20, 200)), 1);
  assert.equal(
    availability.visibleByLocationAndType.get(simulationReactionFormulaKey(30, 300)),
    undefined,
  );
});

void test("separates owned formula totals from visible and in-use location counts", () => {
  const availability = simulationReactionFormulaAvailability(
    [
      { category: "reactionformula", name: "Formula A", quantity: 2, typeId: 100, locationId: 10 },
      { category: "reactionformula", name: "Formula A", quantity: 3, typeId: 100, locationId: 20 },
      { category: "reactionformula", name: "Formula A", quantity: 1, typeId: 100 },
    ],
    [
      {
        activity: "Reaction",
        status: "active",
        ownerType: "character",
        ownerId: 1,
        jobId: 11,
        facilityId: 10,
        blueprintTypeId: 100,
      },
      {
        activity: "Reaction",
        status: "paused",
        ownerType: "character",
        ownerId: 1,
        jobId: 12,
        facilityId: 20,
        blueprintTypeId: 100,
      },
    ],
  );

  assert.equal(availability.ownedByLocationAndType.get(simulationReactionFormulaKey(10, 100)), 2);
  assert.equal(availability.ownedByLocationAndType.get(simulationReactionFormulaKey(20, 100)), 3);
  assert.equal(
    availability.ownedByLocationAndType.has(simulationReactionFormulaKey(30, 100)),
    false,
  );
  assert.equal(availability.visibleByLocationAndType.get(simulationReactionFormulaKey(10, 100)), 2);
  assert.equal(availability.inUseByLocationAndType.get(simulationReactionFormulaKey(10, 100)), 1);
  assert.equal(
    availability.availableByLocationAndType.get(simulationReactionFormulaKey(10, 100)),
    1,
  );
  assert.equal(availability.visibleByLocationAndType.get(simulationReactionFormulaKey(20, 100)), 3);
  assert.equal(availability.inUseByLocationAndType.get(simulationReactionFormulaKey(20, 100)), 1);
  assert.equal(
    availability.availableByLocationAndType.get(simulationReactionFormulaKey(20, 100)),
    2,
  );
});

void test("uses TAKE for owned counts and QUERY for visible counts", () => {
  const source = (canTake: boolean, canQuery: boolean) => ({
    rootLocationId: 10,
    locationFlag: "CorpSAG1",
    containerItemIds: [101],
    canTake,
    canQuery,
  });
  const availability = simulationReactionFormulaAvailability(
    [
      {
        category: "reactionformula",
        name: "Formula A",
        quantity: 1,
        typeId: 100,
        ownerType: "character",
        locationId: 10,
      },
      {
        category: "reactionformula",
        name: "Formula A",
        quantity: 2,
        typeId: 100,
        ownerType: "corporation",
        rootLocationId: 10,
        corporationSource: source(true, false),
      },
      {
        category: "reactionformula",
        name: "Formula A",
        quantity: 3,
        typeId: 100,
        ownerType: "corporation",
        rootLocationId: 10,
        corporationSource: source(true, true),
      },
      {
        category: "reactionformula",
        name: "Formula A",
        quantity: 4,
        typeId: 100,
        ownerType: "corporation",
        rootLocationId: 10,
        corporationSource: source(false, true),
      },
      {
        category: "reactionformula",
        name: "Formula A",
        quantity: 5,
        typeId: 100,
        ownerType: "corporation",
        rootLocationId: 10,
      },
    ],
    [],
  );
  const key = simulationReactionFormulaKey(10, 100);

  assert.equal(availability.ownedByLocationAndType.get(key), 6);
  assert.equal(availability.visibleByLocationAndType.get(key), 8);
  assert.equal(availability.availableByLocationAndType.get(key), 8);
});

void test("matches visible totals when a query-only container is unchecked", () => {
  const ownedFormula = {
    category: "reactionformula" as const,
    name: "Formula A",
    quantity: 4,
    typeId: 100,
    ownerType: "corporation" as const,
    rootLocationId: 10,
    corporationSource: {
      rootLocationId: 10,
      locationFlag: "CorpSAG3",
      containerItemIds: [101],
      canTake: true,
      canQuery: true,
    },
  };
  const uncheckedQueryOnlyFormula = {
    ...ownedFormula,
    quantity: 10,
    corporationSource: {
      ...ownedFormula.corporationSource,
      locationFlag: "CorpSAG6",
      containerItemIds: [102],
      canTake: false,
      canQuery: true,
    },
  };
  const availability = simulationReactionFormulaAvailability(
    [ownedFormula],
    [],
    [ownedFormula, uncheckedQueryOnlyFormula],
  );
  const key = simulationReactionFormulaKey(10, 100);

  assert.equal(availability.visibleByLocationAndType.get(key), 14);
  assert.equal(availability.ownedByLocationAndType.get(key), 4);
  assert.equal(availability.availableByLocationAndType.get(key), 14);
});

void test("counts unchecked TAKE and QUERY formulas as visible only", () => {
  const corporationSource = {
    rootLocationId: 10,
    locationFlag: "CorpSAG1",
    containerItemIds: [101],
    canTake: true,
    canQuery: true,
  };
  const personalFormula = {
    category: "reactionformula" as const,
    name: "Formula A",
    quantity: 1,
    typeId: 100,
    ownerType: "character" as const,
    locationId: 10,
  };
  const selectedFormula = {
    category: "reactionformula" as const,
    name: "Formula A",
    quantity: 2,
    typeId: 100,
    ownerType: "corporation" as const,
    rootLocationId: 10,
    corporationSource: corporationSource,
  };
  const uncheckedFormula = {
    ...selectedFormula,
    quantity: 3,
    corporationSource: { ...corporationSource, containerItemIds: [102] },
  };
  const availability = simulationReactionFormulaAvailability(
    [personalFormula, selectedFormula],
    [],
    [personalFormula, selectedFormula, uncheckedFormula],
  );
  const key = simulationReactionFormulaKey(10, 100);

  assert.equal(availability.ownedByLocationAndType.get(key), 3);
  assert.equal(availability.visibleByLocationAndType.get(key), 6);
  assert.equal(availability.availableByLocationAndType.get(key), 6);
});

void test("distinguishes missing industry jobs from a known empty job list", () => {
  const stock = [
    {
      category: "reactionformula" as const,
      name: "Formula A",
      quantity: 2,
      typeId: 100,
      locationId: 10,
    },
  ];
  const formulaKey = simulationReactionFormulaKey(10, 100);
  const unknown = simulationReactionFormulaAvailability(stock, undefined);
  const knownEmpty = simulationReactionFormulaAvailability(stock, []);

  assert.equal(unknown.availabilityKnown, false);
  assert.equal(unknown.visibleByLocationAndType.get(formulaKey), 2);
  assert.equal(unknown.availableByLocationAndType.has(formulaKey), false);
  assert.equal(knownEmpty.availabilityKnown, true);
  assert.equal(knownEmpty.availableByLocationAndType.get(formulaKey), 2);
});

void test("isolates wormhole reaction slots by system and shares K-space slots", () => {
  const jobs = [
    { ...job("WH-B", 1, 1, 60), locationId: 102 },
    { ...job("WH-A", 1, 1, 60), locationId: 101 },
    { ...job("KS-B", 1, 1, 60), locationId: 104 },
    { ...job("KS-A", 1, 1, 60), locationId: 103 },
  ];
  const schedules = solveSimulationActivity(
    jobs,
    4,
    "available-slots",
    24,
    new Set(jobs.map(({ jobId }) => jobId)),
    [
      { characterId: 1, availableSlots: 1, systemId: 31_000_001 },
      { characterId: 2, availableSlots: 1, systemId: 31_000_002 },
      { characterId: 3, availableSlots: 1, systemId: 30_000_001 },
      { characterId: 4, availableSlots: 1, systemId: 30_000_002 },
    ],
    {
      locationSystemIdsById: new Map([
        [101, 31_000_001],
        [102, 31_000_002],
        [103, 30_000_001],
        [104, 30_000_002],
      ]),
    },
  );

  assert.equal(schedules.get("WH-A")?.installs[0]?.characterId, 1);
  assert.equal(schedules.get("WH-B")?.installs[0]?.characterId, 2);
  assert.deepEqual(
    [
      schedules.get("KS-A")?.installs[0]?.characterId,
      schedules.get("KS-B")?.installs[0]?.characterId,
    ].sort(),
    [3, 4],
  );
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
    [100],
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
    [25, 25, 25],
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

void test("balances runtime-limited installs across eligible reaction jobs", () => {
  const schedules = solveSimulationActivity(
    [job("A", 100, 100, 3600), job("B", 100, 100, 3600)],
    4,
    "run-time-hours",
    2,
  );

  assert.equal(schedules.get("A")?.installs.length, 2);
  assert.equal(schedules.get("B")?.installs.length, 2);
  assert.equal(schedules.get("A")?.runs, 4);
  assert.equal(schedules.get("B")?.runs, 4);
  assert.ok(
    [...schedules.values()].every((schedule) =>
      schedule.installs.every((install) => install.durationSeconds <= 7200),
    ),
  );
});

void test("converts reaction runtime days to hours before calculating runs", () => {
  const schedules = solveSimulationActivity([job("A", 25, 25, 3600)], 2, "run-time-days", 1);

  assert.deepEqual(
    schedules.get("A")?.installs.map((install) => install.runs),
    [13, 12],
  );
});

void test("does not exceed the runtime cap when it conflicts with the protected minimum", () => {
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

  assert.deepEqual(schedules.get("A")?.installs, []);
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
    [{ characterId: 7, slotIndex: 0, runs: 5 }],
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
    [10],
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
    [20],
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
    [35],
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
    [11],
  );
});
