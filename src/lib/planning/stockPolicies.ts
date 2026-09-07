import type { PlanStockItem } from "./types";

/** Returns the effective root location used for stock allocation and hauling. */
export function getStockRootLocationId(item: PlanStockItem) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

/** Identifies item stock representing output from a manufacturing or reaction job. */
export function isIndustryProductionOutput(item: PlanStockItem) {
  const activity = item.activityName?.toLowerCase();
  return (
    item.inBuild === true
    && item.jobId !== undefined
    && item.category === "item"
    && (activity === "manufacturing" || activity === "reactions" || activity === "reaction")
  );
}

/** Identifies production output that is ready to be consumed as ordinary stock. */
export function isUsableIndustryProductionOutput(item: PlanStockItem) {
  if (!isIndustryProductionOutput(item)) return true;
  return item.industryJobStatus === "ready" || item.industryJobStatus === "delivered";
}

/** Identifies production output that has not been cancelled or reverted. */
export function isAvailableIndustryProductionOutput(item: PlanStockItem) {
  if (!isIndustryProductionOutput(item)) return true;
  return item.industryJobStatus !== "cancelled" && item.industryJobStatus !== "reverted";
}

/** Identifies stock that must be reserved at a reaction or blueprint location. */
export function isBlueprintOrReactionFormula(item: PlanStockItem) {
  return item.category === "blueprint" || item.category === "reactionformula";
}
