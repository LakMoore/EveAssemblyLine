/** Fixed hub identities; station owners verified against ESI and owner factions against CCP SDE. */
export const marketHubs = [
  {
    id: "jita",
    name: "Jita",
    regionId: 10000002,
    stationId: 60_003_760,
    systemId: 30000142,
    corporationId: 1000035,
    corporationName: "Caldari Navy",
    factionId: 500001,
    factionName: "Caldari State",
  },
  {
    id: "amarr",
    name: "Amarr",
    regionId: 10000043,
    stationId: 60_008_494,
    systemId: 30002187,
    corporationId: 1000086,
    corporationName: "Emperor Family",
    factionId: 500003,
    factionName: "Amarr Empire",
  },
  {
    id: "hek",
    name: "Hek",
    regionId: 10000042,
    stationId: 60_005_686,
    systemId: 30002053,
    corporationId: 1000057,
    corporationName: "Boundless Creation",
    factionId: 500002,
    factionName: "Minmatar Republic",
  },
  {
    id: "dodixie",
    name: "Dodixie",
    regionId: 10000032,
    stationId: 60_011_866,
    systemId: 30002659,
    corporationId: 1000120,
    corporationName: "Federation Navy",
    factionId: 500004,
    factionName: "Gallente Federation",
  },
  {
    id: "rens",
    name: "Rens",
    regionId: 10000030,
    stationId: 60_004_588,
    systemId: 30002510,
    corporationId: 1000049,
    corporationName: "Brutor Tribe",
    factionId: 500002,
    factionName: "Minmatar Republic",
  },
] as const;

export type MarketHubId = (typeof marketHubs)[number]["id"];

/** PLEX's global market overrides regional and station selections for this type only.
 * @see https://esi.evetech.net/latest/universe/regions/19000001/
 * @see https://esi.evetech.net/latest/universe/types/44992/
 */
export const globalPlexMarket = {
  typeId: 44992,
  regionId: 19000001,
  name: "Global PLEX market",
} as const;
