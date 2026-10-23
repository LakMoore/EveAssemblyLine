import type { StockItem } from "@/lib/planning/types";

/** Counts physical blueprint originals, copies, and remaining copy runs by SDE type. */
export type BlueprintCounts = {
  bpoCount: number;
  bpcCount: number;
  bpcRuns: number;
  availableBpoCount: number;
  availableBpcRuns: number;
};

/** Physical reaction formula quantities and those currently free to use. */
export type ReactionFormulaCounts = { totalCount: number; availableCount: number };

/** Includes physical stock visible to the current collection and ownership view. */
export function isCountableBlueprintStock(item: StockItem, mode: "visible" | "owned"): boolean {
  if (
    (item.category !== "blueprint" && item.category !== "reactionformula")
    || item.inBuild
    || item.source === "marketOrder"
  ) return false;
  return (
    mode !== "owned" || item.ownerType !== "corporation" || Boolean(item.corporationSource?.canTake)
  );
}

/** Counts selected-source formulas, excluding query-only corporation stock in owned mode. */
export function countReactionFormulas(
  assets: readonly StockItem[],
  mode: "visible" | "owned",
): Map<number, ReactionFormulaCounts> {
  const counts = new Map<number, ReactionFormulaCounts>();
  for (const item of assets) {
    if (item.category !== "reactionformula" || !isCountableBlueprintStock(item, mode)) {
      continue;
    }
    const current = counts.get(item.typeId) ?? { totalCount: 0, availableCount: 0 };
    const quantity = Math.max(0, Math.floor(item.quantity));
    current.totalCount += quantity;
    if (!item.inUse) current.availableCount += quantity;
    counts.set(item.typeId, current);
  }
  return counts;
}

/** Aggregates selected-source blueprint stock, excluding query-only corporation stock in owned mode. */
export function countBlueprints(
  assets: readonly StockItem[],
  mode: "visible" | "owned",
): Map<number, BlueprintCounts> {
  const counts = new Map<number, BlueprintCounts>();
  for (const item of assets) {
    if (item.category !== "blueprint" || !isCountableBlueprintStock(item, mode)) continue;
    const current = counts.get(item.typeId) ?? {
      bpoCount: 0,
      bpcCount: 0,
      bpcRuns: 0,
      availableBpoCount: 0,
      availableBpcRuns: 0,
    };
    if (item.blueprintType === "bpo") {
      current.bpoCount += item.quantity;
      if (!item.inUse) current.availableBpoCount += item.quantity;
    }
    else {
      current.bpcCount += item.quantity;
      const runs =
        item.blueprintPrints?.reduce((total, print) => total + Math.max(0, print.runs), 0) ?? 0;
      current.bpcRuns += runs;
      if (!item.inUse) current.availableBpcRuns += runs;
    }
    counts.set(item.typeId, current);
  }
  return counts;
}

/** Picks a copy image when runs are available, otherwise the original image. */
export function blueprintImageVariation(counts: BlueprintCounts | undefined): "bpc" | "bp" {
  if (counts && counts.availableBpcRuns > 0) return "bpc";
  return "bp";
}
