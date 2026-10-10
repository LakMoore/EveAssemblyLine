import assert from "node:assert/strict";
import test from "node:test";
import type { ClientJobsResponse } from "@/lib/client/requestCache";
import {
  createSimulationCharacterProfiles,
  createSimulationSlotMap,
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

void test("builds character skill profiles separately from authoritative slots", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const character = {
    characterId: 7,
    location: { status: "fresh" as const, hasBody: true, systemId: 31_000_001 },
    industrySlots: { Manufacturing: 10, Reactions: 3, Science: 5 },
    skills: {
      status: "fresh" as const,
      hasBody: true,
      body: [
        { skillId: 3380, activeSkillLevel: 4 },
        { skillId: 3388, activeSkillLevel: 3 },
        { skillId: 45746, activeSkillLevel: 5 },
        { skillId: 3406, activeSkillLevel: 2 },
      ],
    },
  };
  const clientJobs: ClientJobsResponse = {
    jobs: [
      clientIndustryJob({ jobId: 101, endDate: "2026-10-04T12:01:00.000Z" }),
      clientIndustryJob({
        jobId: 102,
        activity: "Time research",
        endDate: "2026-10-04T12:02:00.000Z",
      }),
      clientIndustryJob({ jobId: 103, activity: "Material research" }),
      clientIndustryJob({ jobId: 104, activity: "Copying", characterId: 8, ownerId: 8 }),
      clientIndustryJob({ jobId: 105, activity: "Manufacturing" }),
      clientIndustryJob({
        jobId: 107,
        activity: "Manufacturing",
        endDate: "2026-10-04T12:04:00.000Z",
      }),
      clientIndustryJob({ jobId: 106, activity: "Reactions", endDate: "2026-10-04T12:03:00.000Z" }),
      clientIndustryJob({ jobId: 101, endDate: "2026-10-04T12:01:00.000Z" }),
    ],
  };
  const profiles = createSimulationCharacterProfiles([character]);
  const slots = createSimulationSlotMap([character], clientJobs, now);

  assert.equal(profiles[0].systemId, 31_000_001);
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
  assert.equal(profiles[0].freeSlots, undefined);
  assert.equal("inFlightJobs" in profiles[0], false);
  assert.equal(slots.length, 18);
  assert.deepEqual(
    slots
      .filter((slot) => slot.installedJobId !== undefined)
      .map((slot) => [slot.slotKey, slot.installedJobId, slot.availableAtSeconds]),
    [
      ["7:M:8", 105, 60],
      ["7:M:9", 107, 240],
      ["7:R:2", 106, 180],
      ["7:S:2", 101, 60],
      ["7:S:3", 103, 60],
      ["7:S:4", 102, 120],
    ],
  );
});

void test("anchors slot availability to the cached jobs snapshot", () => {
  const snapshotTime = Date.parse("2099-10-04T12:00:00.000Z");
  const character = {
    characterId: 7,
    location: { status: "fresh" as const, hasBody: true, systemId: 30_000_142 },
    industrySlots: { Manufacturing: 1, Reactions: 0, Science: 0 },
  };
  const clientJobs: ClientJobsResponse = {
    lastUpdated: new Date(snapshotTime).toISOString(),
    jobs: [
      clientIndustryJob({
        activity: "Manufacturing",
        endDate: new Date(snapshotTime + 61_000).toISOString(),
      }),
    ],
  };

  const firstSlots = createSimulationSlotMap([character], clientJobs);
  const repeatedSlots = createSimulationSlotMap([character], clientJobs);

  assert.deepEqual(firstSlots, repeatedSlots);
  assert.equal(firstSlots[0].availableAtSeconds, 61);
});

void test("keeps completed active jobs as immediately available slot calendar entries", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const character = {
    characterId: 7,
    location: { status: "fresh" as const, hasBody: true, systemId: 30_000_142 },
    industrySlots: { Manufacturing: 1, Reactions: 0, Science: 0 },
    skills: { status: "fresh" as const, hasBody: true, body: [] },
  };
  const slots = createSimulationSlotMap(
    [character],
    {
      jobs: [
        clientIndustryJob({
          activity: "Manufacturing",
          endDate: "2026-10-04T11:59:00.000Z",
        }),
      ],
    },
    now,
  );

  assert.deepEqual(
    slots,
    [
      {
        slotKey: "7:M:0",
        activity: "manufacturing",
        characterId: 7,
        systemId: 30_000_142,
        slotIndex: 0,
        availableAtSeconds: 0,
        installedJobId: 1,
      },
    ],
  );
});

void test("retains active jobs when cached capacity understates in-use slots", () => {
  const slots = createSimulationSlotMap(
    [
      {
        characterId: 7,
        location: { status: "fresh", hasBody: true, systemId: 30_000_142 },
        industrySlots: { Manufacturing: 1, Reactions: 0, Science: 0 },
      },
    ],
    {
      jobs: [
        clientIndustryJob({
          jobId: 1,
          activity: "Manufacturing",
          endDate: "2026-10-04T12:01:00.000Z",
        }),
        clientIndustryJob({
          jobId: 2,
          activity: "Manufacturing",
          endDate: "2026-10-04T12:02:00.000Z",
        }),
      ],
    },
    Date.parse("2026-10-04T12:00:00.000Z"),
  );

  assert.deepEqual(
    slots.map(({ slotKey, installedJobId, availableAtSeconds }) => [
      slotKey,
      installedJobId,
      availableAtSeconds,
    ]),
    [
      ["7:M:0", 1, 60],
      ["7:M:1", 2, 120],
    ],
  );
});

void test("omits characters whose current system is unavailable", () => {
  assert.deepEqual(createSimulationCharacterProfiles([{ characterId: 9 }]), []);
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
