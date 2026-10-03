export type MaterialActivity = "manufacturing" | "reaction";

export type MaterialEfficiency = {
  me: number;
};

/** Calculates the material quantity required for an activity after its modifiers. */
export function requiredMaterialQuantity(
  activity: MaterialActivity,
  materialQuantity: number,
  runs: number,
  efficiency: MaterialEfficiency,
  materialMultiplier: number,
): number {
  if (runs <= 0) return 0;
  const efficiencyMultiplier = activity === "manufacturing" ? 1 - efficiency.me / 100 : 1;
  const adjustedTotalQuantity =
    Math.ceil(materialQuantity * runs * efficiencyMultiplier) * materialMultiplier;
  return Math.max(runs, Math.ceil(adjustedTotalQuantity));
}

/** Calculates material requirements as separate installs capped at a maximum run count. */
export function requiredMaterialQuantityInBatches(
  activity: MaterialActivity,
  materialQuantity: number,
  runs: number,
  efficiency: MaterialEfficiency,
  materialMultiplier: number,
  maxRunsPerBatch: number,
): number {
  if (!Number.isSafeInteger(maxRunsPerBatch) || maxRunsPerBatch <= 0) {
    throw new RangeError("Maximum runs per batch must be a positive safe integer.");
  }

  if (runs <= 0) return 0;
  const fullBatches = Math.floor(runs / maxRunsPerBatch);
  const remainderRuns = runs % maxRunsPerBatch;
  const fullBatchQuantity = requiredMaterialQuantity(
    activity,
    materialQuantity,
    maxRunsPerBatch,
    efficiency,
    materialMultiplier,
  );
  const remainderQuantity = requiredMaterialQuantity(
    activity,
    materialQuantity,
    remainderRuns,
    efficiency,
    materialMultiplier,
  );
  return fullBatches * fullBatchQuantity + remainderQuantity;
}
