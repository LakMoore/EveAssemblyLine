export const marketHubs = [
  { id: "jita", name: "Jita", regionId: 10000002 },
  { id: "amarr", name: "Amarr", regionId: 10000043 },
  { id: "hek", name: "Hek", regionId: 10000042 },
  { id: "dodixie", name: "Dodixie", regionId: 10000032 },
  { id: "rens", name: "Rens", regionId: 10000030 },
] as const;

export type MarketHubId = (typeof marketHubs)[number]["id"];
