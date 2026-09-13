import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCharacterOwner,
  assertCorporationOwner,
  getCorporationPolicy,
  type OwnerDataContext,
} from "./types";

const context = {
  sessionId: "session-1",
  characterIds: [101],
  corporationPolicies: [
    {
      corporationId: 900,
      supportEnabled: true,
      directHangars: [],
      containerItemIds: [],
    },
  ],
} satisfies OwnerDataContext;

void test("accepts owners present in the authorized provider context", () => {
  assert.doesNotThrow(() => assertCharacterOwner(101, context));
  assert.doesNotThrow(() => assertCorporationOwner(900, context));
  assert.equal(getCorporationPolicy(900, context)?.corporationId, 900);
});

void test("rejects owners outside the authorized provider context", () => {
  assert.throws(() => assertCharacterOwner(102, context));
  assert.throws(() => assertCorporationOwner(901, context));
  assert.equal(getCorporationPolicy(901, context), undefined);
});
