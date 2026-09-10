import type { PlanJobInput, PlanJobInputs, PlanStockItem } from "@/lib/planning/types";

export type HaulItemExclusion = ReadonlyMap<string, number>;

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
