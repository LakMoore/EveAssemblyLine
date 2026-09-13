import assert from "node:assert/strict";
import test from "node:test";
import { volumeForItem } from "./volume";

void test("counts packaged ordinary items by packaged volume", () => {
  assert.equal(
    volumeForItem({
      quantity: 10,
      isPackaged: true,
      assembledVolume: 12,
      packagedVolume: 3,
    }),
    30,
  );
});

void test("counts assembled ordinary items by assembled volume", () => {
  assert.equal(volumeForItem({ quantity: 4, isPackaged: false, assembledVolume: 12 }), 48);
});

void test("excludes assembled containers and ships", () => {
  assert.equal(
    volumeForItem({
      quantity: 1,
      isPackaged: false,
      assembledVolume: 1_000_000,
      isCargoContainer: true,
    }),
    0,
  );
  assert.equal(
    volumeForItem({
      quantity: 1,
      isPackaged: false,
      assembledVolume: 1_000_000,
      isShip: true,
    }),
    0,
  );
});
