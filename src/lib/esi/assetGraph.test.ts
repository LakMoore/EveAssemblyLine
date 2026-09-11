import assert from "node:assert/strict";
import test from "node:test";
import { retainAssetAncestors } from "./assetGraph";

void test("retains query-only container ancestors for accessible assets", () => {
  const assets = [
    { itemId: 10, locationId: 1 },
    { itemId: 1, locationId: 100 },
    { itemId: 100, locationId: 1000 },
    { itemId: 20, locationId: 10 },
    { itemId: 30, locationId: 20 },
  ];

  assert.deepEqual(
    retainAssetAncestors(assets, new Set([30])).map((asset) => asset.itemId),
    [10, 1, 100, 20, 30],
  );
});

void test("does not add unrelated inaccessible assets", () => {
  const assets = [
    { itemId: 10, locationId: 1 },
    { itemId: 20, locationId: 2 },
    { itemId: 30, locationId: 20 },
  ];

  assert.deepEqual(
    retainAssetAncestors(assets, new Set([30])).map((asset) => asset.itemId),
    [20, 30],
  );
});
