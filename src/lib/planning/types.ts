import type { SdeLanguage } from "@/lib/reference/languages";
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

export interface PlanBucketLocations {
  stock: number;
  manufacturing: number;
  reactions: number;
  reprocessing: number;
  copying: number;
  invention: number;
}

export interface PlanBucket {
  id: string;
  name: string;
  stockLocationName?: string;
  locations: PlanBucketLocations;
  groupAssignments?: Partial<Record<ProductionGroupKey, number>>;
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

export interface ClientPlanBucket extends Omit<PlanBucket, "items"> {
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
  category?: "blueprint" | "reactionformula" | "item";
  inBuildQuantity?: number;
  source?: "marketOrder";
}

export interface StockItem extends PlanStockItem {
  assembledVolume?: number;
  packagedVolume?: number;
  techLevel?: number;
  marketCategory?: string;
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
  toBuild?: PlanBuildItem[];
  buckets?: PlanBucket[];
  reprocessingEfficiencies?: Record<string, number>;
  assets?:
    | PlanStockItem[]
    | {
        items: PlanItemInput[];
        blueprints: PlanBlueprintInput[];
        industry: PlanIndustryInput[];
        market: PlanMarketInput[];
      };
  /** @deprecated Use the flat assets array for current planner inputs. */
  stock?: PlanStockItem[];
  locations?: {
    manufacturing: number;
    reactions: number;
    market: number;
    reprocessing?: number;
    copying?: number;
    invention?: number;
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

export type PlannerBucket = Omit<PlanBucket, "items"> & { items: BuildItem[] };

export type PlannerRequest = Omit<PlanRequest, "toBuild" | "assets" | "stock" | "buckets"> & {
  items: BuildItem[];
  stock: PlanStockItem[];
  buckets?: PlannerBucket[];
  groupAssignments?: Partial<Record<ProductionGroupKey, number>>;
};

export type PlanSourceIcon = "market" | "industry" | "invention" | "copying";
export type PlanSourceCounts = Partial<Record<PlanSourceIcon, number>>;
export type PlanJobInputKind = "blueprint" | "material";
export type PlanJobInputStatus = "ready" | "partial" | "blocked";

export interface PlanJobInput {
  kind: PlanJobInputKind;
  typeId: number;
  name: string;
  availableQuantity: number;
  requiredQuantity: number;
  completionPercent: number;
  status: PlanJobInputStatus;
}

export interface PlanJobInputs {
  blueprint: PlanJobInput;
  materials: PlanJobInput[];
  completionPercent: number;
  status: PlanJobInputStatus;
}

export type PlanSkillRequirement = {
  skillId: number;
  name: string;
  requiredLevel: number;
};

export interface PlanResult {
  metadata: {
    generatedAt: string;
    unresolvedAssetCount?: number;
    corporationAssetSources?: number[];
    availableStockByTypeId?: Record<string, number>;
  };
  lists: {
    planItems: Array<
      | (PlanOutputContext & { kind: "material" } & PlanResult["lists"]["materialsToBuy"][number])
      | (PlanOutputContext & {
          kind: "bpc";
          typeId: number;
          name: string;
          neededQuantity: number;
          stockQuantity: number;
          stockRuns: number;
          buyQuantity: number;
          bpoCount: number;
          availableSourceCounts?: PlanSourceCounts;
        })
      | (PlanOutputContext & {
          kind: "reaction";
          typeId: number;
          name: string;
          runsNeeded: number;
          availableQuantity: number;
          availableSourceCounts?: PlanSourceCounts;
        })
    >;
    materialsToBuy: Array<
      PlanOutputContext & {
        typeId: number;
        name: string;
        quantity: number;
        requiredQuantity: number;
        stockQuantity: number;
        availableStockQuantity: number;
        productionQuantity: number;
        buildQuantity: number;
        buyQuantity: number;
        remainingStockQuantity: number;
        remainingProductionQuantity: number;
        fromMarketOrder?: boolean;
        availableSourceCounts?: PlanSourceCounts;
        imageVariation?: "icon" | "bp" | "bpc";
        locationId?: number;
      }
    >;
    bpcsNeeded: Array<
      PlanOutputContext & {
        typeId: number;
        name: string;
        quantity: number;
        neededQuantity: number;
        stockQuantity: number;
        stockRuns: number;
        buyQuantity: number;
        bpoCount: number;
        buildTime: number;
        availableSourceCounts?: PlanSourceCounts;
      }
    >;
    bpcsToBuy: Array<
      PlanOutputContext & {
        typeId: number;
        name: string;
        quantity: number;
        neededQuantity: number;
        stockQuantity: number;
        stockRuns: number;
        buyQuantity: number;
        bpoCount: number;
        buildTime: number;
        availableSourceCounts?: PlanSourceCounts;
      }
    >;
    inventionJobs: Array<
      PlanOutputContext & { typeId: number; name: string; runs: number; locationId?: number }
    >;
    reactionJobs: Array<
      PlanOutputContext & {
        typeId: number;
        name: string;
        runs: number;
        runsAvailable: number;
        totalTime: number;
        locationId?: number;
        inputs: PlanJobInputs;
      }
    >;
    manufacturingJobs: Array<
      PlanOutputContext & {
        typeId: number;
        name: string;
        runs: number;
        runsAvailable: number;
        totalTime: number;
        locationId?: number;
        inputs: PlanJobInputs;
      }
    >;
    reprocessingJobs: Array<
      PlanOutputContext & {
        typeId: number;
        name: string;
        quantity: number;
        efficiency: number;
        locationId: number;
      }
    >;
    skillsRequired: PlanSkillRequirement[];
    haulingTasks: Array<
      PlanOutputContext & {
        itemTypeId: number;
        name: string;
        quantity: number;
        productionQuantity?: number;
        volume: number;
        fromLocationId: number;
        toLocationId: number;
        ownerType?: "character" | "corporation";
        ownerId?: number;
      }
    >;
  };
}

export interface PlanOutputContext {
  bucketId?: string;
  bucketName?: string;
  buildLocationId?: number;
  stockLocationId?: number;
}
