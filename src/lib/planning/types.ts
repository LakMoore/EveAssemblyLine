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

export interface HaulPatch {
  key: string;
  itemTypeId: number;
  name?: string;
  quantity: number;
  volume?: number;
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
  stockpiles?: PlanStockpile[];
  marketBuyOrderQuantities?: Record<string, number>;
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

export type PlannerStockpile = Omit<PlanStockpile, "items"> & { items: BuildItem[] };

export type PlannerRequest = Omit<PlanRequest, "toBuild" | "assets" | "stock" | "stockpiles"> & {
  items: BuildItem[];
  stock: PlanStockItem[];
  stockpiles?: PlannerStockpile[];
  groupAssignments?: Partial<Record<ProductionGroupKey, number>>;
  unresolvedAssetCount?: number;
};

export type PlanSourceIcon = "market" | "industry" | "invention" | "copying" | "reprocessing";
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

/** Detailed internal result used while allocating stock and merging stockpile plans. */
export interface PlanResult {
  metadata: {
    generatedAt: string;
    planId?: string;
    unresolvedAssetCount?: number;
    corporationAssetSources?: number[];
    availableStockByTypeId?: Record<string, number>;
  };
  lists: {
    planItems: Array<
      | (PlanBucketContext & { kind: "material" } & PlanMaterial)
      | (PlanBucketContext & {
          kind: "bpc";
          typeId: number;
          name: string;
          typeGroupId: number;
          typeGroup: string;
          unitVolume: number;
          neededQuantity: number;
          stockQuantity: number;
          stockRuns: number;
          buyQuantity: number;
          bpoCount: number;
          bposInUse?: number;
          buildTime: number;
          availableSourceCounts?: PlanSourceCounts;
        })
      | (PlanBucketContext & {
          kind: "reaction";
          typeId: number;
          name: string;
          runsNeeded: number;
          availableQuantity: number;
          availableSourceCounts?: PlanSourceCounts;
        })
    >;
    materialsToBuy: PlanMaterial[];
    bpcsNeeded: Array<
      PlanBucketContext & {
        typeId: number;
        name: string;
        typeGroupId: number;
        typeGroup: string;
        unitVolume: number;
        quantity: number;
        neededQuantity: number;
        stockQuantity: number;
        stockRuns: number;
        buyQuantity: number;
        bpoCount: number;
        bposInUse?: number;
        buildTime: number;
        availableSourceCounts?: PlanSourceCounts;
      }
    >;
    bpcsToBuy: Array<
      PlanBucketContext & {
        typeId: number;
        name: string;
        typeGroupId: number;
        typeGroup: string;
        unitVolume: number;
        quantity: number;
        neededQuantity: number;
        stockQuantity: number;
        stockRuns: number;
        buyQuantity: number;
        bpoCount: number;
        bposInUse?: number;
        buildTime: number;
        availableSourceCounts?: PlanSourceCounts;
      }
    >;
    inventionJobs: Array<
      PlanBucketContext & { typeId: number; name: string; runs: number; locationId?: number }
    >;
    reactionJobs: Array<
      PlanBucketContext & {
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
      PlanBucketContext & {
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
      PlanBucketContext & {
        typeId: number;
        name: string;
        quantity: number;
        efficiency: number;
        locationId: number;
      }
    >;
    skillsRequired: PlanSkillRequirement[];
    haulingTasks: Array<{
      itemTypeId: number;
      name: string;
      quantity: number;
      productionQuantity?: number;
      volume: number;
      fromLocationId: number;
      toLocationId: number;
      ownerType?: "character" | "corporation";
      ownerId?: number;
    }>;
  };
}

export type PlanMaterial = PlanBucketContext & {
  typeId: number;
  name: string;
  typeGroupId: number;
  typeGroup: string;
  unitVolume: number;
  quantity: number;
  requiredQuantity: number;
  stockQuantity: number;
  availableStockQuantity: number;
  productionQuantity: number;
  reprocessingQuantity?: number;
  buildQuantity: number;
  buyQuantity: number;
  remainingStockQuantity: number;
  remainingProductionQuantity: number;
  fromMarketOrder?: boolean;
  availableSourceCounts?: PlanSourceCounts;
  imageVariation?: "icon" | "bp" | "bpc";
  locationId?: number;
};

export interface PlanMaterialBuyResponse {
  typeId: number;
  typeName: string;
  typeGroupId: number;
  typeGroup: string;
  unitVolume: number;
  neededQuantity: number;
  marketBuyOrderQuantity: number;
}

export interface PlanBlueprintPurchaseResponse extends PlanMaterialBuyResponse {
  bpoCount: number;
  bposInUse: number;
}

export interface PlanBpcToCopyResponse extends PlanBlueprintPurchaseResponse {}

export interface PlanBpoBuyResponse extends PlanBlueprintPurchaseResponse {}

export type PlanMaterialPurchaseResponse = Omit<
  PlanResult["lists"]["haulingTasks"][number],
  "fromLocationId" | "toLocationId" | "ownerType" | "ownerId"
>;

export interface PlanBucketContext {
  stockpileId?: string;
  stockpileName?: string;
  buildLocationId?: number;
  stockLocationId?: number;
}

export interface PlanContextBucket<T> {
  context?: PlanBucketContext;
  items: T[];
}

export type WithoutPlanBucketContext<T> = T extends unknown
  ? Omit<T, keyof PlanBucketContext>
  : never;

export interface PlanHaulBucketResponse {
  fromLocationId: number;
  toLocationId: number;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  items: PlanMaterialPurchaseResponse[];
}

export type PlanResponse = Omit<PlanResult, "lists"> & {
  lists: Omit<
    PlanResult["lists"],
    | "planItems"
    | "materialsToBuy"
    | "bpcsNeeded"
    | "bpcsToBuy"
    | "inventionJobs"
    | "reactionJobs"
    | "manufacturingJobs"
    | "reprocessingJobs"
    | "haulingTasks"
  > & {
    planItems: PlanContextBucket<
      WithoutPlanBucketContext<PlanResult["lists"]["planItems"][number]>
    >[];
    materialsToBuy: PlanMaterialBuyResponse[];
    bpcToCopy: PlanBpcToCopyResponse[];
    bpoToBuy: PlanBpoBuyResponse[];
    inventionJobs: PlanContextBucket<
      WithoutPlanBucketContext<PlanResult["lists"]["inventionJobs"][number]>
    >[];
    reactionJobs: PlanContextBucket<
      WithoutPlanBucketContext<PlanResult["lists"]["reactionJobs"][number]>
    >[];
    manufacturingJobs: PlanContextBucket<
      WithoutPlanBucketContext<PlanResult["lists"]["manufacturingJobs"][number]>
    >[];
    reprocessingJobs: PlanContextBucket<
      WithoutPlanBucketContext<PlanResult["lists"]["reprocessingJobs"][number]>
    >[];
    haulingTasks: PlanHaulBucketResponse[];
  };
};
