import GLPK, { type LP } from "glpk.js/node";

/** Raw material demand for a compression solve. */
export type CompressionRequestItem = { typeId: number; name: string; quantity: number };

/** One reprocessing source, optionally bounded by a single market order. */
export type CompressionCandidate = {
  typeId: number;
  name: string;
  unitsToReprocess: number;
  efficiency: number;
  yields: Map<number, number>;
  maxRuns?: number;
  price?: number;
  packagedVolume?: number;
  selectionId?: number;
};

/** Market prices and packaged volumes used by the optimization. */
export type CompressionPrices = {
  volumes: ReadonlyMap<number, number>;
  buyPrices: ReadonlyMap<number, number>;
  surplusOrders: ReadonlyMap<number, readonly { price: number; volumeRemain: number }[]>;
};

/** Item in the plan, purchase list, or surplus list. */
export type CompressionResultItem = {
  typeId?: number;
  name: string;
  quantity: number;
  ignored: boolean;
  reprocessable?: boolean;
  reprocessingEfficiency?: number;
  packagedVolume?: number;
  fromReprocessing?: number;
  surplus?: number;
};

/** Feasible volume-reducing result. */
export type CompressionResult = {
  plan: CompressionResultItem[];
  toBuy: CompressionResultItem[];
  surplus: CompressionResultItem[];
  purchasePrices: ReadonlyMap<number, number>;
  surplusCredits: ReadonlyMap<number, number>;
  metrics: {
    originalVolume: number;
    purchasedVolume: number;
    volumeLimit: number;
    originalCost: number;
    purchaseCost: number;
    surplusCredit: number;
    estimatedSavings: number;
  };
};

/** Indicates missing market inputs or no feasible smaller cargo. */
export class CompressionSolveError extends Error {}

type PricedCandidate = CompressionCandidate & { price: number; packagedVolume: number };

/** Maximum runs of one source that could help satisfy any requested material. */
export function maximumDemandRuns(
  candidate: { yields: ReadonlyMap<number, number>; efficiency: number },
  required: ReadonlyMap<number, number>,
): number {
  let maximumRuns = 0;
  for (const [typeId, quantity] of required) {
    const outputPerRun = ((candidate.yields.get(typeId) ?? 0) * candidate.efficiency) / 100;
    if (outputPerRun > 0) {
      maximumRuns = Math.max(maximumRuns, Math.ceil(quantity / outputPerRun));
    }
  }
  return maximumRuns;
}

/** Combines market, cargo, and demand bounds for a single candidate. */
function maximumUsableRuns(
  candidate: PricedCandidate,
  required: ReadonlyMap<number, number>,
  ceiling: number,
): number {
  return Math.min(
    candidate.maxRuns ?? Number.MAX_SAFE_INTEGER,
    Math.floor(ceiling / (candidate.packagedVolume * candidate.unitsToReprocess)),
    maximumDemandRuns(candidate, required),
  );
}

/** Disproves full compression when even unconstrained combined output is insufficient. */
export function canCoverDemand(
  required: ReadonlyMap<number, number>,
  candidates: readonly PricedCandidate[],
  ceiling: number,
): boolean {
  return [...required].every(
    ([typeId, quantity]) =>
      candidates.reduce(
        (total, candidate) =>
          total
          + (
            maximumUsableRuns(candidate, required, ceiling)
            * ((candidate.yields.get(typeId) ?? 0) * candidate.efficiency)
          )
            / 100,
        0,
      ) >= quantity,
  );
}

/** Returns the next lower full DST/BR load, or just below demand for small cargo. */
function volumeCeiling(originalVolume: number): number {
  const loadSize = originalVolume >= 60_000 ? 60_000 : 10_000;
  const fullLoads = Math.floor((originalVolume - 1e-6) / loadSize);
  return fullLoads > 0 ? fullLoads * loadSize : originalVolume - 1e-6;
}

/** Models ore runs and direct purchases under complete material and cargo constraints. */
function compressionModel(
  glpk: Awaited<ReturnType<typeof GLPK>>,
  required: ReadonlyMap<number, number>,
  candidates: readonly PricedCandidate[],
  prices: CompressionPrices,
  ceiling: number,
): LP {
  const oreVars = candidates.map((candidate, index) => ({
    name: `ore_${index}`,
    coef: candidate.price * candidate.unitsToReprocess,
  }));
  const directVars = [...required].map(([typeId]) => ({
    name: `direct_${typeId}`,
    coef: prices.buyPrices.get(typeId) ?? 0,
  }));
  const subjectTo: LP["subjectTo"] = [
    {
      name: "cargo_volume",
      vars: [
        ...candidates.map((candidate, index) => ({
          name: `ore_${index}`,
          coef: candidate.packagedVolume * candidate.unitsToReprocess,
        })),
        ...[...required].map(([typeId]) => ({
          name: `direct_${typeId}`,
          coef: prices.volumes.get(typeId) ?? 0,
        })),
      ],
      bnds: { type: glpk.GLP_UP, lb: 0, ub: ceiling },
    },
  ];
  for (const typeId of required.keys()) {
    subjectTo.push({
      name: `yield_${typeId}`,
      vars: [
        ...candidates.flatMap((candidate, index) => {
          const quantity = candidate.yields.get(typeId) ?? 0;
          return quantity > 0
            ? [{ name: `ore_${index}`, coef: (quantity * candidate.efficiency) / 100 }]
            : [];
        }),
        { name: `direct_${typeId}`, coef: 1 },
      ],
      bnds: { type: glpk.GLP_LO, lb: required.get(typeId) ?? 0, ub: 0 },
    });
  }
  return {
    name: "compression",
    objective: {
      direction: glpk.GLP_MIN,
      name: "purchase_cost",
      vars: [...oreVars, ...directVars],
    },
    subjectTo,
    bounds: [
      ...candidates.map((candidate, index) => ({
        name: `ore_${index}`,
        type: glpk.GLP_DB,
        lb: 0,
        ub: maximumUsableRuns(candidate, required, ceiling),
      })),
      ...[...required].map(([typeId, quantity]) => ({
        name: `direct_${typeId}`,
        type: glpk.GLP_DB,
        lb: 0,
        ub: quantity,
      })),
    ],
    generals: [...oreVars, ...directVars].map(({ name }) => name),
  };
}

/** Breaks purchase-cost ties by preferring the least recovered material volume. */
function surplusTieBreakModel(
  glpk: Awaited<ReturnType<typeof GLPK>>,
  model: LP,
  candidates: readonly PricedCandidate[],
  required: ReadonlyMap<number, number>,
  prices: CompressionPrices,
  purchaseCost: number,
): LP {
  return {
    ...model,
    objective: {
      direction: glpk.GLP_MIN,
      name: "recovered_material_volume",
      vars: [
        ...candidates.map((candidate, index) => ({
          name: `ore_${index}`,
          coef: [...candidate.yields].reduce(
            (volume, [typeId, quantity]) =>
              volume
              + ((quantity * candidate.efficiency) / 100) * (prices.volumes.get(typeId) ?? 0),
            0,
          ),
        })),
        ...[...required.keys()].map((typeId) => ({
          name: `direct_${typeId}`,
          coef: prices.volumes.get(typeId) ?? 0,
        })),
      ],
    },
    subjectTo: [
      ...model.subjectTo,
      {
        name: "best_purchase_cost",
        vars: model.objective.vars,
        bnds: { type: glpk.GLP_UP, lb: 0, ub: purchaseCost },
      },
    ],
  };
}

/** Recalculates real aggregate yields and checks cargo after integer rounding. */
function buildResult(
  required: ReadonlyMap<number, number>,
  requestNames: ReadonlyMap<number, string>,
  candidates: readonly PricedCandidate[],
  runs: readonly number[],
  names: ReadonlyMap<number, string>,
  ignored: readonly CompressionRequestItem[],
  prices: CompressionPrices,
  ceiling: number,
  originalVolume: number,
): CompressionResult {
  const recovered = new Map<number, number>();
  const purchases = new Map<
    number,
    { quantity: number; cost: number; volume: number; efficiency: number }
  >();
  for (const [index, candidate] of candidates.entries()) {
    const count = runs[index];
    if (!count) continue;
    for (const [typeId, quantity] of candidate.yields) {
      recovered.set(
        typeId,
        (recovered.get(typeId) ?? 0) + ((quantity * candidate.efficiency) / 100) * count,
      );
    }
    const previous = purchases.get(candidate.typeId);
    purchases.set(
      candidate.typeId,
      {
        quantity: (previous?.quantity ?? 0) + candidate.unitsToReprocess * count,
        cost: (previous?.cost ?? 0) + candidate.price * candidate.unitsToReprocess * count,
        volume:
          (previous?.volume ?? 0) + candidate.packagedVolume * candidate.unitsToReprocess * count,
        efficiency: candidate.efficiency,
      },
    );
  }
  const plan = [...required].map(([typeId, quantity]) => {
    const fromReprocessing = Math.floor(recovered.get(typeId) ?? 0);
    return {
      typeId,
      name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
      quantity,
      ignored: false,
      fromReprocessing,
      surplus: Math.max(0, fromReprocessing - quantity),
    };
  });
  const toBuy: CompressionResultItem[] = [...purchases].map(([typeId, purchase]) => ({
    typeId,
    name: names.get(typeId) ?? `Type ${typeId}`,
    quantity: purchase.quantity,
    ignored: false,
    reprocessable: true,
    ...(purchase.efficiency !== 100 ? { reprocessingEfficiency: purchase.efficiency } : {}),
  }));
  for (const [typeId, quantity] of required) {
    const missing = Math.max(0, quantity - Math.floor(recovered.get(typeId) ?? 0));
    if (missing > 0) {
      toBuy.push({
        typeId,
        name: requestNames.get(typeId) ?? `Type ${typeId}`,
        quantity: missing,
        ignored: false,
      });
    }
  }
  for (const item of ignored) {
    plan.push({ ...item, ignored: true, fromReprocessing: 0, surplus: 0 });
    toBuy.push({ ...item, ignored: true });
  }
  const purchasedVolume =
    [...purchases].reduce((total, [, purchase]) => total + purchase.volume, 0)
    + toBuy.reduce(
      (total, item) =>
        total
        + (item.ignored || item.typeId === undefined || purchases.has(item.typeId)
          ? 0
          : item.quantity * (prices.volumes.get(item.typeId) ?? 0)),
      0,
    );
  if (
    (originalVolume > 0 && purchasedVolume >= originalVolume)
    || purchasedVolume > ceiling + 1e-6
  ) {
    throw new CompressionSolveError(
      "The rounded compression basket exceeds the DST/BR cargo limit.",
    );
  }
  const surplus = [...recovered]
    .map(([typeId, quantity]) => [typeId, Math.floor(quantity)] as const)
    .filter(([typeId, quantity]) => quantity > (required.get(typeId) ?? 0))
    .map(([typeId, quantity]) => ({
      typeId,
      name: requestNames.get(typeId) ?? names.get(typeId) ?? `Type ${typeId}`,
      quantity: quantity - (required.get(typeId) ?? 0),
      ignored: false,
    }));
  const purchasePrices = new Map(
    [...purchases].map(([typeId, purchase]) => [typeId, purchase.cost / purchase.quantity]),
  );
  for (const item of toBuy) {
    if (item.ignored || item.typeId === undefined || purchasePrices.has(item.typeId)) continue;
    purchasePrices.set(item.typeId, prices.buyPrices.get(item.typeId) ?? 0);
  }
  const originalCost = [...required].reduce(
    (total, [typeId, quantity]) => total + quantity * (prices.buyPrices.get(typeId) ?? 0),
    0,
  );
  const purchaseCost =
    [...purchases].reduce((total, [, purchase]) => total + purchase.cost, 0)
    + toBuy.reduce(
      (total, item) =>
        total
        + (item.ignored || item.typeId === undefined || purchases.has(item.typeId)
          ? 0
          : item.quantity * (prices.buyPrices.get(item.typeId) ?? 0)),
      0,
    );
  const surplusCredits = new Map(
    surplus.map((item) => {
      let remaining = item.quantity;
      let value = 0;
      for (const order of [...(prices.surplusOrders.get(item.typeId) ?? [])].sort(
        (left, right) => right.price - left.price,
      )) {
        const sold = Math.min(remaining, order.volumeRemain);
        value += sold * order.price;
        remaining -= sold;
        if (remaining === 0) break;
      }
      return [item.typeId, value] as const;
    }),
  );
  const surplusCredit = [...surplusCredits.values()].reduce((total, value) => total + value, 0);
  return {
    plan,
    toBuy,
    surplus,
    purchasePrices,
    surplusCredits,
    metrics: {
      originalVolume,
      purchasedVolume,
      volumeLimit: ceiling,
      originalCost,
      purchaseCost,
      surplusCredit,
      estimatedSavings: originalCost - purchaseCost,
    },
  };
}

/** Prefers fully compressed demand, then minimizes cost without assuming surplus will sell. */
export async function compressMaterials(
  requested: CompressionRequestItem[],
  candidates: CompressionCandidate[],
  names: Map<number, string>,
  prices: CompressionPrices,
  supportedTypeIds?: ReadonlySet<number>,
): Promise<CompressionResult> {
  const required = new Map<number, number>();
  const requestNames = new Map<number, string>();
  for (const item of requested) {
    required.set(item.typeId, (required.get(item.typeId) ?? 0) + item.quantity);
    requestNames.set(item.typeId, item.name);
  }
  const supported =
    supportedTypeIds
    ?? new Set(
      candidates
        .filter((candidate) => !candidate.name.startsWith("Batch Compressed "))
        .flatMap((candidate) => [...candidate.yields.keys()]),
    );
  const ignored = [...required]
    .filter(([typeId]) => !supported.has(typeId))
    .map(([typeId, quantity]) => ({
      typeId,
      quantity,
      name: requestNames.get(typeId) ?? `Type ${typeId}`,
    }));
  for (const item of ignored) required.delete(item.typeId);
  if (required.size === 0) {
    return buildResult(required, requestNames, [], [], names, ignored, prices, 0, 0);
  }
  const originalVolume = [...required].reduce(
    (total, [typeId, quantity]) => {
      const volume = prices.volumes.get(typeId);
      if (volume === undefined || volume <= 0) {
        throw new CompressionSolveError("Raw material volume is unavailable.");
      }
      if (prices.buyPrices.get(typeId) === undefined) {
        throw new CompressionSolveError("Raw material market price is unavailable.");
      }
      return total + volume * quantity;
    },
    0,
  );
  const ceiling = volumeCeiling(originalVolume);
  const usableCandidates = candidates.filter(
    (candidate): candidate is PricedCandidate =>
      !candidate.name.startsWith("Batch Compressed ")
      && [...candidate.yields.keys()].some((typeId) => required.has(typeId))
      && (candidate.maxRuns === undefined || candidate.maxRuns > 0)
      && candidate.price !== undefined
      && Number.isFinite(candidate.price)
      && candidate.unitsToReprocess > 0
      && candidate.packagedVolume !== undefined
      && candidate.packagedVolume > 0
      && candidate.packagedVolume * candidate.unitsToReprocess <= ceiling
      && candidate.efficiency > 0,
  );
  if (usableCandidates.length === 0 || ceiling <= 0) {
    throw new CompressionSolveError(
      "No priced compression inputs fit below the original cargo and DST/BR load limit.",
    );
  }
  const glpk = await GLPK();
  const model = compressionModel(glpk, required, usableCandidates, prices, ceiling);
  const tieBreakDeadline = Date.now() + 3000;
  const compressedOnlyModel: LP = {
    ...model,
    bounds: model.bounds?.map((bound) =>
      bound.name.startsWith("direct_") ? { ...bound, type: glpk.GLP_FX, lb: 0, ub: 0 } : bound,
    ),
  };
  const compressedOnly = canCoverDemand(required, usableCandidates, ceiling)
    ? glpk.solve(
        compressedOnlyModel,
        {
          presol: true,
          tmlim: 3,
          mipgap: 0,
          msglev: glpk.GLP_MSG_OFF,
        },
      )
    : null;
  const fullSolution =
    compressedOnly?.result.status === glpk.GLP_OPT
    || compressedOnly?.result.status === glpk.GLP_FEAS
      ? compressedOnly
      : null;
  const selectedModel = fullSolution ? compressedOnlyModel : model;
  const solution =
    fullSolution
    ?? glpk.solve(model, { presol: true, tmlim: 3, mipgap: 0, msglev: glpk.GLP_MSG_OFF });
  if (solution.result.status !== glpk.GLP_OPT && solution.result.status !== glpk.GLP_FEAS) {
    if (solution.result.status === glpk.GLP_UNDEF) {
      throw new CompressionSolveError(
        "The compression optimization timed out before finding a feasible basket.",
      );
    }
    throw new CompressionSolveError(
      "No compression plan fits below the original cargo and DST/BR load limit.",
    );
  }
  let chosen = solution.result.vars;
  const tieBreakSeconds = Math.floor((tieBreakDeadline - Date.now()) / 1000);
  if (solution.result.status === glpk.GLP_OPT && tieBreakSeconds > 0) {
    const tieBreakModel = surplusTieBreakModel(
      glpk,
      selectedModel,
      usableCandidates,
      required,
      prices,
      solution.result.z,
    );
    const tieBreak = glpk.solve(
      tieBreakModel,
      {
        presol: true,
        tmlim: tieBreakSeconds,
        mipgap: 0,
        msglev: glpk.GLP_MSG_OFF,
      },
    );
    if (tieBreak.result.status === glpk.GLP_OPT || tieBreak.result.status === glpk.GLP_FEAS) {
      chosen = tieBreak.result.vars;
    }
  }
  const runs = usableCandidates.map((_, index) => Math.round(chosen[`ore_${index}`] ?? 0));
  return buildResult(
    required,
    requestNames,
    usableCandidates,
    runs,
    names,
    ignored,
    prices,
    ceiling,
    originalVolume,
  );
}
