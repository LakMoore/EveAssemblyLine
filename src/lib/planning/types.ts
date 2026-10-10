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
  isIncluded?: boolean;
}

export interface ClientPlanStockpile extends Omit<PlanStockpile, "items"> {
  isActive?: boolean;
  items: ClientBuildItem[];
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
  isShip?: boolean;
  isCargoContainer?: boolean;
  ownerType?: StockOwnerType;
  ownerId?: number;
  inBuild?: boolean;
  inUse?: boolean;
  jobId?: number;
  industryJobStatus?: IndustryJobStatus;
  industryJobEndDate?: string;
  blueprintRunsAtInstall?: number;
  licensedRuns?: number;
  blueprintType?: BlueprintType;
  activityName?: string;
  jobRuns?: number;
  marketOrderIssuerId?: number;
  marketOrderSide?: "buy" | "sell";
  me?: number;
  te?: number;
  corporationSource?: {
    rootLocationId: number;
    locationFlag: string;
    containerItemIds: number[];
    canTake?: boolean;
    canQuery?: boolean;
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
  futureReprocessingOutput?: boolean;
  source?: "marketOrder";
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

export type PlanJobInputKind = "blueprint" | "material";
export type PlanJobInputStatus = "ready" | "partial" | "blocked";

export interface PlanJobInput {
  kind: PlanJobInputKind;
  typeId: number;
  name: string;
  availableQuantity: number;
  inBuildQuantity?: number;
  reprocessingQuantity?: number;
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

export interface PlanHaulExclusion {
  typeId: number;
  fromLocationId: number;
  toLocationId: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
}
