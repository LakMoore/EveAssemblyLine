import assert from "node:assert/strict";
import test from "node:test";
import { getGroups, getMarketGroups, getTypesByIds } from "@/cache/services/sdeCache";
import { isAmmunitionType } from "./ships";

void test("recognizes ammunition through its market-group ancestry", async () => {
  const [types, marketGroups] = await Promise.all([getTypesByIds([178]), getMarketGroups()]);
  assert.equal(isAmmunitionType(178, types, marketGroups), true);
});

void test("does not classify an unrelated type as ammunition", async () => {
  const [types, marketGroups, groups] = await Promise.all([
    getTypesByIds([34]),
    getMarketGroups(),
    getGroups(),
  ]);
  assert.ok(groups.size > 0);
  assert.equal(isAmmunitionType(34, types, marketGroups), false);
});
