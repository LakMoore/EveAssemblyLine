export type CompressionRequestItem = { typeId: number; name: string; quantity: number };

export type CompressionCandidate = { typeId: number; name: string; unitsToReprocess: number; efficiency: number; yields: Map<number, number> };

export type CompressionResultItem = {
  typeId?: number;
  name: string;
  quantity: number;
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
  const usableCandidates = candidates.filter((candidate) =>
    [...candidate.yields].some(([typeId]) => (remaining.get(typeId) ?? 0) > 0),
  );

  const adjustedYields = (candidate: CompressionCandidate) => new Map(
    [...candidate.yields].map(([typeId, quantity]) => [typeId, Math.floor(quantity * candidate.efficiency / 100)] as const),
  );

  while ([...remaining.values()].some((quantity) => quantity > 0) && usableCandidates.length > 0) {
    const candidate = usableCandidates
      .filter((entry) => candidateScore({ ...entry, yields: adjustedYields(entry) }, remaining) > 0)
      .sort((left, right) => candidateScore(right, remaining) - candidateScore(left, remaining) || left.typeId - right.typeId)[0];
    if (!candidate) break;
    let runs = 1;
    const yields = adjustedYields(candidate);
    for (const [typeId, quantity] of yields) {
      const needed = remaining.get(typeId) ?? 0;
      if (needed > 0) runs = Math.max(runs, Math.ceil(needed / quantity));
    }
    selected.set(candidate.typeId, (selected.get(candidate.typeId) ?? 0) + runs);
    for (const [typeId, quantity] of yields) {
      remaining.set(typeId, Math.max(0, (remaining.get(typeId) ?? 0) - quantity * runs));
    }
  }

  const recovered = new Map<number, number>();
  for (const candidate of candidates) {
    const runs = selected.get(candidate.typeId) ?? 0;
    for (const [typeId, quantity] of adjustedYields(candidate)) {
      recovered.set(typeId, (recovered.get(typeId) ?? 0) + quantity * runs);
    }
  }
  const plan = [...required].map(([typeId, quantity]) => {
    const recoveredQuantity = recovered.get(typeId) ?? 0;
    return {
      typeId,
      name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
      quantity,
      fromReprocessing: recoveredQuantity,
      surplus: Math.max(0, recoveredQuantity - quantity),
    };
  });
  const toBuy = [...selected].map(([typeId, quantity]) => ({
    typeId,
    name: names.get(typeId) ?? `Type ${typeId}`,
    quantity: quantity * (candidates.find((candidate) => candidate.typeId === typeId)?.unitsToReprocess ?? 1),
  }));
  for (const [typeId, quantity] of remaining) {
    if (quantity > 0) toBuy.push({ typeId, name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`, quantity });
  }
  const surplus = [...recovered]
    .filter(([typeId, quantity]) => quantity > (required.get(typeId) ?? 0))
    .map(([typeId, quantity]) => ({
      typeId,
      name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
      quantity: quantity - (required.get(typeId) ?? 0),
    }));
  return { plan, toBuy, surplus };
}
