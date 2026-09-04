import assert from "node:assert/strict";
import test from "node:test";
import { getEsiTtlMs } from "@/cache/esiTtl";
import {
  buildCurrentShipAsset,
  endpointDataStatus,
  getStateStatus,
  getMarketOrderAssetDeductions,
  getKnownNonStructureItemIds,
  isCorporationRecordAllowed,
  isCargoContainerType,
  setFresh,
} from "./cache";
import { getGroups, getMarketGroups, getTypesByIds } from "@/cache/services/sdeCache";
import { normalizeCorporationSettings } from "@/lib/auth/tokensStore";
import { getCorporationHangarPermissions } from "./corporationAccess";
import type { CorporationCollectionSettings } from "@/lib/auth/model";

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

function sourcePolicy(overrides: Partial<typeof corporationPolicy> = {}) {
  return { ...corporationPolicy, ...overrides };
}

function corporationRecord(locationId: number, itemId = 400, locationFlag = "CorpSAG1") {
  return { itemId, locationId, locationFlag };
}

test("includes direct hangar contents without including nested container contents", () => {
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

test("includes every nested level below a selected container", () => {
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

test("preserves the selected hangar through an office folder parent", () => {
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

test("does not classify container blueprints as physical containers", async () => {
  const [types, groups, marketGroups] = await Promise.all([
    getTypesByIds([27309, 32858, 33011]),
    getGroups(),
    getMarketGroups(),
  ]);

  assert.equal(isCargoContainerType(27309, types, groups, marketGroups), false);
  assert.equal(isCargoContainerType(32858, types, groups, marketGroups), false);
  assert.equal(isCargoContainerType(33011, types, groups, marketGroups), true);
});

test("allows query-only access for blueprints but not materials", () => {
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

test("shares corporation cache status with non-director attached characters", async () => {
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

test("hides a selected root when no character can query it", () => {
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

test("preserves selected container IDs during settings normalization", () => {
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

test("uses a slow cache for public character data and a shorter member-list cache", () => {
  assert.equal(getEsiTtlMs("/characters/42/", null, null), 24 * 60 * 60 * 1000);
  assert.equal(
    getEsiTtlMs("/corporations/777/members/?character_id=42", null, null),
    5 * 60 * 1000,
  );
});

test("uses only response Last-Modified and Expires metadata", () => {
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
  assert.equal(current.nextRefreshAllowed, "2026-08-26T17:00:00.000Z");
  assert.equal(current.etag, "new-etag");
});

test("does not preserve Last-Modified when the response omits it", () => {
  const current = setFresh(
    [],
    new Headers({ expires: "Wed, 26 Aug 2026 17:00:00 GMT" }),
    {
      lastBody: [],
      lastModified: "2026-08-26T16:00:00.000Z",
      expires: "2026-08-26T16:30:00.000Z",
      nextRefreshAllowed: "2026-08-26T16:30:00.000Z",
      status: "stale",
    },
  );

  assert.equal(current.lastModified, undefined);
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
});

test("blocks a current ship ID without requiring a location snapshot", () => {
  const knownItemIds = getKnownNonStructureItemIds(new Set([100]), 200);

  assert.equal(knownItemIds.has(100), true);
  assert.equal(knownItemIds.has(200), true);
  assert.equal(knownItemIds.has(300), false);
});

test("preserves Last-Modified when a 304 response omits it", () => {
  const current = setFresh(
    [],
    new Headers({ expires: "Wed, 26 Aug 2026 17:00:00 GMT" }),
    {
      lastBody: [],
      lastModified: "2026-08-26T16:00:00.000Z",
      expires: "2026-08-26T16:30:00.000Z",
      nextRefreshAllowed: "2026-08-26T16:30:00.000Z",
      status: "stale",
    },
    true,
  );

  assert.equal(current.lastModified, "2026-08-26T16:00:00.000Z");
  assert.ok(current.lastUpdated);
  assert.ok(Date.parse(current.lastUpdated) > Date.parse("2026-08-26T16:00:00.000Z"));
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
});

test("expiry takes precedence when determining stale status", () => {
  assert.equal(endpointDataStatus("2026-08-26T16:59:59.000Z", "2020-01-01T00:00:00.000Z"), "stale");
});

test("deducts each newer sell order once using its original quantity", () => {
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

test("builds an undocked current ship with a solar-system root", () => {
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
      systemId: 30_000_142,
      resolved: true,
    },
  );
});

test("builds a docked current ship with its known system", () => {
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
      systemId: 30_000_142,
      resolved: false,
    },
  );
});
