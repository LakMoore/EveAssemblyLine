import type { GroupsRecord, TypeDogmaRecord, TypesRecord } from "@/lib/sde/generated";

export type ReprocessingStructure = "NPC" | "Athanor" | "Tatara";
export type ReprocessingSkillLevels = Record<string, number>;
export type ReprocessingEfficiency = {
  normalOre: number;
  moonOre: number;
  ice: number;
  gas: number;
  scrapMetal: number;
};

export type ReprocessingSkill = { id?: number; name: string };

type SdeMaps = {
  types: Map<number, TypesRecord>;
  groups: Map<number, GroupsRecord>;
  typeDogma: Map<number, TypeDogmaRecord>;
  dogmaAttributes: Map<number, { _key: number; name: string; defaultValue: number }>;
};

function attributeId(maps: SdeMaps, name: string) {
  return [...maps.dogmaAttributes.values()].find((attribute) => attribute.name === name)?._key;
}

function dogmaValue(record: TypeDogmaRecord | undefined, id: number | undefined) {
  return id === undefined ? undefined : record?.dogmaAttributes.find((attribute) => attribute.attributeID === id)?.value;
}

function skillMutator(maps: SdeMaps, skillId: number | undefined, skillLevels: ReprocessingSkillLevels) {
  if (skillId === undefined) return 0;
  const skill = maps.typeDogma.get(skillId);
  const mutatorId = attributeId(maps, "refiningYieldMutator");
  const mutator = dogmaValue(skill, mutatorId) ?? 0;
  return mutator * (skillLevels[String(skillId)] ?? 0);
}

function skillMultiplier(maps: SdeMaps, skillIds: number[], skillLevels: ReprocessingSkillLevels) {
  return skillIds.reduce((multiplier, skillId) => multiplier * (1 + skillMutator(maps, skillId, skillLevels) / 100), 1);
}

function namedTypeId(maps: SdeMaps, name: string) {
  return [...maps.types.values()].find((type) => type.name.en === name)?._key;
}

function structureBonus(maps: SdeMaps, structure: ReprocessingStructure) {
  if (structure === "NPC") return 0;
  const structureTypeId = namedTypeId(maps, structure);
  const typeDogma = structureTypeId === undefined ? undefined : maps.typeDogma.get(structureTypeId);
  return dogmaValue(typeDogma, attributeId(maps, "strRefiningYieldBonus")) ?? 0;
}

function securityMultiplier(structure: ReprocessingStructure, securityStatus?: number) {
  if (structure === "NPC" || securityStatus === undefined) return 1;
  const securityBonus = securityStatus >= 0.5 ? 0 : securityStatus > 0 ? 0.06 : 0.12;
  return 1 + securityBonus;
}

export function calculateReprocessingEfficiency(
  maps: SdeMaps,
  structure: ReprocessingStructure,
  skillLevels: ReprocessingSkillLevels,
  implantLevel: number,
  securityStatus?: number,
): ReprocessingEfficiency {
  const normalBase = maps.dogmaAttributes.get(attributeId(maps, "refiningYieldNormalOres") ?? -1)?.defaultValue ?? 0;
  const moonBase = maps.dogmaAttributes.get(attributeId(maps, "refiningYieldMoonOres") ?? -1)?.defaultValue ?? normalBase;
  const iceBase = maps.dogmaAttributes.get(attributeId(maps, "refiningYieldIce") ?? -1)?.defaultValue ?? normalBase;
  const gasBase = maps.dogmaAttributes.get(attributeId(maps, "gasDecompressionBaseEfficiency") ?? -1)?.defaultValue ?? 0;
  const reprocessingId = namedTypeId(maps, "Reprocessing");
  const reprocessingEfficiencyId = namedTypeId(maps, "Reprocessing Efficiency");
  const implantMutatorId = attributeId(maps, "refiningYieldMutator");
  const implantnessId = attributeId(maps, "implantness");
  const implant = [...maps.types.keys()]
    .filter((typeId) => dogmaValue(maps.typeDogma.get(typeId), implantnessId) === 8)
    .map((typeId) => maps.typeDogma.get(typeId))
    .map((record) => dogmaValue(record, implantMutatorId))
    .find((value) => value === implantLevel) ?? 0;
  const multiplier = securityMultiplier(structure, securityStatus) * skillMultiplier(maps, [reprocessingId, reprocessingEfficiencyId].filter((skillId): skillId is number => skillId !== undefined), skillLevels) * (1 + implant / 100);
  const structureBonusPercent = structureBonus(maps, structure);
  const normalOre = (normalBase * 100 + structureBonusPercent) * multiplier;
  const moonOre = (moonBase * 100 + structureBonusPercent) * multiplier;
  const ice = (iceBase * 100 + structureBonusPercent) * multiplier;
  const structureTypeId = namedTypeId(maps, structure);
  const gasStructureBonus = structure === "NPC" || structureTypeId === undefined
    ? 0
    : dogmaValue(maps.typeDogma.get(structureTypeId), attributeId(maps, "structureGasDecompressionEfficiencyBonus")) ?? 0;
  const gas = (gasBase + gasStructureBonus) * 100;
  const scrapSkillId = namedTypeId(maps, "Scrapmetal Processing");
  const scrapMetal = normalBase * 100 * skillMultiplier(maps, [scrapSkillId].filter((skillId): skillId is number => skillId !== undefined), skillLevels);
  return { normalOre, moonOre, ice, gas, scrapMetal };
}

export function efficiencyForType(
  maps: SdeMaps,
  typeId: number,
  calculated: ReprocessingEfficiency,
  skillLevels: ReprocessingSkillLevels,
) {
  const type = maps.types.get(typeId);
  const group = type ? maps.groups.get(type.groupID) : undefined;
  const typeDogma = maps.typeDogma.get(typeId);
  const requiredSkillId = dogmaValue(typeDogma, attributeId(maps, "reprocessingSkillType"));
  if (group?.categoryID === 2 || group?.name.en.toLowerCase().includes("gas")) return calculated.gas;
  if (requiredSkillId === namedTypeId(maps, "Scrapmetal Processing")) return calculated.scrapMetal;
  if (requiredSkillId !== undefined) {
    const requiredSkillName = maps.types.get(requiredSkillId)?.name.en.toLowerCase() ?? "";
    const skillBonus = skillMutator(maps, requiredSkillId, skillLevels);
    if (requiredSkillName.includes("ice")) return calculated.ice * (1 + skillBonus / 100);
    if (requiredSkillName.includes("moon")) return calculated.moonOre * (1 + skillBonus / 100);
    return calculated.normalOre * (1 + skillBonus / 100);
  }
  return calculated.normalOre;
}

export function reprocessingSkillForType(maps: SdeMaps, typeId: number): ReprocessingSkill | undefined {
  const typeDogma = maps.typeDogma.get(typeId);
  const requiredSkillId = dogmaValue(typeDogma, attributeId(maps, "reprocessingSkillType"));
  if (requiredSkillId === undefined) return undefined;
  return { id: requiredSkillId, name: maps.types.get(requiredSkillId)?.name.en ?? `Skill ${requiredSkillId}` };
}
