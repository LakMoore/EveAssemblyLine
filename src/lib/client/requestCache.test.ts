import assert from "node:assert/strict";
import test from "node:test";
import {
  filterClientAssetsForPlanning,
  groupClientAssetsByLocation,
  normalizeClientAssetsResponse,
} from "./requestCache";

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

test("normalizes structure names and hides legacy raw location labels", () => {
  const normalized = normalizeClientAssetsResponse({
    locations: [
      {
        locationId: 1,
        name: "J130330 - Rocky Balboa",
        locationType: "structure",
        systemName: "J130330",
      },
      {
        locationId: 2,
        name: "Location ID 2",
        locationType: "structure",
      },
    ],
  });

  assert.deepEqual(
    normalized.locations?.map((location) => location.name),
    ["J130330 - Rocky Balboa", "Structure details unavailable"],
  );
});

test("matches direct corporation assets by their resolved root location", () => {
  const filtered = filterClientAssetsForPlanning({
    corporationSources: [
      {
        corporationId: 900,
        rootLocationId: 100,
        locationFlag: "CorpSAG3",
        label: "Hangar 3",
        canTake: true,
        canQuery: true,
        selected: true,
        containers: [],
      },
    ],
    assets: [
      {
        typeId: 39,
        name: "Tritanium",
        quantity: 1,
        ownerType: "corporation",
        ownerId: 900,
        rootLocationId: 100,
        corporationSource: {
          rootLocationId: 200,
          locationFlag: "CorpSAG3",
          containerItemIds: [],
        },
      },
    ],
  });

  assert.equal(filtered.assets?.length, 1);
});
