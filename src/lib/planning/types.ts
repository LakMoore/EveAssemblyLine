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
  quantity: number;
  sourceLocationId?: number;
  sourceLocationName?: string;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  locationResolved?: boolean;
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
    materialsToBuy: Array<{
      typeId: number;
      name: string;
      quantity: number;
      requiredQuantity: number;
      stockQuantity: number;
      remainingStockQuantity: number;
      locationId?: number;
    }>;
    bpcsNeeded: Array<{ typeId: number; name: string; quantity: number }>;
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
