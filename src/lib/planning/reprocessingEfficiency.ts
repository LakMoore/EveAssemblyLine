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

const refiningYieldMutatorAttribute = 379;
const refiningYieldMultiplierAttribute = 717;
const securityModifierAttributes = { high: 2355, low: 2356, null: 2357 } as const;

function reprocessingRigTypeId(maps: SdeMaps, structure: ReprocessingStructure, rig: number) {
  if (structure === "NPC" || rig === 0) return undefined;
  const size = "L";
  return namedTypeId(maps, `Standup ${size}-Set Reprocessing Monitor ${rig === 2 ? "II" : "I"}`);
}

export function reprocessingRigModifier(
  maps: SdeMaps,
  structure: ReprocessingStructure,
  rig: number,
) {
  const rigDogma = reprocessingRigTypeId(maps, structure, rig);
  const record = rigDogma === undefined ? undefined : maps.typeDogma.get(rigDogma);
  return (
    dogmaValue(record, refiningYieldMutatorAttribute)
    ?? (dogmaValue(record, refiningYieldMultiplierAttribute) ?? 0.5) * 100 - 50
  );
}

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
  return id === undefined
    ? undefined
    : record?.dogmaAttributes.find((attribute) => attribute.attributeID === id)?.value;
}

function skillMutator(
  maps: SdeMaps,
  skillId: number | undefined,
  skillLevels: ReprocessingSkillLevels,
) {
  if (skillId === undefined) return 0;
  const skill = maps.typeDogma.get(skillId);
  const mutatorId = attributeId(maps, "refiningYieldMutator");
  const mutator = dogmaValue(skill, mutatorId) ?? 0;
  return mutator * (skillLevels[String(skillId)] ?? 0);
}

function skillBonus(
  maps: SdeMaps,
  skillId: number | undefined,
  attributeName: string,
  skillLevels: ReprocessingSkillLevels,
) {
  if (skillId === undefined) return 0;
  const bonus = dogmaValue(maps.typeDogma.get(skillId), attributeId(maps, attributeName)) ?? 0;
  return bonus * (skillLevels[String(skillId)] ?? 0);
}

function skillMultiplier(maps: SdeMaps, skillIds: number[], skillLevels: ReprocessingSkillLevels) {
  return skillIds.reduce(
    (multiplier, skillId) => multiplier * (1 + skillMutator(maps, skillId, skillLevels) / 100),
    1,
  );
}

function namedTypeId(maps: SdeMaps, name: string) {
  return [...maps.types.values()].find((type) => type.name.en === name)?._key;
}

function structureMultiplier(maps: SdeMaps, structure: ReprocessingStructure) {
  if (structure === "NPC") return 1;
  const structureTypeId = namedTypeId(maps, structure);
  const record = structureTypeId === undefined ? undefined : maps.typeDogma.get(structureTypeId);
  return 1 + (dogmaValue(record, attributeId(maps, "strRefiningYieldBonus")) ?? 0) / 100;
}

function securityMultiplier(
  maps: SdeMaps,
  structure: ReprocessingStructure,
  securityStatus: number | undefined,
  rig: number,
) {
  if (structure === "NPC" || securityStatus === undefined || rig === 0) return 1;
  const rigDogma = reprocessingRigTypeId(maps, structure, rig);
  const record = rigDogma === undefined ? undefined : maps.typeDogma.get(rigDogma);
  const securityClass = securityStatus >= 0.5 ? "high" : securityStatus > 0 ? "low" : "null";
  return dogmaValue(record, securityModifierAttributes[securityClass]) ?? 1;
}

export function calculateReprocessingEfficiency(
  maps: SdeMaps,
  structure: ReprocessingStructure,
  skillLevels: ReprocessingSkillLevels,
  implantLevel: number,
  securityStatus?: number,
  reprocessingRig = 0,
): ReprocessingEfficiency {
  const rigModifier = reprocessingRigModifier(maps, structure, reprocessingRig);
  const normalBase =
    maps.dogmaAttributes.get(attributeId(maps, "refiningYieldNormalOres") ?? -1)?.defaultValue ?? 0;
  const moonBase =
    maps.dogmaAttributes.get(attributeId(maps, "refiningYieldMoonOres") ?? -1)?.defaultValue
    ?? normalBase;
  const iceBase =
    maps.dogmaAttributes.get(attributeId(maps, "refiningYieldIce") ?? -1)?.defaultValue
    ?? normalBase;
  const gasBase =
    maps.dogmaAttributes.get(attributeId(maps, "gasDecompressionBaseEfficiency") ?? -1)
      ?.defaultValue ?? 0;
  const reprocessingId = namedTypeId(maps, "Reprocessing");
  const reprocessingEfficiencyId = namedTypeId(maps, "Reprocessing Efficiency");
  const implantMutatorId = attributeId(maps, "refiningYieldMutator");
  const implantnessId = attributeId(maps, "implantness");
  const implant =
    [...maps.types.keys()]
      .filter((typeId) => dogmaValue(maps.typeDogma.get(typeId), implantnessId) === 8)
      .map((typeId) => maps.typeDogma.get(typeId))
      .map((record) => dogmaValue(record, implantMutatorId))
      .find((value) => value === implantLevel) ?? 0;
  const multiplier =
    securityMultiplier(maps, structure, securityStatus, reprocessingRig)
    * structureMultiplier(maps, structure)
    * skillMultiplier(
      maps,
      [reprocessingId, reprocessingEfficiencyId].filter(
        (skillId): skillId is number => skillId !== undefined,
      ),
      skillLevels,
    )
    * (1 + implant / 100);
  const normalOre = (normalBase * 100 + rigModifier) * multiplier;
  const moonOre = (moonBase * 100 + rigModifier) * multiplier;
  const ice = (iceBase * 100 + rigModifier) * multiplier;
  const structureTypeId = namedTypeId(maps, structure);
  const gasStructureBonus =
    structure === "NPC" || structureTypeId === undefined
      ? 0
      : (
          dogmaValue(
            maps.typeDogma.get(structureTypeId),
            attributeId(maps, "structureGasDecompressionEfficiencyBonus"),
          ) ?? 0
        );
  const gasSkillId = namedTypeId(maps, "Gas Decompression Efficiency");
  const gasSkillBonus = skillBonus(
    maps,
    gasSkillId,
    "GasDecompressionEfficiencyBonus",
    skillLevels,
  );
  const gas = (gasBase + gasStructureBonus) * 100 + gasSkillBonus;
  const scrapSkillId = namedTypeId(maps, "Scrapmetal Processing");
  const scrapMetal =
    normalBase * 100 + (scrapSkillId === undefined ? 0 : (skillLevels[String(scrapSkillId)] ?? 0));
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
  if (group?.categoryID === 2 || group?.name.en.toLowerCase().includes("gas")) {
    return calculated.gas;
  }
  const typeName = type?.name.en;
  if (typeName === "Metal Scraps" || typeName === "Reinforced Metal Scraps") {
    return calculated.scrapMetal;
  }
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

export function reprocessingSkillForType(
  maps: SdeMaps,
  typeId: number,
): ReprocessingSkill | undefined {
  const typeDogma = maps.typeDogma.get(typeId);
  const requiredSkillId = dogmaValue(typeDogma, attributeId(maps, "reprocessingSkillType"));
  if (requiredSkillId === undefined) {
    const typeName = maps.types.get(typeId)?.name.en;
    if (typeName === "Metal Scraps" || typeName === "Reinforced Metal Scraps") {
      const scrapSkillId = namedTypeId(maps, "Scrapmetal Processing");
      return scrapSkillId === undefined
        ? undefined
        : { id: scrapSkillId, name: "Scrapmetal Processing" };
    }
    const group = maps.groups.get(maps.types.get(typeId)?.groupID ?? -1);
    if (group?.name.en.toLowerCase() === "compressed gas") {
      const gasSkillId = namedTypeId(maps, "Gas Decompression Efficiency");
      return gasSkillId === undefined
        ? undefined
        : { id: gasSkillId, name: "Gas Decompression Efficiency" };
    }
    return undefined;
  }
  return {
    id: requiredSkillId,
    name: maps.types.get(requiredSkillId)?.name.en ?? `Skill ${requiredSkillId}`,
  };
}
