export type PlannerLocations = {
  manufacturing: number;
  reactions: number;
  market: number;
  reprocessing?: number;
  copying?: number;
  invention?: number;
  structures: KnownStructure[];
};

export type KnownStructure = {
  id: string;
  systemId: number;
  systemName: string;
  securityStatus?: number;
  type: string;
  typeId?: number;
  size: "Small" | "Medium" | "Large" | "Extra Large";
  sizeId?: number;
  name: string;
  rigs: string[];
  rigTypeIds?: number[];
  esiStructureId?: number;
  allowStandardBuilds?: boolean;
  allowCapitalBuilds?: boolean;
  allowReprocessing?: boolean;
  allowReactionBuilds?: boolean;
  allowBiochemicalReactions?: boolean;
  allowCompositeReactions?: boolean;
  allowHybridReactions?: boolean;
  allowInvention?: boolean;
  allowResearch?: boolean;
  jobTypes?: import("./facilities").FacilityJobTypes;
  settingsLastModified?: string;
};

export type PlannerSettings = {
  includeCorporationAssets: boolean;
  personalSellOrdersAsStock: boolean;
  allCorporationSellOrdersAsStock: boolean;
  myCorporationSellOrdersAsStock: boolean;
  respectActiveJobs: boolean;
  buildBlacklist: import("@/lib/reference/types").TypeMetadata[];
  defaultMe: number;
  defaultTe: number;
};

export const defaultLocations: PlannerLocations = {
  manufacturing: 60003760,
  reactions: 30000142,
  market: 60008494,
  reprocessing: 60003760,
  copying: 60003760,
  invention: 60003760,
  structures: [],
};

export const defaultSettings: PlannerSettings = {
  includeCorporationAssets: true,
  personalSellOrdersAsStock: true,
  allCorporationSellOrdersAsStock: true,
  myCorporationSellOrdersAsStock: true,
  respectActiveJobs: true,
  buildBlacklist: [],
  defaultMe: 10,
  defaultTe: 20,
};

export const locationsStorageKey = "assembly-line-locations";
export const settingsStorageKey = "assembly-line-settings";
