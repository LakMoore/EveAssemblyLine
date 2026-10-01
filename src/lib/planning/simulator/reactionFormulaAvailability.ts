import type { ClientJobsResponse } from "@/lib/client/requestCache";
import type { PlanStockItem } from "@/lib/planning/types";
import { simulationReactionFormulaKey } from "./clientScheduler";

/** Per-location owned, visible, in-use, and available formula counts. */
export type SimulationReactionFormulaAvailability = {
  availabilityKnown: boolean;
  ownedByLocationAndType: ReadonlyMap<string, number>;
  visibleByLocationAndType: ReadonlyMap<string, number>;
  inUseByLocationAndType: ReadonlyMap<string, number>;
  availableByLocationAndType: ReadonlyMap<string, number>;
};

type ReactionIndustryJob = Pick<
  NonNullable<ClientJobsResponse["jobs"]>[number],
  "activity" | "blueprintTypeId" | "facilityId" | "jobId" | "ownerId" | "ownerType" | "status"
>;

/** Counts located formulas and subtracts distinct unfinished reaction jobs by location and type. */
export function simulationReactionFormulaAvailability(
  stock: readonly PlanStockItem[],
  industryJobs: readonly ReactionIndustryJob[] | undefined,
  visibleStock: readonly PlanStockItem[] = stock,
): SimulationReactionFormulaAvailability {
  const ownedByLocationAndType = new Map<string, number>();
  const visibleByLocationAndType = new Map<string, number>();
  const inFlightByLocationAndType = new Map<string, number>();
  const inFlightJobKeys = new Set<string>();

  for (const item of stock) {
    if (item.category !== "reactionformula") continue;
    const isCorporationFormula =
      item.ownerType === "corporation" || item.corporationSource !== undefined;
    const canTake = !isCorporationFormula || item.corporationSource?.canTake === true;
    const quantity = Math.max(0, Math.floor(item.quantity));
    const locationId = item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
    if (locationId === undefined || !canTake) continue;
    const key = simulationReactionFormulaKey(locationId, item.typeId);
    ownedByLocationAndType.set(key, (ownedByLocationAndType.get(key) ?? 0) + quantity);
  }

  for (const item of visibleStock) {
    if (item.category !== "reactionformula") continue;
    const isCorporationFormula =
      item.ownerType === "corporation" || item.corporationSource !== undefined;
    const canQuery = !isCorporationFormula || item.corporationSource?.canQuery === true;
    const quantity = Math.max(0, Math.floor(item.quantity));
    const locationId = item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
    if (locationId === undefined || !canQuery) continue;
    const key = simulationReactionFormulaKey(locationId, item.typeId);
    visibleByLocationAndType.set(key, (visibleByLocationAndType.get(key) ?? 0) + quantity);
  }

  for (const job of industryJobs ?? []) {
    const activity = job.activity.toLowerCase();
    const status = job.status.toLowerCase();
    if (!activity.includes("reaction") || (status !== "active" && status !== "paused")) continue;
    const jobKey = `${job.ownerType}:${job.ownerId}:${job.jobId}`;
    if (inFlightJobKeys.has(jobKey)) continue;
    inFlightJobKeys.add(jobKey);
    const key = simulationReactionFormulaKey(job.facilityId, job.blueprintTypeId);
    inFlightByLocationAndType.set(key, (inFlightByLocationAndType.get(key) ?? 0) + 1);
  }

  const availableByLocationAndType = new Map<string, number>();
  if (industryJobs !== undefined) {
    const formulaKeys = new Set([
      ...visibleByLocationAndType.keys(),
      ...inFlightByLocationAndType.keys(),
    ]);
    for (const key of formulaKeys) {
      availableByLocationAndType.set(
        key,
        Math.max(
          0,
          (visibleByLocationAndType.get(key) ?? 0) - (inFlightByLocationAndType.get(key) ?? 0),
        ),
      );
    }
  }

  return {
    availabilityKnown: industryJobs !== undefined,
    ownedByLocationAndType,
    visibleByLocationAndType,
    inUseByLocationAndType: inFlightByLocationAndType,
    availableByLocationAndType,
  };
}
