/** Bump when simulator calculations change to invalidate client-cached results. */
export const simulationCalculationVersion = 15;

/** Creates the simulator validator for one request, SDE revision, and calculation version. */
export function createSimulationEtag(
  normalizedInputHash: string,
  sdeRevision: string,
  calculationVersion: number,
): string {
  return `"simulation-v${calculationVersion}-${normalizedInputHash}-${encodeURIComponent(sdeRevision)}"`;
}
