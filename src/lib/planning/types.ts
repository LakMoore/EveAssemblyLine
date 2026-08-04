import type { SdeLanguage } from "@/lib/reference/languages";

export interface BuildItem {
  typeId: number;
  name: string;
  quantity: number;
  me: number;
  te: number;
}

export interface PlanStockItem {
  typeId: number;
  name: string;
  quantity: number;  // this is the number of items in the stack (not the number of runs)
  runCount?: number;
  blueprintPrints?: BlueprintPrint[];
  sourceLocationId?: number;
  sourceLocationName?: string;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  locationResolved?: boolean;
  category?: "bpo" | "bpc" | "reaction" | "item";
}

export interface BlueprintPrint {
  itemId: number;
  runs: number;
  me?: number;
  te?: number;
}

export interface PlanRequest {
  language?: SdeLanguage;
  items: BuildItem[];
  stock?: PlanStockItem[];
  assets?: PlanStockItem[];
  locations?: { manufacturing: number; reactions: number; market: number };
  settings: {
    includeCorporationAssets: boolean;
    buildBlacklist: number[];
    buyBlacklist: number[];
    defaultMe: number;
    defaultTe: number;
  };
}

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
        }
      | {
          kind: "reaction";
          typeId: number;
          name: string;
          runsNeeded: number;
          availableQuantity: number;
        }
    >;
    materialsToBuy: Array<{
      typeId: number;
      name: string;
      quantity: number;
      requiredQuantity: number;
      stockQuantity: number;
      availableStockQuantity: number;
      buildQuantity: number;
      buyQuantity: number;
      remainingStockQuantity: number;
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
      locationResolved?: boolean;
    }>;
  };
}
