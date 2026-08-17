import type { DogmaEffectsRecord, TypeDogmaRecord } from "@/lib/sde/generated";

export type FacilityBonusValue = {
  rawMultiplier: number;
  percentage: number;
};

export type FacilityBonusResult = {
  manufacturing: {
    material: FacilityBonusValue;
    time: FacilityBonusValue;
    cost: FacilityBonusValue;
  };
  reactions: {
    material: FacilityBonusValue;
    time: FacilityBonusValue;
    cost: FacilityBonusValue;
  };
  reprocessingYield: number;
};

const structureMaterialAttribute = 2600;
const structureTimeAttribute = 2601;
const structureCostAttribute = 2602;
const rigMaterialAttribute = 2594;
const rigTimeAttribute = 2593;
const rigCostAttribute = 2595;
const reactionRigMaterialAttribute = 2714;
const reactionRigTimeAttribute = 2713;
const rigReprocessingAttribute = 379;

function attributesFor(record: TypeDogmaRecord | undefined) {
  return new Map(
    (record?.dogmaAttributes ?? []).map((attribute) => [attribute.attributeID, attribute.value]),
  );
}

function percentageFromMultiplier(multiplier: number) {
  return (1 - multiplier) * -100;
}

function multiplier(value: number | undefined) {
  return value === undefined ? 1 : value;
}

function addPercentageModifier(multiplierValue: number, modifier: number) {
  return multiplierValue * (1 + modifier / 100);
}

function effectModifiers(
  rig: TypeDogmaRecord | undefined,
  effects: Map<number, DogmaEffectsRecord>,
  modifyingAttributeId: number,
) {
  return (rig?.dogmaEffects ?? []).flatMap(({ effectID }) =>
    (effects.get(effectID)?.modifierInfo ?? []).filter(
      (modifier) => modifier.modifyingAttributeID === modifyingAttributeId,
    ),
  );
}

function hasTarget(
  rig: TypeDogmaRecord | undefined,
  effects: Map<number, DogmaEffectsRecord>,
  modifyingAttributeId: number,
  minimumTarget: number,
  maximumTarget: number,
) {
  return effectModifiers(rig, effects, modifyingAttributeId).some(
    (modifier) =>
      modifier.modifiedAttributeID !== undefined
      && modifier.modifiedAttributeID >= minimumTarget
      && modifier.modifiedAttributeID <= maximumTarget,
  );
}

/** Calculates the industry modifiers supplied by a structure and its fitted rigs. */
export function calculateFacilityBonuses(
  structure: TypeDogmaRecord | undefined,
  rigTypeIds: readonly number[],
  typeDogma: Map<number, TypeDogmaRecord>,
  dogmaEffects: Map<number, DogmaEffectsRecord>,
): FacilityBonusResult {
  const structureAttributes = attributesFor(structure);
  let material = multiplier(structureAttributes.get(structureMaterialAttribute));
  let time = multiplier(structureAttributes.get(structureTimeAttribute));
  let cost = multiplier(structureAttributes.get(structureCostAttribute));
  let reactionMaterial = 1;
  let reactionTime = 1;
  let reactionCost = 1;
  let reprocessingYield = 0;

  for (const rigTypeId of rigTypeIds) {
    if (rigTypeId <= 0) continue;
    const rig = typeDogma.get(rigTypeId);
    const rigAttributes = attributesFor(rig);
    const materialModifier = rigAttributes.get(rigMaterialAttribute);
    const timeModifier = rigAttributes.get(rigTimeAttribute);
    const costModifier = rigAttributes.get(rigCostAttribute);
    if (
      materialModifier !== undefined
      && hasTarget(rig, dogmaEffects, rigMaterialAttribute, 2538, 2570)
    ) {
      material = addPercentageModifier(material, materialModifier);
    }
    if (timeModifier !== undefined && hasTarget(rig, dogmaEffects, rigTimeAttribute, 2538, 2570)) {
      time = addPercentageModifier(time, timeModifier);
    }
    if (costModifier !== undefined && hasTarget(rig, dogmaEffects, rigCostAttribute, 2538, 2570)) {
      cost = addPercentageModifier(cost, costModifier);
    }
    const reactionMaterialModifier = rigAttributes.get(reactionRigMaterialAttribute);
    const reactionTimeModifier = rigAttributes.get(reactionRigTimeAttribute);
    if (
      reactionMaterialModifier !== undefined
      && hasTarget(rig, dogmaEffects, reactionRigMaterialAttribute, 2715, 2720)
    ) {
      reactionMaterial = addPercentageModifier(reactionMaterial, reactionMaterialModifier);
    }
    if (
      reactionTimeModifier !== undefined
      && hasTarget(rig, dogmaEffects, reactionRigTimeAttribute, 2715, 2720)
    ) {
      reactionTime = addPercentageModifier(reactionTime, reactionTimeModifier);
    }
    reprocessingYield += rigAttributes.get(rigReprocessingAttribute) ?? 0;
  }

  return {
    manufacturing: {
      material: { rawMultiplier: material, percentage: percentageFromMultiplier(material) },
      time: { rawMultiplier: time, percentage: percentageFromMultiplier(time) },
      cost: { rawMultiplier: cost, percentage: percentageFromMultiplier(cost) },
    },
    reactions: {
      material: {
        rawMultiplier: reactionMaterial,
        percentage: percentageFromMultiplier(reactionMaterial),
      },
      time: { rawMultiplier: reactionTime, percentage: percentageFromMultiplier(reactionTime) },
      cost: { rawMultiplier: reactionCost, percentage: percentageFromMultiplier(reactionCost) },
    },
    reprocessingYield,
  };
}
