import type {
  PlanJobInput,
  PlanJobInputs,
  PlanResponse,
  PlanResult,
  PlanStockItem,
  PlanSourceCounts,
  PlanSourceIcon,
} from "@/lib/planning/types";

export type PlanItemEntry = PlanResult["lists"]["planItems"][number];
export type PlanBuyEntry =
  | PlanResponse["lists"]["materialsToBuy"][number]
  | PlanResponse["lists"]["bpoToBuy"][number]
  | PlanResult["lists"]["materialsToBuy"][number]
  | PlanResult["lists"]["bpcsToBuy"][number];
export type HaulItemExclusion = ReadonlyMap<string, number>;
type MaterialValues = Omit<Extract<PlanItemEntry, { kind: "material" }>, "kind">;

/** Returns the quantity that a material row should display in the selected output view. */
export function getMaterialDisplayQuantity(
  material: Pick<MaterialValues, "buildQuantity" | "buyQuantity">,
  view: "plan" | "buy",
): number {
  return view === "buy" ? material.buyQuantity : material.buildQuantity || material.buyQuantity;
}

/** Creates the stable identity used to retain one excluded haul item across plan requests. */
export function createHaulItemExclusionKey(
  sourceRootLocationId: number,
  itemTypeId: number,
): string {
  return `${sourceRootLocationId}:${itemTypeId}`;
}

/** Parses a haul exclusion key into the source and type it represents. */
export function parseHaulItemExclusionKey(key: string): {
  sourceRootLocationId: number;
  itemTypeId: number;
} | null {
  const parts = key.split(":");
  if (parts.length !== 2) return null;
  const [sourceRootLocationId, itemTypeId] = parts.map(Number);
  if (
    !Number.isSafeInteger(sourceRootLocationId)
    || !Number.isSafeInteger(itemTypeId)
    || sourceRootLocationId <= 0
    || itemTypeId <= 0
  ) {
    return null;
  }
  return { sourceRootLocationId, itemTypeId };
}

/** Removes all matching source/type stock from a plan request. */
export function excludeHaulItemsFromStock(
  stock: readonly PlanStockItem[],
  exclusions: HaulItemExclusion,
): PlanStockItem[] {
  const excludedSourceAndTypeKeys = new Set(
    [...exclusions.keys()].filter((key) => parseHaulItemExclusionKey(key) !== null),
  );

  return stock.filter((item) => {
    if (
      item.rootLocationId === undefined
      || item.category === "blueprint"
      || item.category === "reactionformula"
    ) return true;
    return !excludedSourceAndTypeKeys.has(`${item.rootLocationId}:${item.typeId}`);
  });
}

export type ReactionRunAllocation = {
  installs: number;
  runs: number;
  totalRuns: number;
  availableBlueprints: number;
};

/** Split reaction runs across suggested installs without leaving a shortage. */
export function splitReactionRunAllocations(
  totalNeeded: number,
  installs: number,
  availableBlueprints: number,
): ReactionRunAllocation[] {
  const normalizedTotalNeeded = Math.max(0, Math.floor(totalNeeded));
  const normalizedInstalls = Math.max(0, Math.floor(installs));
  let remainingBlueprints = Math.max(0, Math.floor(availableBlueprints));
  if (normalizedTotalNeeded === 0 || normalizedInstalls === 0) {
    return [
      {
        installs: 0,
        runs: 0,
        totalRuns: 0,
        availableBlueprints: remainingBlueprints,
      },
    ];
  }

  const runsPerInstall = Math.floor(normalizedTotalNeeded / normalizedInstalls);
  const baseTotalRuns = normalizedInstalls * runsPerInstall;
  if (baseTotalRuns === normalizedTotalNeeded) {
    return [
      {
        installs: normalizedInstalls,
        runs: runsPerInstall,
        totalRuns: normalizedTotalNeeded,
        availableBlueprints: remainingBlueprints,
      },
    ];
  }

  const extraRuns = normalizedTotalNeeded - baseTotalRuns;
  const installsWithBaseRuns = normalizedInstalls - extraRuns;
  const allocations: ReactionRunAllocation[] = [];

  if (installsWithBaseRuns > 0) {
    const allocatedBlueprints = Math.min(remainingBlueprints, installsWithBaseRuns);
    allocations.push({
      installs: installsWithBaseRuns,
      runs: runsPerInstall,
      totalRuns: installsWithBaseRuns * runsPerInstall,
      availableBlueprints: allocatedBlueprints,
    });
    remainingBlueprints -= allocatedBlueprints;
  }

  if (extraRuns > 0) {
    allocations.push({
      installs: extraRuns,
      runs: runsPerInstall + 1,
      totalRuns: extraRuns * (runsPerInstall + 1),
      availableBlueprints: remainingBlueprints,
    });
  }

  return allocations;
}

function getSplitInputStatus(availableQuantity: number, requiredQuantity: number) {
  if (requiredQuantity <= 0 || availableQuantity >= requiredQuantity) return "ready" as const;
  return availableQuantity > 0 ? ("partial" as const) : ("blocked" as const);
}

function getSplitInput(
  input: PlanJobInput,
  sourceRuns: number,
  rowRuns: number,
  precedingRuns: number,
): PlanJobInput {
  const requiredQuantity =
    sourceRuns > 0 ? Math.ceil((input.requiredQuantity * rowRuns) / sourceRuns) : 0;
  const precedingRequiredQuantity =
    sourceRuns > 0 ? Math.ceil((input.requiredQuantity * precedingRuns) / sourceRuns) : 0;
  const remainingAvailableQuantity = Math.max(
    0,
    input.availableQuantity - precedingRequiredQuantity,
  );
  const availableQuantity =
    precedingRuns === 0
      ? Math.min(remainingAvailableQuantity, requiredQuantity)
      : remainingAvailableQuantity;
  const completionPercent =
    requiredQuantity <= 0
      ? 100
      : Math.min(100, Math.round((availableQuantity / requiredQuantity) * 100));

  return {
    ...input,
    availableQuantity,
    requiredQuantity,
    completionPercent,
    status: getSplitInputStatus(availableQuantity, requiredQuantity),
  };
}

/**
 * Recalculate material inputs for one row of a split reaction job.
 *
 * @param inputs Aggregate reaction inputs for the complete job.
 * @param sourceRuns Runs represented by the aggregate input quantities.
 * @param rowRuns Runs assigned to this split row.
 * @param precedingRuns Runs assigned to rows before this one.
 * @returns Row-specific inputs with availability consumed in row order.
 */
export function splitReactionJobInputs(
  inputs: PlanJobInputs,
  sourceRuns: number,
  rowRuns: number,
  precedingRuns: number,
): PlanJobInputs {
  const materials = inputs.materials.map((input) =>
    getSplitInput(input, sourceRuns, rowRuns, precedingRuns),
  );
  const completionPercent = Math.min(
    inputs.blueprint.completionPercent,
    ...materials.map((input) => input.completionPercent),
  );
  const status =
    completionPercent >= 100
      ? ("ready" as const)
      : completionPercent > 0
        ? ("partial" as const)
        : ("blocked" as const);
  return {
    ...inputs,
    materials,
    completionPercent,
    status,
  };
}

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

/** Return material left after stock and production have covered the plan. */
export function getMaterialSurplus(
  remainingStockQuantity: number,
  remainingProductionQuantity: number,
): number {
  return Math.max(0, remainingStockQuantity) + Math.max(0, remainingProductionQuantity);
}

/** Return the material quantity still needing purchase or production. */
export function getMaterialBuyOrBuildQuantity(
  requiredQuantity: number,
  availableStockQuantity: number,
  productionQuantity: number,
  reprocessingQuantity: number,
): number {
  const plannedProductionQuantity = Math.max(0, productionQuantity - reprocessingQuantity);
  return Math.max(0, plannedProductionQuantity, requiredQuantity - availableStockQuantity);
}

/** Return material that remains after stock and planned production cover the requirement. */
export function getMaterialOverviewSurplus(
  requiredQuantity: number,
  availableStockQuantity: number,
  productionQuantity: number,
  reprocessingQuantity: number,
): number {
  return Math.max(
    0,
    availableStockQuantity
      + Math.max(0, productionQuantity - reprocessingQuantity)
      - requiredQuantity,
  );
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

function planEntryKey(entry: PlanItemEntry) {
  return `${entry.kind}:${entry.typeId}`;
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
    buyQuantity: existing.neededQuantity + entry.neededQuantity,
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
          (left, right) =>
            getBuyEntryName(left).localeCompare(getBuyEntryName(right))
            || left.typeId - right.typeId,
        ),
      ]),
  );
}

function getBuyEntryName(entry: PlanBuyEntry) {
  return "typeName" in entry ? entry.typeName : entry.name;
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
