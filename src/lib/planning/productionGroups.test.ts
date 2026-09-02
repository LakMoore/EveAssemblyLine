import assert from "node:assert/strict";
import test from "node:test";
import type {
  DogmaEffectsRecord,
  GroupsRecord,
  IndustryModifierSourcesRecord,
  IndustryTargetFiltersRecord,
  TypeDogmaRecord,
} from "@/lib/sde/generated";
import { calculateFacilityGroupBonuses } from "./facilityBonuses";
import { getProductionGroupReferences, productionGroupDefinitions } from "./productionGroups";

function groupRecord(groupId: number, categoryID: number, name: string): GroupsRecord {
  return {
    _key: groupId,
    anchorable: false,
    anchored: false,
    categoryID,
    fittableNonSingleton: false,
    name: { en: name },
    published: true,
    useBasePrice: false,
  };
}

function dogmaRecord(
  attributes: Array<{ attributeID: number; value: number }>,
  effectID = 0,
): TypeDogmaRecord {
  return {
    _key: 1,
    dogmaAttributes: attributes,
    dogmaEffects: [{ effectID }],
  } as TypeDogmaRecord;
}

function effectRecord(): DogmaEffectsRecord {
  return {
    _key: 0,
    disallowAutoRepeat: false,
    effectCategoryID: 0,
    electronicChance: false,
    isAssistance: false,
    isOffensive: false,
    isWarpSafe: false,
    modifierInfo: [
      {
        domain: "structureID",
        func: "ItemModifier",
        modifiedAttributeID: 2546,
        modifyingAttributeID: 2594,
      },
      {
        domain: "structureID",
        func: "ItemModifier",
        modifiedAttributeID: 2547,
        modifyingAttributeID: 2593,
      },
    ],
    name: "test",
    propulsionChance: false,
    published: true,
    rangeChance: false,
  };
}

const mediumShips = productionGroupDefinitions.find(
  (definition) => definition.targetFilterId === 7,
)!;
const smallShips = productionGroupDefinitions.find(
  (definition) => definition.targetFilterId === 5,
)!;

test("resolves target-filter memberships and localized group names", () => {
  const references = getProductionGroupReferences(
    new Map<number, IndustryTargetFiltersRecord>([
      [7, { _key: 7, groupIDs: [26], name: "Medium T1 Ships" }],
      [5, { _key: 5, groupIDs: [25], name: "Small T1 Ships" }],
    ]),
    new Map<number, GroupsRecord>([
      [26, groupRecord(26, 6, "Cruisers")],
      [25, groupRecord(25, 6, "Frigates")],
    ]),
  );

  assert.deepEqual(
    references.find((reference) => reference.key === "mediumShips"),
    {
      ...mediumShips,
      groupIds: [26],
      categoryIds: [],
      localizedGroupNames: { "26": "Cruisers" },
    },
  );
});

test("applies a rig only to its matching group and scales low-security bonuses", () => {
  const structure = dogmaRecord([
    { attributeID: 2600, value: 1 },
    { attributeID: 2601, value: 1 },
    { attributeID: 2721, value: 1 },
  ]);
  const rig = dogmaRecord([
    { attributeID: 2355, value: 1 },
    { attributeID: 2356, value: 2 },
    { attributeID: 2594, value: -2 },
    { attributeID: 2593, value: -5 },
  ]);
  const source: IndustryModifierSourcesRecord = {
    _key: 2,
    manufacturing: {
      material: [{ dogmaAttributeID: 2546, filterID: 7 }],
      time: [{ dogmaAttributeID: 2547, filterID: 7 }],
    },
  };
  const bonuses = calculateFacilityGroupBonuses(
    structure,
    [2],
    new Map([[2, rig]]),
    new Map([[0, effectRecord()]]),
    new Map([[2, source]]),
    [
      {
        ...mediumShips,
        groupIds: [],
        categoryIds: [],
        localizedGroupNames: {},
      },
      {
        ...smallShips,
        groupIds: [],
        categoryIds: [],
        localizedGroupNames: {},
      },
    ],
    0.1,
  );

  assert.equal(bonuses.mediumShips.manufacturingMaterialMultiplier, 0.96);
  assert.equal(bonuses.mediumShips.manufacturingTimeMultiplier, 0.9);
  assert.equal(bonuses.smallShips.manufacturingMaterialMultiplier, 1);
  assert.equal(bonuses.smallShips.manufacturingTimeMultiplier, 1);
});

test("applies a broad Ships rig to every ship subgroup", () => {
  const structure = dogmaRecord([{ attributeID: 2600, value: 0.99 }]);
  const rig = dogmaRecord([
    { attributeID: 2356, value: 1.9 },
    { attributeID: 2594, value: -2 },
  ]);
  const effect: DogmaEffectsRecord = {
    ...effectRecord(),
    modifierInfo: [
      {
        domain: "structureID",
        func: "ItemModifier",
        modifiedAttributeID: 2592,
        modifyingAttributeID: 2594,
      },
    ],
  };
  const references = getProductionGroupReferences(
    new Map<number, IndustryTargetFiltersRecord>([
      [3, { _key: 3, categoryIDs: [6], name: "Ships" }],
      [5, { _key: 5, groupIDs: [25], name: "Small T1 Ships" }],
      [9, { _key: 9, groupIDs: [27], name: "Large T1 Ships" }],
      [4, { _key: 4, categoryIDs: [8], name: "Charges" }],
      [1, { _key: 1, categoryIDs: [18], name: "Drones/Fighters" }],
    ]),
    new Map<number, GroupsRecord>(),
  );
  const bonuses = calculateFacilityGroupBonuses(
    structure,
    [2],
    new Map([[2, rig]]),
    new Map([[0, effect]]),
    new Map([
      [
        2,
        {
          _key: 2,
          manufacturing: { material: [{ dogmaAttributeID: 2592, filterID: 3 }] },
        },
      ],
    ]),
    references,
    0.1,
  );

  assert.ok(Math.abs(bonuses.smallShips.manufacturingMaterialPercentage + 3.8) < 1e-9);
  assert.ok(Math.abs(bonuses.largeShips.manufacturingMaterialPercentage + 3.8) < 1e-9);
  assert.ok(Math.abs(bonuses.charges.manufacturingMaterialPercentage) < 1e-9);
  assert.ok(Math.abs(bonuses.drones.manufacturingMaterialPercentage) < 1e-9);
});
