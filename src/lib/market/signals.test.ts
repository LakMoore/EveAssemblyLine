import assert from "node:assert/strict";
import test from "node:test";
import type { AssetRecord } from "@/lib/auth/model";
import { calculateSevenDayMarketMetrics } from "@/lib/esi/marketHistory";
import { buildMarketSignals, groupMarketStationStock, type MarketStation } from "./signals";

const jita: MarketStation = {
  stationId: 60_003_760,
  name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
  systemId: 30_000_142,
  regionId: 10_000_002,
};

/** Creates a minimal cached stock asset for signal aggregation tests. */
function asset(typeId: number, quantity: number, stationId = jita.stationId): AssetRecord {
  return {
    itemId: typeId * 100,
    typeId,
    quantity,
    locationId: stationId,
    locationType: "station",
    locationFlag: "Hangar",
    isSingleton: false,
    ownerType: "character",
    ownerId: 1,
    rootLocation: { locationId: stationId, kind: "station", resolved: true },
  };
}

test("calculates a volume-weighted price and seven-calendar-day volume", () => {
  const metrics = calculateSevenDayMarketMetrics(
    [
      { date: "2026-08-28", average: 10, volume: 70 },
      { date: "2026-08-29", average: 20, volume: 140 },
      { date: "2026-08-22", average: 1, volume: 7_000 },
    ],
    new Date("2026-08-29T18:00:00Z"),
  );

  assert.equal(metrics.averagePrice, 50 / 3);
  assert.equal(metrics.dailyVolume, 30);
  assert.ok(metrics.priceStandardDeviation !== null);
  assert.ok(Math.abs(metrics.priceStandardDeviation - Math.sqrt(200 / 9)) < 1e-10);
});

test("groups only positive stock held at configured stations", () => {
  const grouped = groupMarketStationStock(
    [asset(34, 10), asset(34, 5), asset(35, 8, 60_008_494), asset(36, 0)],
    [jita],
  );

  assert.deepEqual(
    grouped,
    [{ stationId: jita.stationId, regionId: jita.regionId, typeId: 34, quantity: 15 }],
  );
});

test("groups stock held at a configured resolved structure", () => {
  const structureId = 1_000_000_000_001;
  const structureAsset = asset(34, 7, structureId);
  structureAsset.rootLocation = {
    locationId: structureId,
    kind: "structure",
    resolved: true,
  };

  assert.deepEqual(
    groupMarketStationStock([structureAsset], [{ ...jita, stationId: structureId }]),
    [{ stationId: structureId, regionId: jita.regionId, typeId: 34, quantity: 7 }],
  );
});

test("requires a sell/buy margin and average above max buy by more than one deviation", () => {
  const stock = [
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 34, quantity: 10 },
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 35, quantity: 2 },
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 36, quantity: 1 },
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 37, quantity: 1 },
  ];
  const signals = buildMarketSignals(
    stock,
    new Map([
      [`${jita.regionId}:34`, { averagePrice: 100, dailyVolume: 1_400, priceStandardDeviation: 5 }],
      [`${jita.regionId}:35`, { averagePrice: 100, dailyVolume: 500, priceStandardDeviation: 5 }],
      [
        `${jita.regionId}:36`,
        { averagePrice: null, dailyVolume: 25, priceStandardDeviation: null },
      ],
      [`${jita.regionId}:37`, { averagePrice: 100, dailyVolume: 25, priceStandardDeviation: 5 }],
    ]),
    new Map([
      [`${jita.regionId}:34`, { minSellPrice: 110, maxBuyPrice: 90 }],
      [`${jita.regionId}:35`, { minSellPrice: 90, maxBuyPrice: 90 }],
      [`${jita.regionId}:36`, { minSellPrice: 150, maxBuyPrice: 120 }],
      [`${jita.regionId}:37`, { minSellPrice: 150, maxBuyPrice: 95 }],
    ]),
    3.6,
    0,
  );

  assert.deepEqual(
    signals.map((signal) => signal.typeId),
    [34],
  );
  assert.ok(Math.abs(signals[0].totalPriceAfterTax - 1_060.4) < 1e-10);
  assert.equal(signals[0].maxBuyPrice, 90);
});

test("requires both daily market value and on-hand sell value to meet the threshold", () => {
  const stock = [
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 34, quantity: 50_000 },
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 35, quantity: 10_000 },
    { stationId: jita.stationId, regionId: jita.regionId, typeId: 36, quantity: 50_000 },
  ];
  const signals = buildMarketSignals(
    stock,
    new Map([
      [
        `${jita.regionId}:34`,
        { averagePrice: 100, dailyVolume: 50_000, priceStandardDeviation: 5 },
      ],
      [
        `${jita.regionId}:35`,
        { averagePrice: 100, dailyVolume: 50_000, priceStandardDeviation: 5 },
      ],
      [
        `${jita.regionId}:36`,
        { averagePrice: 100, dailyVolume: 49_999, priceStandardDeviation: 5 },
      ],
    ]),
    new Map([
      [`${jita.regionId}:34`, { minSellPrice: 100, maxBuyPrice: 90 }],
      [`${jita.regionId}:35`, { minSellPrice: 100, maxBuyPrice: 90 }],
      [`${jita.regionId}:36`, { minSellPrice: 100, maxBuyPrice: 90 }],
    ]),
    3.6,
    5_000_000,
  );

  assert.deepEqual(
    signals.map((signal) => signal.typeId),
    [34],
  );
});
