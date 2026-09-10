import type {
  PlanJobInput,
  PlanJobInputs,
  PlanResponse,
  PlanStockItem,
  StockOwnerType,
} from "@/lib/planning/types";

export interface HaulItemExclusionDetails {
  destinationLocationId: number;
  neededQuantity: number;
  originalSourceQuantity: number;
  retainedSourceQuantity: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
}

export type HaulItemExclusion = ReadonlyMap<string, HaulItemExclusionDetails>;

/** Creates the stable identity used to retain one excluded haul item across plan requests. */
export function createHaulItemExclusionKey(
  sourceRootLocationId: number,
  itemTypeId: number,
  ownerType?: StockOwnerType,
  ownerId?: number,
): string {
  const ownerKey =
    ownerType !== undefined && ownerId !== undefined ? `:${ownerType}:${ownerId}` : "";
  return `${sourceRootLocationId}:${itemTypeId}${ownerKey}`;
}

/** Parses a haul exclusion key into the source and type it represents. */
export function parseHaulItemExclusionKey(key: string): {
  sourceRootLocationId: number;
  itemTypeId: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
} | null {
  const parts = key.split(":");
  if (parts.length !== 2 && parts.length !== 4) return null;
  const sourceRootLocationId = Number(parts[0]);
  const itemTypeId = Number(parts[1]);
  if (
    !Number.isSafeInteger(sourceRootLocationId)
    || !Number.isSafeInteger(itemTypeId)
    || sourceRootLocationId <= 0
    || itemTypeId <= 0
  ) {
    return null;
  }
  if (parts.length === 2) return { sourceRootLocationId, itemTypeId };
  const ownerId = Number(parts[3]);
  if (
    (parts[2] !== "character" && parts[2] !== "corporation")
    || !Number.isSafeInteger(ownerId)
    || ownerId <= 0
  ) return null;
  return {
    sourceRootLocationId,
    itemTypeId,
    ownerType: parts[2],
    ownerId,
  };
}

/** Reduces excluded source stock to the amount needed by local production. */
export function excludeHaulItemsFromStock(
  stock: readonly PlanStockItem[],
  exclusions: HaulItemExclusion,
): PlanStockItem[] {
  const remainingByKey = new Map<string, number>();
  for (const [key, exclusion] of exclusions) {
    if (parseHaulItemExclusionKey(key)) {
      remainingByKey.set(key, Math.max(0, exclusion.retainedSourceQuantity));
    }
  }

  return stock.flatMap((item) => {
    if (
      item.rootLocationId === undefined
      || item.category === "blueprint"
      || item.category === "reactionformula"
    ) return [item];
    const matchingEntry = [...exclusions.entries()].find(([key, exclusion]) => {
      const parsed = parseHaulItemExclusionKey(key);
      return (
        parsed !== null
        && parsed.sourceRootLocationId === item.rootLocationId
        && parsed.itemTypeId === item.typeId
        && (
          parsed.ownerType === undefined
          || (item.ownerType === parsed.ownerType && item.ownerId === parsed.ownerId)
        )
        && exclusion.retainedSourceQuantity >= 0
      );
    });
    if (!matchingEntry) return [item];

    const [key] = matchingEntry;
    const remaining = remainingByKey.get(key) ?? 0;
    const retainedQuantity = Math.min(item.quantity, remaining);
    remainingByKey.set(key, remaining - retainedQuantity);
    return retainedQuantity > 0 ? [{ ...item, quantity: retainedQuantity }] : [];
  });
}

/** Restores excluded source surplus in plan presentation without changing buy quantities. */
export function restoreExcludedHaulStockInPlan(
  plan: PlanResponse,
  exclusions: HaulItemExclusion,
): PlanResponse {
  const restoredByType = new Map<number, number>();
  const restoredByLocationAndType = new Map<string, number>();
  for (const [key, exclusion] of exclusions) {
    const parsed = parseHaulItemExclusionKey(key);
    if (!parsed) continue;
    const restoredQuantity = Math.max(
      0,
      exclusion.originalSourceQuantity - exclusion.retainedSourceQuantity,
    );
    if (restoredQuantity <= 0) continue;
    restoredByType.set(
      parsed.itemTypeId,
      Math.max(restoredByType.get(parsed.itemTypeId) ?? 0, restoredQuantity),
    );
    const locationKey = `${parsed.sourceRootLocationId}:${parsed.itemTypeId}`;
    restoredByLocationAndType.set(
      locationKey,
      Math.max(restoredByLocationAndType.get(locationKey) ?? 0, restoredQuantity),
    );
  }
  if (restoredByType.size === 0) return plan;

  const restoreEntry = (
    entry: PlanResponse["lists"]["planItems"]["all"][number],
    restoredQuantity: number,
  ) => ({
    ...entry,
    availableQuantity: entry.availableQuantity + restoredQuantity,
    surplusQuantity: entry.surplusQuantity + restoredQuantity,
  });
  return {
    ...plan,
    lists: {
      ...plan.lists,
      planItems: {
        all: plan.lists.planItems.all.map((entry) =>
          restoredByType.has(entry.typeId)
            ? restoreEntry(entry, restoredByType.get(entry.typeId) ?? 0)
            : entry,
        ),
        byActivityLocation: plan.lists.planItems.byActivityLocation.map((bucket) => ({
          ...bucket,
          items: bucket.items.map((entry) => {
            const restoredQuantity =
              bucket.locationId === undefined
                ? 0
                : (restoredByLocationAndType.get(`${bucket.locationId}:${entry.typeId}`) ?? 0);
            return restoredQuantity > 0 ? restoreEntry(entry, restoredQuantity) : entry;
          }),
        })),
      },
    },
  };
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
