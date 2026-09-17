import assert from "node:assert/strict";
import test from "node:test";
import {
  getIndustryJobMinutesUntil,
  getIndustryJobSummary,
  getNextIndustryJobEndTime,
  getNextIndustryActivityJobEndTime,
  nextIndustryJobDetail,
} from "./industryJobs";
import type { ClientJobsResponse } from "./requestCache";

const jobs = {
  jobs: [
    {
      jobId: 1,
      characterId: 10,
      ownerId: 10,
      ownerType: "character",
      activity: "manufacturing",
      status: "active",
      runs: 1,
      outputQuantity: 5,
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-01T00:20:00Z",
      facilityId: 100,
      outputLocationId: 200,
      outputLocationName: "Station",
      blueprintTypeId: 300,
      productTypeId: 57460,
    },
    {
      jobId: 2,
      characterId: 11,
      ownerId: 11,
      ownerType: "character",
      activity: "reaction",
      status: "active",
      runs: 1,
      outputQuantity: 7,
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-01T00:10:00Z",
      facilityId: 101,
      outputLocationId: 201,
      outputLocationName: "Other station",
      blueprintTypeId: 301,
      productTypeId: 57460,
    },
    {
      jobId: 3,
      characterId: 10,
      ownerId: 10,
      ownerType: "character",
      activity: "copying",
      status: "active",
      runs: 1,
      outputQuantity: 99,
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-01T00:01:00Z",
      facilityId: 100,
      outputLocationId: 200,
      outputLocationName: "Station",
      blueprintTypeId: 300,
      productTypeId: 57460,
    },
    {
      jobId: 4,
      characterId: 10,
      ownerId: 10,
      ownerType: "character",
      activity: "manufacturing",
      status: "completed",
      runs: 1,
      outputQuantity: 50,
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-01T00:02:00Z",
      facilityId: 100,
      outputLocationId: 200,
      outputLocationName: "Station",
      blueprintTypeId: 300,
      productTypeId: 57460,
    },
  ],
} satisfies ClientJobsResponse;

void test("summarizes active production jobs at a matching location", () => {
  assert.deepEqual(
    getIndustryJobSummary(57460, jobs, 100),
    {
      quantity: 5,
      nextEndTime: Date.parse("2026-01-01T00:20:00Z"),
    },
  );
  assert.equal(getIndustryJobSummary(57460, jobs, 999).quantity, 0);
});

void test("filters by production activity and character", () => {
  assert.equal(
    getNextIndustryActivityJobEndTime("reaction", jobs, 11),
    Date.parse("2026-01-01T00:10:00Z"),
  );
  assert.equal(getNextIndustryActivityJobEndTime("manufacturing", jobs, 11), undefined);
});

void test("filters output timing by owner", () => {
  const corporationJob = {
    ...jobs.jobs[0],
    jobId: 5,
    ownerType: "corporation" as const,
    ownerId: 99,
    endDate: "2026-01-01T00:05:00Z",
  };
  const jobsWithCorporationJob = { jobs: [...jobs.jobs, corporationJob] };
  assert.equal(
    getNextIndustryJobEndTime(57460, jobsWithCorporationJob, 100, "corporation", 99),
    Date.parse("2026-01-01T00:05:00Z"),
  );
  assert.equal(
    getNextIndustryJobEndTime(57460, jobsWithCorporationJob, 100, "character", 10),
    Date.parse("2026-01-01T00:20:00Z"),
  );
});

void test("rounds remaining minutes up and clamps expired jobs", () => {
  const endTime = Date.parse("2026-01-01T00:10:01Z");
  assert.equal(getIndustryJobMinutesUntil(endTime, Date.parse("2026-01-01T00:00:01Z")), 10);
  assert.equal(getIndustryJobMinutesUntil(endTime, Date.parse("2026-01-01T00:11:00Z")), 0);
});

void test("formats completed jobs as ready for delivery", () => {
  assert.equal(nextIndustryJobDetail(0), "; next job ready for delivery");
  assert.equal(nextIndustryJobDetail(1), "; next job ends in 1 minutes");
  assert.equal(nextIndustryJobDetail(undefined), "");
});
