import type { SimulationIndustryJob } from "./types";

/** Scheduling modes exposed by the simulator activity controls. */
export type ClientSimulationSolveMode = "available-slots" | "run-time-hours" | "run-time-days";

/** Describes the currently available slots for one character. */
export type ClientSimulationSlotGroup = {
  characterId: number;
  availableSlots: number;
  systemId?: number;
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

/** One integer-sized batch of generated installs and its per-install duration. */
export type ClientSimulationInstallBatch = {
  runsPerInstall: number;
  installCount: number;
  estimatedDurationSecondsPerInstall: number;
};

/** Exact install counts and integer-run batches derived from current solver output. */
export type ClientSimulationInstallSummary = {
  count: number;
  totalRuns: number;
  batches: ClientSimulationInstallBatch[];
};

/** Splits generated installs into floor/ceiling run batches without changing totals. */
export function summarizeClientSimulationInstalls(
  installs: readonly ClientSimulationInstall[],
): ClientSimulationInstallSummary {
  const count = installs.length;
  if (count === 0) return { count: 0, totalRuns: 0, batches: [] };

  const totalRuns = installs.reduce((total, install) => total + install.runs, 0);
  const totalDurationSeconds = installs.reduce(
    (total, install) => total + install.durationSeconds,
    0,
  );
  const floorRuns = Math.floor(totalRuns / count);
  const ceilInstallCount = totalRuns % count;
  const floorInstallCount = count - ceilInstallCount;
  const averageSecondsPerRun = totalRuns > 0 ? totalDurationSeconds / totalRuns : 0;
  const batches: ClientSimulationInstallBatch[] = [];

  if (ceilInstallCount > 0) {
    batches.push({
      runsPerInstall: floorRuns + 1,
      installCount: ceilInstallCount,
      estimatedDurationSecondsPerInstall: (floorRuns + 1) * averageSecondsPerRun,
    });
  }
  if (floorInstallCount > 0) {
    batches.push({
      runsPerInstall: floorRuns,
      installCount: floorInstallCount,
      estimatedDurationSecondsPerInstall: floorRuns * averageSecondsPerRun,
    });
  }

  return {
    count,
    totalRuns,
    batches,
  };
}

export type ClientSimulationScheduleOptions = {
  availableReactionFormulaCountsByLocationAndType?: ReadonlyMap<string, number>;
  protectReactionMaterialBonus?: boolean;
  reactionMaterialBonusesByLocation?: ReadonlyMap<number, number>;
  locationSystemIdsById?: ReadonlyMap<number, number>;
};

/** Creates a stable key for reaction formula availability at one location. */
export function simulationReactionFormulaKey(locationId: number, typeId: number): string {
  return `${locationId}:${typeId}`;
}

/** Returns whether a solar-system ID belongs to EVE's wormhole system range. */
export function isWormholeSystemId(systemId: number | undefined): boolean {
  return systemId !== undefined && systemId >= 31_000_000 && systemId < 32_000_000;
}

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
  const formulaCounts = options.availableReactionFormulaCountsByLocationAndType;
  const rows = jobs.map((job) => ({
    job,
    runs: getSimulationInstallableRuns(job),
    minimumRunsPerInstall: getSimulationMinimumRunsPerInstall(job, options),
    formulaKey:
      job.activity === "reaction"
        ? simulationReactionFormulaKey(job.locationId, job.blueprint.blueprintTypeId)
        : undefined,
    formulaCapacity:
      job.activity !== "reaction" || formulaCounts === undefined
        ? undefined
        : Math.max(
            0,
            Math.floor(
              formulaCounts.get(
                simulationReactionFormulaKey(job.locationId, job.blueprint.blueprintTypeId),
              ) ?? 0,
            ),
          ),
    preferSingleInstall:
      job.activity === "reaction"
      && (
        getSimulationInstallableRuns(job) < 10
        || getSimulationInstallableRuns(job) * job.durationPerRunSeconds < 86400
      ),
    installs: 0,
    scheduledRuns: 0,
    assignedSlots: [] as ClientSimulationSlot[],
  }));
  const enabledRows = rows.filter(
    ({ job, runs, minimumRunsPerInstall }) =>
      enabledJobIds.has(job.jobId) && runs > 0 && job.durationPerRunSeconds > 0,
  );

  if (mode === "available-slots") {
    const partitions = simulationSchedulePartitions(
      enabledRows,
      availableSlots,
      slotGroups,
      options,
    );
    for (const partition of partitions) {
      allocateSimulationPartition(
        partition.rows,
        partition.availableSlots,
        mode,
        targetTime,
        options,
      );
      assignSlotDetails(partition.rows, partition.slotGroups);
    }
  }
  else {
    const partitions = simulationSchedulePartitions(
      enabledRows,
      availableSlots,
      slotGroups,
      options,
    );
    for (const partition of partitions) {
      allocateSimulationPartition(
        partition.rows,
        partition.availableSlots,
        mode,
        targetTime,
        options,
      );
      assignSlotDetails(partition.rows, partition.slotGroups);
    }
  }

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

type SimulationSchedulePartition = {
  rows: SimulationScheduleRow[];
  availableSlots: number;
  slotGroups: readonly ClientSimulationSlotGroup[];
};

/** Splits reaction work into a shared K-space pool and isolated wormhole systems. */
function simulationSchedulePartitions(
  rows: SimulationScheduleRow[],
  availableSlots: number,
  slotGroups: readonly ClientSimulationSlotGroup[],
  options: ClientSimulationScheduleOptions,
): SimulationSchedulePartition[] {
  const systemIdsByLocation = options.locationSystemIdsById;
  if (!systemIdsByLocation || !rows.every(({ job }) => job.activity === "reaction")) {
    return [{ rows, availableSlots, slotGroups }];
  }

  const rowsBySystem = new Map<string, SimulationScheduleRow[]>();
  const systemIdByKey = new Map<string, number | undefined>();
  for (const row of rows) {
    const systemId = systemIdsByLocation.get(row.job.locationId);
    const key =
      systemId === undefined
        ? "unknown-system"
        : isWormholeSystemId(systemId)
          ? `wormhole:${systemId}`
          : "k-space";
    const partitionRows = rowsBySystem.get(key) ?? [];
    partitionRows.push(row);
    rowsBySystem.set(key, partitionRows);
    systemIdByKey.set(key, isWormholeSystemId(systemId) ? systemId : undefined);
  }

  return [...rowsBySystem.entries()].map(([key, partitionRows]) => {
    const systemId = systemIdByKey.get(key);
    const eligibleSlotGroups = slotGroups.filter((group) => {
      if (key === "k-space") {
        return group.systemId !== undefined && !isWormholeSystemId(group.systemId);
      }
      return systemId !== undefined && group.systemId === systemId;
    });
    return {
      rows: partitionRows,
      slotGroups: eligibleSlotGroups,
      availableSlots: eligibleSlotGroups.reduce(
        (total, group) => total + Math.max(0, Math.floor(group.availableSlots)),
        0,
      ),
    };
  });
}

/** Applies the selected scheduling policy to one eligible slot pool. */
function allocateSimulationPartition(
  enabledRows: SimulationScheduleRow[],
  availableSlots: number,
  mode: ClientSimulationSolveMode,
  targetTime: number,
  options: ClientSimulationScheduleOptions,
): void {
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
}

type SimulationScheduleRow = {
  job: SimulationIndustryJob;
  runs: number;
  minimumRunsPerInstall: number;
  formulaKey?: string;
  formulaCapacity?: number;
  preferSingleInstall: boolean;
  runsPerInstall?: number;
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
    if (!canAllocateInstall(row, rows)) continue;
    row.installs = 1;
    row.scheduledRuns = row.runs;
    remainingSlots -= 1;
  }
  while (remainingSlots > 0) {
    const candidates = rows
      .filter((row) => !row.preferSingleInstall && canAllocateInstall(row, rows))
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
      .filter((row) => row.runs < floorAverage && canAllocateInstall(row, rows))
      .sort((left, right) => left.runs - right.runs);
    if (lowRunRows.length === 0) break;

    let allocatedRow = false;
    for (const row of lowRunRows) {
      if (remainingSlots <= 0) break;
      if (!canAllocateInstall(row, rows)) continue;
      row.installs = 1;
      row.scheduledRuns = row.runs;
      remainingSlots -= 1;
      remainingRows = remainingRows.filter((candidate) => candidate !== row);
      allocatedRow = true;
    }
    if (!allocatedRow) break;
  }

  allocateBalancedSlots(remainingRows, remainingSlots, rows);
}

/** Balances the remaining reaction runs across the remaining slots. */
function allocateBalancedSlots(
  rows: SimulationScheduleRow[],
  availableSlots: number,
  allRows: readonly SimulationScheduleRow[] = rows,
): void {
  let remainingSlots = Math.max(0, Math.floor(availableSlots));
  const selectedRows = rows.slice().sort((left, right) => right.runs - left.runs);
  const selectedRuns = selectedRows.reduce((total, row) => total + row.runs, 0);
  const averageRunsPerSlot = remainingSlots > 0 ? selectedRuns / remainingSlots : 0;

  for (const row of selectedRows) {
    if (remainingSlots <= 0) break;
    if (!canAllocateInstall(row, allRows)) continue;
    row.installs = 1;
    row.scheduledRuns = row.runs;
    remainingSlots -= 1;
  }

  while (remainingSlots > 0) {
    const candidates = selectedRows
      .filter((row) => !row.preferSingleInstall && canAllocateInstall(row, allRows))
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

  const targetSeconds = targetHours * 3600;
  for (const row of rows) {
    const runsAllowedByTime = Math.floor(targetSeconds / row.job.durationPerRunSeconds);
    row.runsPerInstall =
      runsAllowedByTime >= row.minimumRunsPerInstall ? Math.min(row.runs, runsAllowedByTime) : 0;
  }

  let remainingSlots = Math.max(0, Math.floor(availableSlots));
  while (remainingSlots > 0) {
    const candidates = rows
      .filter(
        (row) =>
          (row.runsPerInstall ?? 0) > 0
          && row.scheduledRuns < row.runs
          && canAllocateInstall(row, rows),
      )
      .sort((left, right) => {
        const leftCoverage = left.scheduledRuns / left.runs;
        const rightCoverage = right.scheduledRuns / right.runs;
        return leftCoverage - rightCoverage || right.runs - left.runs;
      });
    if (candidates.length === 0) return;
    const row = candidates[0];
    row.installs += 1;
    row.scheduledRuns += Math.min(row.runsPerInstall ?? 0, row.runs - row.scheduledRuns);
    remainingSlots -= 1;
  }
}

/** Returns the maximum install count that preserves the ME protection minimum. */
function maximumInstallCount(row: SimulationScheduleRow): number {
  const minimumPreservingCount = Math.max(1, Math.ceil(row.runs / row.minimumRunsPerInstall));
  return Math.min(row.runs, row.formulaCapacity ?? Number.MAX_SAFE_INTEGER, minimumPreservingCount);
}

/** Returns whether an install respects both the row and shared formula limits. */
function canAllocateInstall(
  row: SimulationScheduleRow,
  rows: readonly SimulationScheduleRow[],
): boolean {
  if (row.installs >= maximumInstallCount(row)) return false;
  if (row.formulaKey === undefined || row.formulaCapacity === undefined) return true;
  const allocatedFormulaCount = rows.reduce(
    (total, candidate) =>
      total + (candidate.formulaKey === row.formulaKey ? candidate.installs : 0),
    0,
  );
  return allocatedFormulaCount < row.formulaCapacity;
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
