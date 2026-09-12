import type { SdeLanguage } from "@/lib/reference/languages";
import type { AssemblyLineGroup, AssemblyLineGroups } from "@/lib/reference/assemblyLineGroups";
import type { FacilityGroupBonus } from "./facilityBonuses";
import type { ProductionGroupKey } from "./productionGroups";

// shape of build items passed between client and server
export interface PlanBuildItem {
  typeId: number;
  quantity: number;
  me: number;
  te: number;
  fromCompression: boolean;
}

export interface PlanStockpileLocations {
  stock: number;
  manufacturing: number;
  reactions: number;
  reprocessing: number;
  copying: number;
  invention: number;
}

export type PlanActivityLocations = Omit<PlanStockpileLocations, "stock"> & {
  market: number;
};

export type PlanStockpileKind = "standard" | "special";

export interface PlanStockpile {
  id: string;
  name: string;
  kind?: PlanStockpileKind;
  stockLocationName?: string;
  locations: PlanStockpileLocations;
  groupAssignments?: Partial<Record<ProductionGroupKey, number>>;
  reprocessingEfficiencies?: Record<string, number>;
  items: PlanBuildItem[];
}

export interface PlanFacilityProfile {
  locationId: number;
  sizeId: number;
  buildTypeGroups: Partial<Record<ProductionGroupKey, FacilityGroupBonus>>;
}

// shape of the build item used on the server
export interface BuildItem extends PlanBuildItem {
  name: string;
  iconCategory?: "bpo" | "bpc" | "reactionformula" | "item";
}

// Client-side BuildItem is a BuildItem with an extra localised CategoryName
export interface ClientBuildItem extends BuildItem {
  categoryName: string;
}

export interface ClientPlanStockpile extends Omit<PlanStockpile, "items"> {
  items: ClientBuildItem[];
}

export interface PlanAssetLocation {
  locationId: number;
  rootLocationId: number;
}

export interface PlanItemInput extends PlanAssetLocation {
  typeId: number;
  quantity: number;
}

export interface PlanBlueprintInput extends PlanAssetLocation {
  itemId?: number;
  typeId: number;
  type: "bpc" | "bpo";
  quantity: number;
  runs: number;
  me?: number;
  te?: number;
}

export interface PlanIndustryInput extends PlanAssetLocation {
  jobId: number;
  blueprintId?: number;
  typeId: number;
  quantity: number;
  runs: number;
  activity: string;
  status?: IndustryJobStatus;
  blueprintTypeId?: number;
  blueprintRunsAtInstall?: number;
  licensedRuns?: number;
  installedRuns?: number;
}

export interface PlanMarketInput extends PlanAssetLocation {
  typeId: number;
  quantity: number;
}

export type StockOwnerType = "character" | "corporation";
export type BlueprintType = "bpo" | "bpc";
export type IndustryJobStatus =
  | "active"
  | "cancelled"
  | "delivered"
  | "paused"
  | "ready"
  | "reverted";

export interface StockItemBase {
  typeId: number;
  quantity: number; // this is the number of items in the stack (not the number of runs)
  locationId?: number;
  rootLocationId?: number;
  isPackaged?: boolean;
  ownerType?: StockOwnerType;
  ownerId?: number;
  inBuild?: boolean;
  inUse?: boolean;
  jobId?: number;
  industryJobStatus?: IndustryJobStatus;
  blueprintRunsAtInstall?: number;
  licensedRuns?: number;
  blueprintType?: BlueprintType;
  activityName?: string;
  jobRuns?: number;
  me?: number;
  te?: number;
  corporationSource?: {
    rootLocationId: number;
    locationFlag: string;
    containerItemIds: number[];
  };
}

export interface PlanStockItem extends StockItemBase {
  name: string;
  blueprintPrints?: BlueprintPrint[];
  sourceLocationId?: number;
  sourceLocationName?: string;
  sourceLocationKind?: "station" | "structure" | "anchored";
  sourceSystemId?: number;
  sourceSystemName?: string;
  category?: "blueprint" | "reactionformula" | "item";
  inBuildQuantity?: number;
  source?: "marketOrder";
}

export interface HaulPatch extends ResponseMaterial {
  key: string;
  fromLocationId: number;
  toLocationId: number;
  ownerType: StockOwnerType;
  ownerId: number;
  assetsLastModified?: string;
}

export interface StockItem extends PlanStockItem {
  assembledVolume?: number;
  packagedVolume?: number;
  techLevel?: number;
  assemblyLineGroup?: string;
}

export interface StockContribution extends StockItemBase {
  itemId: number;
  ownerType: StockOwnerType;
  blueprintPrint?: BlueprintPrint;
}

export interface BlueprintPrint {
  itemId: number;
  runs: number;
  type: BlueprintType;
  me?: number;
  te?: number;
  activity?: string;
}

export interface PlanRequest {
  language?: SdeLanguage;
  stockpiles: PlanStockpile[];
  reprocessingEfficiencies?: Record<string, number>;
  assets?:
    | PlanStockItem[]
    | {
        items: PlanItemInput[];
        blueprints: PlanBlueprintInput[];
        industry: PlanIndustryInput[];
        market: PlanMarketInput[];
      };
  facilityTimeMultipliers?: {
    manufacturing: number;
    reactions: number;
  };
  facilityProfiles?: PlanFacilityProfile[];
  skillTimeMultipliers?: {
    manufacturing: number;
    reactions: number;
  };
  haulExclusions?: PlanHaulExclusion[];
  settings: {
    includeCorporationAssets: boolean;
    personalSellOrdersAsStock: boolean;
    allCorporationSellOrdersAsStock: boolean;
    myCorporationSellOrdersAsStock: boolean;
    buildBlacklist: number[];
    buyBlacklist: number[];
    defaultMe: number;
    defaultTe: number;
  };
}

export type PlannerStockpile = Omit<PlanStockpile, "items"> & { items: BuildItem[] };

export type PlannerRequest = Omit<PlanRequest, "toBuild" | "assets" | "stock" | "stockpiles"> & {
  items: BuildItem[];
  stock: PlanStockItem[];
  stockpiles: PlannerStockpile[];
  groupAssignments?: Partial<Record<ProductionGroupKey, number>>;
  unresolvedAssetCount?: number;
};

export type PlanSourceIcon = "market" | "industry" | "invention" | "copying" | "reprocessing";
export type PlanSourceCounts = Partial<Record<PlanSourceIcon, number>>;
export type PlanSourceCountsByLocation = Partial<Record<number, PlanSourceCounts>>;
export type PlanSourceCountsByType = Map<number, PlanSourceCountsByLocation>;
export type PlanJobInputKind = "blueprint" | "material";
export type PlanJobInputStatus = "ready" | "partial" | "blocked";

export interface PlanJobInput {
  kind: PlanJobInputKind;
  typeId: number;
  name: string;
  availableQuantity: number;
  inBuildQuantity?: number;
  requiredQuantity: number;
  completionPercent: number;
  status: PlanJobInputStatus;
}

export interface PlanJobInputs {
  blueprint: PlanJobInput;
  materials: PlanJobInput[];
  bpoCount: number;
  bpcRuns: number;
  completionPercent: number;
  status: PlanJobInputStatus;
}

export type PlanSkillRequirement = {
  skillId: number;
  name: string;
  requiredLevel: number;
};

interface ResponseMetadata {
  generatedAt: string;
  planId?: string;
  unresolvedAssetCount?: number;
  corporationAssetSources?: number[];
}

interface ResponseJob {
  typeId: number;
  name: string;
  countNeeded: number;
}

interface ResponseJobManufacturing extends ResponseJob {
  inputs: PlanJobInputs;
  runsAvailable: number;
  totalTime: number;
}

interface ResponseJobReprocessing extends ResponseJob {
  efficiency: number;
}

interface PlanJob extends ResponseJob {
  locationId?: number;
}

interface PlanJobManufacturing extends PlanJob {
  inputs: PlanJobInputs;
  runsAvailable: number;
  totalTime: number;
  locationId?: number;
}

interface PlanJobReprocessing extends ResponseJobReprocessing {
  locationId?: number;
}

export interface ResponseMaterial {
  typeId: number;
  typeName: string;
  unitVolume: number;
  neededQuantity: number;
  inBuildQuantity?: number;
}

export type ResponseMaterialBucket<T extends ResponseMaterial = ResponseMaterial> =
  AssemblyLineGroup<T>;

export type ResponseHaulTask = ResponseMaterial & {
  fromLocationId: number;
  toLocationId: number;
  ownerType?: "character" | "corporation";
  ownerId?: number;
};

export interface PlanHaulExclusion {
  typeId: number;
  fromLocationId: number;
  toLocationId: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
}

export type PlanHaulTask = ResponseHaulTask & {
  source?: "production";
};

export interface ResponsePlanMaterial extends ResponseMaterial {
  kind: "material";
  requiredQuantity: number;
  availableQuantity: number;
  surplusQuantity: number;
  availableSourceCounts?: PlanSourceCountsByLocation;
  haulingQuantity: number;
}

export interface ResponsePlanBlueprint extends ResponseMaterial {
  kind: "bpc";
  requiredQuantity: number;
  availableQuantity: number;
  surplusQuantity: number;
  availableSourceCounts?: PlanSourceCountsByLocation;
  haulingQuantity: number;
  bpoCount: number;
  bposInUse: number;
  buildTime: number;
}

export interface ResponsePlanReaction extends ResponseMaterial {
  kind: "reaction";
  requiredQuantity: number;
  availableQuantity: number;
  surplusQuantity: number;
  availableSourceCounts?: PlanSourceCountsByLocation;
  haulingQuantity: number;
  bpoCount: number;
  bposInUse: number;
}

export type ResponsePlanItem = ResponsePlanMaterial | ResponsePlanBlueprint | ResponsePlanReaction;

export interface ResponseMaterialBuy extends ResponseMaterial {}

export interface ResponseBlueprintBuy extends ResponseMaterialBuy {
  bpoCount: number;
  bposInUse: number;
}

export interface ResponseBlueprintCopy extends ResponseBlueprintBuy {}

export interface ResponseLocationBucket<T> {
  locationId?: number;
  items: T[];
}

export type ResponseItem<T> = T extends unknown
  ? Omit<T, "activityLocationId" | "stockpileLocationId" | "locationId">
  : never;

export interface ResponseHaulBucket {
  fromLocationId: number;
  toLocationId: number;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  items: ResponseMaterial[];
}

export interface ResponsePlanItems {
  all: ResponsePlanItem[];
  byActivityLocation: ResponseLocationBucket<ResponsePlanItem>[];
}

export interface PlanCalculationBase {
  typeId: number;
  unitVolume: number;
  availableSourceCounts?: PlanSourceCountsByLocation;
  activityLocationId?: number;
  stockpileLocationId?: number;
}

export type PlanMaterial = PlanCalculationBase & {
  quantity: number;
  requiredQuantity: number;
  stockQuantity: number;
  availableStockQuantity: number;
  productionQuantity: number;
  reprocessingQuantity?: number;
  buyQuantity: number;
  remainingProductionQuantity: number;
};

export type PlanCalculationBlueprint = PlanCalculationBase & {
  neededQuantity: number;
  stockQuantity: number;
  stockRuns: number;
  buyQuantity: number;
  bpoCount: number;
  bposInUse?: number;
  buildTime: number;
};

export type PlanCalculationReaction = PlanCalculationBase & {
  runsNeeded: number;
  availableQuantity: number;
  bpoCount: number;
  bposInUse: number;
};

export type PlanCalculationItem =
  | (PlanMaterial & { kind: "material" })
  | (PlanCalculationBlueprint & { kind: "bpc" })
  | (PlanCalculationReaction & { kind: "reaction" });

export interface PlanCalculationLists {
  planItems: PlanCalculationItem[];
  materialsToBuy: PlanMaterial[];
  bpcsNeeded: PlanCalculationBlueprint[];
  bpcsToBuy: PlanCalculationBlueprint[];
  inventionJobs: PlanJob[];
  reactionJobs: PlanJobManufacturing[];
  manufacturingJobs: PlanJobManufacturing[];
  reprocessingJobs: PlanJobReprocessing[];
  skillsRequired: PlanSkillRequirement[];
  haulingTasks: PlanHaulTask[];
}

/** Calculation state retained only until the authoritative response is assembled. */
export interface PlanCalculation {
  metadata: ResponseMetadata;
  lists: PlanCalculationLists;
  availableSourceCountsByType?: PlanSourceCountsByType;
  availableStockQuantitiesByLocationAndType?: Map<string, number>;
  availableStockQuantitiesByType?: Map<number, number>;
}

export type PlanResponse = {
  metadata: ResponseMetadata;
  lists: {
    planItems: ResponsePlanItems;
    materialsToBuy: AssemblyLineGroups<ResponseMaterialBuy>;
    bpcToCopy: ResponseLocationBucket<ResponseBlueprintCopy>[];
    bpoToBuy: AssemblyLineGroups<ResponseBlueprintBuy>;
    inventionJobs: ResponseLocationBucket<ResponseJob>[];
    reactionJobs: ResponseLocationBucket<ResponseJobManufacturing>[];
    manufacturingJobs: ResponseLocationBucket<ResponseJobManufacturing>[];
    reprocessingJobs: ResponseLocationBucket<ResponseJobReprocessing>[];
    haulingTasks: ResponseHaulBucket[];
    skillsRequired: PlanSkillRequirement[];
  };
};
