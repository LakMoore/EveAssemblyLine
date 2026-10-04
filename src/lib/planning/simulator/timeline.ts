import { getAvailableSlotCount } from "@/lib/client/slotUsage";
import type { ClientJobsResponse } from "@/lib/client/requestCache";
import type { SimulationInFlightJobActivity } from "./types";

export type SimulationTimelineActivity =
  | SimulationInFlightJobActivity
  | "manufacturing"
  | "reaction";

export type SimulationTimelinePool = "manufacturing" | "reaction" | "science";

export interface InFlightTimelineEvent {
  eventId: string;
  jobId: string;
  activity: SimulationTimelineActivity;
  pool: SimulationTimelinePool;
  typeId?: number;
  characterId: number;
  slotIndex: number;
  locationId: number;
  label: string;
  quantityLabel: string;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  durationSeconds: number;
  isInFlight: true;
  dependencyJobIds: string[];
}

interface InFlightJobGroupEntry {
  job: NonNullable<ClientJobsResponse["jobs"]>[number];
  activity: SimulationTimelineActivity;
  pool: SimulationTimelinePool;
  slotCategory: "Manufacturing" | "Reactions" | "Science";
  remainingSeconds: number;
}

const timelineActivityByJobActivity = new Map<
  string,
  Pick<InFlightJobGroupEntry, "activity" | "pool" | "slotCategory">
>([
  [
    "manufacturing",
    { activity: "manufacturing", pool: "manufacturing", slotCategory: "Manufacturing" },
  ],
  ["reaction", { activity: "reaction", pool: "reaction", slotCategory: "Reactions" }],
  ["reactions", { activity: "reaction", pool: "reaction", slotCategory: "Reactions" }],
  ["time research", { activity: "time-research", pool: "science", slotCategory: "Science" }],
  [
    "material research",
    { activity: "material-research", pool: "science", slotCategory: "Science" },
  ],
  ["copying", { activity: "copying", pool: "science", slotCategory: "Science" }],
  ["invention", { activity: "invention", pool: "science", slotCategory: "Science" }],
]);

/** Converts jobs active at the simulation origin into occupied schedule-slot events. */
export function createInFlightTimelineEvents(
  jobs: ClientJobsResponse["jobs"],
  generatedAt: string,
  collectionCharacterIds: ReadonlySet<number>,
  slotUsage: ClientJobsResponse["slotUsage"],
): InFlightTimelineEvent[] {
  const originMilliseconds = Date.parse(generatedAt);
  if (!Number.isFinite(originMilliseconds)) return [];

  const groupedJobs = new Map<string, InFlightJobGroupEntry[]>();
  const seenJobIds = new Set<number>();
  for (const job of jobs ?? []) {
    const activityDetails = timelineActivityByJobActivity.get(job.activity.trim().toLowerCase());
    const startMilliseconds = Date.parse(job.startDate);
    const endMilliseconds = Date.parse(job.endDate);
    if (
      job.status.toLowerCase() !== "active"
      || !activityDetails
      || !collectionCharacterIds.has(job.characterId)
      || seenJobIds.has(job.jobId)
      || !Number.isFinite(startMilliseconds)
      || !Number.isFinite(endMilliseconds)
      || startMilliseconds > originMilliseconds
      || endMilliseconds <= originMilliseconds
    ) continue;

    seenJobIds.add(job.jobId);
    const key = `${job.characterId}:${activityDetails.pool}`;
    const group = groupedJobs.get(key) ?? [];
    group.push({
      job,
      ...activityDetails,
      remainingSeconds: (endMilliseconds - originMilliseconds) / 1000,
    });
    groupedJobs.set(key, group);
  }

  return [...groupedJobs.values()].flatMap((group) => {
    group.sort(
      (left, right) =>
        left.remainingSeconds - right.remainingSeconds || left.job.jobId - right.job.jobId,
    );
    const first = group[0];
    const freeSlots = getAvailableSlotCount(
      slotUsage?.[String(first.job.characterId)],
      first.slotCategory,
    );
    return group.map(({ job, activity, pool, remainingSeconds }, index) => ({
      eventId: `in-flight:${job.jobId}`,
      jobId: String(job.jobId),
      activity,
      pool,
      typeId: job.productTypeId ?? job.blueprintTypeId,
      characterId: job.characterId,
      slotIndex: freeSlots + index,
      locationId: job.facilityId,
      label: job.productTypeName?.trim() || job.blueprintTypeName?.trim() || `Job ${job.jobId}`,
      quantityLabel: `${job.runs.toLocaleString()} ${job.runs === 1 ? "run" : "runs"}`,
      startOffsetSeconds: 0,
      endOffsetSeconds: remainingSeconds,
      durationSeconds: remainingSeconds,
      isInFlight: true,
      dependencyJobIds: [],
    }));
  });
}
