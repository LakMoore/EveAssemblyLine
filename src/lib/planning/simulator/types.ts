import type { PlanRequest, StockOwnerType } from "@/lib/planning/types";

/** Activity kinds represented by simulator ledgers and schedules. */
export type SimulationActivity =
  | "manufacturing"
  | "reaction"
  | "copying"
  | "invention"
  | "reprocessing"
  | "stock"
  | "surplus";

/** Availability horizons used to prevent projected stock from becoming physical stock. */
export type SupplyHorizon = "now" | "after-hauling" | "after-upstream" | "after-purchase";

/** Per-character capacity and skill snapshot supplied by the client. */
export interface SimulationCharacterProfile {
  characterId: number;
  freeSlots: {
    manufacturing: number;
    reactions: number;
    science: number;
  };
  timeMultipliers: {
    manufacturing: number;
    reactions: number;
    copying: number;
    invention: number;
  };
  skillLevels: Record<string, number>;
}

/** Location-specific science activity modifiers absent from the legacy request. */
export interface SimulationScienceProfile {
  locationId: number;
  copyingDurationMultiplier: number;
  copyingMaterialMultiplier: number;
  inventionDurationMultiplier: number;
  inventionMaterialMultiplier: number;
}

/** Versioned policy controls for deterministic simulation. */
export interface SimulationPolicyV1 {
  inventionExpectedOutputFactor: number;
  fallbackInventionSkillLevel: number;
  decryptorTypeIdByProductBlueprintTypeId: Record<string, number>;
  maxGraphNodes: number;
  maxGraphDepth: number;
}

/** Additive simulator controls carried beside the current planning request. */
export interface SimulationOptionsV1 {
  version: 1;
  includeSurplusForAllLocations: boolean;
  characters: SimulationCharacterProfile[];
  scienceProfiles: SimulationScienceProfile[];
  policy: SimulationPolicyV1;
}

/** Public request accepted by the versioned simulator endpoint. */
export interface SimulationRequestV1 extends PlanRequest {
  simulation: SimulationOptionsV1;
}

/** Stable, readiness-aware provenance for one planned material requirement. */
export interface SimulationDemandSource {
  demandId: string;
  stockpileId: string;
  materialTypeId: number;
  productTypeId: number;
  productQuantity: number;
  plannedQuantity: number;
  requiredNow: number;
  reserved: number;
  destinationLocationId: number;
  activity: Exclude<SimulationActivity, "surplus">;
  demandingJobId?: string;
}

/** Presentation-ready balance for one material type at one physical location. */
export interface SimulationMaterialBalance {
  typeId: number;
  typeName: string;
  unitVolume: number;
  locationId: number;
  requiredNow: number;
  reserved: number;
  availableNow: number;
  availableFromHauling: number;
  availableFromProduction: number;
  availableFromCopying: number;
  availableFromInvention: number;
  availableFromReprocessing: number;
  availableFromMarket: number;
  transferredOut: number;
  unsatisfied: number;
  surplus: number;
  demandSources: SimulationDemandSource[];
}

/** Location bucket containing simulator material rows for direct presentation. */
export interface SimulationMaterialLocationBucket {
  locationId: number;
  items: SimulationMaterialBalance[];
}

/** Identifies the upstream activity and quantity reserved for an input. */
export type SimulationUpstreamSupplyState = "in-production" | "paused" | "planned";

/** Identifies the upstream activity, quantity, and execution state reserved for an input. */
export interface SimulationUpstreamReservation {
  activity: "manufacturing" | "reaction";
  quantity: number;
  state: SimulationUpstreamSupplyState;
}

/** Exact material requirement and availability for an industry allocation. */
export interface SimulationJobInput {
  typeId: number;
  typeName: string;
  requiredQuantity: number;
  availableNow: number;
  availableFromHauling: number;
  availableAfterUpstream: number;
  unsatisfiedQuantity: number;
  upstreamReservations?: readonly SimulationUpstreamReservation[];
  purchaseQuantity?: number;
}

/** Blueprint or reaction formula selected for an industry allocation. */
export interface SimulationBlueprintAllocation {
  blueprintTypeId: number;
  blueprintItemId?: number;
  blueprintKind: "bpo" | "bpc" | "formula" | "fallback";
  sourceLocationId?: number;
  runs: number;
  materialEfficiency: number;
  timeEfficiency: number;
}

/** One install assigned to a character slot. */
export interface SimulationInstall {
  installId: string;
  characterId: number;
  slotIndex: number;
  runs: number;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  durationSeconds: number;
  readiness: SupplyHorizon;
  inputs: SimulationJobInput[];
}

/** Fully calculated manufacturing or reaction job row. */
export interface SimulationIndustryJob {
  jobId: string;
  activity: "manufacturing" | "reaction";
  stockpileId: string;
  locationId: number;
  productTypeId: number;
  productName: string;
  blueprint: SimulationBlueprintAllocation;
  outputPerRun: number;
  requiredRuns: number;
  readyNowRuns: number;
  readyAfterHaulingRuns: number;
  readyAfterUpstreamRuns: number;
  blockedRuns: number;
  unscheduledRuns: number;
  materialMultiplier: number;
  timeMultiplier: number;
  durationPerRunSeconds: number;
  inputs: SimulationJobInput[];
  installs: SimulationInstall[];
  demandSources: SimulationDemandSource[];
}

/** Fully calculated invention work required for an output blueprint. */
export interface SimulationInventionJob {
  jobId: string;
  stockpileId: string;
  locationId: number;
  sourceBlueprintTypeId: number;
  outputBlueprintTypeId: number;
  attempts: number;
  successProbability: number;
  runsPerSuccess: number;
  requiredOutputRuns: number;
  targetExpectedRuns: number;
  expectedOutputRuns: number;
  materialEfficiency: number;
  timeEfficiency: number;
  decryptorTypeId?: number;
  skillSource: "request" | "fallback-level-3";
  durationSeconds: number;
  inputs: SimulationJobInput[];
  assignments: SimulationScienceAssignment[];
  unscheduledAttempts: number;
}

/** Fully calculated copying work required for downstream blueprint runs. */
export interface SimulationCopyJob {
  jobId: string;
  stockpileId: string;
  locationId: number;
  blueprintTypeId: number;
  sourceBlueprintItemId?: number;
  copies: number;
  licensedRunsPerCopy: number;
  totalLicensedRuns: number;
  durationSeconds: number;
  inputs: SimulationJobInput[];
  assignments: SimulationScienceAssignment[];
  unscheduledCopies: number;
}

/** One copying or invention job assigned to a character science slot. */
export interface SimulationScienceAssignment {
  assignmentId: string;
  characterId: number;
  slotIndex: number;
  units: number;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  durationSeconds: number;
}

/** Selected reprocessing source and all resulting material yields. */
export interface SimulationReprocessingJob {
  jobId: string;
  stockpileId: string;
  locationId: number;
  sourceLotId?: string;
  sourceTypeId: number;
  sourceTypeName: string;
  sourceQuantity: number;
  portionCount: number;
  efficiency: number;
  state: "local" | "after-hauling" | "after-purchase";
  yields: Array<{ typeId: number; typeName: string; quantity: number; allocatedQuantity: number }>;
}

/** One job's contribution to an aggregated haul task. */
export interface SimulationHaulDemand {
  jobId?: string;
  quantity: number;
}

/** Physical haul requirement aggregated by source, type, and owner. */
export interface SimulationHaulTask {
  transferId: string;
  lotId: string;
  typeId: number;
  typeName: string;
  blueprintKind?: "bpo" | "bpc" | "formula";
  quantity: number;
  unitVolume: number;
  fromLocationId: number;
  toLocationId: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
  purpose: "industry-input" | "completion" | "reprocessing-input";
  demands: SimulationHaulDemand[];
}

/** One destination contribution retained under an aggregated purchase row. */
export interface SimulationPurchaseDestination {
  stockpileId: string;
  locationId: number;
  quantity: number;
  demandingJobId?: string;
  purpose: "material" | "blueprint" | "reprocessing-input";
}

/** Locationless aggregate purchase with complete destination provenance. */
export interface SimulationPurchase {
  typeId: number;
  typeName: string;
  assemblyLineGroup: string;
  unitVolume: number;
  quantity: number;
  destinations: SimulationPurchaseDestination[];
}

/** Skill requirement with the jobs that introduced it. */
export interface SimulationSkillRequirement {
  skillId: number;
  name: string;
  requiredLevel: number;
  jobIds: string[];
}

/** Typed non-fatal simulation diagnostic. */
export interface SimulationWarning {
  code:
    | "cycle-detected"
    | "graph-limit-exceeded"
    | "missing-sde-data"
    | "missing-blueprint"
    | "missing-facility"
    | "missing-capacity"
    | "fallback-blueprint"
    | "fallback-invention-skills"
    | "unresolved-asset"
    | "blocked-by-policy"
    | "invariant-violation";
  message: string;
  typeId?: number;
  locationId?: number;
  jobId?: string;
}

/** Auditable summary of one location's canonical material ledger. */
export interface SimulationLedgerView {
  ledgerId: string;
  locationId: number;
  balances: SimulationMaterialBalance[];
}

/** Versioned native simulator result; all rows are ready for direct presentation. */
export interface SimulationResultV1 {
  metadata: {
    simulatorVersion: 1;
    policyVersion: 1;
    generatedAt: string;
    sdeRevision: string;
    normalizedInputHash: string;
    elapsedMilliseconds: number;
    warningCount: number;
    invariantViolationCount: number;
    unresolvedAssetCount: number;
  };
  lists: {
    warnings: SimulationWarning[];
    planItems: SimulationMaterialLocationBucket[];
    surplusItems: SimulationMaterialLocationBucket[];
    haulingTasks: SimulationHaulTask[];
    materialsToBuy: SimulationPurchase[];
    bpoToBuy: SimulationPurchase[];
    reprocessingJobs: SimulationReprocessingJob[];
    bpcToCopy: SimulationCopyJob[];
    inventionJobs: SimulationInventionJob[];
    reactionJobs: SimulationIndustryJob[];
    manufacturingJobs: SimulationIndustryJob[];
    skillsRequired: SimulationSkillRequirement[];
  };
  /** Development-only diagnostic projection; never required for presentation. */
  ledgers?: SimulationLedgerView[];
}

/** Internal simulator result with the diagnostic ledger projection available. */
export type SimulationResultWithDiagnostics = SimulationResultV1 & {
  ledgers: SimulationLedgerView[];
};
