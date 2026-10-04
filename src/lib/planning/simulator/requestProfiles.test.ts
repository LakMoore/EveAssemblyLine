import assert from "node:assert/strict";
import test from "node:test";
import type { ClientJobsResponse } from "@/lib/client/requestCache";
import {
  createSimulationCharacterProfiles,
  hasUsableSimulationCharacterSnapshots,
  simulationTimeMultipliers,
} from "./requestProfiles";

type ClientIndustryJob = NonNullable<ClientJobsResponse["jobs"]>[number];

function clientIndustryJob(overrides: Partial<ClientIndustryJob> = {}): ClientIndustryJob {
  return {
    jobId: 1,
    characterId: 7,
    ownerId: 7,
    ownerType: "character",
    activity: "Invention",
    status: "active",
    runs: 1,
    outputQuantity: 1,
    startDate: "2026-10-04T11:00:00.000Z",
    endDate: "2026-10-04T12:01:00.000Z",
    facilityId: 10,
    outputLocationId: 10,
    outputLocationName: "Test facility",
    blueprintTypeId: 100,
    ...overrides,
  };
}

void test("builds character slot and skill profiles from cached planner state", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const profiles = createSimulationCharacterProfiles(
    [
      {
        characterId: 7,
        location: { status: "fresh", hasBody: true, systemId: 31_000_001 },
        skills: {
          status: "fresh",
          hasBody: true,
          body: [
            { skillId: 3380, activeSkillLevel: 4 },
            { skillId: 3388, activeSkillLevel: 3 },
            { skillId: 45746, activeSkillLevel: 5 },
            { skillId: 3406, activeSkillLevel: 2 },
          ],
        },
      },
    ],
    {
      slotUsage: {
        "7": {
          slots: { Manufacturing: 2, Reactions: 1, Science: 3 },
          availableSlots: { Manufacturing: 10, Reactions: 3, Science: 5 },
        },
      },
      jobs: [
        clientIndustryJob({ jobId: 101, endDate: "2026-10-04T12:01:00.000Z" }),
        clientIndustryJob({
          jobId: 102,
          activity: "Time research",
          endDate: "2026-10-04T12:02:00.000Z",
        }),
        clientIndustryJob({ jobId: 103, activity: "Material research" }),
        clientIndustryJob({
          jobId: 104,
          activity: "Copying",
          characterId: 8,
          ownerId: 8,
        }),
        clientIndustryJob({ jobId: 105, activity: "Manufacturing" }),
        clientIndustryJob({
          jobId: 106,
          activity: "Reactions",
          endDate: "2026-10-04T12:03:00.000Z",
        }),
        clientIndustryJob({ jobId: 101, endDate: "2026-10-04T12:01:00.000Z" }),
      ],
    },
    now,
  );

  assert.equal(profiles[0].systemId, 31_000_001);
  assert.deepEqual(
    profiles[0].freeSlots,
    {
      manufacturing: 8,
      reactions: 2,
      science: 2,
    },
  );
  assert.deepEqual(
    profiles[0].timeMultipliers,
    {
      manufacturing: 0.7644,
      reactions: 0.8,
      copying: 1,
      invention: 1,
    },
  );
  assert.equal(profiles[0].skillLevels["3406"], 2);
  assert.deepEqual(
    profiles[0].inFlightJobs,
    [
      { jobId: 101, activity: "invention", remainingSeconds: 60, slotIndex: 2 },
      { jobId: 103, activity: "material-research", remainingSeconds: 60, slotIndex: 3 },
      { jobId: 105, activity: "manufacturing", remainingSeconds: 60, slotIndex: 8 },
      { jobId: 102, activity: "time-research", remainingSeconds: 120, slotIndex: 4 },
      { jobId: 106, activity: "reaction", remainingSeconds: 180, slotIndex: 2 },
    ],
  );
});

void test("omits characters whose current system is unavailable", () => {
  assert.deepEqual(createSimulationCharacterProfiles([{ characterId: 9 }], undefined), []);
  assert.deepEqual(
    simulationTimeMultipliers(undefined),
    {
      manufacturing: 1,
      reactions: 1,
      copying: 1,
      invention: 1,
    },
  );
});

void test("requires complete character skill, job, and slot snapshots for simulation", () => {
  const characters = [
    {
      characterId: 7,
      location: { status: "fresh" as const, hasBody: true, systemId: 30_000_142 },
      industrySlots: { Manufacturing: 10, Reactions: 3, Science: 5 },
      skills: { status: "fresh" as const, hasBody: true, body: [] },
      jobs: { status: "cached" as const, hasBody: true },
    },
  ];
  const slotUsage = {
    "7": {
      slots: {},
      availableSlots: { Manufacturing: 10, Reactions: 3, Science: 5 },
    },
  };

  assert.equal(hasUsableSimulationCharacterSnapshots(characters, slotUsage), true);
  assert.equal(hasUsableSimulationCharacterSnapshots([{ characterId: 7 }], slotUsage), false);
  assert.equal(hasUsableSimulationCharacterSnapshots(characters, {}), false);
  assert.equal(
    hasUsableSimulationCharacterSnapshots(
      [{ ...characters[0], location: { status: "error", hasBody: false } }],
      slotUsage,
    ),
    false,
  );
  assert.equal(
    hasUsableSimulationCharacterSnapshots(
      [{ ...characters[0], skills: { status: "error", hasBody: false, body: null } }],
      slotUsage,
    ),
    false,
  );
});
