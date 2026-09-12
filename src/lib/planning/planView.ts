import type {
  PlanJobInput,
  PlanJobInputs,
  PlanHaulExclusion,
  PlanResponse,
  StockOwnerType,
} from "@/lib/planning/types";

export interface HaulItemExclusionDetails {
  neededQuantity: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
}

export type HaulItemExclusion = ReadonlyMap<string, HaulItemExclusionDetails>;

/** Creates the stable identity used to retain one excluded haul item across plan requests. */
export function createHaulItemExclusionKey(
  sourceRootLocationId: number,
  itemTypeId: number,
  destinationLocationId: number,
  ownerType?: StockOwnerType,
  ownerId?: number,
): string {
  const ownerKey =
    ownerType !== undefined && ownerId !== undefined ? `:${ownerType}:${ownerId}` : "";
  return `${sourceRootLocationId}:${itemTypeId}:${destinationLocationId}${ownerKey}`;
}

/** Parses a haul exclusion key into the source, type, and destination it represents. */
export function parseHaulItemExclusionKey(key: string): {
  sourceRootLocationId: number;
  itemTypeId: number;
  destinationLocationId: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
} | null {
  const parts = key.split(":");
  if (parts.length !== 3 && parts.length !== 5) return null;
  const sourceRootLocationId = Number(parts[0]);
  const itemTypeId = Number(parts[1]);
  const destinationLocationId = Number(parts[2]);
  if (
    !Number.isSafeInteger(sourceRootLocationId)
    || !Number.isSafeInteger(itemTypeId)
    || !Number.isSafeInteger(destinationLocationId)
    || sourceRootLocationId <= 0
    || itemTypeId <= 0
    || destinationLocationId <= 0
  ) {
    return null;
  }
  if (parts.length === 3) return { sourceRootLocationId, itemTypeId, destinationLocationId };
  const ownerId = Number(parts[4]);
  if (
    (parts[3] !== "character" && parts[3] !== "corporation")
    || !Number.isSafeInteger(ownerId)
    || ownerId <= 0
  ) return null;
  return {
    sourceRootLocationId,
    itemTypeId,
    destinationLocationId,
    ownerType: parts[3],
    ownerId,
  };
}

/** Converts UI haul exclusions into the route-scoped planner request contract. */
export function toPlanHaulExclusions(exclusions: HaulItemExclusion): PlanHaulExclusion[] {
  return [...exclusions].flatMap(([key]) => {
    const parsed = parseHaulItemExclusionKey(key);
    if (!parsed) return [];
    return [
      {
        typeId: parsed.itemTypeId,
        fromLocationId: parsed.sourceRootLocationId,
        toLocationId: parsed.destinationLocationId,
        ...(parsed.ownerType ? { ownerType: parsed.ownerType } : {}),
        ...(parsed.ownerId !== undefined ? { ownerId: parsed.ownerId } : {}),
      },
    ];
  });
}
/** Removes excluded haul quantities from a cached response until the next calculation completes. */
export function applyHaulItemExclusionsToPlan(
  plan: PlanResponse,
  exclusions: HaulItemExclusion,
): PlanResponse {
  const excludedByType = new Map<number, number>();
  const excludedByLocationAndType = new Map<string, number>();
  for (const bucket of plan.lists.haulingTasks) {
    for (const item of bucket.items) {
      const key = createHaulItemExclusionKey(
        bucket.fromLocationId,
        item.typeId,
        bucket.toLocationId,
        bucket.ownerType,
        bucket.ownerId,
      );
      if (!exclusions.has(key)) continue;
      excludedByType.set(item.typeId, (excludedByType.get(item.typeId) ?? 0) + item.neededQuantity);
      const locationKey = `${bucket.toLocationId}:${item.typeId}`;
      excludedByLocationAndType.set(
        locationKey,
        (excludedByLocationAndType.get(locationKey) ?? 0) + item.neededQuantity,
      );
    }
  }
  if (excludedByType.size === 0) return plan;

  const updateEntry = (
    entry: PlanResponse["lists"]["planItems"]["all"][number],
    quantity: number,
    includeHaulingAvailability: boolean,
  ) => {
    const availableQuantity =
      includeHaulingAvailability && entry.kind === "material"
        ? Math.max(0, entry.availableQuantity - quantity)
        : entry.availableQuantity;
    return {
      ...entry,
      haulingQuantity: Math.max(0, entry.haulingQuantity - quantity),
      availableQuantity,
      ...(includeHaulingAvailability && entry.kind === "material"
        ? {
            neededQuantity: Math.max(0, entry.neededQuantity + quantity - entry.surplusQuantity),
            surplusQuantity: Math.max(0, entry.surplusQuantity - quantity),
          }
        : {}),
    };
  };
  return {
    ...plan,
    lists: {
      ...plan.lists,
      planItems: {
        all: plan.lists.planItems.all.map((entry) =>
          updateEntry(entry, excludedByType.get(entry.typeId) ?? 0, false),
        ),
        byActivityLocation: plan.lists.planItems.byActivityLocation.map((bucket) => ({
          ...bucket,
          items: bucket.items.map((entry) =>
            updateEntry(
              entry,
              bucket.locationId === undefined
                ? 0
                : (excludedByLocationAndType.get(`${bucket.locationId}:${entry.typeId}`) ?? 0),
              bucket.locationId !== undefined,
            ),
          ),
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
