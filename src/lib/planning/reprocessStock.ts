export const specialReprocessableTypeIds = [15331, 30497] as const;

/** A bounded source of reprocessable items available to the planner. */
export type ReprocessingCandidate = {
  typeId: number;
  availableQuantity: number;
  portionSize: number;
  efficiency: number;
  yields: ReadonlyMap<number, number>;
  source: "owned" | "purchase";
  volumePerUnit: number;
  quantityAtReprocessingLocation?: number;
};

/** Quantities selected for reprocessing and the material output they produce. */
export type ReprocessingAllocation = {
  consumedOwned: Map<number, number>;
  consumedPurchases: Map<number, number>;
  readyToReprocess: Map<number, number>;
  producedMaterials: Map<number, number>;
  remainingRequirements: Map<number, number>;
};

/** Output from committed reprocessing purchases before owned stock is considered. */
export type CommittedReprocessing = {
  purchased: Map<number, number>;
  producedMaterials: Map<number, number>;
};

/** Returns fractional material output from one complete reprocessing portion. */
function yieldsPerPortion(candidate: ReprocessingCandidate) {
  return new Map(
    [...candidate.yields].map(([typeId, quantity]) => [
      typeId,
      (quantity * candidate.efficiency) / 100,
    ]),
  );
}

/** Returns whole material units after combining the output from all selected portions. */
function yieldsForRuns(candidate: ReprocessingCandidate, runs: number) {
  return new Map(
    [...yieldsPerPortion(candidate)].map(([typeId, quantity]) => [
      typeId,
      Math.floor(quantity * runs),
    ]),
  );
}

/**
 * Converts every complete portion of explicitly committed purchases into future materials.
 * The full requested quantity remains a purchase even when it contains an incomplete portion.
 */
export function reprocessCommittedPurchases(
  candidates: readonly ReprocessingCandidate[],
): CommittedReprocessing {
  const purchased = new Map<number, number>();
  const producedMaterials = new Map<number, number>();
  for (const candidate of candidates) {
    purchased.set(
      candidate.typeId,
      (purchased.get(candidate.typeId) ?? 0) + candidate.availableQuantity,
    );
    const runs = Math.floor(candidate.availableQuantity / candidate.portionSize);
    for (const [typeId, quantity] of yieldsForRuns(candidate, runs)) {
      producedMaterials.set(typeId, (producedMaterials.get(typeId) ?? 0) + quantity);
    }
  }
  return { purchased, producedMaterials };
}

/** Scores how efficiently one candidate portion covers the remaining requirements. */
function candidateScore(candidate: ReprocessingCandidate, remaining: ReadonlyMap<number, number>) {
  const yields = yieldsPerPortion(candidate);
  let covered = 0;
  let surplus = 0;
  for (const [typeId, quantity] of yields) {
    const needed = remaining.get(typeId) ?? 0;
    covered += Math.min(needed, quantity);
    surplus += Math.max(0, quantity - needed);
  }
  if (covered <= 0) return undefined;
  const localRuns = Math.floor(
    (candidate.quantityAtReprocessingLocation ?? 0) / candidate.portionSize,
  );
  const haulingVolume = localRuns > 0 ? 0 : candidate.portionSize * candidate.volumePerUnit;
  return { covered, surplus, haulingVolume };
}

/** Calculates how many candidate portions can contribute to current shortages. */
function contributingRuns(
  candidate: ReprocessingCandidate,
  remaining: ReadonlyMap<number, number>,
) {
  const yields = yieldsPerPortion(candidate);
  const usefulRuns = [...yields].flatMap(([typeId, quantity]) => {
    const needed = remaining.get(typeId) ?? 0;
    return needed > 0 && quantity > 0 ? [Math.ceil(needed / quantity)] : [];
  });
  const availableRuns = Math.floor(candidate.availableQuantity / candidate.portionSize);
  if (usefulRuns.length === 0) return 0;
  const localRuns = Math.floor(
    (candidate.quantityAtReprocessingLocation ?? 0) / candidate.portionSize,
  );
  return Math.min(
    availableRuns,
    Math.min(...usefulRuns),
    localRuns > 0 ? localRuns : Number.POSITIVE_INFINITY,
  );
}

/**
 * Selects only complete reprocessing portions that contribute to material requirements.
 * Owned stock is exhausted before explicit compression purchases are considered.
 */
export function allocateReprocessing(
  requiredMaterials: ReadonlyMap<number, number>,
  candidates: readonly ReprocessingCandidate[],
): ReprocessingAllocation {
  const remainingRequirements = new Map(
    [...requiredMaterials].filter(([, quantity]) => quantity > 0),
  );
  const producedMaterials = new Map<number, number>();
  const consumedOwned = new Map<number, number>();
  const consumedPurchases = new Map<number, number>();
  const readyToReprocess = new Map<number, number>();
  const allocatedRunsByCandidate = new Map<ReprocessingCandidate, number>();

  for (const source of ["owned", "purchase"] as const) {
    const available = candidates
      .filter((candidate) => candidate.source === source)
      .map((candidate) => ({ ...candidate }));
    while ([...remainingRequirements.values()].some((quantity) => quantity > 0)) {
      const ranked = available
        .map((candidate) => ({
          candidate,
          score: candidateScore(candidate, remainingRequirements),
        }))
        .filter(
          (entry): entry is typeof entry & { score: NonNullable<typeof entry.score> } =>
            entry.score !== undefined
            && contributingRuns(entry.candidate, remainingRequirements) > 0,
        )
        .sort(
          (left, right) =>
            Number(left.score.haulingVolume > 0) - Number(right.score.haulingVolume > 0)
            || right.score.covered / (1 + right.score.haulingVolume)
              - left.score.covered / (1 + left.score.haulingVolume)
            || left.score.surplus - right.score.surplus
            || left.candidate.typeId - right.candidate.typeId,
        );
      const selectedEntry = ranked.at(0);
      if (!selectedEntry) break;
      const selected = selectedEntry.candidate;

      const runs = contributingRuns(selected, remainingRequirements);
      const consumedQuantity = runs * selected.portionSize;
      const localQuantity = Math.min(
        consumedQuantity,
        selected.quantityAtReprocessingLocation ?? 0,
      );
      selected.availableQuantity -= consumedQuantity;
      selected.quantityAtReprocessingLocation = Math.max(
        0,
        (selected.quantityAtReprocessingLocation ?? 0) - consumedQuantity,
      );
      const consumed = source === "owned" ? consumedOwned : consumedPurchases;
      consumed.set(selected.typeId, (consumed.get(selected.typeId) ?? 0) + consumedQuantity);
      if (source === "owned" && localQuantity > 0) {
        readyToReprocess.set(
          selected.typeId,
          (readyToReprocess.get(selected.typeId) ?? 0) + localQuantity,
        );
      }
      const previouslyAllocatedRuns = allocatedRunsByCandidate.get(selected) ?? 0;
      const totalAllocatedRuns = previouslyAllocatedRuns + runs;
      allocatedRunsByCandidate.set(selected, totalAllocatedRuns);
      const previousYields = yieldsForRuns(selected, previouslyAllocatedRuns);
      for (const [typeId, totalQuantity] of yieldsForRuns(selected, totalAllocatedRuns)) {
        const produced = totalQuantity - (previousYields.get(typeId) ?? 0);
        producedMaterials.set(typeId, (producedMaterials.get(typeId) ?? 0) + produced);
        remainingRequirements.set(
          typeId,
          Math.max(0, (remainingRequirements.get(typeId) ?? 0) - produced),
        );
      }
    }
  }

  return {
    consumedOwned,
    consumedPurchases,
    readyToReprocess,
    producedMaterials,
    remainingRequirements,
  };
}
