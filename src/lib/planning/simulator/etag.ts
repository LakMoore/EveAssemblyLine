/** Creates the simulator validator for one request and SDE revision. */
export function createSimulationEtag(normalizedInputHash: string, sdeRevision: string): string {
  return `"simulation-v1-${normalizedInputHash}-${encodeURIComponent(sdeRevision)}"`;
}
