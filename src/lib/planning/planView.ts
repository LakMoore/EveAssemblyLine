import type { PlanResult, PlanSourceCounts, PlanSourceIcon } from "@/lib/planning/types";

export type PlanItemEntry = PlanResult["lists"]["planItems"][number];
export type PlanBuyEntry =
  | PlanResult["lists"]["materialsToBuy"][number]
  | PlanResult["lists"]["bpcsToBuy"][number];
type MaterialValues = Omit<Extract<PlanItemEntry, { kind: "material" }>, "kind">;

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
 * @param entries Plan rows from one or more planner stockpiles.
 * @param buildLocationId Build location to retain on the merged rows.
 * @param totalAvailableStockByTypeId Full eligible stock for the global view.
 * @returns One aggregated row per type ID and row kind.
 */
export function mergePlanItemEntries(
  entries: PlanItemEntry[],
  buildLocationId?: number,
  totalAvailableStockByTypeId?: Record<string, number>,
): PlanItemEntry[] {
  const merged = new Map<string, PlanItemEntry>();
  for (const entry of entries) {
    const existing = merged.get(planEntryKey(entry));
    if (!existing) {
      merged.set(planEntryKey(entry), withoutPlanContext(entry, buildLocationId));
      continue;
    }
    if (entry.kind === "material" && existing.kind === "material") {
      merged.set(planEntryKey(entry), mergeMaterialEntries(existing, entry));
    }
    else if (entry.kind === "bpc" && existing.kind === "bpc") {
      merged.set(planEntryKey(entry), mergeBpcEntries(existing, entry));
    }
    else if (entry.kind === "reaction" && existing.kind === "reaction") {
      merged.set(planEntryKey(entry), mergeReactionEntries(existing, entry));
    }
  }
  const rows = [...merged.values()].map((entry) => {
    if (
      buildLocationId !== undefined
      || totalAvailableStockByTypeId === undefined
      || entry.kind !== "material"
    ) {
      return entry;
    }
    const availableStockQuantity = totalAvailableStockByTypeId[String(entry.typeId)] ?? 0;
    return {
      ...entry,
      availableStockQuantity,
      remainingStockQuantity: Math.max(0, availableStockQuantity - entry.stockQuantity),
    };
  });
  return rows.sort(
    (left, right) => left.name.localeCompare(right.name) || left.typeId - right.typeId,
  );
}

/**
 * Merge Buy rows that represent the same type across planner stockpiles.
 *
 * @param entries Material and BPC purchase rows from the planner.
 * @returns One aggregated purchase row per type ID.
 */
export function mergeBuyEntries(entries: PlanBuyEntry[]): PlanBuyEntry[] {
  const merged = new Map<string, PlanBuyEntry>();
  for (const entry of entries) {
    const existing = merged.get(buyEntryKey(entry));
    if (!existing) {
      merged.set(buyEntryKey(entry), { ...entry });
      continue;
    }

    if ("bpoCount" in entry && "bpoCount" in existing) {
      merged.set(buyEntryKey(entry), mergeBuyBpcEntries(existing, entry));
      continue;
    }

    if (!("bpoCount" in entry) && !("bpoCount" in existing)) {
      merged.set(buyEntryKey(entry), mergeBuyMaterialEntries(existing, entry));
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.typeId - right.typeId,
  );
}

function planEntryKey(entry: PlanItemEntry) {
  return `${entry.kind}:${entry.typeId}`;
}

function buyEntryKey(entry: PlanBuyEntry) {
  return `${"bpoCount" in entry ? "bpc" : "material"}:${entry.typeId}`;
}

function withoutPlanContext(entry: PlanItemEntry, buildLocationId?: number): PlanItemEntry {
  return {
    ...entry,
    stockpileId: undefined,
    stockpileName: undefined,
    buildLocationId,
    stockLocationId: undefined,
  };
}

function mergeMaterialValues(existing: MaterialValues, entry: MaterialValues) {
  return {
    ...existing,
    quantity: existing.quantity + entry.quantity,
    requiredQuantity: existing.requiredQuantity + entry.requiredQuantity,
    stockQuantity: existing.stockQuantity + entry.stockQuantity,
    availableStockQuantity: existing.availableStockQuantity + entry.availableStockQuantity,
    productionQuantity: existing.productionQuantity + entry.productionQuantity,
    reprocessingQuantity: (existing.reprocessingQuantity ?? 0) + (entry.reprocessingQuantity ?? 0),
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
  };
}

function mergeMaterialEntries(
  existing: Extract<PlanItemEntry, { kind: "material" }>,
  entry: Extract<PlanItemEntry, { kind: "material" }>,
) {
  return { kind: "material" as const, ...mergeMaterialValues(existing, entry) };
}

function mergeBpcEntries(
  existing: Extract<PlanItemEntry, { kind: "bpc" }>,
  entry: Extract<PlanItemEntry, { kind: "bpc" }>,
) {
  return {
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
  };
}

function mergeReactionEntries(
  existing: Extract<PlanItemEntry, { kind: "reaction" }>,
  entry: Extract<PlanItemEntry, { kind: "reaction" }>,
) {
  return {
    ...existing,
    runsNeeded: existing.runsNeeded + entry.runsNeeded,
    availableQuantity: existing.availableQuantity + entry.availableQuantity,
    availableSourceCounts: mergeSourceCounts(
      existing.availableSourceCounts,
      entry.availableSourceCounts,
    ),
  };
}

function mergeBuyMaterialEntries(
  existing: Extract<PlanBuyEntry, { requiredQuantity: number }>,
  entry: Extract<PlanBuyEntry, { requiredQuantity: number }>,
) {
  return mergeMaterialValues(existing, entry);
}

function mergeBuyBpcEntries(
  existing: Extract<PlanBuyEntry, { bpoCount: number }>,
  entry: Extract<PlanBuyEntry, { bpoCount: number }>,
) {
  return {
    ...existing,
    quantity: existing.quantity + entry.quantity,
    neededQuantity: existing.neededQuantity + entry.neededQuantity,
    stockQuantity: existing.stockQuantity + entry.stockQuantity,
    stockRuns: existing.stockRuns + entry.stockRuns,
    buyQuantity: Math.max(
      0,
      existing.neededQuantity + entry.neededQuantity - existing.stockRuns - entry.stockRuns,
    ),
    bpoCount: existing.bpoCount + entry.bpoCount,
    availableSourceCounts: mergeSourceCounts(
      existing.availableSourceCounts,
      entry.availableSourceCounts,
    ),
  };
}

/**
 * Group Buy rows by the localized market category used by the assets view.
 *
 * @param entries Aggregated planner purchase rows.
 * @param marketCategoryByTypeId Market category metadata keyed by type ID.
 * @returns Sorted market-category groups containing sorted purchase rows.
 */
export function groupBuyEntriesByMarketCategory(
  entries: PlanBuyEntry[],
  marketCategoryByTypeId: Map<number, string>,
): Map<string, PlanBuyEntry[]> {
  const grouped = new Map<string, PlanBuyEntry[]>();
  for (const entry of entries) {
    const marketCategory = marketCategoryByTypeId.get(entry.typeId) ?? "Other";
    const categoryEntries = grouped.get(marketCategory) ?? [];
    categoryEntries.push(entry);
    grouped.set(marketCategory, categoryEntries);
  }
  return new Map(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, categoryEntries]) => [
        category,
        categoryEntries.sort(
          (left, right) => left.name.localeCompare(right.name) || left.typeId - right.typeId,
        ),
      ]),
  );
}

/**
 * Group plan rows by build location and aggregate duplicate types within each group.
 *
 * @param entries Plan rows from all planner stockpiles.
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
