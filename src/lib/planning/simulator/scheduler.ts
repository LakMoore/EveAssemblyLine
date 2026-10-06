import type {
  SimulationCharacterProfile,
  SimulationCopyJob,
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationInstall,
  SimulationJobSkillRequirement,
  SimulationScienceAssignment,
  SimulationSlot,
  SimulationWarning,
  SupplyHorizon,
} from "./types";
import { isWormholeSystemId } from "./clientScheduler";

interface ScheduledInterval {
  startOffsetSeconds: number;
  endOffsetSeconds: number;
}

interface AvailableSlot {
  slotKey: string;
  characterId: number;
  systemId: number;
  slotIndex: number;
  timeMultiplier: number;
  scheduledIntervals: ScheduledInterval[];
}

interface AvailableScienceSlot {
  slotKey: string;
  characterId: number;
  systemId: number;
  slotIndex: number;
  copyingTimeMultiplier: number;
  inventionTimeMultiplier: number;
  latestJobEndSeconds: number;
}

type BaselineIndustryTimeMultipliers = Pick<
  SimulationCharacterProfile["timeMultipliers"],
  "manufacturing" | "reactions"
>;

const activityStartIntervalSeconds = 12 * 60 * 60;
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
  slots: readonly SimulationSlot[],
  activity: "manufacturing" | "reaction",
): AvailableSlot[] {
  const charactersById = new Map(characters.map((character) => [character.characterId, character]));
  return slots.flatMap((slot) => {
    if (slot.activity !== activity) return [];
    const character = charactersById.get(slot.characterId);
    if (!character) return [];
    const timeMultiplier =
      activity === "manufacturing"
        ? character.timeMultipliers.manufacturing
        : character.timeMultipliers.reactions;
    return [
      {
        slotKey: slot.slotKey,
        characterId: slot.characterId,
        systemId: slot.systemId,
        slotIndex: slot.slotIndex,
        timeMultiplier,
        scheduledIntervals:
          slot.availableAtSeconds > 0
            ? [{ startOffsetSeconds: 0, endOffsetSeconds: slot.availableAtSeconds }]
            : [],
      },
    ];
  });
}

function scienceSlots(
  characters: readonly SimulationCharacterProfile[],
  slots: readonly SimulationSlot[],
): AvailableScienceSlot[] {
  const charactersById = new Map(characters.map((character) => [character.characterId, character]));
  return slots.flatMap((slot) => {
    if (slot.activity !== "science") return [];
    const character = charactersById.get(slot.characterId);
    if (!character) return [];
    return [
      {
        slotKey: slot.slotKey,
        characterId: slot.characterId,
        systemId: slot.systemId,
        slotIndex: slot.slotIndex,
        copyingTimeMultiplier: character.timeMultipliers.copying,
        inventionTimeMultiplier: character.timeMultipliers.invention,
        latestJobEndSeconds: slot.availableAtSeconds,
      },
    ];
  });
}

function inFlightCompletionOffsets(slots: readonly SimulationSlot[]): Map<string, number> {
  return new Map(
    slots.flatMap((slot) =>
      slot.installedJobId === undefined
        ? []
        : [[String(slot.installedJobId), slot.availableAtSeconds] as const],
    ),
  );
}

function characterCanScheduleAtSystem(characterSystemId: number, activitySystemId?: number) {
  if (activitySystemId === undefined) return false;
  return isWormholeSystemId(activitySystemId)
    ? characterSystemId === activitySystemId
    : !isWormholeSystemId(characterSystemId);
}

/** Explains system eligibility failures without implying that K-space systems must match. */
function noEligibleSystemSlotReason(activitySystemId: number | undefined, activity: string) {
  if (activitySystemId === undefined) {
    return "The facility's solar system is unavailable for character eligibility.";
  }
  if (isWormholeSystemId(activitySystemId)) {
    return `No character in this wormhole system has a free ${activity} slot.`;
  }
  return `No non-wormhole character has a free ${activity} slot.`;
}

function nextValidActivityStart(earliestStartSeconds: number): number {
  return (
    Math.ceil(earliestStartSeconds / activityStartIntervalSeconds) * activityStartIntervalSeconds
  );
}

/** Finds the earliest valid start that does not overlap a slot or blueprint booking. */
function earliestIndustryResourceStart(
  slotIntervals: readonly ScheduledInterval[],
  blueprintIntervals: readonly ScheduledInterval[],
  earliestStartSeconds: number,
  durationSeconds: number,
): number {
  let startOffsetSeconds = nextValidActivityStart(earliestStartSeconds);
  let conflictingIntervals: ScheduledInterval[] = [];
  do {
    const endOffsetSeconds = startOffsetSeconds + durationSeconds;
    conflictingIntervals = [...slotIntervals, ...blueprintIntervals].filter(
      (interval) =>
        startOffsetSeconds < interval.endOffsetSeconds
        && endOffsetSeconds > interval.startOffsetSeconds,
    );
    if (conflictingIntervals.length > 0) {
      startOffsetSeconds = nextValidActivityStart(
        Math.max(...conflictingIntervals.map((interval) => interval.endOffsetSeconds)),
      );
    }
  } while (conflictingIntervals.length > 0);
  return startOffsetSeconds;
}

function characterMeetsSkillRequirements(
  character: SimulationCharacterProfile,
  requirements: readonly SimulationJobSkillRequirement[],
): boolean {
  return requirements.every(
    (requirement) =>
      (character.skillLevels[String(requirement.skillId)] ?? 0) >= requirement.requiredLevel,
  );
}

function groupSkillRequirementsByJob(
  requirements: readonly SimulationJobSkillRequirement[],
): Map<string, SimulationJobSkillRequirement[]> {
  const requirementsByJob = new Map<string, SimulationJobSkillRequirement[]>();
  for (const requirement of requirements) {
    const jobRequirements = requirementsByJob.get(requirement.jobId) ?? [];
    jobRequirements.push(requirement);
    requirementsByJob.set(requirement.jobId, jobRequirements);
  }
  return requirementsByJob;
}

function readiness(job: SimulationIndustryJob): SupplyHorizon {
  if (
    existingAssetsNeedHauling(job.inputs)
    || (
      job.blueprint.sourceLocationId !== undefined
      && job.blueprint.sourceLocationId !== job.locationId
    )
  ) return "after-hauling";
  if (job.readyNowRuns >= job.requiredRuns) return "now";
  if (job.readyAfterHaulingRuns >= job.requiredRuns) return "after-hauling";
  if (job.readyAfterUpstreamRuns >= job.requiredRuns) return "after-upstream";
  return "after-purchase";
}

/** Assigns consuming-job depth and shares the deepest value for each product/location. */
function scheduledJobDepths(
  industryJobs: readonly SimulationIndustryJob[],
  inventionJobs: readonly SimulationInventionJob[],
  copyJobs: readonly SimulationCopyJob[],
): Map<string, number> {
  const nodes = [
    ...industryJobs.map((job) => ({
      jobId: job.jobId,
      outputTypeId: job.productTypeId,
      locationId: job.locationId,
      inputs: job.inputs,
    })),
    ...inventionJobs.map((job) => ({
      jobId: job.jobId,
      outputTypeId: job.outputBlueprintTypeId,
      locationId: job.locationId,
      inputs: job.inputs,
    })),
    ...copyJobs.map((job) => ({
      jobId: job.jobId,
      outputTypeId: job.blueprintTypeId,
      locationId: job.locationId,
      inputs: job.inputs,
    })),
  ];
  const jobsById = new Map(nodes.map((job) => [job.jobId, job]));
  const producersByConsumer = new Map<string, Set<string>>();
  const jobsByProductLocation = new Map<string, typeof nodes>();
  for (const job of nodes) {
    const groupKey = `${job.outputTypeId}:${job.locationId}`;
    const productJobs = jobsByProductLocation.get(groupKey) ?? [];
    productJobs.push(job);
    jobsByProductLocation.set(groupKey, productJobs);
    for (const input of job.inputs) {
      for (const reservation of input.upstreamReservations ?? []) {
        if (reservation.sourceJobId === undefined) continue;
        const producerId = String(reservation.sourceJobId);
        if (!jobsById.has(producerId)) continue;
        const producers = producersByConsumer.get(job.jobId) ?? new Set<string>();
        producers.add(producerId);
        producersByConsumer.set(job.jobId, producers);
      }
    }
  }
  for (const job of industryJobs) {
    for (const source of job.demandSources) {
      if (source.demandingJobId === undefined || !jobsById.has(source.demandingJobId)) continue;
      const producers = producersByConsumer.get(source.demandingJobId) ?? new Set<string>();
      producers.add(job.jobId);
      producersByConsumer.set(source.demandingJobId, producers);
    }
  }
  const inventionsByBlueprintType = new Map<number, SimulationInventionJob[]>();
  for (const job of inventionJobs) {
    const jobsForType = inventionsByBlueprintType.get(job.outputBlueprintTypeId) ?? [];
    jobsForType.push(job);
    inventionsByBlueprintType.set(job.outputBlueprintTypeId, jobsForType);
  }
  for (const consumer of industryJobs) {
    if (consumer.blueprint.blueprintKind !== "bpc") continue;
    for (const producer of inventionsByBlueprintType.get(consumer.blueprint.blueprintTypeId)
      ?? []) {
      const producers = producersByConsumer.get(consumer.jobId) ?? new Set<string>();
      producers.add(producer.jobId);
      producersByConsumer.set(consumer.jobId, producers);
    }
  }

  const depths = new Map(nodes.map((job) => [job.jobId, 1]));
  const pending = nodes.map((job) => job.jobId);
  const maximumDepth = Math.max(1, nodes.length);
  for (let index = 0; index < pending.length; index += 1) {
    const consumerId = pending[index];
    const consumer = jobsById.get(consumerId);
    if (!consumer) continue;
    const nextDepth = Math.min(maximumDepth, (depths.get(consumerId) ?? 1) + 1);
    for (const producerId of producersByConsumer.get(consumerId) ?? []) {
      const producer = jobsById.get(producerId);
      if (!producer) continue;
      const groupKey = `${producer.outputTypeId}:${producer.locationId}`;
      for (const peer of jobsByProductLocation.get(groupKey) ?? [producer]) {
        if (nextDepth <= (depths.get(peer.jobId) ?? 1)) continue;
        depths.set(peer.jobId, nextDepth);
        pending.push(peer.jobId);
      }
    }
  }
  return depths;
}

const missingInputAvailabilityOffsetSeconds = 24 * 60 * 60;

/** Converts a character factor relative to the shared factor already used during batch planning. */
function relativeIndustryTimeMultiplier(
  activity: "manufacturing" | "reaction",
  characterMultiplier: number,
  baselineTimeMultipliers: BaselineIndustryTimeMultipliers,
): number {
  const baselineMultiplier =
    activity === "manufacturing"
      ? baselineTimeMultipliers.manufacturing
      : baselineTimeMultipliers.reactions;
  return baselineMultiplier > 0 ? characterMultiplier / baselineMultiplier : 1;
}

type IndustryStartDecision =
  | { startOffsetSeconds: number; noTimingReason?: never }
  | { startOffsetSeconds?: never; noTimingReason: string };

function existingAssetsNeedHauling(inputs: readonly SimulationIndustryJob["inputs"][number][]) {
  return inputs.some(
    (input) => input.availableNow < input.requiredQuantity && input.availableFromHauling > 0,
  );
}

function earliestIndustryStart(
  job: SimulationIndustryJob,
  completionOffsets: ReadonlyMap<string, number>,
  jobsById: ReadonlyMap<string, SimulationIndustryJob>,
): IndustryStartDecision {
  const blueprint = job.blueprint;
  if (blueprint.blueprintKind === "formula" && blueprint.sourceLocationId === undefined) {
    return {
      noTimingReason: "The required blueprint or reaction formula is unavailable at this facility.",
    };
  }
  let earliest = 0;
  if (blueprint.sourceLocationId !== undefined && blueprint.sourceLocationId !== job.locationId) {
    earliest = Math.max(earliest, missingInputAvailabilityOffsetSeconds);
  }
  if (existingAssetsNeedHauling(job.inputs)) {
    earliest = Math.max(earliest, missingInputAvailabilityOffsetSeconds);
  }
  if (job.readyNowRuns >= job.requiredRuns) return { startOffsetSeconds: earliest };
  if (job.readyAfterHaulingRuns >= job.requiredRuns) {
    earliest = Math.max(earliest, missingInputAvailabilityOffsetSeconds);
  }
  for (const input of job.inputs) {
    if (input.availableNow >= input.requiredQuantity) continue;
    if (input.availableFromHauling > 0) {
      earliest = Math.max(earliest, missingInputAvailabilityOffsetSeconds);
    }
    let accounted = input.availableNow;
    for (const reservation of input.upstreamReservations ?? []) {
      if (reservation.sourceJobId === undefined || reservation.state === "paused") continue;
      const sourceJobId = String(reservation.sourceJobId);
      const producer = jobsById.get(sourceJobId);
      const completionOffset = completionOffsets.get(sourceJobId);
      if (
        (reservation.state === "planned" && !producer)
        || (reservation.state === "in-production" && !completionOffsets.has(sourceJobId))
        || completionOffset === undefined
      ) continue;
      accounted += reservation.quantity;
      earliest = Math.max(earliest, completionOffset);
    }
    if (accounted < input.requiredQuantity || input.unsatisfiedQuantity > 0) {
      earliest = Math.max(earliest, missingInputAvailabilityOffsetSeconds);
    }
  }
  return { startOffsetSeconds: earliest };
}

function scheduleIndustryActivities(
  manufacturingJobs: readonly SimulationIndustryJob[],
  reactionJobs: readonly SimulationIndustryJob[],
  characters: readonly SimulationCharacterProfile[],
  slots: readonly SimulationSlot[],
  locationSystemIdsById: ReadonlyMap<number, number>,
  baselineTimeMultipliers: BaselineIndustryTimeMultipliers,
  skillRequirementsByJob: ReadonlyMap<string, readonly SimulationJobSkillRequirement[]>,
  maxReactionJobDurationHours: number,
  depths: ReadonlyMap<string, number>,
): {
  manufacturingJobs: SimulationIndustryJob[];
  reactionJobs: SimulationIndustryJob[];
  warnings: SimulationWarning[];
} {
  const jobs = [...manufacturingJobs, ...reactionJobs];
  const slotsByActivity = {
    manufacturing: industrySlots(characters, slots, "manufacturing"),
    reaction: industrySlots(characters, slots, "reaction"),
  };
  const scheduledJobIds = new Map<string, SimulationInstall[]>();
  const completionOffsets = inFlightCompletionOffsets(slots);
  const noTimingReasons = new Map<string, string>();
  const schedulableJobIds = new Set<string>();
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const blueprintIntervalsByItemId = new Map<number, ScheduledInterval[]>();
  const candidates = jobs
    .slice()
    .sort(
      (left, right) =>
        (depths.get(right.jobId) ?? 1) - (depths.get(left.jobId) ?? 1)
        || right.durationPerRunSeconds * right.requiredRuns
          - left.durationPerRunSeconds * left.requiredRuns
        || left.jobId.localeCompare(right.jobId),
    );
  for (const job of candidates) {
    const startDecision = earliestIndustryStart(job, completionOffsets, jobsById);
    if (startDecision.startOffsetSeconds === undefined) {
      noTimingReasons.set(job.jobId, startDecision.noTimingReason);
      continue;
    }
    schedulableJobIds.add(job.jobId);
    const activitySystemId = locationSystemIdsById.get(job.locationId);
    const locationSlots = slotsByActivity[job.activity].filter((slot) =>
      characterCanScheduleAtSystem(slot.systemId, activitySystemId),
    );
    if (locationSlots.length === 0) {
      noTimingReasons.set(job.jobId, noEligibleSystemSlotReason(activitySystemId, job.activity));
      continue;
    }
    const jobSkillRequirements = skillRequirementsByJob.get(job.jobId) ?? [];
    const eligibleCharacterIds = new Set(
      characters
        .filter((character) => characterMeetsSkillRequirements(character, jobSkillRequirements))
        .map((character) => character.characterId),
    );
    const slots = locationSlots.filter((slot) => eligibleCharacterIds.has(slot.characterId));
    if (slots.length === 0) {
      noTimingReasons.set(
        job.jobId,
        "No character with the required activity skills has an eligible slot.",
      );
      continue;
    }
    const blueprintItemId = job.blueprint.blueprintItemId;
    const maxRunsPerInstall =
      job.activity === "reaction"
        ? Math.max(1, Math.floor((maxReactionJobDurationHours * 3600) / job.durationPerRunSeconds))
        : job.requiredRuns;
    const installs: SimulationInstall[] = [];
    let remainingRuns = job.requiredRuns;
    while (remainingRuns > 0) {
      const runs = Math.min(remainingRuns, maxRunsPerInstall);
      const slot = slots
        .map((candidate) => {
          const durationSeconds = Math.ceil(
            job.durationPerRunSeconds
              * runs
              * relativeIndustryTimeMultiplier(
                job.activity,
                candidate.timeMultiplier,
                baselineTimeMultipliers,
              ),
          );
          const blueprintIntervals =
            blueprintItemId === undefined
              ? []
              : (blueprintIntervalsByItemId.get(blueprintItemId) ?? []);
          const slotAvailableAtSeconds = earliestIndustryResourceStart(
            candidate.scheduledIntervals,
            [],
            0,
            durationSeconds,
          );
          const startOffsetSeconds = earliestIndustryResourceStart(
            candidate.scheduledIntervals,
            blueprintIntervals,
            startDecision.startOffsetSeconds,
            durationSeconds,
          );
          return { candidate, slotAvailableAtSeconds, startOffsetSeconds, durationSeconds };
        })
        .sort(
          (left, right) =>
            left.startOffsetSeconds - right.startOffsetSeconds
            || left.slotAvailableAtSeconds - right.slotAvailableAtSeconds
            || left.startOffsetSeconds
              + left.durationSeconds
              - (right.startOffsetSeconds + right.durationSeconds)
            || left.candidate.characterId - right.candidate.characterId
            || left.candidate.slotIndex - right.candidate.slotIndex,
        )[0];
      const endOffsetSeconds = slot.startOffsetSeconds + slot.durationSeconds;
      installs.push({
        installId:
          installs.length === 0 && runs === job.requiredRuns
            ? `install:${job.jobId}:${slot.candidate.slotKey}`
            : `install:${job.jobId}:${installs.length}:${slot.candidate.slotKey}`,
        slotKey: slot.candidate.slotKey,
        characterId: slot.candidate.characterId,
        slotIndex: slot.candidate.slotIndex,
        runs,
        startOffsetSeconds: slot.startOffsetSeconds,
        endOffsetSeconds,
        durationSeconds: slot.durationSeconds,
        readiness: readiness(job),
        inputs: job.inputs,
      });
      remainingRuns -= runs;
      const scheduledInterval = {
        startOffsetSeconds: slot.startOffsetSeconds,
        endOffsetSeconds,
      };
      slot.candidate.scheduledIntervals.push(scheduledInterval);
      if (blueprintItemId !== undefined) {
        const blueprintIntervals = blueprintIntervalsByItemId.get(blueprintItemId) ?? [];
        blueprintIntervals.push(scheduledInterval);
        blueprintIntervalsByItemId.set(blueprintItemId, blueprintIntervals);
      }
    }
    scheduledJobIds.set(job.jobId, installs);
    completionOffsets.set(
      job.jobId,
      installs.reduce(
        (latestEnd, install) => Math.max(latestEnd, install.endOffsetSeconds),
        startDecision.startOffsetSeconds,
      ),
    );
  }
  const scheduled = jobs.map((job) => {
    const installs = scheduledJobIds.get(job.jobId) ?? [];
    const scheduledRuns = installs.reduce((total, install) => total + install.runs, 0);
    const unscheduledRuns = job.requiredRuns - scheduledRuns;
    return {
      ...job,
      depth: depths.get(job.jobId) ?? 1,
      installs,
      unscheduledRuns,
      ...(unscheduledRuns > 0
        ? {
            noTimingReason:
              noTimingReasons.get(job.jobId) ?? "No eligible character slot is available.",
          }
        : {}),
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
  slotMap: readonly SimulationSlot[],
  locationSystemIdsById: ReadonlyMap<number, number>,
  industryJobs: readonly SimulationIndustryJob[],
  depths: ReadonlyMap<string, number>,
  skillRequirementsByJob: ReadonlyMap<string, readonly SimulationJobSkillRequirement[]>,
): {
  inventionJobs: SimulationInventionJob[];
  copyJobs: SimulationCopyJob[];
  warnings: SimulationWarning[];
} {
  const slots = scienceSlots(characters, slotMap).sort(
    (left, right) => left.characterId - right.characterId || left.slotIndex - right.slotIndex,
  );
  const assignments = new Map<string, SimulationScienceAssignment>();
  const completionOffsets = new Map([
    ...inFlightCompletionOffsets(slotMap),
    ...industryJobs.flatMap((job) => {
      const completionOffset = job.installs.reduce<number | undefined>(
        (latestEnd, install) =>
          latestEnd === undefined
            ? install.endOffsetSeconds
            : Math.max(latestEnd, install.endOffsetSeconds),
        undefined,
      );
      return completionOffset === undefined ? [] : [[job.jobId, completionOffset] as const];
    }),
  ]);
  const jobs = [
    ...copyJobs.map((job) => ({ activity: "copying" as const, job })),
    ...inventionJobs.map((job) => ({ activity: "invention" as const, job })),
  ];
  const schedulableJobIds = new Set<string>();
  const noTimingReasons = new Map<string, string>();
  for (const entry of jobs
    .slice()
    .sort(
      (left, right) =>
        (depths.get(right.job.jobId) ?? 1) - (depths.get(left.job.jobId) ?? 1)
        || Number(left.activity === "invention") - Number(right.activity === "invention")
        || right.job.durationSeconds - left.job.durationSeconds
        || left.job.jobId.localeCompare(right.job.jobId),
    )) {
    if (entry.activity === "copying" && entry.job.sourceBlueprintItemId === undefined) {
      noTimingReasons.set(entry.job.jobId, "The source blueprint is unavailable at this facility.");
      continue;
    }
    let earliestFromSupply = 0;
    let requiresHauling =
      entry.activity === "copying"
      && entry.job.sourceBlueprintLocationId !== undefined
      && entry.job.sourceBlueprintLocationId !== entry.job.locationId;
    if (requiresHauling) {
      earliestFromSupply = Math.max(earliestFromSupply, missingInputAvailabilityOffsetSeconds);
    }
    for (const input of entry.job.inputs) {
      if (input.availableNow >= input.requiredQuantity) continue;
      if (input.availableFromHauling > 0) {
        requiresHauling = true;
        earliestFromSupply = Math.max(earliestFromSupply, missingInputAvailabilityOffsetSeconds);
      }
      let accounted = input.availableNow;
      for (const reservation of input.upstreamReservations ?? []) {
        if (reservation.sourceJobId === undefined || reservation.state === "paused") continue;
        const sourceJobId = String(reservation.sourceJobId ?? "");
        const completedAt = completionOffsets.get(sourceJobId);
        if (completedAt === undefined) continue;
        accounted += reservation.quantity;
        earliestFromSupply = Math.max(earliestFromSupply, completedAt);
      }
      if (accounted < input.requiredQuantity || input.unsatisfiedQuantity > 0) {
        earliestFromSupply = Math.max(earliestFromSupply, missingInputAvailabilityOffsetSeconds);
      }
    }
    schedulableJobIds.add(entry.job.jobId);
    const activitySystemId = locationSystemIdsById.get(entry.job.locationId);
    const locationSlots = slots.filter((slot) =>
      characterCanScheduleAtSystem(slot.systemId, activitySystemId),
    );
    if (locationSlots.length === 0) {
      noTimingReasons.set(entry.job.jobId, noEligibleSystemSlotReason(activitySystemId, "Science"));
      continue;
    }
    const jobSkillRequirements = skillRequirementsByJob.get(entry.job.jobId) ?? [];
    const eligibleCharacterIds = new Set(
      characters
        .filter((character) => characterMeetsSkillRequirements(character, jobSkillRequirements))
        .map((character) => character.characterId),
    );
    const eligibleSlots = locationSlots.filter((slot) =>
      eligibleCharacterIds.has(slot.characterId),
    );
    if (eligibleSlots.length === 0) {
      noTimingReasons.set(
        entry.job.jobId,
        "No character with the required activity skills has an eligible Science slot.",
      );
      continue;
    }
    const slot = eligibleSlots
      .map((candidate) => {
        const timeMultiplier =
          entry.activity === "copying"
            ? candidate.copyingTimeMultiplier
            : candidate.inventionTimeMultiplier;
        return {
          candidate,
          slotAvailableAtSeconds: nextValidActivityStart(candidate.latestJobEndSeconds),
          durationSeconds: Math.ceil(entry.job.durationSeconds * timeMultiplier),
          startOffsetSeconds: nextValidActivityStart(
            Math.max(candidate.latestJobEndSeconds, earliestFromSupply),
          ),
        };
      })
      .sort(
        (left, right) =>
          left.startOffsetSeconds - right.startOffsetSeconds
          || left.slotAvailableAtSeconds - right.slotAvailableAtSeconds
          || left.startOffsetSeconds
            + left.durationSeconds
            - (right.startOffsetSeconds + right.durationSeconds)
          || left.candidate.characterId - right.candidate.characterId
          || left.candidate.slotIndex - right.candidate.slotIndex,
      )[0];
    const units = entry.activity === "copying" ? entry.job.copies : entry.job.attempts;
    const startOffsetSeconds = slot.startOffsetSeconds;
    const endOffsetSeconds = startOffsetSeconds + slot.durationSeconds;
    assignments.set(
      entry.job.jobId,
      {
        assignmentId: `science:${entry.job.jobId}:${slot.candidate.slotKey}`,
        slotKey: slot.candidate.slotKey,
        characterId: slot.candidate.characterId,
        slotIndex: slot.candidate.slotIndex,
        units,
        startOffsetSeconds,
        endOffsetSeconds,
        durationSeconds: slot.durationSeconds,
        ...(requiresHauling ? { readiness: "after-hauling" as const } : {}),
      },
    );
    slot.candidate.latestJobEndSeconds = endOffsetSeconds;
    completionOffsets.set(entry.job.jobId, endOffsetSeconds);
  }
  const scheduledCopying = copyJobs.map((job) => {
    const assignment = assignments.get(job.jobId);
    return {
      ...job,
      depth: depths.get(job.jobId) ?? 1,
      assignments: assignment ? [assignment] : [],
      unscheduledCopies: assignment ? 0 : job.copies,
      ...(!assignment
        ? {
            noTimingReason:
              noTimingReasons.get(job.jobId) ?? "No eligible character Science slot is available.",
          }
        : {}),
    };
  });
  const scheduledInvention = inventionJobs.map((job) => {
    const assignment = assignments.get(job.jobId);
    return {
      ...job,
      depth: depths.get(job.jobId) ?? 1,
      assignments: assignment ? [assignment] : [],
      unscheduledAttempts: assignment ? 0 : job.attempts,
      ...(!assignment
        ? {
            noTimingReason:
              noTimingReasons.get(job.jobId) ?? "No eligible character Science slot is available.",
          }
        : {}),
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
  locationSystemIdsById: ReadonlyMap<number, number>,
  baselineTimeMultipliers: BaselineIndustryTimeMultipliers = { manufacturing: 1, reactions: 1 },
  jobSkillRequirements: readonly SimulationJobSkillRequirement[] = [],
  maxReactionJobDurationHours = 24,
  slots: readonly SimulationSlot[] = [],
): SimulationScheduleResult {
  const skillRequirementsByJob = groupSkillRequirementsByJob(jobSkillRequirements);
  const depths = scheduledJobDepths(
    [...manufacturingJobs, ...reactionJobs],
    inventionJobs,
    copyJobs,
  );
  const industry = scheduleIndustryActivities(
    manufacturingJobs,
    reactionJobs,
    characters,
    slots,
    locationSystemIdsById,
    baselineTimeMultipliers,
    skillRequirementsByJob,
    maxReactionJobDurationHours,
    depths,
  );
  const science = scheduleScienceJobs(
    inventionJobs,
    copyJobs,
    characters,
    slots,
    locationSystemIdsById,
    [...industry.manufacturingJobs, ...industry.reactionJobs],
    depths,
    skillRequirementsByJob,
  );
  return {
    manufacturingJobs: industry.manufacturingJobs,
    reactionJobs: industry.reactionJobs,
    inventionJobs: science.inventionJobs,
    copyJobs: science.copyJobs,
    warnings: [...industry.warnings, ...science.warnings],
  };
}
