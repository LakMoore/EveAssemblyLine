import type { PlanResult, PlanSourceCounts, PlanSourceIcon } from "@/lib/planning/types";

export type PlanItemEntry = PlanResult["lists"]["planItems"][number];

/**
 * Return haul quantity not already represented by in-production stock.
 *
 * @param haulingQuantity Total quantity represented by haul tasks.
 * @param productionQuantity Quantity in the haul tasks that comes from production output.
 * @returns Quantity that should receive a separate haul indicator.
 */
export function getNonProductionHaulingQuantity(
  haulingQuantity: number,
  productionQuantity: number,
): number {
  return Math.max(0, haulingQuantity - productionQuantity);
}

/**
 * Merge plan rows that represent the same type within one view scope.
 *
 * @param entries Plan rows from one or more planner buckets.
 * @param buildLocationId Build location to retain on the merged rows.
 * @returns One aggregated row per type ID and row kind.
 */
export function mergePlanItemEntries(
  entries: PlanItemEntry[],
  buildLocationId?: number,
): PlanItemEntry[] {
  const merged = new Map<number, PlanItemEntry>();
  for (const entry of entries) {
    const existing = merged.get(entry.typeId);
    if (!existing) {
      merged.set(
        entry.typeId,
        {
          ...entry,
          bucketId: undefined,
          bucketName: undefined,
          buildLocationId,
          stockLocationId: undefined,
        },
      );
      continue;
    }
    if (existing.kind !== entry.kind) continue;
    if (entry.kind === "material" && existing.kind === "material") {
      merged.set(
        entry.typeId,
        {
          ...existing,
          quantity: existing.quantity + entry.quantity,
          requiredQuantity: existing.requiredQuantity + entry.requiredQuantity,
          stockQuantity: existing.stockQuantity + entry.stockQuantity,
          availableStockQuantity: existing.availableStockQuantity + entry.availableStockQuantity,
          productionQuantity: existing.productionQuantity + entry.productionQuantity,
          buildQuantity: existing.buildQuantity + entry.buildQuantity,
          buyQuantity: existing.buyQuantity + entry.buyQuantity,
          remainingStockQuantity: existing.remainingStockQuantity + entry.remainingStockQuantity,
          remainingProductionQuantity:
            existing.remainingProductionQuantity + entry.remainingProductionQuantity,
          fromMarketOrder: existing.fromMarketOrder || entry.fromMarketOrder,
          availableSourceCounts: mergeSourceCounts(
            existing.availableSourceCounts,
            entry.availableSourceCounts,
          ),
        },
      );
    }
    else if (entry.kind === "bpc" && existing.kind === "bpc") {
      merged.set(
        entry.typeId,
        {
          ...existing,
          neededQuantity: existing.neededQuantity + entry.neededQuantity,
          stockQuantity: existing.stockQuantity + entry.stockQuantity,
          stockRuns: existing.stockRuns + entry.stockRuns,
          buyQuantity: existing.buyQuantity + entry.buyQuantity,
          bpoCount: existing.bpoCount + entry.bpoCount,
          availableSourceCounts: mergeSourceCounts(
            existing.availableSourceCounts,
            entry.availableSourceCounts,
          ),
        },
      );
    }
    else if (entry.kind === "reaction" && existing.kind === "reaction") {
      merged.set(
        entry.typeId,
        {
          ...existing,
          runsNeeded: existing.runsNeeded + entry.runsNeeded,
          availableQuantity: existing.availableQuantity + entry.availableQuantity,
          availableSourceCounts: mergeSourceCounts(
            existing.availableSourceCounts,
            entry.availableSourceCounts,
          ),
        },
      );
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.typeId - right.typeId,
  );
}

/**
 * Group plan rows by build location and aggregate duplicate types within each group.
 *
 * @param entries Plan rows from all planner buckets.
 * @returns Aggregated plan rows keyed by build location ID.
 */
export function groupPlanItemEntriesByBuildLocation(
  entries: PlanItemEntry[],
): Map<number | undefined, PlanItemEntry[]> {
  const entriesByLocation = new Map<number | undefined, PlanItemEntry[]>();
  for (const entry of entries) {
    const locationEntries = entriesByLocation.get(entry.buildLocationId) ?? [];
    locationEntries.push(entry);
    entriesByLocation.set(entry.buildLocationId, locationEntries);
  }
  return new Map(
    [...entriesByLocation.entries()].map(([locationId, locationEntries]) => [
      locationId,
      mergePlanItemEntries(locationEntries, locationId),
    ]),
  );
}

function mergeSourceCounts(
  left: PlanSourceCounts | undefined,
  right: PlanSourceCounts | undefined,
): PlanSourceCounts | undefined {
  const counts: PlanSourceCounts = { ...left };
  for (const [source, count] of Object.entries(right ?? {})) {
    const sourceIcon = source as PlanSourceIcon;
    counts[sourceIcon] = (counts[sourceIcon] ?? 0) + count;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}
