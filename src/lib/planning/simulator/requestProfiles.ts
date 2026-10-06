import type { ClientCharacterStatus, ClientJobsResponse } from "@/lib/client/requestCache";
import type { SimulationCharacterProfile, SimulationSlot, SimulationSlotActivity } from "./types";

type CharacterSkill = { skillId: number; activeSkillLevel: number };
type InFlightSlotCategory = "Manufacturing" | "Reactions" | "Science";

/** Skill IDs and time bonuses used by the current planner's industry estimates. */
export const simulationIndustrySkillIds = {
  industry: 3380,
  advancedIndustry: 3388,
  reactions: 45746,
} as const;

const slotActivityByJobActivity = new Map<string, SimulationSlotActivity>([
  ["manufacturing", "manufacturing"],
  ["reaction", "reaction"],
  ["reactions", "reaction"],
  ["time research", "science"],
  ["material research", "science"],
  ["copying", "science"],
  ["invention", "science"],
]);

const slotCategoryByActivity: Record<SimulationSlotActivity, InFlightSlotCategory> = {
  manufacturing: "Manufacturing",
  reaction: "Reactions",
  science: "Science",
};

const slotCodeByActivity: Record<SimulationSlotActivity, string> = {
  manufacturing: "M",
  reaction: "R",
  science: "S",
};

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

/** Builds simulator character profiles from cached skills and locations. */
export function createSimulationCharacterProfiles(
  characters: readonly ClientCharacterStatus[],
): SimulationCharacterProfile[] {
  return characters.flatMap((character) => {
    const systemId = character.location?.systemId;
    if (systemId === undefined) return [];
    const skills = character.skills?.body ?? [];
    return [
      {
        characterId: character.characterId,
        systemId,
        timeMultipliers: simulationTimeMultipliers(skills),
        skillLevels: Object.fromEntries(
          skills.map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
        ),
      },
    ];
  });
}

/** Creates a keyed slot map anchored to the cached jobs snapshot when its timestamp is available. */
export function createSimulationSlotMap(
  characters: readonly ClientCharacterStatus[],
  clientJobs: ClientJobsResponse | null | undefined,
  nowMilliseconds?: number,
): SimulationSlot[] {
  const snapshotTime = clientJobs?.lastUpdated ? Date.parse(clientJobs.lastUpdated) : Number.NaN;
  const referenceTime =
    nowMilliseconds ?? (Number.isFinite(snapshotTime) ? snapshotTime : Date.now());
  const seenJobIds = new Set<number>();
  const jobsByCharacterAndActivity = new Map<string, NonNullable<ClientJobsResponse["jobs"]>>();
  for (const job of clientJobs?.jobs ?? []) {
    const activity = slotActivityByJobActivity.get(job.activity.trim().toLowerCase());
    const startTime = Date.parse(job.startDate);
    const endTime = Date.parse(job.endDate);
    if (
      job.status.toLowerCase() !== "active"
      || activity === undefined
      || seenJobIds.has(job.jobId)
      || !Number.isFinite(startTime)
      || !Number.isFinite(endTime)
      || startTime > referenceTime
    ) continue;
    seenJobIds.add(job.jobId);
    const groupKey = `${job.characterId}:${activity}`;
    const group = jobsByCharacterAndActivity.get(groupKey) ?? [];
    group.push(job);
    jobsByCharacterAndActivity.set(groupKey, group);
  }

  return characters
    .flatMap((character) => {
      const systemId = character.location?.systemId;
      if (systemId === undefined) return [];
      return (Object.keys(slotCategoryByActivity) as SimulationSlotActivity[]).flatMap(
        (activity) => {
          const category = slotCategoryByActivity[activity];
          const availableSlots = character.industrySlots?.[category] ?? 0;
          const activeJobs = (
            jobsByCharacterAndActivity.get(`${character.characterId}:${activity}`) ?? []
          )
            .slice()
            .sort(
              (left, right) =>
                Date.parse(left.endDate) - Date.parse(right.endDate) || left.jobId - right.jobId,
            );
          const totalSlots = Math.max(availableSlots, activeJobs.length);
          const firstOccupiedSlot = totalSlots - activeJobs.length;
          return Array.from(
            { length: totalSlots },
            (_, slotIndex) => {
              const activeJobIndex = slotIndex - firstOccupiedSlot;
              const installedJob = activeJobIndex < 0 ? undefined : activeJobs.at(activeJobIndex);
              const remainingSeconds = installedJob
                ? Math.max(0, Math.ceil((Date.parse(installedJob.endDate) - referenceTime) / 1000))
                : 0;
              return {
                slotKey: `${character.characterId}:${slotCodeByActivity[activity]}:${slotIndex}`,
                activity,
                characterId: character.characterId,
                systemId,
                slotIndex,
                availableAtSeconds: remainingSeconds,
                ...(installedJob ? { installedJobId: installedJob.jobId } : {}),
              };
            },
          );
        },
      );
    })
    .sort((left, right) => left.slotKey.localeCompare(right.slotKey));
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
