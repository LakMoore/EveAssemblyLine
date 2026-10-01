import type {
  SimulationCharacterProfile,
  SimulationCopyJob,
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationInstall,
  SimulationScienceAssignment,
  SimulationWarning,
  SupplyHorizon,
} from "./types";

interface AvailableSlot {
  characterId: number;
  slotIndex: number;
  timeMultiplier: number;
  availableAtSeconds: number;
}

interface AvailableScienceSlot {
  characterId: number;
  slotIndex: number;
  copyingTimeMultiplier: number;
  inventionTimeMultiplier: number;
  availableAtSeconds: number;
}

/** Result of scheduling all currently declared simulator jobs. */
export interface SimulationScheduleResult {
  manufacturingJobs: SimulationIndustryJob[];
  reactionJobs: SimulationIndustryJob[];
  inventionJobs: SimulationInventionJob[];
  copyJobs: SimulationCopyJob[];
  warnings: SimulationWarning[];
}

function industrySlots(
  characters: readonly SimulationCharacterProfile[],
  activity: "manufacturing" | "reaction",
): AvailableSlot[] {
  return characters.flatMap((character) => {
    const count =
      activity === "manufacturing"
        ? character.freeSlots.manufacturing
        : character.freeSlots.reactions;
    const timeMultiplier =
      activity === "manufacturing"
        ? character.timeMultipliers.manufacturing
        : character.timeMultipliers.reactions;
    return Array.from(
      { length: count },
      (_, slotIndex) => ({
        characterId: character.characterId,
        slotIndex,
        timeMultiplier,
        availableAtSeconds: 0,
      }),
    );
  });
}

function scienceSlots(characters: readonly SimulationCharacterProfile[]): AvailableScienceSlot[] {
  return characters.flatMap((character) =>
    Array.from(
      { length: character.freeSlots.science },
      (_, slotIndex) => ({
        characterId: character.characterId,
        slotIndex,
        copyingTimeMultiplier: character.timeMultipliers.copying,
        inventionTimeMultiplier: character.timeMultipliers.invention,
        availableAtSeconds: 0,
      }),
    ),
  );
}

function readiness(job: SimulationIndustryJob): SupplyHorizon {
  if (job.readyNowRuns >= job.requiredRuns) return "now";
  if (job.readyAfterHaulingRuns >= job.requiredRuns) return "after-hauling";
  if (job.readyAfterUpstreamRuns >= job.requiredRuns) return "after-upstream";
  return "after-purchase";
}

function dependencyDepth(
  job: SimulationIndustryJob,
  jobsById: ReadonlyMap<string, SimulationIndustryJob>,
  visiting: ReadonlySet<string> = new Set(),
): number {
  if (visiting.has(job.jobId)) return 0;
  const nextVisiting = new Set(visiting).add(job.jobId);
  const dependencies = job.inputs
    .flatMap((input) => input.upstreamReservations ?? [])
    .filter((reservation) => reservation.state === "planned")
    .map((reservation) => jobsById.get(String(reservation.sourceJobId)))
    .filter((upstream): upstream is SimulationIndustryJob => upstream !== undefined);
  return dependencies.length === 0
    ? 0
    : 1
        + Math.max(
          ...dependencies.map((upstream) => dependencyDepth(upstream, jobsById, nextVisiting)),
        );
}

function earliestIndustryStart(
  job: SimulationIndustryJob,
  scheduledJobs: ReadonlyMap<string, SimulationInstall>,
  jobsById: ReadonlyMap<string, SimulationIndustryJob>,
): number | undefined {
  if (
    job.blueprint.blueprintKind === "fallback"
    || (job.blueprint.blueprintKind === "formula" && job.blueprint.blueprintItemId === undefined)
    || (
      job.blueprint.sourceLocationId !== undefined
      && job.blueprint.sourceLocationId !== job.locationId
    )
  ) return undefined;
  if (job.readyNowRuns >= job.requiredRuns) return 0;
  if (
    job.readyAfterUpstreamRuns < job.requiredRuns
    || job.readyAfterHaulingRuns >= job.requiredRuns
  ) {
    return undefined;
  }
  let earliest = 0;
  for (const input of job.inputs) {
    if (input.availableFromHauling > 0 || input.unsatisfiedQuantity > 0) return undefined;
    let accounted = input.availableNow;
    for (const reservation of input.upstreamReservations ?? []) {
      if (reservation.state !== "planned" || typeof reservation.sourceJobId !== "string") {
        return undefined;
      }
      const producer = jobsById.get(reservation.sourceJobId);
      const install = scheduledJobs.get(reservation.sourceJobId);
      if (!producer || !install || producer.locationId !== job.locationId) return undefined;
      accounted += reservation.quantity;
      earliest = Math.max(earliest, install.endOffsetSeconds);
    }
    if (accounted < input.requiredQuantity) return undefined;
  }
  return earliest;
}

function scheduleIndustryActivities(
  manufacturingJobs: readonly SimulationIndustryJob[],
  reactionJobs: readonly SimulationIndustryJob[],
  characters: readonly SimulationCharacterProfile[],
): {
  manufacturingJobs: SimulationIndustryJob[];
  reactionJobs: SimulationIndustryJob[];
  warnings: SimulationWarning[];
} {
  const jobs = [...manufacturingJobs, ...reactionJobs];
  const slotsByActivity = {
    manufacturing: industrySlots(characters, "manufacturing"),
    reaction: industrySlots(characters, "reaction"),
  };
  const scheduledJobIds = new Map<string, SimulationInstall>();
  const schedulableJobIds = new Set<string>();
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const blueprintAvailableAt = new Map<number, number>();
  const candidates = jobs
    .slice()
    .sort(
      (left, right) =>
        dependencyDepth(left, jobsById) - dependencyDepth(right, jobsById)
        || right.durationPerRunSeconds * right.requiredRuns
          - left.durationPerRunSeconds * left.requiredRuns
        || left.jobId.localeCompare(right.jobId),
    );
  for (const job of candidates) {
    const earliestFromSupply = earliestIndustryStart(job, scheduledJobIds, jobsById);
    if (earliestFromSupply === undefined) continue;
    schedulableJobIds.add(job.jobId);
    const slots = slotsByActivity[job.activity];
    if (slots.length === 0) continue;
    const blueprintItemId = job.blueprint.blueprintItemId;
    const slot = slots
      .map((candidate) => {
        const startOffsetSeconds = Math.max(
          candidate.availableAtSeconds,
          earliestFromSupply,
          blueprintItemId === undefined ? 0 : (blueprintAvailableAt.get(blueprintItemId) ?? 0),
        );
        const durationSeconds = Math.ceil(
          job.durationPerRunSeconds * job.requiredRuns * candidate.timeMultiplier,
        );
        return { candidate, startOffsetSeconds, durationSeconds };
      })
      .sort(
        (left, right) =>
          left.startOffsetSeconds
            + left.durationSeconds
            - (right.startOffsetSeconds + right.durationSeconds)
          || left.candidate.characterId - right.candidate.characterId
          || left.candidate.slotIndex - right.candidate.slotIndex,
      )[0];
    const endOffsetSeconds = slot.startOffsetSeconds + slot.durationSeconds;
    const install: SimulationInstall = {
      installId: `install:${job.jobId}:${slot.candidate.characterId}:${slot.candidate.slotIndex}`,
      characterId: slot.candidate.characterId,
      slotIndex: slot.candidate.slotIndex,
      runs: job.requiredRuns,
      startOffsetSeconds: slot.startOffsetSeconds,
      endOffsetSeconds,
      durationSeconds: slot.durationSeconds,
      readiness: readiness(job),
      inputs: job.inputs,
    };
    scheduledJobIds.set(job.jobId, install);
    slot.candidate.availableAtSeconds = endOffsetSeconds;
    if (blueprintItemId !== undefined) blueprintAvailableAt.set(blueprintItemId, endOffsetSeconds);
  }
  const scheduled = jobs.map((job) => {
    const install = scheduledJobIds.get(job.jobId);
    return {
      ...job,
      installs: install ? [install] : [],
      unscheduledRuns: install ? 0 : job.requiredRuns,
    };
  });
  const warnings = scheduled
    .filter((job) => job.unscheduledRuns > 0 && schedulableJobIds.has(job.jobId))
    .map(
      (job): SimulationWarning => ({
        code: "missing-capacity",
        typeId: job.productTypeId,
        locationId: job.locationId,
        jobId: job.jobId,
        message: `${job.unscheduledRuns} ${job.activity} runs could not be assigned to a free character slot.`,
      }),
    );
  return {
    manufacturingJobs: scheduled.filter((job) => job.activity === "manufacturing"),
    reactionJobs: scheduled.filter((job) => job.activity === "reaction"),
    warnings,
  };
}

function scheduleScienceJobs(
  inventionJobs: readonly SimulationInventionJob[],
  copyJobs: readonly SimulationCopyJob[],
  characters: readonly SimulationCharacterProfile[],
  industryJobs: readonly SimulationIndustryJob[],
): {
  inventionJobs: SimulationInventionJob[];
  copyJobs: SimulationCopyJob[];
  warnings: SimulationWarning[];
} {
  const slots = scienceSlots(characters).sort(
    (left, right) => left.characterId - right.characterId || left.slotIndex - right.slotIndex,
  );
  const assignments = new Map<string, SimulationScienceAssignment>();
  const completionOffsets = new Map(
    industryJobs.flatMap((job) =>
      job.installs.map((install) => [job.jobId, install.endOffsetSeconds] as const),
    ),
  );
  const jobs = [
    ...copyJobs.map((job) => ({ activity: "copying" as const, job })),
    ...inventionJobs.map((job) => ({ activity: "invention" as const, job })),
  ];
  const locationsByJobId = new Map([
    ...industryJobs.map((job) => [job.jobId, job.locationId] as const),
    ...jobs.map((entry) => [entry.job.jobId, entry.job.locationId] as const),
  ]);
  const schedulableJobIds = new Set<string>();
  for (const entry of jobs
    .slice()
    .sort(
      (left, right) =>
        Number(left.activity === "invention") - Number(right.activity === "invention")
        || right.job.durationSeconds - left.job.durationSeconds
        || left.job.jobId.localeCompare(right.job.jobId),
    )) {
    if (
      entry.activity === "copying"
      && (
        entry.job.sourceBlueprintItemId === undefined
        || (
          entry.job.sourceBlueprintLocationId !== undefined
          && entry.job.sourceBlueprintLocationId !== entry.job.locationId
        )
      )
    ) continue;
    let earliestFromSupply = 0;
    let inputReady = true;
    for (const input of entry.job.inputs) {
      if (input.availableNow >= input.requiredQuantity) continue;
      if (input.availableFromHauling > 0 || input.unsatisfiedQuantity > 0) {
        inputReady = false;
        break;
      }
      let accounted = input.availableNow;
      for (const reservation of input.upstreamReservations ?? []) {
        const sourceJobId = String(reservation.sourceJobId ?? "");
        const completedAt = completionOffsets.get(sourceJobId);
        if (
          reservation.state !== "planned"
          || completedAt === undefined
          || locationsByJobId.get(sourceJobId) !== entry.job.locationId
        ) {
          inputReady = false;
          break;
        }
        accounted += reservation.quantity;
        earliestFromSupply = Math.max(earliestFromSupply, completedAt);
      }
      if (!inputReady || accounted < input.requiredQuantity) {
        inputReady = false;
        break;
      }
    }
    if (!inputReady) continue;
    schedulableJobIds.add(entry.job.jobId);
    if (slots.length === 0) continue;
    const slot = slots
      .map((candidate) => {
        const timeMultiplier =
          entry.activity === "copying"
            ? candidate.copyingTimeMultiplier
            : candidate.inventionTimeMultiplier;
        return {
          candidate,
          durationSeconds: Math.ceil(entry.job.durationSeconds * timeMultiplier),
        };
      })
      .sort(
        (left, right) =>
          left.candidate.availableAtSeconds
            + left.durationSeconds
            - (right.candidate.availableAtSeconds + right.durationSeconds)
          || left.candidate.characterId - right.candidate.characterId
          || left.candidate.slotIndex - right.candidate.slotIndex,
      )[0];
    const units = entry.activity === "copying" ? entry.job.copies : entry.job.attempts;
    const startOffsetSeconds = Math.max(slot.candidate.availableAtSeconds, earliestFromSupply);
    const endOffsetSeconds = startOffsetSeconds + slot.durationSeconds;
    assignments.set(
      entry.job.jobId,
      {
        assignmentId: `science:${entry.job.jobId}:${slot.candidate.characterId}:${slot.candidate.slotIndex}`,
        characterId: slot.candidate.characterId,
        slotIndex: slot.candidate.slotIndex,
        units,
        startOffsetSeconds,
        endOffsetSeconds,
        durationSeconds: slot.durationSeconds,
      },
    );
    slot.candidate.availableAtSeconds = endOffsetSeconds;
    completionOffsets.set(entry.job.jobId, endOffsetSeconds);
  }
  const scheduledCopying = copyJobs.map((job) => {
    const assignment = assignments.get(job.jobId);
    return {
      ...job,
      assignments: assignment ? [assignment] : [],
      unscheduledCopies: assignment ? 0 : job.copies,
    };
  });
  const scheduledInvention = inventionJobs.map((job) => {
    const assignment = assignments.get(job.jobId);
    return {
      ...job,
      assignments: assignment ? [assignment] : [],
      unscheduledAttempts: assignment ? 0 : job.attempts,
    };
  });
  const warnings: SimulationWarning[] = [
    ...scheduledCopying.map((job) => ({ job, units: job.unscheduledCopies, activity: "copying" })),
    ...scheduledInvention.map((job) => ({
      job,
      units: job.unscheduledAttempts,
      activity: "invention",
    })),
  ].flatMap(({ job, units, activity }): SimulationWarning[] =>
    units > 0 && schedulableJobIds.has(job.jobId)
      ? [
          {
            code: "missing-capacity",
            locationId: job.locationId,
            jobId: job.jobId,
            message: `${units} ${activity} units could not be assigned to a free Science slot.`,
          },
        ]
      : [],
  );
  return { inventionJobs: scheduledInvention, copyJobs: scheduledCopying, warnings };
}

/** Assigns complete install rows to character slots in deterministic longest-job-first order. */
export function scheduleSimulationJobs(
  manufacturingJobs: readonly SimulationIndustryJob[],
  reactionJobs: readonly SimulationIndustryJob[],
  inventionJobs: readonly SimulationInventionJob[],
  copyJobs: readonly SimulationCopyJob[],
  characters: readonly SimulationCharacterProfile[],
): SimulationScheduleResult {
  const industry = scheduleIndustryActivities(manufacturingJobs, reactionJobs, characters);
  const science = scheduleScienceJobs(
    inventionJobs,
    copyJobs,
    characters,
    [...industry.manufacturingJobs, ...industry.reactionJobs],
  );
  return {
    manufacturingJobs: industry.manufacturingJobs,
    reactionJobs: industry.reactionJobs,
    inventionJobs: science.inventionJobs,
    copyJobs: science.copyJobs,
    warnings: [...industry.warnings, ...science.warnings],
  };
}
