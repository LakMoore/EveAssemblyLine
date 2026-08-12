import type { SdeLanguage } from "@/lib/reference/languages";

export interface BuildItem {
  typeId: number;
  name: string;
  quantity: number;
  me: number;
  te: number;
  category?: "blueprint" | "bp" | "bpo" | "bpc" | "reaction" | "item";
}

export interface PlanBuildInput {
  typeId: number;
  quantity: number;
  me: number;
  te: number;
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
}

export interface PlanMarketInput extends PlanAssetLocation {
  typeId: number;
  quantity: number;
}

export interface PlanStockItem {
  typeId: number;
  name: string;
  quantity: number;  // this is the number of items in the stack (not the number of runs)
  locationId?: number;
  rootLocationId?: number;
  techLevel?: number;
  type?: "bpo" | "bpc";
  blueprintPrints?: BlueprintPrint[];
  sourceLocationId?: number;
  sourceLocationName?: string;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  category?: "blueprint" | "bp" | "bpo" | "bpc" | "reaction" | "item";
  inBuild?: boolean;
  inBuildQuantity?: number;
  jobId?: number;
  blueprintTypeId?: number;
  blueprintIsOriginal?: boolean;
  blueprintRunsAtInstall?: number;
  licensedRuns?: number;
  activityName?: string;
  jobRuns?: number;
  source?: "marketOrder";
}

export interface BlueprintPrint {
  itemId: number;
  runs: number;
  type: "bpo" | "bpc";
  me?: number;
  te?: number;
  activity?: string;
  endDate?: string;
}

export interface PlanRequest {
  language?: SdeLanguage;
  toBuild: PlanBuildInput[];
  assets: {
    items: PlanItemInput[];
    blueprints: PlanBlueprintInput[];
    industry: PlanIndustryInput[];
    market: PlanMarketInput[];
  };
  stock?: PlanStockItem[];
  locations?: { manufacturing: number; reactions: number; market: number };
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
    haulingTasks: Array<{
      itemTypeId: number;
      name: string;
      quantity: number;
      volume: number;
      fromLocationId: number;
      toLocationId: number;
      fromLocationName?: string;
      toLocationName?: string;
      ownerType?: "character" | "corporation";
      ownerId?: number;
    }>;
  };
}
