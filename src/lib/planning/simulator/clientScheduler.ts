import type { SimulationIndustryJob } from "./types";

/** Scheduling modes exposed by the simulator activity controls. */
export type ClientSimulationSolveMode = "available-slots" | "run-time-hours" | "run-time-days";

/** Describes the currently available slots for one character. */
export type ClientSimulationSlotGroup = {
  characterId: number;
  availableSlots: number;
};

/** Converts a runtime target between the hour and day solve modes. */
export function convertSimulationTargetTime(
  targetTime: number,
  fromMode: ClientSimulationSolveMode,
  toMode: ClientSimulationSolveMode,
): number {
  const normalizedTarget = Number.isFinite(targetTime) ? Math.max(0, targetTime) : 0;
  if (fromMode === "run-time-days" && toMode === "run-time-hours") {
    return Math.max(1, Math.ceil(normalizedTarget * 24));
  }
  if (fromMode === "run-time-hours" && toMode === "run-time-days") {
    return Math.max(1, Math.ceil(normalizedTarget / 24));
  }
  return Math.max(1, Math.ceil(normalizedTarget));
}

/** One client-side install suggestion for a simulator job. */
export type ClientSimulationInstall = {
  installId: string;
  runs: number;
  durationSeconds: number;
  characterId?: number;
  slotIndex?: number;
};

/** The client-side install suggestions and summary for one simulator job. */
export type ClientSimulationSchedule = {
  installs: ClientSimulationInstall[];
  runs: number;
  timeSeconds: number;
};

/** Returns the runs that can be installed immediately for a simulator job. */
export function getSimulationInstallableRuns(job: SimulationIndustryJob): number {
  return Math.min(Math.max(0, job.requiredRuns), Math.max(0, job.readyNowRuns));
}

/** Solves simulator activity rows for available slots or a target install duration. */
export function solveSimulationActivity(
  jobs: readonly SimulationIndustryJob[],
  availableSlots: number,
  mode: ClientSimulationSolveMode,
  targetTime: number,
  enabledJobIds: ReadonlySet<string> = new Set(jobs.map((job) => job.jobId)),
  slotGroups: readonly ClientSimulationSlotGroup[] = [],
): ReadonlyMap<string, ClientSimulationSchedule> {
  const rows = jobs.map((job) => ({
    job,
    runs: getSimulationInstallableRuns(job),
    installs: 0,
    scheduledRuns: 0,
    assignedSlots: [] as ClientSimulationSlot[],
  }));
  const enabledRows = rows.filter(
    ({ job, runs }) => enabledJobIds.has(job.jobId) && runs > 0 && job.durationPerRunSeconds > 0,
  );

  if (mode === "available-slots") {
    allocateAvailableSlots(enabledRows, availableSlots);
  }
  else {
    const targetSeconds = mode === "run-time-days" ? targetTime * 86400 : targetTime * 3600;
    if (targetSeconds > 0) {
      let remainingSlots = Math.max(0, Math.floor(availableSlots));
      for (const row of enabledRows.slice().sort((left, right) => right.runs - left.runs)) {
        if (remainingSlots <= 0) break;
        const runsPerInstall = Math.max(
          1,
          Math.floor(targetSeconds / row.job.durationPerRunSeconds),
        );
        row.installs = Math.min(remainingSlots, Math.ceil(row.runs / runsPerInstall));
        row.scheduledRuns = Math.min(row.runs, row.installs * runsPerInstall);
        remainingSlots -= row.installs;
      }
    }
  }

  assignSlotDetails(enabledRows, slotGroups);

  return new Map(
    rows.map(({ job, installs, scheduledRuns, assignedSlots }) => {
      const allocations = splitRuns(scheduledRuns, installs);
      const scheduleInstalls = allocations.map((installRuns, index) => ({
        installId: `client-install:${job.jobId}:${index}`,
        runs: installRuns,
        durationSeconds: Math.ceil(installRuns * job.durationPerRunSeconds),
        characterId: assignedSlots[index]?.characterId,
        slotIndex: assignedSlots[index]?.slotIndex,
      }));
      return [
        job.jobId,
        {
          installs: scheduleInstalls,
          runs: scheduleInstalls.reduce((total, install) => total + install.runs, 0),
          timeSeconds: Math.max(...scheduleInstalls.map((install) => install.durationSeconds), 0),
        },
      ] as const;
    }),
  );
}

type SimulationScheduleRow = {
  job: SimulationIndustryJob;
  runs: number;
  installs: number;
  scheduledRuns: number;
  assignedSlots: ClientSimulationSlot[];
};

type ClientSimulationSlot = {
  characterId: number;
  slotIndex: number;
};

/** Assigns available character slots to each scheduled install for presentation. */
function assignSlotDetails(
  rows: SimulationScheduleRow[],
  slotGroups: readonly ClientSimulationSlotGroup[],
): void {
  const slots = slotGroups.flatMap((group) =>
    Array.from(
      { length: Math.max(0, Math.floor(group.availableSlots)) },
      (_, slotIndex) => ({
        characterId: group.characterId,
        slotIndex,
      }),
    ),
  );
  let slotOffset = 0;
  for (const row of rows) {
    row.assignedSlots = slots.slice(slotOffset, slotOffset + row.installs);
    slotOffset += row.installs;
  }
}

/** Distributes available slots toward the largest remaining installable chunks. */
function allocateAvailableSlots(rows: SimulationScheduleRow[], availableSlots: number): void {
  let remainingSlots = Math.max(0, Math.floor(availableSlots));
  for (const row of rows.slice().sort((left, right) => right.runs - left.runs)) {
    if (remainingSlots <= 0) return;
    row.installs = 1;
    row.scheduledRuns = row.runs;
    remainingSlots -= 1;
  }
  while (remainingSlots > 0) {
    const candidates = rows
      .filter((row) => row.installs < row.runs)
      .sort((left, right) => {
        const leftChunk = Math.ceil(left.runs / Math.max(1, left.installs));
        const rightChunk = Math.ceil(right.runs / Math.max(1, right.installs));
        return rightChunk - leftChunk || right.runs - left.runs;
      });
    if (candidates.length === 0) return;
    const candidate = candidates[0];
    candidate.installs += 1;
    candidate.scheduledRuns = candidate.runs;
    remainingSlots -= 1;
  }
}

/** Splits a run count into balanced positive install quantities. */
function splitRuns(runs: number, installCount: number): number[] {
  if (runs <= 0 || installCount <= 0) return [];
  const count = Math.min(runs, installCount);
  const baseRuns = Math.floor(runs / count);
  const remainder = runs % count;
  return Array.from({ length: count }, (_, index) => baseRuns + (index < remainder ? 1 : 0));
}
