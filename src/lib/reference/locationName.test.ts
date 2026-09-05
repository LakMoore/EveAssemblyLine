import assert from "node:assert/strict";
import test from "node:test";
import { formatLocationName, normalizeLocationName } from "./locationName";

test("removes the ESI solar-system prefix from structure names", () => {
  assert.equal(normalizeLocationName("J130330", "J130330 - Rocky Balboa"), "Rocky Balboa");
});

test("does not remove a non-matching name prefix", () => {
  assert.equal(normalizeLocationName("Jita", "J130330 - Rocky Balboa"), "J130330 - Rocky Balboa");
});

test("formats a structure name with its system exactly once", () => {
  assert.equal(formatLocationName("J130330", "Rocky Balboa"), "J130330 - Rocky Balboa");
  assert.equal(formatLocationName("J130330", "J130330 - Rocky Balboa"), "J130330 - Rocky Balboa");
});
