export type CompressionRequestItem = { typeId: number; name: string; quantity: number };

export type CompressionCandidate = {
  typeId: number;
  name: string;
  unitsToReprocess: number;
  efficiency: number;
  yields: Map<number, number>;
  maxRuns?: number;
  price?: number;
  selectionId?: number;
};

export type CompressionResultItem = {
  typeId?: number;
  name: string;
  quantity: number;
  packagedVolume?: number;
  fromReprocessing?: number;
  surplus?: number;
};

export type CompressionResult = {
  plan: CompressionResultItem[];
  toBuy: CompressionResultItem[];
  surplus: CompressionResultItem[];
};

function candidateScore(candidate: CompressionCandidate, remaining: Map<number, number>) {
  let covered = 0;
  let waste = 0;
  for (const [typeId, quantity] of candidate.yields) {
    const needed = remaining.get(typeId) ?? 0;
    covered += Math.min(needed, quantity);
    waste += Math.max(0, quantity - needed);
  }
  return covered / (1 + waste);
}

export function compressMaterials(
  requested: CompressionRequestItem[],
  candidates: CompressionCandidate[],
  names: Map<number, string>,
): CompressionResult {
  const required = new Map<number, number>();
  const requestNames = new Map<number, string>();
  for (const item of requested) {
    required.set(item.typeId, (required.get(item.typeId) ?? 0) + item.quantity);
    requestNames.set(item.typeId, item.name);
  }

  const remaining = new Map(required);
  const selected = new Map<number, number>();
  const candidateKey = (candidate: CompressionCandidate) =>
    candidate.selectionId ?? candidate.typeId;
  const usableCandidates = candidates.filter((candidate) => {
    if (candidate.name.startsWith("Batch Compressed ")) {
      return false;
    }
    const matchesRequest = [...candidate.yields].some(
      ([typeId]) => (remaining.get(typeId) ?? 0) > 0,
    );
    const hasMarketCapacity = candidate.maxRuns === undefined || candidate.maxRuns > 0;
    return matchesRequest && hasMarketCapacity;
  });

  const adjustedYields = (candidate: CompressionCandidate) =>
    new Map(
      [...candidate.yields].map(
        ([typeId, quantity]) => [typeId, (quantity * candidate.efficiency) / 100] as const,
      ),
    );
  const runsNeeded = (candidate: CompressionCandidate, remainingMaterials: Map<number, number>) => {
    const yields = adjustedYields(candidate);
    let runs = 1;
    for (const [typeId, quantity] of yields) {
      const needed = remainingMaterials.get(typeId) ?? 0;
      if (needed > 0) runs = Math.max(runs, Math.ceil(needed / quantity));
    }
    return runs;
  };

  while ([...remaining.values()].some((quantity) => quantity > 0) && usableCandidates.length > 0) {
    const candidate = usableCandidates
      .filter((entry) => candidateScore({ ...entry, yields: adjustedYields(entry) }, remaining) > 0)
      .filter(
        (entry) => entry.maxRuns === undefined || runsNeeded(entry, remaining) <= entry.maxRuns,
      )
      .sort(
        (left, right) =>
          candidateScore(right, remaining) - candidateScore(left, remaining)
          || (left.price ?? Number.POSITIVE_INFINITY) - (right.price ?? Number.POSITIVE_INFINITY)
          || left.typeId - right.typeId,
      )[0];
    if (!candidate) {
      break;
    }
    const runs = runsNeeded(candidate, remaining);
    const yields = adjustedYields(candidate);
    selected.set(candidateKey(candidate), (selected.get(candidateKey(candidate)) ?? 0) + runs);
    for (const [typeId, quantity] of yields) {
      remaining.set(typeId, Math.max(0, (remaining.get(typeId) ?? 0) - quantity * runs));
    }
  }

  const recovered = new Map<number, number>();
  for (const candidate of candidates) {
    const runs = selected.get(candidateKey(candidate)) ?? 0;
    for (const [typeId, quantity] of adjustedYields(candidate)) {
      recovered.set(typeId, (recovered.get(typeId) ?? 0) + quantity * runs);
    }
  }
  const plan = [...required].map(([typeId, quantity]) => {
    const recoveredQuantity = Math.floor(recovered.get(typeId) ?? 0);
    return {
      typeId,
      name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
      quantity,
      fromReprocessing: recoveredQuantity,
      surplus: Math.max(0, recoveredQuantity - quantity),
    };
  });
  const toBuy = [...selected].map(([selectionId, quantity]) => {
    const candidate = candidates.find((entry) => candidateKey(entry) === selectionId);
    const typeId = candidate?.typeId ?? selectionId;
    return {
      typeId,
      name: names.get(typeId) ?? candidate?.name ?? `Type ${typeId}`,
      quantity: quantity * (candidate?.unitsToReprocess ?? 1),
    };
  });
  for (const [typeId, quantity] of remaining) {
    if (quantity > 0) {
      toBuy.push({
        typeId,
        name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
        quantity,
      });
    }
  }
  const surplus = [...recovered]
    .map(([typeId, quantity]) => [typeId, Math.floor(quantity)] as const)
    .filter(([typeId, quantity]) => quantity > (required.get(typeId) ?? 0))
    .map(([typeId, quantity]) => ({
      typeId,
      name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
      quantity: quantity - (required.get(typeId) ?? 0),
    }));
  return { plan, toBuy, surplus };
}
