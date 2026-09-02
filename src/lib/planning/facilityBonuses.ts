import type {
  DogmaEffectsRecord,
  IndustryModifierSourcesRecord,
  TypeDogmaRecord,
} from "@/lib/sde/generated";
import type { ProductionGroupReference } from "./productionGroups";

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

export type FacilityGroupBonus = {
  manufacturingMaterialMultiplier: number;
  manufacturingMaterialPercentage: number;
  manufacturingTimeMultiplier: number;
  manufacturingTimePercentage: number;
  reactionMaterialMultiplier: number;
  reactionMaterialPercentage: number;
  reactionTimeMultiplier: number;
  reactionTimePercentage: number;
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
const reactionStructureTimeMultiplierAttribute = 2721;
const securityModifierAttributes = { high: 2355, low: 2356, null: 2357 } as const;

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

function securityClass(securityStatus: number | undefined) {
  if (securityStatus === undefined || securityStatus >= 0.5) return "high";
  return securityStatus > 0 ? "low" : "null";
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

function modifierValue(
  rig: TypeDogmaRecord | undefined,
  effects: Map<number, DogmaEffectsRecord>,
  modifiedAttributeId: number,
  modifyingAttributeId: number,
) {
  const rigAttributes = attributesFor(rig);
  const modifier = effectModifiers(rig, effects, modifyingAttributeId).find(
    (entry) => entry.modifiedAttributeID === modifiedAttributeId,
  );
  return modifier?.modifyingAttributeID === undefined
    ? undefined
    : rigAttributes.get(modifier.modifyingAttributeID);
}

function sourceEntries(
  source: IndustryModifierSourcesRecord | undefined,
  activity: "manufacturing" | "reaction",
  kind: "material" | "time",
) {
  if (activity === "manufacturing") return source?.manufacturing?.[kind] ?? [];
  return source?.reaction?.[kind] ?? [];
}

function groupRigModifier(
  rig: TypeDogmaRecord | undefined,
  effects: Map<number, DogmaEffectsRecord>,
  source: IndustryModifierSourcesRecord | undefined,
  activity: "manufacturing" | "reaction",
  kind: "material" | "time",
  targetFilterIds: readonly number[],
  securityStatus: number | undefined,
) {
  const modifyingAttributeId =
    activity === "manufacturing"
      ? kind === "material"
        ? rigMaterialAttribute
        : rigTimeAttribute
      : kind === "material"
        ? reactionRigMaterialAttribute
        : reactionRigTimeAttribute;
  const securityMultiplier =
    attributesFor(rig).get(securityModifierAttributes[securityClass(securityStatus)]) ?? 1;
  const values = sourceEntries(source, activity, kind)
    .filter((entry) => entry.filterID !== undefined && targetFilterIds.includes(entry.filterID))
    .flatMap((entry) => {
      const value = modifierValue(rig, effects, entry.dogmaAttributeID, modifyingAttributeId);
      return value === undefined ? [] : [value * securityMultiplier];
    });
  return values.length === 0 ? undefined : Math.min(...values);
}

function applyModifier(value: number, modifier: number | undefined) {
  return modifier === undefined ? value : addPercentageModifier(value, modifier);
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
  securityStatus?: number,
): FacilityBonusResult {
  const structureAttributes = attributesFor(structure);
  let material = multiplier(structureAttributes.get(structureMaterialAttribute));
  let time = multiplier(structureAttributes.get(structureTimeAttribute));
  let cost = multiplier(structureAttributes.get(structureCostAttribute));
  let reactionMaterial = 1;
  let reactionTime = 1;
  let reactionCost = 1;
  let reprocessingYield = 0;
  let bestManufacturingMaterialModifier: number | undefined;

  reactionTime = multiplier(structureAttributes.get(reactionStructureTimeMultiplierAttribute));

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
      const securityMultiplier =
        attributesFor(rig).get(securityModifierAttributes[securityClass(securityStatus)]) ?? 1;
      const effectiveMaterialModifier = materialModifier * securityMultiplier;
      if (
        bestManufacturingMaterialModifier === undefined
        || effectiveMaterialModifier < bestManufacturingMaterialModifier
      ) {
        bestManufacturingMaterialModifier = effectiveMaterialModifier;
      }
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

  if (bestManufacturingMaterialModifier !== undefined) {
    material = addPercentageModifier(material, bestManufacturingMaterialModifier);
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

/** Calculates the facility material and time multipliers for every production group. */
export function calculateFacilityGroupBonuses(
  structure: TypeDogmaRecord | undefined,
  rigTypeIds: readonly number[],
  typeDogma: Map<number, TypeDogmaRecord>,
  dogmaEffects: Map<number, DogmaEffectsRecord>,
  modifierSources: Map<number, IndustryModifierSourcesRecord>,
  productionGroups: readonly ProductionGroupReference[],
  securityStatus?: number,
): Record<string, FacilityGroupBonus> {
  const structureAttributes = attributesFor(structure);
  const structureTime = multiplier(structureAttributes.get(structureTimeAttribute));
  const reactionTime = multiplier(
    structureAttributes.get(reactionStructureTimeMultiplierAttribute),
  );
  const rigs = rigTypeIds
    .filter((rigTypeId) => rigTypeId > 0)
    .map((rigTypeId) => ({
      dogma: typeDogma.get(rigTypeId),
      source: modifierSources.get(rigTypeId),
    }));
  return Object.fromEntries(
    productionGroups.map((group) => {
      const modifierTargetFilterIds = group.modifierTargetFilterIds ?? [group.targetFilterId];
      const manufacturingMaterialModifier = Math.min(
        ...rigs.flatMap(({ dogma, source }) => {
          const value = groupRigModifier(
            dogma,
            dogmaEffects,
            source,
            "manufacturing",
            "material",
            modifierTargetFilterIds,
            securityStatus,
          );
          return value === undefined ? [] : [value];
        }),
        0,
      );
      const manufacturingTimeModifiers = rigs.flatMap(({ dogma, source }) => {
        const value = groupRigModifier(
          dogma,
          dogmaEffects,
          source,
          "manufacturing",
          "time",
          modifierTargetFilterIds,
          securityStatus,
        );
        return value === undefined ? [] : [value];
      });
      const reactionMaterialModifier = Math.min(
        ...rigs.flatMap(({ dogma, source }) => {
          const value = groupRigModifier(
            dogma,
            dogmaEffects,
            source,
            "reaction",
            "material",
            modifierTargetFilterIds,
            securityStatus,
          );
          return value === undefined ? [] : [value];
        }),
        0,
      );
      const reactionTimeModifiers = rigs.flatMap(({ dogma, source }) => {
        const value = groupRigModifier(
          dogma,
          dogmaEffects,
          source,
          "reaction",
          "time",
          modifierTargetFilterIds,
          securityStatus,
        );
        return value === undefined ? [] : [value];
      });
      const manufacturingMaterialMultiplier = applyModifier(1, manufacturingMaterialModifier);
      const manufacturingTimeMultiplier = manufacturingTimeModifiers.reduce(
        applyModifier,
        structureTime,
      );
      const reactionMaterialMultiplier = applyModifier(1, reactionMaterialModifier);
      const reactionTimeMultiplier = reactionTimeModifiers.reduce(applyModifier, reactionTime);
      return [
        group.key,
        {
          manufacturingMaterialMultiplier,
          manufacturingMaterialPercentage: percentageFromMultiplier(
            manufacturingMaterialMultiplier,
          ),
          manufacturingTimeMultiplier,
          manufacturingTimePercentage: percentageFromMultiplier(manufacturingTimeMultiplier),
          reactionMaterialMultiplier,
          reactionMaterialPercentage: percentageFromMultiplier(reactionMaterialMultiplier),
          reactionTimeMultiplier,
          reactionTimePercentage: percentageFromMultiplier(reactionTimeMultiplier),
        },
      ];
    }),
  );
}
