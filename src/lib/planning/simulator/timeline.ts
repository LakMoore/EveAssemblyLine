import type { ClientJobsResponse } from "@/lib/client/requestCache";
import type { SimulationInFlightJobActivity, SimulationJobInput, SimulationSlot } from "./types";

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
  slotKey: string;
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
}

const timelineActivityByJobActivity = new Map<
  string,
  Pick<InFlightJobGroupEntry, "activity" | "pool">
>([
  ["manufacturing", { activity: "manufacturing", pool: "manufacturing" }],
  ["reaction", { activity: "reaction", pool: "reaction" }],
  ["reactions", { activity: "reaction", pool: "reaction" }],
  ["time research", { activity: "time-research", pool: "science" }],
  ["material research", { activity: "material-research", pool: "science" }],
  ["copying", { activity: "copying", pool: "science" }],
  ["invention", { activity: "invention", pool: "science" }],
]);

/** Returns known planned or active source jobs that can supply timeline inputs. */
export function timelineDependencyJobIds(inputs: readonly SimulationJobInput[]): string[] {
  return [
    ...new Set(
      inputs.flatMap((input) =>
        (input.upstreamReservations ?? [])
          .filter(
            (reservation) =>
              reservation.state === "planned" || reservation.state === "in-production",
          )
          .flatMap((reservation) =>
            reservation.sourceJobId === undefined ? [] : [String(reservation.sourceJobId)],
          ),
      ),
    ),
  ];
}

/** Converts jobs active at the simulation origin into occupied schedule-slot events. */
export function createInFlightTimelineEvents(
  jobs: ClientJobsResponse["jobs"],
  generatedAt: string,
  collectionCharacterIds: ReadonlySet<number>,
  slots: readonly SimulationSlot[],
): InFlightTimelineEvent[] {
  const originMilliseconds = Date.parse(generatedAt);
  if (!Number.isFinite(originMilliseconds)) return [];

  const slotByInstalledJobId = new Map(
    slots.flatMap((slot) =>
      slot.installedJobId === undefined ? [] : [[slot.installedJobId, slot] as const],
    ),
  );
  const seenJobIds = new Set<number>();
  const events: InFlightTimelineEvent[] = [];
  for (const job of jobs ?? []) {
    const activityDetails = timelineActivityByJobActivity.get(job.activity.trim().toLowerCase());
    const startMilliseconds = Date.parse(job.startDate);
    const slot = slotByInstalledJobId.get(job.jobId);
    if (
      job.status.toLowerCase() !== "active"
      || !activityDetails
      || !collectionCharacterIds.has(job.characterId)
      || seenJobIds.has(job.jobId)
      || !Number.isFinite(startMilliseconds)
      || startMilliseconds > originMilliseconds
      || !slot
      || slot.characterId !== job.characterId
      || slot.availableAtSeconds <= 0
    ) continue;

    seenJobIds.add(job.jobId);
    const durationSeconds = slot.availableAtSeconds;
    events.push({
      eventId: `in-flight:${job.jobId}`,
      jobId: String(job.jobId),
      activity: activityDetails.activity,
      pool: activityDetails.pool,
      slotKey: slot.slotKey,
      typeId: job.productTypeId ?? job.blueprintTypeId,
      characterId: job.characterId,
      slotIndex: slot.slotIndex,
      locationId: job.facilityId,
      label: job.productTypeName?.trim() || job.blueprintTypeName?.trim() || `Job ${job.jobId}`,
      quantityLabel: `${job.runs.toLocaleString()} ${job.runs === 1 ? "run" : "runs"}`,
      startOffsetSeconds: 0,
      endOffsetSeconds: durationSeconds,
      durationSeconds,
      isInFlight: true,
      dependencyJobIds: [],
    });
  }
  return events.sort(
    (left, right) =>
      left.endOffsetSeconds - right.endOffsetSeconds || left.eventId.localeCompare(right.eventId),
  );
}
