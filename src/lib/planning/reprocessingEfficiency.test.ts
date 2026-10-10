import assert from "node:assert/strict";
import { test } from "node:test";
import type { TypeDogmaRecord, TypesRecord } from "@/lib/sde/generated";
import { calculateReprocessingProfile } from "./reprocessingEfficiency";
import { createReprocessingProfile, reprocessingProfileSchema } from "./reprocessingProfile";

void test("calculates efficiency from the selected rig type ID", () => {
  const profile = createReprocessingProfile(
    {
      locationType: "structure",
      structureTypeId: 1200,
      rigTypeIds: [900, 901, 0],
      securityStatus: 0.6,
    },
    {},
    0,
  );
  const maps = {
    types: new Map([
      [500, { _key: 500, name: { en: "Tritanium" }, groupID: 1 } as TypesRecord],
      [501, { _key: 501, name: { en: "Scrapmetal Processing" }, groupID: 1 } as TypesRecord],
    ]),
    groups: new Map(),
    typeDogma: new Map([
      [900, { dogmaAttributes: [{ attributeID: 999, value: 50 }] } as TypeDogmaRecord],
      [901, { dogmaAttributes: [{ attributeID: 379, value: 15 }] } as TypeDogmaRecord],
    ]),
    dogmaAttributes: new Map([
      [1000, { _key: 1000, name: "refiningYieldNormalOres", defaultValue: 0.5 }],
    ]),
  };

  assert.deepEqual(profile.rigTypeIds, [900, 901]);
  assert.equal(calculateReprocessingProfile(maps, [500], profile).efficiencies["500"], 65);
});

void test("ignores structure rigs when the selected location is a station", () => {
  const profile = createReprocessingProfile(
    {
      locationType: "station",
      structureTypeId: 1200,
      rigTypeIds: [901],
      securityStatus: 0.6,
    },
    {},
    2,
  );

  assert.equal(profile.structureTypeId, 0);
  assert.deepEqual(profile.rigTypeIds, []);
});

void test("requires every field in the reprocessing profile request", () => {
  assert.equal(reprocessingProfileSchema.safeParse({ structureTypeId: 0 }).success, false);
  assert.equal(
    reprocessingProfileSchema.safeParse({
      structureTypeId: 0,
      rigTypeIds: [],
      skillLevels: {},
      implantLevel: 0,
    }).success,
    true,
  );
  assert.equal(
    reprocessingProfileSchema.safeParse({
      structureTypeId: 0,
      rigTypeIds: [],
      skillLevels: {},
      implantLevel: 0,
      reprocessingRig: 1,
    }).success,
    false,
  );
});
