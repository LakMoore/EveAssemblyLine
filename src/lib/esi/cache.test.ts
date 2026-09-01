import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCurrentShipAsset,
  endpointDataStatus,
  getMarketOrderAssetDeductions,
  getKnownNonStructureItemIds,
  setFresh,
} from "./cache";

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
