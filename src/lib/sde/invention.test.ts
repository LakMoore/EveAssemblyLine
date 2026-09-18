import assert from "node:assert/strict";
import test from "node:test";
import { getBlueprints, getTypeDogma } from "./loader";
import { getInventionDecryptorModifiers, getNoDecryptorInventionOutput } from "./invention";

void test("decodes the Ladar ECM II no-decryptor invention outcome", async () => {
  const sourceBlueprint = (await getBlueprints()).byBlueprintId.get(11630);
  assert.ok(sourceBlueprint);
  assert.deepEqual(
    getNoDecryptorInventionOutput(sourceBlueprint, 11783),
    {
      productTypeId: 11783,
      probability: 0.34,
      runs: 10,
      materialEfficiency: 2,
      timeEfficiency: 4,
    },
  );
});

void test("decodes the Vargur no-decryptor invention outcome", async () => {
  const sourceBlueprint = (await getBlueprints()).byBlueprintId.get(693);
  assert.ok(sourceBlueprint);
  assert.deepEqual(
    getNoDecryptorInventionOutput(sourceBlueprint, 28666),
    {
      productTypeId: 28666,
      probability: 0.22,
      runs: 1,
      materialEfficiency: 2,
      timeEfficiency: 4,
    },
  );
});

void test("decodes the distinct Tech III relic outcomes for Loki Wake Limiter", async () => {
  const blueprints = await getBlueprints();
  const outcomes = [30187, 30558, 30562].map((sourceTypeId) => {
    const source = blueprints.byBlueprintId.get(sourceTypeId);
    assert.ok(source);
    return getNoDecryptorInventionOutput(source, 45716);
  });
  assert.deepEqual(
    outcomes,
    [
      {
        productTypeId: 45716,
        probability: 0.26,
        runs: 20,
        materialEfficiency: 2,
        timeEfficiency: 4,
      },
      {
        productTypeId: 45716,
        probability: 0.21,
        runs: 10,
        materialEfficiency: 2,
        timeEfficiency: 4,
      },
      {
        productTypeId: 45716,
        probability: 0.14,
        runs: 3,
        materialEfficiency: 2,
        timeEfficiency: 4,
      },
    ],
  );
});

void test("decodes all invention modifiers from a decryptor dogma record", async () => {
  const modifiers = getInventionDecryptorModifiers(34208, (await getTypeDogma()).get(34208));
  assert.deepEqual(
    modifiers,
    {
      typeId: 34208,
      probabilityMultiplier: 0.9,
      materialEfficiencyModifier: 2,
      timeEfficiencyModifier: 0,
      maxRunModifier: 7,
    },
  );
});
