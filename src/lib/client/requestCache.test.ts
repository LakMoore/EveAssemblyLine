import assert from "node:assert/strict";
import test from "node:test";
import {
  filterClientAssetsForPlanning,
  groupClientAssetsByLocation,
  isCompleteClientAssetsResponse,
  normalizeClientAssetsResponse,
} from "./requestCache";

test("requires the complete asset snapshot before using the local cache", () => {
  assert.equal(
    isCompleteClientAssetsResponse({
      assets: [],
      facilities: [],
      settings: { lastModified: "", facilities: {} },
      productionGroups: [],
      corporationSources: [],
    }),
    true,
  );
  assert.equal(
    isCompleteClientAssetsResponse({ assets: [], facilities: [], productionGroups: [] }),
    false,
  );
});

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

test("groups anchored assets under their solar system", () => {
  const locations = groupClientAssetsByLocation({
    facilities: [],
    assets: [
      {
        typeId: 62456,
        name: "Compressed Glistening Bitumens",
        quantity: 15_750,
        rootLocationId: 30_004_129,
        sourceLocationKind: "anchored",
        sourceSystemId: 30_004_129,
        sourceSystemName: "Munory",
        ownerType: "character",
        ownerId: 2118225169,
      },
    ],
  });

  assert.deepEqual(
    locations.map((location) => ({
      locationId: location.locationId,
      locationType: location.locationType,
      name: location.name,
      quantity: location.items[0]?.quantity,
    })),
    [
      {
        locationId: 30_004_129,
        locationType: "anchored",
        name: "Munory",
        quantity: 15_750,
      },
    ],
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

test("keeps reaction formulas from selected corporation containers", () => {
  const filtered = filterClientAssetsForPlanning({
    corporationSources: [
      {
        corporationId: 900,
        rootLocationId: 100,
        locationFlag: "CorpSAG6",
        label: "Hangar 6",
        canTake: false,
        canQuery: true,
        selected: false,
        containers: [
          {
            itemId: 500,
            name: "001 - Reactions",
            locationId: 50,
            rootLocationId: 100,
            selected: true,
          },
        ],
      },
    ],
    assets: [
      {
        typeId: 46165,
        name: "C3-FTM Acid Reaction Formula",
        quantity: 1,
        ownerType: "corporation",
        ownerId: 900,
        rootLocationId: 100,
        category: "reactionformula",
        corporationSource: {
          rootLocationId: 100,
          locationFlag: "CorpSAG6",
          containerItemIds: [500],
        },
      },
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 100,
        ownerType: "corporation",
        ownerId: 900,
        rootLocationId: 100,
        category: "item",
        corporationSource: {
          rootLocationId: 100,
          locationFlag: "CorpSAG6",
          containerItemIds: [500],
        },
      },
    ],
  });

  assert.deepEqual(
    filtered.assets?.map((item) => item.typeId),
    [46165],
  );
});
