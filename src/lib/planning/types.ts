import type { SdeLanguage } from "@/lib/reference/languages";

// shape of build items passed between client and server
export interface PlanBuildItem {
  typeId: number;
  quantity: number;
  me: number;
  te: number;
  fromCompression: boolean;
  reprocessingEfficiency?: number;
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
  blueprintRunsAtInstall?: number;
  licensedRuns?: number;
  blueprintType?: BlueprintType;
  activityName?: string;
  jobRuns?: number;
  me?: number;
  te?: number;
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
  toBuild: PlanBuildItem[];
  assets?: {
    items: PlanItemInput[];
    blueprints: PlanBlueprintInput[];
    industry: PlanIndustryInput[];
    market: PlanMarketInput[];
  };
  stock?: PlanStockItem[];
  locations?: {
    manufacturing: number;
    reactions: number;
    market: number;
    reprocessing?: number;
    copying?: number;
    invention?: number;
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

export type PlannerRequest = Omit<PlanRequest, "toBuild" | "assets"> & {
  items: BuildItem[];
  stock: PlanStockItem[];
};

export type PlanSourceIcon = "market" | "industry" | "invention" | "copying";
export type PlanSourceCounts = Partial<Record<PlanSourceIcon, number>>;
export type PlanSkillRequirement = {
  skillId: number;
  name: string;
  requiredLevel: number;
};

export interface PlanResult {
  metadata: {
    generatedAt: string;
    assetsLastUpdated: string | null;
    jobsLastUpdated: string | null;
    unresolvedAssetCount?: number;
    corporationAssetSources?: number[];
  };
  lists: {
    planItems: Array<
      | ({ kind: "material" } & PlanResult["lists"]["materialsToBuy"][number])
      | {
          kind: "bpc";
          typeId: number;
          name: string;
          neededQuantity: number;
          stockQuantity: number;
          stockRuns: number;
          buyQuantity: number;
          bpoCount: number;
          availableSourceCounts?: PlanSourceCounts;
        }
      | {
          kind: "reaction";
          typeId: number;
          name: string;
          runsNeeded: number;
          availableQuantity: number;
          availableSourceCounts?: PlanSourceCounts;
        }
    >;
    materialsToBuy: Array<{
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
    }>;
    bpcsNeeded: Array<{
      typeId: number;
      name: string;
      quantity: number;
      neededQuantity: number;
      stockQuantity: number;
      stockRuns: number;
      buyQuantity: number;
      bpoCount: number;
      availableSourceCounts?: PlanSourceCounts;
    }>;
    bpcsToBuy: Array<{
      typeId: number;
      name: string;
      quantity: number;
      neededQuantity: number;
      stockQuantity: number;
      stockRuns: number;
      buyQuantity: number;
      bpoCount: number;
      availableSourceCounts?: PlanSourceCounts;
    }>;
    inventionJobs: Array<{ typeId: number; name: string; runs: number; locationId?: number }>;
    reactionJobs: Array<{
      typeId: number;
      name: string;
      runs: number;
      totalTime: number;
      locationId?: number;
    }>;
    manufacturingJobs: Array<{
      typeId: number;
      name: string;
      runs: number;
      totalTime: number;
      locationId?: number;
    }>;
    skillsRequired: PlanSkillRequirement[];
    haulingTasks: Array<{
      itemTypeId: number;
      name: string;
      quantity: number;
      volume: number;
      fromLocationId: number;
      toLocationId: number;
      ownerType?: "character" | "corporation";
      ownerId?: number;
    }>;
  };
}
