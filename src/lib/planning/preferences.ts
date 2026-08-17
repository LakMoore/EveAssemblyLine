export type PlannerLocations = {
  manufacturing: number;
  reactions: number;
  market: number;
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
  allowReactionBuilds?: boolean;
  allowBiochemicalReactions?: boolean;
  allowCompositeReactions?: boolean;
  allowHybridReactions?: boolean;
  allowInvention?: boolean;
  allowResearch?: boolean;
  standardTaxRate?: number;
  capitalTaxRate?: number;
  reactionTaxRate?: number;
  biochemicalTaxRate?: number;
  compositeTaxRate?: number;
  hybridTaxRate?: number;
  inventionTaxRate?: number;
  researchTaxRate?: number;
  settingsLastModified?: string;
};

export type PlannerSettings = {
  includeCorporationAssets: boolean;
  personalSellOrdersAsStock: boolean;
  allCorporationSellOrdersAsStock: boolean;
  myCorporationSellOrdersAsStock: boolean;
  respectActiveJobs: boolean;
  defaultMe: number;
  defaultTe: number;
};

export const defaultLocations: PlannerLocations = {
  manufacturing: 60003760,
  reactions: 30000142,
  market: 60008494,
  structures: [],
};

export const defaultSettings: PlannerSettings = {
  includeCorporationAssets: true,
  personalSellOrdersAsStock: true,
  allCorporationSellOrdersAsStock: true,
  myCorporationSellOrdersAsStock: true,
  respectActiveJobs: true,
  defaultMe: 10,
  defaultTe: 20,
};

export const locationsStorageKey = "assembly-line-locations";
export const settingsStorageKey = "assembly-line-settings";
