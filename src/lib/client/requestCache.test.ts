import assert from "node:assert/strict";
import test from "node:test";
import {
  filterClientAssetsForPlanning,
  groupClientAssetsByLocation,
  normalizeClientAssetsResponse,
} from "./requestCache";

test("groups each market order at its source location once", () => {
  const locations = groupClientAssetsByLocation({
    facilities: [
      {
        id: 1,
        name: "Jita",
        locationType: "station",
        typeId: 52678,
        systemId: 30000142,
        sizeId: 0,
        systemCostIndices: {},
        activities: {
          reprocessing: { available: true },
          manufacturing: {
            available: true,
            standard: { available: true },
            capital: { available: false },
          },
          reactions: {
            available: true,
            biochemical: { available: true },
            composite: { available: true },
            hybrid: { available: true },
          },
          meResearch: { available: true },
          teResearch: { available: true },
          invention: { available: true },
          copying: { available: true },
        },
        buildTypeGroups: {},
        services: [],
        rigTypeIds: [],
        settingsLastModified: "",
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
    facilities: [],
    corporationSources: [
      {
        corporationId: 900,
        rootLocationId: 1,
        locationFlag: "",
        label: "Structure",
        rootLocation: {
          locationId: 1,
          kind: "structure",
          name: "J130330 - Rocky Balboa",
          systemName: "J130330",
          resolved: true,
        },
        canTake: true,
        canQuery: true,
        selected: true,
        containers: [],
      },
    ],
  });

  assert.deepEqual(
    normalized.corporationSources?.map((source) => source.rootLocation?.name),
    ["J130330 - Rocky Balboa"],
  );
  assert.equal("locations" in normalized, false);
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
