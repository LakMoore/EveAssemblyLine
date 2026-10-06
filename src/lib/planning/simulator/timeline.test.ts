import assert from "node:assert/strict";
import test from "node:test";
import type { ClientJobsResponse } from "@/lib/client/requestCache";
import { createInFlightTimelineEvents, timelineDependencyJobIds } from "./timeline";

type ClientIndustryJob = NonNullable<ClientJobsResponse["jobs"]>[number];

function clientIndustryJob(overrides: Partial<ClientIndustryJob> = {}): ClientIndustryJob {
  return {
    jobId: 1,
    characterId: 7,
    ownerId: 7,
    ownerType: "character",
    activity: "Manufacturing",
    status: "active",
    runs: 2,
    outputQuantity: 2,
    startDate: "2026-10-04T11:00:00.000Z",
    endDate: "2026-10-04T14:00:00.000Z",
    facilityId: 10,
    outputLocationId: 10,
    outputLocationName: "Test facility",
    blueprintTypeId: 100,
    productTypeId: 200,
    productTypeName: "Test item",
    ...overrides,
  };
}

void test("includes active in-flight source jobs in timeline dependencies", () => {
  const dependencyIds = timelineDependencyJobIds([
    {
      typeId: 1,
      typeName: "Test input",
      requiredQuantity: 10,
      availableNow: 0,
      availableFromHauling: 0,
      availableAfterUpstream: 10,
      unsatisfiedQuantity: 0,
      upstreamReservations: [
        { activity: "reaction", quantity: 5, state: "in-production", sourceJobId: 101 },
        { activity: "manufacturing", quantity: 5, state: "planned", sourceJobId: "planned-1" },
        { activity: "reaction", quantity: 2, state: "paused", sourceJobId: 202 },
        { activity: "reaction", quantity: 5, state: "in-production", sourceJobId: 101 },
        { activity: "reaction", quantity: 1, state: "in-production" },
      ],
    },
  ]);

  assert.deepEqual(dependencyIds, ["101", "planned-1"]);
});

void test("overlays jobs active at T+0 on the character's occupied slots", () => {
  const events = createInFlightTimelineEvents(
    [
      clientIndustryJob({ jobId: 101, endDate: "2026-10-04T14:00:00.000Z" }),
      clientIndustryJob({ jobId: 102, endDate: "2026-10-04T13:00:00.000Z" }),
      clientIndustryJob({ jobId: 102, endDate: "2026-10-04T13:00:00.000Z" }),
      clientIndustryJob({ jobId: 103, endDate: "2026-10-04T11:59:00.000Z" }),
      clientIndustryJob({ jobId: 104, startDate: "2026-10-04T12:01:00.000Z" }),
      clientIndustryJob({ jobId: 105, activity: "Invention" }),
      clientIndustryJob({ jobId: 106, characterId: 99 }),
    ],
    "2026-10-04T12:00:00.000Z",
    new Set([7]),
    [
      {
        slotKey: "7:M:9",
        activity: "manufacturing",
        characterId: 7,
        systemId: 30_000_142,
        slotIndex: 9,
        availableAtSeconds: 7200,
        installedJobId: 101,
      },
      {
        slotKey: "7:M:8",
        activity: "manufacturing",
        characterId: 7,
        systemId: 30_000_142,
        slotIndex: 8,
        availableAtSeconds: 3600,
        installedJobId: 102,
      },
      {
        slotKey: "7:M:7",
        activity: "manufacturing",
        characterId: 7,
        systemId: 30_000_142,
        slotIndex: 7,
        availableAtSeconds: 0,
        installedJobId: 103,
      },
      {
        slotKey: "7:S:4",
        activity: "science",
        characterId: 7,
        systemId: 30_000_142,
        slotIndex: 4,
        availableAtSeconds: 7200,
        installedJobId: 105,
      },
    ],
  );

  assert.equal(events[0].typeId, 200);
  assert.equal(events[2].typeId, 200);
  assert.deepEqual(
    events.map(({ jobId, activity, slotIndex, startOffsetSeconds, endOffsetSeconds }) => ({
      jobId,
      activity,
      slotIndex,
      startOffsetSeconds,
      endOffsetSeconds,
    })),
    [
      {
        jobId: "102",
        activity: "manufacturing",
        slotIndex: 8,
        startOffsetSeconds: 0,
        endOffsetSeconds: 3600,
      },
      {
        jobId: "101",
        activity: "manufacturing",
        slotIndex: 9,
        startOffsetSeconds: 0,
        endOffsetSeconds: 7200,
      },
      {
        jobId: "105",
        activity: "invention",
        slotIndex: 4,
        startOffsetSeconds: 0,
        endOffsetSeconds: 7200,
      },
    ],
  );
});

void test("maps active science research into the science slot pool", () => {
  const [event] = createInFlightTimelineEvents(
    [clientIndustryJob({ activity: "Time research" })],
    "2026-10-04T12:00:00.000Z",
    new Set([7]),
    [
      {
        slotKey: "7:S:1",
        activity: "science",
        characterId: 7,
        systemId: 30_000_142,
        slotIndex: 1,
        availableAtSeconds: 7200,
        installedJobId: 1,
      },
    ],
  );

  assert.equal(event.activity, "time-research");
  assert.equal(event.pool, "science");
  assert.equal(event.slotKey, "7:S:1");
  assert.equal(event.slotIndex, 1);
});
