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
  const adjustedQuantityPerRun = materialQuantity * efficiencyMultiplier * materialMultiplier;
  return Math.max(1, Math.ceil(adjustedQuantityPerRun)) * runs;
}
