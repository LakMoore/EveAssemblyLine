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

function scheduleIndustryActivity(
  jobs: readonly SimulationIndustryJob[],
  characters: readonly SimulationCharacterProfile[],
  activity: "manufacturing" | "reaction",
): { jobs: SimulationIndustryJob[]; warnings: SimulationWarning[] } {
  const slots = industrySlots(characters, activity).sort(
    (left, right) =>
      left.timeMultiplier - right.timeMultiplier
      || left.characterId - right.characterId
      || left.slotIndex - right.slotIndex,
  );
  const scheduledJobIds = new Map<string, SimulationInstall>();
  const blueprintAvailableAt = new Map<number, number>();
  const candidates = jobs
    .slice()
    .sort(
      (left, right) =>
        right.durationPerRunSeconds * right.requiredRuns
          - left.durationPerRunSeconds * left.requiredRuns || left.jobId.localeCompare(right.jobId),
    );
  for (const job of candidates) {
    if (slots.length === 0) continue;
    const blueprintItemId = job.blueprint.blueprintItemId;
    const slot = slots
      .map((candidate) => {
        const startOffsetSeconds = Math.max(
          candidate.availableAtSeconds,
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
    .filter((job) => job.unscheduledRuns > 0)
    .map(
      (job): SimulationWarning => ({
        code: "missing-capacity",
        typeId: job.productTypeId,
        locationId: job.locationId,
        jobId: job.jobId,
        message: `${job.unscheduledRuns} ${activity} runs could not be assigned to a free character slot.`,
      }),
    );
  return { jobs: scheduled, warnings };
}

function scheduleScienceJobs(
  inventionJobs: readonly SimulationInventionJob[],
  copyJobs: readonly SimulationCopyJob[],
  characters: readonly SimulationCharacterProfile[],
): {
  inventionJobs: SimulationInventionJob[];
  copyJobs: SimulationCopyJob[];
  warnings: SimulationWarning[];
} {
  const slots = scienceSlots(characters).sort(
    (left, right) => left.characterId - right.characterId || left.slotIndex - right.slotIndex,
  );
  const assignments = new Map<string, SimulationScienceAssignment>();
  const jobs = [
    ...inventionJobs.map((job) => ({ activity: "invention" as const, job })),
    ...copyJobs.map((job) => ({ activity: "copying" as const, job })),
  ];
  for (const entry of jobs
    .slice()
    .sort(
      (left, right) =>
        right.job.durationSeconds - left.job.durationSeconds
        || left.job.jobId.localeCompare(right.job.jobId),
    )) {
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
    const startOffsetSeconds = slot.candidate.availableAtSeconds;
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
    units > 0
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
  const manufacturing = scheduleIndustryActivity(manufacturingJobs, characters, "manufacturing");
  const reactions = scheduleIndustryActivity(reactionJobs, characters, "reaction");
  const science = scheduleScienceJobs(inventionJobs, copyJobs, characters);
  return {
    manufacturingJobs: manufacturing.jobs,
    reactionJobs: reactions.jobs,
    inventionJobs: science.inventionJobs,
    copyJobs: science.copyJobs,
    warnings: [...manufacturing.warnings, ...reactions.warnings, ...science.warnings],
  };
}
