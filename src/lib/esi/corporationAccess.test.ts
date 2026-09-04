import assert from "node:assert/strict";
import test from "node:test";
import {
  corporationHangarFlagForDivision,
  corporationHangarNumber,
  getCorporationHangarPermissions,
  isCorporationHangarFlag,
} from "./corporationAccess";

test("maps corporation divisions to asset location flags", () => {
  assert.equal(corporationHangarFlagForDivision(0), "CorpDeliveries");
  assert.equal(corporationHangarFlagForDivision(1), "CorpSAG1");
  assert.equal(corporationHangarFlagForDivision(7), "CorpSAG7");
  assert.equal(corporationHangarFlagForDivision(8), undefined);
  assert.equal(corporationHangarNumber("CorpDeliveries"), 8);
  assert.equal(corporationHangarNumber("CorpSAG4"), 4);
  assert.equal(isCorporationHangarFlag("CorpSAG4"), true);
  assert.equal(isCorporationHangarFlag("Hangar"), false);
});

test("uses HQ and other-location roles for non-directors", () => {
  const characters = [
    {
      corporationId: 42,
      corporationRoles: [],
      rolesAtHq: ["Hangar_Take_1", "Deliveries_Query"],
      rolesAtOther: ["Hangar_Query_2"],
      hasDirectorRole: false,
    },
  ];

  const atHeadquarters = getCorporationHangarPermissions(characters, 42, 9001, 9001);
  assert.deepEqual(
    atHeadquarters.get("CorpSAG1"),
    {
      flag: "CorpSAG1",
      canTake: true,
      canQuery: true,
    },
  );
  assert.deepEqual(
    atHeadquarters.get("CorpDeliveries"),
    {
      flag: "CorpDeliveries",
      canTake: false,
      canQuery: true,
    },
  );
  assert.equal(atHeadquarters.get("CorpSAG2")?.canQuery, false);

  const elsewhere = getCorporationHangarPermissions(characters, 42, 9002, 9001);
  assert.equal(elsewhere.get("CorpSAG1")?.canTake, false);
  assert.equal(elsewhere.get("CorpSAG2")?.canQuery, true);
});

test("deduplicates permissions across collection characters and grants directors all access", () => {
  const permissions = getCorporationHangarPermissions(
    [
      {
        corporationId: 42,
        corporationRoles: ["Hangar_Query_3"],
        rolesAtHq: [],
        rolesAtOther: [],
        hasDirectorRole: false,
      },
      {
        corporationId: 42,
        corporationRoles: [],
        rolesAtHq: [],
        rolesAtOther: [],
        hasDirectorRole: true,
      },
      {
        corporationId: 99,
        corporationRoles: ["Director"],
        rolesAtHq: [],
        rolesAtOther: [],
        hasDirectorRole: true,
      },
    ],
    42,
    9002,
    9001,
  );

  for (const permission of permissions.values()) {
    assert.equal(permission.canTake, true);
    assert.equal(permission.canQuery, true);
  }
});
