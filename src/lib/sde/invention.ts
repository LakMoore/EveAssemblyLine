import type { BlueprintsRecord, TypeDogmaRecord } from "./generated";

const inventionProbabilityMultiplierAttributeId = 1112;
const inventionMaterialEfficiencyModifierAttributeId = 1113;
const inventionTimeEfficiencyModifierAttributeId = 1114;
const inventionMaxRunModifierAttributeId = 1124;

/** The base outcome for inventing a particular BPC without a decryptor. */
export type InventionOutput = {
  productTypeId: number;
  probability: number;
  runs: number;
  materialEfficiency: number;
  timeEfficiency: number;
};

/** The modifiers supplied by a decryptor's dogma attributes. */
export type InventionDecryptorModifiers = {
  typeId: number;
  probabilityMultiplier: number;
  materialEfficiencyModifier: number;
  timeEfficiencyModifier: number;
  maxRunModifier: number;
};

/**
 * Gets an invention product's no-decryptor output from its source blueprint.
 *
 * @param blueprint The T1 source blueprint record from the SDE.
 * @param productTypeId The invented BPC type ID.
 * @returns The no-decryptor invention outcome, or undefined when not produced by this blueprint.
 */
export function getNoDecryptorInventionOutput(
  blueprint: BlueprintsRecord,
  productTypeId: number,
): InventionOutput | undefined {
  const product = blueprint.activities.invention?.products?.find(
    (candidate) => candidate.typeID === productTypeId,
  );
  if (!product) return undefined;
  return {
    productTypeId,
    probability: product.probability ?? 1,
    runs: product.quantity,
    materialEfficiency: 2,
    timeEfficiency: 4,
  };
}

/**
 * Decodes all invention-relevant modifiers from a decryptor's dogma record.
 *
 * @param typeId The decryptor type ID.
 * @param dogma The decryptor's SDE dogma record.
 * @returns The normalized decryptor modifiers, or undefined when the type is not a decryptor.
 */
export function getInventionDecryptorModifiers(
  typeId: number,
  dogma: TypeDogmaRecord | undefined,
): InventionDecryptorModifiers | undefined {
  const attributes = new Map(
    dogma?.dogmaAttributes.map((attribute) => [attribute.attributeID, attribute.value]),
  );
  if (!attributes.has(inventionMaxRunModifierAttributeId)) return undefined;
  return {
    typeId,
    probabilityMultiplier: attributes.get(inventionProbabilityMultiplierAttributeId) ?? 1,
    materialEfficiencyModifier: attributes.get(inventionMaterialEfficiencyModifierAttributeId) ?? 0,
    timeEfficiencyModifier: attributes.get(inventionTimeEfficiencyModifierAttributeId) ?? 0,
    maxRunModifier: attributes.get(inventionMaxRunModifierAttributeId) ?? 0,
  };
}
