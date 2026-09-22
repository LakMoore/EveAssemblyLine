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

export type ClientSimulationScheduleOptions = {
  protectReactionMaterialBonus?: boolean;
  reactionMaterialBonusesByLocation?: ReadonlyMap<number, number>;
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
  options: ClientSimulationScheduleOptions = {},
): ReadonlyMap<string, ClientSimulationSchedule> {
  const rows = jobs.map((job) => ({
    job,
    runs: getSimulationInstallableRuns(job),
    minimumRunsPerInstall: getSimulationMinimumRunsPerInstall(job, options),
    installs: 0,
    scheduledRuns: 0,
    assignedSlots: [] as ClientSimulationSlot[],
  }));
  const enabledRows = rows.filter(
    ({ job, runs, minimumRunsPerInstall }) =>
      enabledJobIds.has(job.jobId) && runs > 0 && job.durationPerRunSeconds > 0,
  );

  if (mode === "available-slots") {
    const shouldBalanceProtectedReactions =
      options.protectReactionMaterialBonus
      && enabledRows.every(({ job }) => job.activity === "reaction");
    if (shouldBalanceProtectedReactions) {
      allocateReactionAvailableSlots(enabledRows, availableSlots);
    }
    else {
      allocateAvailableSlots(enabledRows, availableSlots);
    }
  }
  else {
    if (enabledRows.every(({ job }) => job.activity === "reaction")) {
      allocateReactionRuntimeSlots(enabledRows, availableSlots, mode, targetTime);
    }
    else {
      const targetSeconds = mode === "run-time-days" ? targetTime * 86400 : targetTime * 3600;
      if (targetSeconds > 0) {
        let remainingSlots = Math.max(0, Math.floor(availableSlots));
        for (const row of enabledRows.slice().sort((left, right) => right.runs - left.runs)) {
          if (remainingSlots <= 0) break;
          const runsPerInstall = Math.max(
            row.minimumRunsPerInstall,
            Math.floor(targetSeconds / row.job.durationPerRunSeconds),
          );
          row.installs = Math.min(
            remainingSlots,
            Math.ceil(row.runs / runsPerInstall),
            maximumInstallCount(row),
          );
          row.scheduledRuns = Math.min(row.runs, row.installs * runsPerInstall);
          remainingSlots -= row.installs;
        }
      }
    }
  }

  assignSlotDetails(enabledRows, slotGroups);

  return new Map(
    rows.map(({ job, minimumRunsPerInstall, installs, scheduledRuns, assignedSlots }) => {
      const allocations = splitSimulationRuns(scheduledRuns, installs, minimumRunsPerInstall);
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
  minimumRunsPerInstall: number;
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
      .filter((row) => row.installs < maximumInstallCount(row))
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

/** Allocates reaction slots by removing below-average jobs before balancing the remainder. */
function allocateReactionAvailableSlots(
  rows: SimulationScheduleRow[],
  availableSlots: number,
): void {
  let remainingSlots = Math.max(0, Math.floor(availableSlots));
  let remainingRows = rows.slice();

  while (remainingSlots > 0 && remainingRows.length > 0) {
    const totalRuns = remainingRows.reduce((total, row) => total + row.runs, 0);
    const floorAverage = Math.floor(totalRuns / remainingSlots);
    const lowRunRows = remainingRows
      .filter((row) => row.runs < floorAverage)
      .sort((left, right) => left.runs - right.runs);
    if (lowRunRows.length === 0) break;

    for (const row of lowRunRows) {
      if (remainingSlots <= 0) break;
      row.installs = 1;
      row.scheduledRuns = row.runs;
      remainingSlots -= 1;
      remainingRows = remainingRows.filter((candidate) => candidate !== row);
    }
  }

  allocateBalancedSlots(remainingRows, remainingSlots);
}

/** Balances the remaining reaction runs across the remaining slots. */
function allocateBalancedSlots(rows: SimulationScheduleRow[], availableSlots: number): void {
  let remainingSlots = Math.max(0, Math.floor(availableSlots));
  const selectedRows = rows.slice().sort((left, right) => right.runs - left.runs);
  const selectedRuns = selectedRows.reduce((total, row) => total + row.runs, 0);
  const averageRunsPerSlot = remainingSlots > 0 ? selectedRuns / remainingSlots : 0;

  for (const row of selectedRows) {
    if (remainingSlots <= 0) break;
    row.installs = 1;
    row.scheduledRuns = row.runs;
    remainingSlots -= 1;
  }

  while (remainingSlots > 0) {
    const candidates = selectedRows
      .filter((row) => row.installs < maximumInstallCount(row))
      .sort((left, right) => {
        const leftIdealInstalls = averageRunsPerSlot > 0 ? left.runs / averageRunsPerSlot : 0;
        const rightIdealInstalls = averageRunsPerSlot > 0 ? right.runs / averageRunsPerSlot : 0;
        return (
          rightIdealInstalls - right.installs - (leftIdealInstalls - left.installs)
          || right.runs - left.runs
        );
      });
    if (candidates.length === 0) return;
    candidates[0].installs += 1;
    candidates[0].scheduledRuns = candidates[0].runs;
    remainingSlots -= 1;
  }
}

/** Allocates reaction installs to complete each type within the requested runtime. */
function allocateReactionRuntimeSlots(
  rows: SimulationScheduleRow[],
  availableSlots: number,
  mode: ClientSimulationSolveMode,
  targetTime: number,
): void {
  const targetHours = mode === "run-time-days" ? targetTime * 24 : targetTime;
  if (targetHours <= 0) return;

  let remainingSlots = Math.max(0, Math.floor(availableSlots));
  for (const row of rows.slice().sort((left, right) => right.runs - left.runs)) {
    if (remainingSlots <= 0) return;
    const runsPerInstall = Math.max(
      row.minimumRunsPerInstall,
      Math.floor((targetHours * 3600) / row.job.durationPerRunSeconds),
    );
    const requiredInstalls = Math.ceil(row.runs / runsPerInstall);
    const safeInstallCount = maximumInstallCount(row);
    row.installs = Math.min(remainingSlots, requiredInstalls, safeInstallCount);
    row.scheduledRuns = Math.min(row.runs, row.installs * runsPerInstall);
    remainingSlots -= row.installs;
  }
}

/** Returns the maximum install count that preserves the ME protection minimum. */
function maximumInstallCount(row: SimulationScheduleRow): number {
  return Math.max(1, Math.ceil(row.runs / row.minimumRunsPerInstall));
}

/** Calculates the minimum runs needed for a reaction rig saving to remove one unit. */
export function getSimulationMinimumRunsPerInstall(
  job: SimulationIndustryJob,
  options: ClientSimulationScheduleOptions,
): number {
  if (!options.protectReactionMaterialBonus || job.activity !== "reaction") return 1;
  const materialBonus =
    -(options.reactionMaterialBonusesByLocation?.get(job.locationId) ?? 0) / 100;
  if (materialBonus <= 0) return 1;
  const smallestInputQuantity = Math.min(
    ...job.inputs
      .map(
        (input) =>
          input.quantityPerRun
          ?? (job.requiredRuns > 0 ? input.requiredQuantity / job.requiredRuns : 0),
      )
      .filter((quantity) => quantity > 1),
  );
  if (!Number.isFinite(smallestInputQuantity)) return 1;
  return Math.max(1, Math.ceil(1 / (smallestInputQuantity * materialBonus)));
}

/** Splits runs evenly while keeping at most one protected under-minimum remainder. */
export function splitSimulationRuns(
  runs: number,
  installCount: number,
  minimumRunsPerInstall: number,
): number[] {
  if (runs <= 0 || installCount <= 0) return [];
  const count = Math.min(runs, installCount);
  if (minimumRunsPerInstall > 1 && count > Math.floor(runs / minimumRunsPerInstall)) {
    const underMinimumRuns = runs % minimumRunsPerInstall;
    if (underMinimumRuns > 0 && count > 1) {
      const fullInstallRuns = Math.floor((runs - underMinimumRuns) / (count - 1));
      return [...Array.from({ length: count - 1 }, () => fullInstallRuns), underMinimumRuns];
    }
  }
  const baseRuns = Math.floor(runs / count);
  const remainder = runs % count;
  return Array.from({ length: count }, (_, index) => baseRuns + (index < remainder ? 1 : 0));
}
