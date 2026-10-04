import { getAvailableSlotCount } from "@/lib/client/slotUsage";
import type { ClientCharacterStatus, ClientJobsResponse } from "@/lib/client/requestCache";
import type { SimulationCharacterProfile, SimulationInFlightJob } from "./types";

type CharacterSkill = { skillId: number; activeSkillLevel: number };
type InFlightSlotCategory = "Manufacturing" | "Reactions" | "Science";

interface InFlightJobSlotGroup {
  characterId: number;
  slotCategory: InFlightSlotCategory;
  jobs: Array<Omit<SimulationInFlightJob, "slotIndex">>;
}

/** Skill IDs and time bonuses used by the current planner's industry estimates. */
export const simulationIndustrySkillIds = {
  industry: 3380,
  advancedIndustry: 3388,
  reactions: 45746,
} as const;

const simulationActivityByJobActivity = new Map<string, SimulationInFlightJob["activity"]>([
  ["manufacturing", "manufacturing"],
  ["reaction", "reaction"],
  ["reactions", "reaction"],
  ["time research", "time-research"],
  ["material research", "material-research"],
  ["copying", "copying"],
  ["invention", "invention"],
]);

/** Calculates character-specific activity timing factors from the cached skill snapshot. */
export function simulationTimeMultipliers(
  skills: readonly CharacterSkill[] | undefined,
): SimulationCharacterProfile["timeMultipliers"] {
  const levels = new Map((skills ?? []).map((skill) => [skill.skillId, skill.activeSkillLevel]));
  return {
    manufacturing: skillTimeMultiplier(
      levels,
      [
        { skillId: simulationIndustrySkillIds.industry, bonusPerLevel: 0.04 },
        { skillId: simulationIndustrySkillIds.advancedIndustry, bonusPerLevel: 0.03 },
      ],
    ),
    reactions: skillTimeMultiplier(
      levels,
      [{ skillId: simulationIndustrySkillIds.reactions, bonusPerLevel: 0.04 }],
    ),
    copying: 1,
    invention: 1,
  };
}

/** Maps a cached ESI activity label to its simulator scheduling activity. */
function simulationActivityForJob(activity: string): SimulationInFlightJob["activity"] | undefined {
  return simulationActivityByJobActivity.get(activity.trim().toLowerCase());
}

/** Returns the ESI slot category used by one simulator activity. */
function inFlightSlotCategory(activity: SimulationInFlightJob["activity"]): InFlightSlotCategory {
  if (activity === "manufacturing") return "Manufacturing";
  if (activity === "reaction") return "Reactions";
  return "Science";
}

/** Groups active supported jobs by character and activity slot pool. */
function inFlightJobsByCharacter(
  jobs: ClientJobsResponse["jobs"],
  slotUsage: ClientJobsResponse["slotUsage"],
  nowMilliseconds: number,
): ReadonlyMap<number, SimulationInFlightJob[]> {
  const seenJobIds = new Set<number>();
  const groupsByKey = new Map<string, InFlightJobSlotGroup>();
  for (const job of jobs ?? []) {
    const activity = simulationActivityForJob(job.activity);
    const startTime = Date.parse(job.startDate);
    const endTime = Date.parse(job.endDate);
    if (
      job.status.toLowerCase() !== "active"
      || !activity
      || seenJobIds.has(job.jobId)
      || !Number.isFinite(startTime)
      || !Number.isFinite(endTime)
      || startTime > nowMilliseconds
      || endTime <= nowMilliseconds
    ) continue;
    seenJobIds.add(job.jobId);
    const slotCategory = inFlightSlotCategory(activity);
    const groupKey = `${job.characterId}:${slotCategory}`;
    const group = groupsByKey.get(groupKey) ?? {
      characterId: job.characterId,
      slotCategory,
      jobs: [],
    };
    group.jobs.push({
      jobId: job.jobId,
      activity,
      remainingSeconds: Math.ceil((endTime - nowMilliseconds) / 1000),
    });
    groupsByKey.set(groupKey, group);
  }

  const jobsByCharacter = new Map<number, SimulationInFlightJob[]>();
  for (const group of groupsByKey.values()) {
    group.jobs.sort(
      (left, right) => left.remainingSeconds - right.remainingSeconds || left.jobId - right.jobId,
    );
    const firstSlotIndex = getAvailableSlotCount(
      slotUsage?.[String(group.characterId)],
      group.slotCategory,
    );
    const characterJobs = jobsByCharacter.get(group.characterId) ?? [];
    characterJobs.push(
      ...group.jobs.map((job, index) => ({ ...job, slotIndex: firstSlotIndex + index })),
    );
    jobsByCharacter.set(group.characterId, characterJobs);
  }
  for (const characterJobs of jobsByCharacter.values()) {
    characterJobs.sort(
      (left, right) => left.remainingSeconds - right.remainingSeconds || left.jobId - right.jobId,
    );
  }
  return jobsByCharacter;
}

/** Builds simulator profiles from cached skills, job end dates, and industry slot usage. */
export function createSimulationCharacterProfiles(
  characters: readonly ClientCharacterStatus[],
  clientJobs: ClientJobsResponse | null | undefined,
  nowMilliseconds = Date.now(),
): SimulationCharacterProfile[] {
  const activeJobsByCharacter = inFlightJobsByCharacter(
    clientJobs?.jobs,
    clientJobs?.slotUsage,
    nowMilliseconds,
  );
  return characters.flatMap((character) => {
    const systemId = character.location?.systemId;
    if (systemId === undefined) return [];
    const skills = character.skills?.body ?? [];
    const usage = clientJobs?.slotUsage?.[String(character.characterId)];
    return [
      {
        characterId: character.characterId,
        systemId,
        freeSlots: {
          manufacturing: getAvailableSlotCount(usage, "Manufacturing"),
          reactions: getAvailableSlotCount(usage, "Reactions"),
          science: getAvailableSlotCount(usage, "Science"),
        },
        inFlightJobs: activeJobsByCharacter.get(character.characterId) ?? [],
        timeMultipliers: simulationTimeMultipliers(skills),
        skillLevels: Object.fromEntries(
          skills.map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
        ),
      },
    ];
  });
}

/** Returns whether every active character has usable skills, jobs, and slot-capacity snapshots. */
export function hasUsableSimulationCharacterSnapshots(
  characters: readonly ClientCharacterStatus[],
  slotUsage: ClientJobsResponse["slotUsage"],
): boolean {
  return (
    characters.length > 0
    && characters.every((character) => {
      const skills = character.skills;
      const jobs = character.jobs;
      const location = character.location;
      const systemId = location?.systemId;
      return (
        skills !== undefined
        && skills.hasBody
        && Array.isArray(skills.body)
        && jobs !== undefined
        && jobs.hasBody
        && location?.hasBody === true
        && systemId !== undefined
        && Number.isSafeInteger(systemId)
        && systemId > 0
        && character.industrySlots !== undefined
        && slotUsage?.[String(character.characterId)] !== undefined
      );
    })
  );
}

/** Applies independent skill time bonuses without allowing negative durations. */
function skillTimeMultiplier(
  levels: ReadonlyMap<number, number>,
  bonuses: readonly { skillId: number; bonusPerLevel: number }[],
): number {
  return bonuses.reduce(
    (multiplier, bonus) =>
      multiplier * (1 - (levels.get(bonus.skillId) ?? 0) * bonus.bonusPerLevel),
    1,
  );
}
