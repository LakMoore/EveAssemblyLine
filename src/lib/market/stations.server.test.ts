import assert from "node:assert/strict";
import test from "node:test";
import type { AssetLocation } from "@/lib/auth/model";
import { emptyActivitiesRequest } from "@/lib/planning/facilities";
import {
  filterMarketStationOptions,
  getKnownMarketStructureLocations,
  getResolvedStructureSearchOptions,
  type MarketStationSearchOption,
} from "./stations.server";

const stations: MarketStationSearchOption[] = [
  {
    stationId: 60_003_760,
    name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    systemName: "Jita",
    kind: "station",
  },
  {
    stationId: 60_002_959,
    name: "Jita IV - Moon 10 - Caldari Constructions Production Plant",
    systemName: "Jita",
    kind: "station",
  },
  {
    stationId: 60_008_494,
    name: "Amarr VIII (Oris) - Emperor Family Academy",
    systemName: "Amarr",
    kind: "station",
  },
];

test("matches every partial station-name term and ranks prefix matches first", () => {
  const matches = filterMarketStationOptions([stations[2], stations[1], stations[0]], "jita navy");

  assert.deepEqual(
    matches.map((station) => station.stationId),
    [60_003_760],
  );
  assert.equal(filterMarketStationOptions(stations, "amarr")[0].stationId, 60_008_494);
});

test("limits station search results", () => {
  assert.equal(filterMarketStationOptions(stations, "moon", 1).length, 1);
});

test("includes only structures resolved from cached asset roots", () => {
  const rootLocations = new Map<number, AssetLocation>([
    [
      1_000_000_000_001,
      {
        locationId: 1_000_000_000_001,
        kind: "structure",
        name: "Example Trade Keepstar",
        systemId: 30_000_142,
        resolved: true,
      },
    ],
    [
      1_000_000_000_002,
      {
        locationId: 1_000_000_000_002,
        kind: "structure",
        resolved: false,
      },
    ],
  ]);

  assert.deepEqual(
    getResolvedStructureSearchOptions(rootLocations, new Map([[30_000_142, "Jita"]])),
    [
      {
        stationId: 1_000_000_000_001,
        name: "Example Trade Keepstar",
        systemName: "Jita",
        kind: "structure",
      },
    ],
  );
});

test("retains persisted resolved structures and excludes persisted NPC stations", async () => {
  const structureId = 1_050_827_868_452;
  const locations = await getKnownMarketStructureLocations(
    [],
    "test",
    [
      {
        locationId: structureId,
        systemId: 30_002_059,
        name: "Guru Foundry",
        typeId: 35_836,
        rigTypeIds: [46_640],
        activities: emptyActivitiesRequest,
      },
      {
        locationId: 60_003_760,
        systemId: 30_000_142,
        name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
        rigTypeIds: [1],
        activities: emptyActivitiesRequest,
      },
    ],
  );

  assert.equal(locations.get(structureId)?.name, "Guru Foundry");
  assert.equal(locations.has(60_003_760), false);
});
