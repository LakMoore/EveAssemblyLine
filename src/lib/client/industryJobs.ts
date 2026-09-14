import type { ClientJobsResponse } from "./requestCache";

export type ClientIndustryJob = NonNullable<ClientJobsResponse["jobs"]>[number];

function isProductionActivity(activity: string) {
  const normalizedActivity = activity.toLowerCase();
  return (
    normalizedActivity === "manufacturing"
    || normalizedActivity === "reaction"
    || normalizedActivity === "reactions"
  );
}

function matchesLocation(job: ClientIndustryJob, locationId: number | undefined) {
  return (
    locationId === undefined || job.facilityId === locationId || job.outputLocationId === locationId
  );
}

function matchingIndustryJobs(
  typeId: number,
  jobs: ClientJobsResponse | null,
  locationId: number | undefined,
) {
  return (jobs?.jobs ?? []).filter(
    (job) =>
      job.status.toLowerCase() === "active"
      && isProductionActivity(job.activity)
      && job.productTypeId === typeId
      && matchesLocation(job, locationId)
      && job.outputQuantity > 0,
  );
}

/** Summarizes active production jobs for an output type and optional location. */
export function getIndustryJobSummary(
  typeId: number,
  jobs: ClientJobsResponse | null,
  locationId?: number,
) {
  const matchingJobs = matchingIndustryJobs(typeId, jobs, locationId);
  const endTimes = matchingJobs
    .map((job) => Date.parse(job.endDate))
    .filter((endTime) => Number.isFinite(endTime));
  return {
    quantity: matchingJobs.reduce((total, job) => total + job.outputQuantity, 0),
    nextEndTime: endTimes.length ? Math.min(...endTimes) : undefined,
  };
}

/** Returns the next active production job for an output type and optional location. */
export function getNextIndustryJobEndTime(
  typeId: number,
  jobs: ClientJobsResponse | null,
  locationId?: number,
  ownerType?: "character" | "corporation",
  ownerId?: number,
) {
  const matchingJobs = matchingIndustryJobs(typeId, jobs, locationId).filter(
    (job) =>
      ownerType === undefined
      || (job.ownerType === ownerType && (ownerId === undefined || job.ownerId === ownerId)),
  );
  const endTimes = matchingJobs
    .map((job) => Date.parse(job.endDate))
    .filter((endTime) => Number.isFinite(endTime));
  return endTimes.length ? Math.min(...endTimes) : undefined;
}

/** Returns the next active production job for an activity and optional character. */
export function getNextIndustryActivityJobEndTime(
  activity: "manufacturing" | "reaction",
  jobs: ClientJobsResponse | null,
  characterId?: number,
  characterIds?: ReadonlySet<number>,
) {
  const endTimes = (jobs?.jobs ?? [])
    .filter(
      (job) =>
        job.status.toLowerCase() === "active"
        && job.activity.toLowerCase() === activity
        && (characterId === undefined || job.characterId === characterId)
        && (characterIds === undefined || characterIds.has(job.characterId)),
    )
    .map((job) => Date.parse(job.endDate))
    .filter((endTime) => Number.isFinite(endTime));
  return endTimes.length ? Math.min(...endTimes) : undefined;
}

/** Converts a job end timestamp into whole minutes remaining. */
export function getIndustryJobMinutesUntil(endTime: number | undefined, now = Date.now()) {
  if (endTime === undefined) return undefined;
  return Math.max(0, Math.ceil((endTime - now) / 60_000));
}

/** Formats the shared next-job detail used by production icon tooltips. */
export function nextIndustryJobDetail(minutes: number | undefined) {
  if (minutes === undefined) return "";
  return minutes === 0 ? "; Ready for Delivery" : `; next job ends in ${minutes} minutes`;
}
