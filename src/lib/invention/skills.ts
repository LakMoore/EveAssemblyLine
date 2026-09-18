/** Identifies whether an invention activity skill contributes to its success chance. */
export type InventionSkillRole = "science" | "encryption";

/** A known invention success skill and its contribution category. */
export type InventionSkill = {
  name: string;
  role: InventionSkillRole;
};

/**
 * All chance-affecting skills found in SDE invention activity requirements.
 *
 * Basic prerequisites such as Science, Outpost Construction, and Capital Ship Construction are
 * intentionally excluded: they are required to start some jobs but do not affect success chance.
 */
export const inventionSkillsByTypeId: ReadonlyMap<number, InventionSkill> = new Map([
  [3408, { name: "Sleeper Encryption Methods", role: "encryption" }],
  [11433, { name: "High Energy Physics", role: "science" }],
  [11441, { name: "Plasma Physics", role: "science" }],
  [11442, { name: "Nanite Engineering", role: "science" }],
  [11443, { name: "Hydromagnetic Physics", role: "science" }],
  [11444, { name: "Amarr Starship Engineering", role: "science" }],
  [11445, { name: "Minmatar Starship Engineering", role: "science" }],
  [11446, { name: "Graviton Physics", role: "science" }],
  [11447, { name: "Laser Physics", role: "science" }],
  [11448, { name: "Electromagnetic Physics", role: "science" }],
  [11449, { name: "Rocket Science", role: "science" }],
  [11450, { name: "Gallente Starship Engineering", role: "science" }],
  [11451, { name: "Nuclear Physics", role: "science" }],
  [11452, { name: "Mechanical Engineering", role: "science" }],
  [11453, { name: "Electronic Engineering", role: "science" }],
  [11454, { name: "Caldari Starship Engineering", role: "science" }],
  [11455, { name: "Quantum Physics", role: "science" }],
  [11529, { name: "Molecular Engineering", role: "science" }],
  [21790, { name: "Caldari Encryption Methods", role: "encryption" }],
  [21791, { name: "Minmatar Encryption Methods", role: "encryption" }],
  [23087, { name: "Amarr Encryption Methods", role: "encryption" }],
  [23121, { name: "Gallente Encryption Methods", role: "encryption" }],
  [30324, { name: "Defensive Subsystem Technology", role: "science" }],
  [30325, { name: "Core Subsystem Technology", role: "science" }],
  [30326, { name: "Engineering Subsystem Technology", role: "science" }],
  [30327, { name: "Offensive Subsystem Technology", role: "science" }],
  [30788, { name: "Propulsion Subsystem Technology", role: "science" }],
  [52307, { name: "Triglavian Quantum Engineering", role: "science" }],
  [52308, { name: "Triglavian Encryption Methods", role: "encryption" }],
  [55025, { name: "Upwell Encryption Methods", role: "encryption" }],
  [81050, { name: "Upwell Starship Engineering", role: "science" }],
]);

/** Builds an invention profile with each chance-affecting skill set to one level. */
export function inventionSkillLevels(level: number): Record<string, number> {
  return Object.fromEntries([...inventionSkillsByTypeId.keys()].map((typeId) => [typeId, level]));
}
