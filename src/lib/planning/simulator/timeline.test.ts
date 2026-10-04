import assert from "node:assert/strict";
import test from "node:test";
import type { ClientJobsResponse } from "@/lib/client/requestCache";
import { createInFlightTimelineEvents } from "./timeline";

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
    {
      "7": {
        slots: { Manufacturing: 2, Reactions: 0, Science: 0 },
        availableSlots: { Manufacturing: 10, Reactions: 3, Science: 5 },
      },
    },
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
        slotIndex: 5,
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
    {
      "7": {
        slots: { Manufacturing: 0, Reactions: 0, Science: 2 },
        availableSlots: { Manufacturing: 10, Reactions: 3, Science: 5 },
      },
    },
  );

  assert.equal(event.activity, "time-research");
  assert.equal(event.pool, "science");
  assert.equal(event.slotIndex, 3);
});
