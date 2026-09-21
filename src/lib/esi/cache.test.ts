import assert from "node:assert/strict";
import test from "node:test";
import { getEsiTtlMs } from "@/cache/esiTtl";
import {
  buildCurrentShipAsset,
  endpointDataStatus,
  getCorporationAssetSource,
  getCorporationIdsForCharacters,
  getStateStatus,
  getMarketOrderAssetDeductions,
  getJobAssetRootLocationId,
  getKnownNonStructureItemIds,
  isStationLocationId,
  isStructureLocationCandidate,
  buildDeliveredJobAsset,
  canMergeDeliveredAsset,
  getStructureResolverCharacterId,
  isCorporationRecordAllowed,
  isCorporationRecordAccessible,
  isCargoContainerType,
  isHaulableShipHoldAsset,
  resolveAssetLocationIds,
  setFresh,
  toClientEndpointStatus,
} from "./cache";
import { getGroups, getMarketGroups, getTypesByIds } from "@/cache/services/sdeCache";
import { normalizeCorporationSettings } from "@/lib/auth/tokensStore";
import { getCorporationHangarPermissions } from "./corporationAccess";
import type {
  AssetRecord,
  CorporationCollectionSettings,
  IndustryJobRecord,
} from "@/lib/auth/model";

const corporationPolicy: CorporationCollectionSettings = {
  corporationId: 900,
  supportEnabled: true,
  directHangars: [],
  containerItemIds: [],
};

const corporationRoles = [
  {
    corporationId: 900,
    corporationRoles: ["Hangar_Take_1", "Hangar_Query_1"],
    rolesAtHq: [],
    rolesAtOther: ["Hangar_Take_1", "Hangar_Query_1"],
    hasDirectorRole: false,
  },
] satisfies Parameters<typeof getCorporationHangarPermissions>[0];

const corporationAssets = new Map([
  [
    200,
    {
      itemId: 200,
      typeId: 1,
      quantity: 1,
      locationId: 700,
      locationType: "item" as const,
      locationFlag: "CorpSAG1",
      isSingleton: true,
      ownerType: "corporation" as const,
      ownerId: 900,
    },
  ],
  [
    300,
    {
      itemId: 300,
      typeId: 1,
      quantity: 1,
      locationId: 200,
      locationType: "item" as const,
      locationFlag: "CorpSAG1",
      isSingleton: true,
      ownerType: "corporation" as const,
      ownerId: 900,
    },
  ],
]);

void test("resolves asset container, hangar, and root location IDs", () => {
  const hangar = {
    itemId: 700,
    typeId: 100,
    quantity: 1,
    locationId: 600,
    locationType: "station",
    locationFlag: "CorpSAG1",
    isSingleton: true,
    ownerType: "corporation",
    ownerId: 900,
  } satisfies AssetRecord;
  const nestedContainer = {
    ...hangar,
    itemId: 800,
    typeId: 101,
    locationId: hangar.itemId,
    locationType: "item",
  } satisfies AssetRecord;
  const asset = {
    ...hangar,
    itemId: 900,
    typeId: 102,
    locationId: nestedContainer.itemId,
    locationType: "item",
    isSingleton: false,
  } satisfies AssetRecord;
  const rootLocation = {
    locationId: 600,
    kind: "station" as const,
    resolved: true,
  };

  assert.deepEqual(
    resolveAssetLocationIds(
      asset,
      new Map<number, AssetRecord>([
        [hangar.itemId, hangar],
        [nestedContainer.itemId, nestedContainer],
        [asset.itemId, asset],
      ]),
      new Map([[nestedContainer.itemId, rootLocation]]),
    ),
    {
      containerId: nestedContainer.itemId,
      rootLocationId: rootLocation.locationId,
      hangarId: hangar.itemId,
    },
  );
});

void test("uses a CorpSAG container location ID as the structure root", () => {
  const hangarContainer = {
    itemId: 1_054_061_681_947,
    typeId: 3465,
    quantity: 1,
    locationId: 1_050_827_709_022,
    locationType: "other" as const,
    locationFlag: "CorpSAG3",
    isSingleton: true,
    ownerType: "character" as const,
    ownerId: 42,
  } satisfies AssetRecord;
  const corporationAsset = {
    itemId: 400,
    typeId: 34,
    quantity: 1,
    locationId: hangarContainer.itemId,
    locationType: "item" as const,
    locationFlag: "CorpSAG3",
    isSingleton: false,
    ownerType: "corporation" as const,
    ownerId: 900,
  } satisfies AssetRecord;

  assert.deepEqual(
    getCorporationAssetSource(
      corporationAsset,
      new Map<number, AssetRecord>([
        [hangarContainer.itemId, hangarContainer],
        [corporationAsset.itemId, corporationAsset],
      ]),
    ),
    {
      rootLocationId: hangarContainer.locationId,
      locationFlag: "CorpSAG3",
      containerItemIds: [hangarContainer.itemId],
    },
  );
});

function sourcePolicy(overrides: Partial<typeof corporationPolicy> = {}) {
  return { ...corporationPolicy, ...overrides };
}

function corporationRecord(locationId: number, itemId = 400, locationFlag = "CorpSAG1") {
  return { itemId, locationId, locationFlag };
}

void test("does not expose internal endpoint metadata to clients", () => {
  assert.deepEqual(
    toClientEndpointStatus({
      lastBody: [],
      etag: "private-etag",
      expires: "2026-08-26T17:00:00.000Z",
      status: "fresh",
    }),
    { expires: "2026-08-26T17:00:00.000Z", status: "fresh", hasBody: true },
  );
});

void test("includes direct hangar contents without including nested container contents", () => {
  const policy = sourcePolicy({
    directHangars: [{ rootLocationId: 700, locationFlag: "CorpSAG1" }],
  });
  const assets = new Map([
    ...corporationAssets,
    [
      900,
      {
        itemId: 900,
        typeId: 1,
        quantity: 1,
        locationId: 700,
        locationType: "item" as const,
        locationFlag: "OfficeFolder",
        isSingleton: true,
        ownerType: "corporation" as const,
        ownerId: 900,
      },
    ],
  ]);

  assert.equal(
    isCorporationRecordAllowed(corporationRecord(700), policy, corporationRoles, new Set(), assets),
    true,
  );
  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(900, 401, "CorpSAG1"),
      policy,
      corporationRoles,
      new Set(),
      assets,
    ),
    true,
  );
  assert.equal(
    isCorporationRecordAllowed(corporationRecord(200), policy, corporationRoles, new Set(), assets),
    false,
  );
});

void test("includes corporations represented by non-director attached characters", () => {
  assert.deepEqual(
    getCorporationIdsForCharacters([
      { corporationId: 900 },
      { corporationId: 901 },
      { corporationId: undefined },
    ]),
    new Set([900, 901]),
  );
});

void test("includes every nested level below a selected container", () => {
  const policy = sourcePolicy({ containerItemIds: [200] });

  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(700),
      policy,
      corporationRoles,
      new Set(),
      corporationAssets,
    ),
    false,
  );
  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(200),
      policy,
      corporationRoles,
      new Set(),
      corporationAssets,
    ),
    true,
  );
  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(300),
      policy,
      corporationRoles,
      new Set(),
      corporationAssets,
    ),
    true,
  );
});

void test("preserves the selected hangar through an office folder parent", () => {
  const policy = sourcePolicy({ containerItemIds: [200] });
  const roles = [
    {
      ...corporationRoles[0],
      corporationRoles: ["Hangar_Take_3", "Hangar_Query_3"],
      rolesAtOther: ["Hangar_Take_3", "Hangar_Query_3"],
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];
  const assets = new Map([
    [
      200,
      {
        itemId: 200,
        typeId: 1,
        quantity: 1,
        locationId: 900,
        locationType: "item" as const,
        locationFlag: "CorpSAG3",
        isSingleton: true,
        ownerType: "corporation" as const,
        ownerId: 900,
      },
    ],
    [
      900,
      {
        itemId: 900,
        typeId: 1,
        quantity: 1,
        locationId: 700,
        locationType: "item" as const,
        locationFlag: "OfficeFolder",
        isSingleton: true,
        ownerType: "corporation" as const,
        ownerId: 900,
      },
    ],
  ]);

  assert.equal(
    isCorporationRecordAllowed(
      { itemId: 300, locationId: 200, locationFlag: "AutoFit" },
      policy,
      roles,
      new Set(),
      assets,
    ),
    true,
  );
});

void test("does not classify container blueprints as physical containers", async () => {
  const [types, groups, marketGroups] = await Promise.all([
    getTypesByIds([27309, 32858, 33011]),
    getGroups(),
    getMarketGroups(),
  ]);

  assert.equal(isCargoContainerType(27309, types, groups, marketGroups), false);
  assert.equal(isCargoContainerType(32858, types, groups, marketGroups), false);
  assert.equal(isCargoContainerType(33011, types, groups, marketGroups), true);
});

void test("allows query-only access for blueprints but not materials", () => {
  const queryOnlyRoles = [
    {
      ...corporationRoles[0],
      corporationRoles: ["Hangar_Query_1"],
      rolesAtOther: ["Hangar_Query_1"],
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];
  const policy = sourcePolicy({
    directHangars: [{ rootLocationId: 700, locationFlag: "CorpSAG1" }],
  });

  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(700, 500),
      policy,
      queryOnlyRoles,
      new Set([500]),
      corporationAssets,
    ),
    true,
  );
  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(700, 501),
      policy,
      queryOnlyRoles,
      new Set([500]),
      corporationAssets,
    ),
    false,
  );
});

void test("limits refresh access to the hangars visible to non-directors", () => {
  const roles = [
    {
      ...corporationRoles[0],
      corporationRoles: [],
      rolesAtOther: ["Hangar_Take_2", "Hangar_Query_2"],
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];
  const assets = new Map([
    [
      700,
      {
        itemId: 700,
        typeId: 1,
        quantity: 1,
        locationId: 800,
        locationType: "item" as const,
        locationFlag: "CorpSAG2",
        isSingleton: true,
        ownerType: "corporation" as const,
        ownerId: 900,
      },
    ],
  ]);

  assert.equal(
    isCorporationRecordAccessible(
      corporationRecord(700, 401, "CorpSAG2"),
      sourcePolicy(),
      roles,
      new Set(),
      assets,
    ),
    true,
  );
  assert.equal(
    isCorporationRecordAccessible(
      corporationRecord(900, 402, "CorpSAG3"),
      sourcePolicy(),
      roles,
      new Set(),
      assets,
    ),
    false,
  );
});

void test("recognizes patched corporation delivery stock as an accessible source", () => {
  const deliveredJob = {
    jobId: 700,
    activityId: 1,
    blueprintId: 701,
    blueprintLocationId: 600,
    blueprintTypeId: 21034,
    endDate: "2026-09-14T12:00:00.000Z",
    facilityId: 600,
    installerId: 1,
    locationId: 600,
    outputLocationId: 600,
    ownerType: "corporation",
    ownerId: 900,
    productTypeId: 21035,
    runs: 10,
    startDate: "2026-09-14T11:00:00.000Z",
    status: "delivered",
  } satisfies IndustryJobRecord;
  const deliveredAsset = buildDeliveredJobAsset(deliveredJob, deliveredJob.productTypeId, 10);

  assert.deepEqual(
    deliveredAsset,
    {
      itemId: -700,
      typeId: 21035,
      quantity: 10,
      locationId: 600,
      locationType: "item",
      locationFlag: "CorpDeliveries",
      isSingleton: false,
      ownerType: "corporation",
      ownerId: 900,
      rootLocationId: 600,
      containerId: 600,
      hangarId: null,
    },
  );

  const deliveredContainerAsset = buildDeliveredJobAsset(
    deliveredJob,
    deliveredJob.productTypeId,
    10,
    undefined,
    {
      locationType: "item",
      locationFlag: "CorpSAG3",
      containerId: 1054061681947,
      rootLocationId: 1050827709022,
      hangarId: 1054061681947,
    },
  );
  assert.equal(deliveredContainerAsset.locationFlag, "CorpSAG3");
  assert.equal(deliveredContainerAsset.rootLocationId, 1050827709022);

  const deliveryRoles = [
    {
      ...corporationRoles[0],
      corporationRoles: ["Deliveries_Take", "Deliveries_Query"],
      rolesAtOther: ["Deliveries_Take", "Deliveries_Query"],
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];

  assert.equal(
    isCorporationRecordAccessible(
      deliveredAsset,
      sourcePolicy(),
      deliveryRoles,
      new Set(),
      new Map(),
    ),
    true,
  );
});

void test("does not merge delivered stock into a different container", () => {
  assert.equal(canMergeDeliveredAsset({ containerId: 100 }, { containerId: 200 }), false);
  assert.equal(canMergeDeliveredAsset({ containerId: 100 }, { containerId: 100 }), true);
});

void test("uses the hangar location rather than an outer asset for HQ roles", () => {
  const roles = [
    {
      ...corporationRoles[0],
      corporationRoles: [],
      rolesAtHq: [],
      rolesAtOther: ["Hangar_Take_2"],
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];
  const assets = new Map([
    [
      200,
      {
        itemId: 200,
        typeId: 1,
        quantity: 1,
        locationId: 700,
        locationType: "item" as const,
        locationFlag: "CorpSAG2",
        isSingleton: true,
        ownerType: "corporation" as const,
        ownerId: 900,
      },
    ],
    [
      700,
      {
        itemId: 700,
        typeId: 1,
        quantity: 1,
        locationId: 600,
        locationType: "item" as const,
        locationFlag: "OfficeFolder",
        isSingleton: true,
        ownerType: "corporation" as const,
        ownerId: 900,
      },
    ],
  ]);

  assert.equal(
    isCorporationRecordAccessible(
      { itemId: 300, locationId: 200, locationFlag: "AutoFit" },
      { ...sourcePolicy(), headquartersId: 700 },
      roles,
      new Set(),
      assets,
    ),
    false,
  );
});

void test("gives a same-corporation director access to every hangar", () => {
  const directorRoles = [
    {
      ...corporationRoles[0],
      corporationRoles: ["Director"],
      rolesAtOther: [],
      hasDirectorRole: true,
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];

  assert.equal(
    isCorporationRecordAccessible(
      corporationRecord(700, 401, "CorpSAG7"),
      sourcePolicy(),
      directorRoles,
      new Set(),
      corporationAssets,
    ),
    true,
  );
});

void test("shares corporation cache status with non-director attached characters", async () => {
  const characters = [
    {
      characterId: 9101,
      characterName: "Director Pilot",
      corporationId: 9901,
      hasDirectorRole: true,
      personalAuth: {
        refreshToken: "refresh-director",
        accessToken: "access-director",
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        scopes: [],
        lastUsedAt: 0,
      },
    },
    {
      characterId: 9102,
      characterName: "Non Director Pilot",
      corporationId: 9901,
      hasDirectorRole: false,
      personalAuth: {
        refreshToken: "refresh-member",
        accessToken: "access-member",
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        scopes: [],
        lastUsedAt: 0,
      },
    },
  ];
  const status = await getStateStatus([9101, 9102], "shared-corporation-status-test", characters);
  const directorStatus = status.characters.find((character) => character.characterId === 9101);
  const nonDirectorStatus = status.characters.find((character) => character.characterId === 9102);

  assert.deepEqual(nonDirectorStatus?.corporations, directorStatus?.corporations);
  assert.deepEqual(
    nonDirectorStatus?.corporations.map((corporation) => corporation.corporationId),
    [9901],
  );
});

void test("hides a selected root when no character can query it", () => {
  const inaccessibleRoles = [
    {
      ...corporationRoles[0],
      corporationRoles: [],
      rolesAtOther: [],
    },
  ] satisfies Parameters<typeof getCorporationHangarPermissions>[0];
  const policy = sourcePolicy({
    directHangars: [{ rootLocationId: 700, locationFlag: "CorpSAG1" }],
  });

  assert.equal(
    isCorporationRecordAllowed(
      corporationRecord(700),
      policy,
      inaccessibleRoles,
      new Set(),
      corporationAssets,
    ),
    false,
  );
});

void test("preserves selected container IDs during settings normalization", () => {
  assert.deepEqual(
    normalizeCorporationSettings([
      {
        corporationId: 900,
        supportEnabled: true,
        directHangars: [],
        containerItemIds: [300, 300, 0, Number.NaN],
      },
    ]),
    [{ corporationId: 900, supportEnabled: true, directHangars: [], containerItemIds: [300] }],
  );
});

void test("uses a slow cache for public character data and a shorter member-list cache", () => {
  assert.equal(getEsiTtlMs("/characters/42/", null, null), 24 * 60 * 60 * 1000);
  assert.equal(
    getEsiTtlMs("/corporations/777/members/?character_id=42", null, null),
    5 * 60 * 1000,
  );
});

void test("uses only response Last-Modified and Expires metadata", () => {
  const previous = setFresh(
    { value: "old" },
    new Headers({
      etag: "old-etag",
      "last-modified": "Wed, 26 Aug 2026 16:00:00 GMT",
      expires: "Wed, 26 Aug 2026 16:30:00 GMT",
    }),
  );
  const current = setFresh(
    { value: "new" },
    new Headers({
      etag: "new-etag",
      "last-modified": "Wed, 26 Aug 2026 16:55:00 GMT",
      expires: "Wed, 26 Aug 2026 17:00:00 GMT",
    }),
    previous,
  );

  assert.equal(current.lastModified, "2026-08-26T16:55:00.000Z");
  assert.ok(current.lastUpdated);
  assert.ok(Date.parse(current.lastUpdated) <= Date.now());
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
  assert.equal(current.etag, "new-etag");
});

void test("does not preserve Last-Modified when the response omits it", () => {
  const current = setFresh(
    [],
    new Headers({ expires: "Wed, 26 Aug 2026 17:00:00 GMT" }),
    {
      lastBody: [],
      lastModified: "2026-08-26T16:00:00.000Z",
      expires: "2026-08-26T16:30:00.000Z",
      status: "stale",
    },
  );

  assert.equal(current.lastModified, undefined);
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
});

void test("blocks a current ship ID without requiring a location snapshot", () => {
  const knownItemIds = getKnownNonStructureItemIds(new Set([100]), 200);

  assert.equal(knownItemIds.has(100), true);
  assert.equal(knownItemIds.has(200), true);
  assert.equal(knownItemIds.has(300), false);
});

void test("identifies only documented station IDs as station locations", () => {
  assert.equal(isStationLocationId(59_999_999), false);
  assert.equal(isStationLocationId(60_000_000), true);
  assert.equal(isStationLocationId(69_999_999), true);
  assert.equal(isStationLocationId(70_000_000), false);
  assert.equal(isStationLocationId(1_050_000_000_001), false);
});

void test("only probes unknown non-item roots as structures", () => {
  const assetItemIds = new Set([1_050_000_000_001]);

  assert.equal(isStructureLocationCandidate(60_000_000, "other", assetItemIds), false);
  assert.equal(isStructureLocationCandidate(1_050_000_000_001, "other", assetItemIds), false);
  assert.equal(isStructureLocationCandidate(1_050_000_000_002, "other", assetItemIds), true);
  assert.equal(isStructureLocationCandidate(30_000_142, "solar_system", assetItemIds), false);
});

void test("preserves Last-Modified when a 304 response omits it", () => {
  const current = setFresh(
    [],
    new Headers({ expires: "Wed, 26 Aug 2026 17:00:00 GMT" }),
    {
      lastBody: [],
      lastModified: "2026-08-26T16:00:00.000Z",
      expires: "2026-08-26T16:30:00.000Z",
      status: "stale",
    },
    true,
  );

  assert.equal(current.lastModified, "2026-08-26T16:00:00.000Z");
  assert.ok(current.lastUpdated);
  assert.ok(Date.parse(current.lastUpdated) > Date.parse("2026-08-26T16:00:00.000Z"));
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
});

void test("expiry takes precedence when determining stale status", () => {
  assert.equal(endpointDataStatus("2026-08-26T16:59:59.000Z", "2020-01-01T00:00:00.000Z"), "stale");
});

void test("deducts each newer sell order once using its original quantity", () => {
  const orders = [
    {
      orderId: 1,
      typeId: 34,
      locationId: 600_000_001,
      issuedAt: "2026-08-26T15:00:00.000Z",
      volumeRemain: 100,
      volumeTotal: 100,
      isBuyOrder: false,
      ownerType: "character" as const,
      ownerId: 42,
    },
    {
      orderId: 2,
      typeId: 34,
      locationId: 600_000_001,
      issuedAt: "2026-08-26T17:00:00.000Z",
      volumeRemain: 40,
      volumeTotal: 100,
      isBuyOrder: false,
      ownerType: "character" as const,
      ownerId: 42,
    },
    {
      orderId: 3,
      typeId: 34,
      locationId: 600_000_001,
      issuedAt: "2026-08-26T18:00:00.000Z",
      volumeRemain: 100,
      volumeTotal: 100,
      isBuyOrder: true,
      ownerType: "character" as const,
      ownerId: 42,
    },
  ];
  const first = getMarketOrderAssetDeductions(orders, "2026-08-26T16:00:00.000Z");
  const second = getMarketOrderAssetDeductions(orders, "2026-08-26T16:00:00.000Z");

  assert.equal(first.get("34:600000001"), 100);
  assert.deepEqual([...second], [...first]);
});

void test("uses the resolved root location for installed-job asset deductions", () => {
  const rootLocation = {
    locationId: 600,
    kind: "structure" as const,
    resolved: true,
  };

  assert.equal(getJobAssetRootLocationId(new Map([[9001, rootLocation]]), 9001), 600);
  assert.equal(getJobAssetRootLocationId(new Map(), 600), 600);
});

void test("keeps the source record character ahead of merged root-cache metadata", () => {
  assert.equal(
    getStructureResolverCharacterId(
      {
        ownerType: "character",
        ownerId: 42,
        recordType: "job",
        discoveredByCharacterId: 42,
      },
      { discoveredByCharacterId: 84 },
    ),
    42,
  );
  assert.equal(
    getStructureResolverCharacterId(
      { ownerType: "character", ownerId: 42, recordType: "job" },
      { discoveredByCharacterId: 84 },
    ),
    84,
  );
});

void test("builds an undocked current ship with a solar-system root", () => {
  const asset = buildCurrentShipAsset(
    {
      characterId: 42,
      itemId: 9_001,
      name: "Active ship",
      typeId: 587,
    },
    { solarSystemId: 30_000_142 },
  );

  assert.equal(asset.itemId, 9_001);
  assert.equal(asset.locationId, 30_000_142);
  assert.equal(asset.locationType, "solar_system");
  assert.equal(asset.locationFlag, "Pilot");
  assert.deepEqual(
    asset.rootLocation,
    {
      locationId: 30_000_142,
      kind: "solar_system",
      discoveredByCharacterId: 42,
      systemId: 30_000_142,
      resolved: true,
    },
  );
});

void test("only includes assets from haulable ship holds in planning stock", () => {
  assert.equal(isHaulableShipHoldAsset({ locationFlag: "Cargo" }), true);
  assert.equal(isHaulableShipHoldAsset({ locationFlag: "SpecializedMiningHold" }), false);
  assert.equal(isHaulableShipHoldAsset({ locationFlag: "DroneBay" }), false);
});

void test("builds a docked current ship with its known system", () => {
  const asset = buildCurrentShipAsset(
    {
      characterId: 42,
      itemId: 9_002,
      name: "Docked ship",
      typeId: 587,
    },
    {
      solarSystemId: 30_000_142,
      structureId: 1_050_000_000_001,
    },
  );

  assert.equal(asset.locationId, 1_050_000_000_001);
  assert.equal(asset.locationType, "structure");
  assert.deepEqual(
    asset.rootLocation,
    {
      locationId: 1_050_000_000_001,
      kind: "structure",
      discoveredByCharacterId: 42,
      systemId: 30_000_142,
      resolved: false,
    },
  );
});
