import assert from "node:assert/strict";
import test from "node:test";
import { getGroups, getMarketGroups, getTypesByIds } from "@/cache/services/sdeCache";
import { getAssetsContainedByShip, isAmmunitionType } from "./ships";

void test("collects all descendants of a ship, including nested ships", () => {
  const assets = [
    { itemId: 1, locationId: 900 },
    { itemId: 2, locationId: 1 },
    { itemId: 3, locationId: 2 },
    { itemId: 4, locationId: 2 },
    { itemId: 5, locationId: 900 },
    { itemId: 6, locationId: 4 },
    { itemId: 7, locationId: 7 },
  ];
  assert.deepEqual(
    getAssetsContainedByShip(1, assets),
    [assets[1], assets[2], assets[3], assets[5]],
  );
});

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
