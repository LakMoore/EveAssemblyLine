/** A market station saved in browser settings. */
export type ConfiguredMarketStation = {
  stationId: number;
  name: string;
};

/** Default major trade-hub stations used by the Signals tool. */
export const defaultMarketStations: ConfiguredMarketStation[] = [
  { stationId: 60_003_760, name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant" },
  { stationId: 60_008_494, name: "Amarr VIII (Oris) - Emperor Family Academy" },
  { stationId: 60_011_866, name: "Dodixie IX - Moon 20 - Federation Navy Assembly Plant" },
  { stationId: 60_004_588, name: "Rens VI - Moon 8 - Brutor Tribe Treasury" },
  { stationId: 60_005_686, name: "Hek VIII - Moon 12 - Boundless Creation Factory" },
];
