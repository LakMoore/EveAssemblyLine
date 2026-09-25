import assert from "node:assert/strict";
import test from "node:test";
import {
  filterClientAssetsForPlanning,
  filterClientSellOrdersForPlanning,
  getClientOwnerSnapshotOwners,
  groupClientAssetsByLocation,
  isCompleteClientAssetsResponse,
  normalizeClientAssetsResponse,
  applyCorporationSettings,
  loadClientSystemNames,
} from "./requestCache";

void test("filters sell orders using personal and corporation settings", () => {
  const data = {
    facilities: [],
    assets: [
      {
        typeId: 1,
        name: "Personal",
        quantity: 1,
        source: "marketOrder" as const,
        ownerType: "character" as const,
        ownerId: 7,
      },
      {
        typeId: 2,
        name: "My corporation",
        quantity: 2,
        source: "marketOrder" as const,
        ownerType: "corporation" as const,
        ownerId: 90,
        marketOrderIssuerId: 7,
      },
      {
        typeId: 3,
        name: "Other corporation",
        quantity: 3,
        source: "marketOrder" as const,
        ownerType: "corporation" as const,
        ownerId: 90,
        marketOrderIssuerId: 8,
      },
      { typeId: 4, name: "Regular", quantity: 4, ownerType: "character" as const, ownerId: 7 },
    ],
  };
  const selectedCharacterOnly = filterClientSellOrdersForPlanning(
    data,
    {
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: true,
    },
    [7],
  );
  assert.deepEqual(
    selectedCharacterOnly.assets?.map((item) => item.typeId),
    [2, 4],
  );

  const allOrders = filterClientSellOrdersForPlanning(
    data,
    {
      personalSellOrdersAsStock: true,
      allCorporationSellOrdersAsStock: true,
      myCorporationSellOrdersAsStock: false,
    },
    [7],
  );
  assert.deepEqual(
    allOrders.assets?.map((item) => item.typeId),
    [1, 2, 3, 4],
  );
});

void test("shares overlapping in-flight system name requests", async () => {
  const originalFetch = globalThis.fetch;
  const fetchBodies: number[][] = [];
  let releaseFirstRequest!: () => void;
  const firstRequestReleased = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { systemIds: number[] };
    fetchBodies.push(body.systemIds);
    if (fetchBodies.length === 1) await firstRequestReleased;
    return {
      ok: true,
      json: async () => ({
        items: body.systemIds.map((systemId) => ({ systemId, name: `System ${systemId}` })),
      }),
    } as Response;
  };

  try {
    const first = loadClientSystemNames([1, 2], "en");
    const second = loadClientSystemNames([2, 3], "en");
    await Promise.resolve();
    assert.deepEqual(fetchBodies, [[1, 2], [3]]);
    releaseFirstRequest();
    assert.deepEqual(
      [...(await first).entries()],
      [
        [1, "System 1"],
        [2, "System 2"],
      ],
    );
    assert.deepEqual(
      [...(await second).entries()],
      [
        [2, "System 2"],
        [3, "System 3"],
      ],
    );
    assert.deepEqual(
      [...(await loadClientSystemNames([1, 3], "en")).entries()],
      [
        [1, "System 1"],
        [3, "System 3"],
      ],
    );
    assert.deepEqual(fetchBodies, [[1, 2], [3]]);
  }
  finally {
    globalThis.fetch = originalFetch;
  }
});

void test("deduplicates supported corporation snapshot owners", () => {
  const owners = getClientOwnerSnapshotOwners({
    characters: [
      {
        characterId: 1,
        characterName: "One",
        onDeployment: false,
        corporationId: 900,
        corporationRoles: [],
        rolesAtBase: [],
        rolesAtHq: [],
        rolesAtOther: [],
        hasDirectorRole: false,
        allowCorpRefreshOptIn: false,
        hasAccountantRole: false,
        hasTraderRole: false,
        corporationSupportEnabled: true,
      },
      {
        characterId: 2,
        characterName: "Two",
        onDeployment: false,
        corporationId: 900,
        corporationRoles: [],
        rolesAtBase: [],
        rolesAtHq: [],
        rolesAtOther: [],
        hasDirectorRole: false,
        allowCorpRefreshOptIn: false,
        hasAccountantRole: false,
        hasTraderRole: false,
        corporationSupportEnabled: true,
      },
    ],
  });

  assert.deepEqual(
    owners,
    [
      { kind: "character", id: 1 },
      { kind: "character", id: 2 },
      { kind: "corporation", id: 900 },
    ],
  );
});

void test("requires the complete asset snapshot before using the local cache", () => {
  assert.equal(
    isCompleteClientAssetsResponse({
      assets: [],
      facilities: [],
      corporationSources: [],
    }),
    true,
  );
  assert.equal(isCompleteClientAssetsResponse({ assets: [], facilities: [] }), false);
});

void test("reapplies saved corporation source selections to owner snapshot assets", () => {
  const resolved = applyCorporationSettings(
    {
      assets: [],
      facilities: [],
      corporationSources: [
        {
          corporationId: 900,
          rootLocationId: 600,
          locationFlag: "CorpSAG1",
          label: "Industry",
          canTake: true,
          canQuery: true,
          selected: false,
          containers: [
            {
              itemId: 44,
              locationId: 44,
              rootLocationId: 600,
              selected: false,
            },
          ],
        },
      ],
    },
    [
      {
        corporationId: 900,
        supportEnabled: true,
        directHangars: [{ rootLocationId: 600, locationFlag: "CorpSAG1" }],
        containerItemIds: [44],
      },
    ],
  );

  const resolvedSource = resolved.corporationSources?.[0];
  assert.ok(resolvedSource);
  assert.equal(resolvedSource.selected, true);
  assert.equal(resolvedSource.containers[0]?.selected, true);
});

void test("groups each market order at its source location once", () => {
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
            supercapital: { available: false },
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

void test("groups anchored assets under their solar system", () => {
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

void test("groups resolved non-facility structure assets by their root location", () => {
  const locations = groupClientAssetsByLocation({
    facilities: [],
    assets: [
      {
        typeId: 62457,
        name: "Compressed Coesite",
        quantity: 100,
        rootLocationId: 1050181032181,
        sourceLocationName: "Munory - A-55",
        sourceLocationKind: "structure",
        sourceSystemId: 30004129,
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
    })),
    [
      {
        locationId: 1050181032181,
        locationType: "structure",
        name: "Munory - A-55",
      },
    ],
  );
});

void test("excludes assembled ships and containers from location volume", () => {
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
            supercapital: { available: false },
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
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 2,
        isPackaged: true,
        assembledVolume: 10,
        packagedVolume: 3,
        rootLocationId: 1,
      },
      {
        typeId: 100,
        name: "Cargo Container",
        quantity: 1,
        isPackaged: false,
        assembledVolume: 500,
        isCargoContainer: true,
        rootLocationId: 1,
      },
      {
        typeId: 200,
        name: "Capital Ship",
        quantity: 1,
        isPackaged: false,
        assembledVolume: 1_000_000,
        isShip: true,
        rootLocationId: 1,
      },
    ],
  });

  assert.equal(locations[0]?.totalVolume, 6);
});

void test("normalizes structure names and hides legacy raw location labels", () => {
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

void test("matches direct corporation assets by their resolved root location", () => {
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

void test("hides a corporation job output in an unselected destination container", () => {
  const filtered = filterClientAssetsForPlanning({
    corporationSources: [
      {
        corporationId: 900,
        rootLocationId: 100,
        locationFlag: "CorpSAG6",
        label: "Hangar 6",
        canTake: true,
        canQuery: true,
        selected: true,
        containers: [
          {
            itemId: 701,
            name: "Output Can",
            locationId: 100,
            rootLocationId: 100,
            selected: false,
          },
        ],
      },
    ],
    assets: [
      {
        typeId: 11478,
        name: "Job Output",
        quantity: 1,
        locationId: 701,
        rootLocationId: 100,
        ownerType: "corporation",
        ownerId: 900,
        inBuild: true,
        jobId: 700,
      },
      {
        typeId: 11477,
        name: "Job Blueprint",
        quantity: 1,
        locationId: 701,
        rootLocationId: 100,
        ownerType: "corporation",
        ownerId: 900,
        inBuild: true,
        inUse: true,
        jobId: 700,
        category: "blueprint",
      },
    ],
  });

  assert.deepEqual(filtered.assets, []);
});

void test("hides a corporation job output when its source cannot be taken", () => {
  const filtered = filterClientAssetsForPlanning({
    corporationSources: [
      {
        corporationId: 900,
        rootLocationId: 100,
        locationFlag: "CorpSAG6",
        label: "Hangar 6",
        canTake: false,
        canQuery: true,
        selected: true,
        containers: [
          {
            itemId: 701,
            name: "Output Can",
            locationId: 100,
            rootLocationId: 100,
            selected: true,
          },
        ],
      },
    ],
    assets: [
      {
        typeId: 11478,
        name: "Job Output",
        quantity: 1,
        locationId: 701,
        rootLocationId: 100,
        ownerType: "corporation",
        ownerId: 900,
        inBuild: true,
        jobId: 700,
        corporationSource: {
          rootLocationId: 100,
          locationFlag: "CorpSAG6",
          containerItemIds: [701],
        },
      },
    ],
  });

  assert.deepEqual(filtered.assets, []);
});

void test("selecting an outer corporation container includes nested assets", () => {
  const filtered = filterClientAssetsForPlanning({
    corporationSources: [
      {
        corporationId: 900,
        rootLocationId: 100,
        locationFlag: "CorpSAG6",
        label: "Hangar 6",
        canTake: true,
        canQuery: true,
        selected: false,
        containers: [
          { itemId: 700, locationId: 100, rootLocationId: 100, selected: true },
          { itemId: 701, locationId: 700, rootLocationId: 100, selected: false },
        ],
      },
    ],
    assets: [
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 1,
        locationId: 701,
        rootLocationId: 100,
        ownerType: "corporation",
        ownerId: 900,
        corporationSource: {
          rootLocationId: 100,
          locationFlag: "CorpSAG6",
          containerItemIds: [701],
        },
      },
    ],
  });

  assert.equal(filtered.assets?.length, 1);
});

void test("keeps reaction formulas from selected corporation containers", () => {
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
