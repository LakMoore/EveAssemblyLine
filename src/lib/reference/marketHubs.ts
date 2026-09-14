export const marketHubs = [
  { id: "jita", name: "Jita", regionId: 10000002, stationId: 60_003_760 },
  { id: "amarr", name: "Amarr", regionId: 10000043, stationId: 60_008_494 },
  { id: "hek", name: "Hek", regionId: 10000042, stationId: 60_005_686 },
  { id: "dodixie", name: "Dodixie", regionId: 10000032, stationId: 60_011_866 },
  { id: "rens", name: "Rens", regionId: 10000030, stationId: 60_004_588 },
] as const;

export type MarketHubId = (typeof marketHubs)[number]["id"];
