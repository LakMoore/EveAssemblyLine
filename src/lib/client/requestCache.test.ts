import assert from "node:assert/strict";
import test from "node:test";
import { groupClientAssetsByLocation } from "./requestCache";

test("groups each market order at its source location once", () => {
  const locations = groupClientAssetsByLocation({
    locations: [
      {
        locationId: 1,
        name: "Jita",
        locationType: "station",
      },
    ],
    assets: [
      { typeId: 2929, name: "800mm Repeating Cannon II", quantity: 100, rootLocationId: 1 },
      {
        typeId: 2929,
        name: "800mm Repeating Cannon II",
        quantity: 18,
        source: "marketOrder",
        sourceLocationId: 1,
      },
    ],
  });

  assert.deepEqual(
    locations[0]?.items.map((item) => item.quantity),
    [100, 18],
  );
});
