import {
  getBlueprintsByInventionProductId,
  getBuildBlueprintByProductTypeId,
} from "@/cache/services/sdeCache";
import { getTypes } from "@/lib/sde/loader";
import { PlannerRequest, PlanResult, PlanSourceCounts, PlanSourceIcon } from "./types";

type Material = PlanResult["lists"]["materialsToBuy"][number];
type Efficiency = { me: number; te: number };

type ProfileEntry = { count: number; totalMs: number; maxMs: number };

class PlanProfiler {
  private readonly entries = new Map<string, ProfileEntry>();
  private readonly enabled = process.env.DEBUG_PLAN === "1";

  get isEnabled() {
    return this.enabled;
  }

  count(name: string) {
    if (!this.enabled) return;
    const entry = this.entries.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    this.entries.set(name, entry);
  }

  measure<T>(
    name: string,
    operation: () => Promise<T>,
    details?: () => Record<string, number | string>,
  ): Promise<T> {
    if (!this.enabled) return operation();
    const startedAt = performance.now();
    return operation().then(
      (value) => {
        this.record(name, startedAt, details);
        return value;
      },
      (error: unknown) => {
        this.record(name, startedAt, details);
        throw error;
      },
    );
  }

  private record(name: string, startedAt: number, details?: () => Record<string, number | string>) {
    const elapsedMs = performance.now() - startedAt;
    const entry = this.entries.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    entry.totalMs += elapsedMs;
    entry.maxMs = Math.max(entry.maxMs, elapsedMs);
    this.entries.set(name, entry);
    if (elapsedMs >= 100) {
      console.debug(`[plan] slow ${name}: ${elapsedMs.toFixed(1)}ms`, details?.());
    }
  }

  logSummary() {
    if (!this.enabled) return;
    console.debug(
      "[plan] profile",
      Object.fromEntries(
        [...this.entries.entries()].map(([name, entry]) => [
          name,
          {
            count: entry.count,
            totalMs: Number(entry.totalMs.toFixed(1)),
            maxMs: Number(entry.maxMs.toFixed(1)),
          },
        ]),
      ),
    );
  }
}

function clampEfficiency(value: number, maximum: number) {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

export async function calculatePlan(request: PlannerRequest): Promise<PlanResult> {
  const profiler = new PlanProfiler();
  const startedAt = performance.now();
  profiler.count("calculatePlan");
  const fallbackByTypeId = new Map<number, string>();
  function typeName(typeId: number, fallback: string) {
    fallbackByTypeId.set(typeId, fallback);
    return fallback;
  }
  const language = request.language ?? "en";
  const materials = new Map<number, Material>();
  const bpcs = new Map<number, PlanResult["lists"]["bpcsNeeded"][number]>();
  const reactionFormulas = new Map<number, PlanResult["lists"]["planItems"][number]>();
  const manufacturingJobs = new Map<number, PlanResult["lists"]["manufacturingJobs"][number]>();
  const reactionJobs = new Map<number, PlanResult["lists"]["reactionJobs"][number]>();
  const inventionJobs = new Map<number, PlanResult["lists"]["inventionJobs"][number]>();
  const inventedBpcTypeIds = new Set<number>();
  const producedParts = new Map<number, number>();
  const sourceCountsByTypeId = new Map<number, Map<PlanSourceIcon, number>>();
  for (const stockItem of request.stock ?? []) {
    const sourceCounts =
      sourceCountsByTypeId.get(stockItem.typeId) ?? new Map<PlanSourceIcon, number>();
    const addSource = (source: PlanSourceIcon, quantityOverride?: number) => {
      const quantity =
        quantityOverride ??
        (source === "invention" || source === "copying"
          ? (stockItem.jobRuns ?? stockItem.quantity) *
            (source === "copying" ? (stockItem.licensedRuns ?? 1) : 1)
          : stockItem.quantity);
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + quantity);
    };
    if (stockItem.category === "item" && stockItem.source === "marketOrder") {
      addSource("market");
    }
    if (stockItem.inBuild && stockItem.category === "item") {
      addSource("industry", stockItem.inBuildQuantity ?? stockItem.quantity);
    }
    if (
      stockItem.inBuild &&
      stockItem.category === "bp" &&
      stockItem.type === "bpc" &&
      stockItem.blueprintRunsAtInstall !== undefined &&
      stockItem.activityName === "Invention"
    ) {
      addSource("invention");
    }
    if (stockItem.inBuild && stockItem.category === "bp" && stockItem.activityName === "Copying") {
      addSource("copying");
    }
    if (sourceCounts.size > 0) sourceCountsByTypeId.set(stockItem.typeId, sourceCounts);
  }
  function sourceMetadata(typeId: number) {
    const counts = sourceCountsByTypeId.get(typeId);
    if (!counts) return undefined;
    return {
      icons: [...counts.keys()],
      counts: Object.fromEntries(counts) as PlanSourceCounts,
    };
  }
  const standardStock = request.stock
    .filter((item) => item.category === "item")
    .filter((item) => item.source !== "marketOrder")
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const marketOrderStock = request.stock
    .filter((item) => item.category === "item" && item.source === "marketOrder")
    .reduce(
      (map, item) => map.set(item.typeId, (map.get(item.typeId) ?? 0) + item.quantity),
      new Map<number, number>(),
    );
  const totalStock = new Map(standardStock);
  const initialBuildTypeIds = new Set(request.items.map((item) => item.typeId));
  for (const [typeId, quantity] of marketOrderStock) {
    if (!initialBuildTypeIds.has(typeId)) continue;
    totalStock.set(typeId, (totalStock.get(typeId) ?? 0) + quantity);
  }
  const availableBlueprintCopies = request.stock.filter(
    (item) => item.category === "bp" && item.type === "bpc" && !item.inBuild,
  );
  const availableBlueprintOriginals = request.stock.filter(
    (item) => item.category === "bp" && item.type === "bpo",
  );
  const availableReactionFormulas = request.stock.filter((item) => item.category === "reaction");
  const blueprintCopyStock = new Map<number, { copies: number; runs: number }>();
  const seenBlueprintPrints = new Set<number>();
  for (const item of availableBlueprintCopies) {
    const existing = blueprintCopyStock.get(item.typeId) ?? { copies: 0, runs: 0 };
    const prints = item.blueprintPrints ?? [];
    const uniquePrints = prints.filter((print) => {
      if (seenBlueprintPrints.has(print.itemId)) return false;
      seenBlueprintPrints.add(print.itemId);
      return true;
    });
    if (prints.length > 0 && uniquePrints.length === 0) continue;
    const printRuns = uniquePrints
      .filter((print) => print.type === "bpc")
      .reduce((total, print) => total + Math.max(0, print.runs), 0);
    blueprintCopyStock.set(item.typeId, {
      copies: existing.copies + item.quantity,
      runs: existing.runs + printRuns,
    });
  }
  for (const item of request.stock ?? []) {
    if (!item.inBuild || item.category !== "bp" || item.activityName !== "Copying") continue;
    const copiedRuns = (item.jobRuns ?? 0) * (item.licensedRuns ?? 1);
    if (copiedRuns <= 0) continue;
    const existing = blueprintCopyStock.get(item.typeId) ?? { copies: 0, runs: 0 };
    blueprintCopyStock.set(item.typeId, {
      copies: existing.copies + (item.jobRuns ?? 0),
      runs: existing.runs + copiedRuns,
    });
  }
  const blueprintOriginalCounts = new Map<number, number>();
  for (const item of availableBlueprintOriginals) {
    blueprintOriginalCounts.set(
      item.typeId,
      (blueprintOriginalCounts.get(item.typeId) ?? 0) + item.quantity,
    );
  }
  const reactionFormulaCounts = new Map<number, number>();
  for (const item of availableReactionFormulas) {
    reactionFormulaCounts.set(
      item.typeId,
      (reactionFormulaCounts.get(item.typeId) ?? 0) + item.quantity,
    );
  }
  const usedRunsByBlueprint = new Map<number, number>();
  const consumedStock = new Map<number, number>();
  const consumedMarketOrderStock = new Set<number>();
  const buildBlacklist = new Set(request.settings.buildBlacklist);
  const buyBlacklist = new Set(request.settings.buyBlacklist);
  const buildBlueprintsByTypeId = new Map<
    number,
    ReturnType<typeof getBuildBlueprintByProductTypeId>
  >();
  const defaultEfficiency: Efficiency = {
    me: clampEfficiency(request.settings.defaultMe ?? 10, 10),
    te: clampEfficiency(request.settings.defaultTe ?? 20, 20),
  };

  function updateMaterial(typeId: number, fallbackName: string, update: Partial<Material>) {
    const existing = materials.get(typeId);
    materials.set(typeId, {
      typeId,
      name: typeName(typeId, fallbackName),
      quantity: existing?.quantity ?? 0,
      requiredQuantity: existing?.requiredQuantity ?? 0,
      stockQuantity: existing?.stockQuantity ?? 0,
      availableStockQuantity: existing?.availableStockQuantity ?? totalStock.get(typeId) ?? 0,
      productionQuantity: existing?.productionQuantity ?? 0,
      buildQuantity: existing?.buildQuantity ?? 0,
      buyQuantity: existing?.buyQuantity ?? 0,
      remainingStockQuantity: existing?.remainingStockQuantity ?? 0,
      remainingProductionQuantity: existing?.remainingProductionQuantity ?? 0,
      fromMarketOrder: existing?.fromMarketOrder || consumedMarketOrderStock.has(typeId),
      availableSourceCounts: existing?.availableSourceCounts ?? sourceMetadata(typeId)?.counts,
      ...update,
      ...(request.locations ? { locationId: request.locations.market } : {}),
    });
  }

  async function addMaterial(
    typeId: number,
    quantity: number,
    fallbackName: string,
    demandAlreadyRecorded = false,
    imageVariation: "icon" | "bp" | "bpc" = "icon",
  ) {
    return profiler.measure("addMaterial", async () => {
      const stockAvailable = standardStock.get(typeId) ?? 0;
      const stockConsumed = Math.min(stockAvailable, quantity);
      if (stockConsumed > 0)
        consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
      const remainingStock = stockAvailable - stockConsumed;
      if (remainingStock > 0) standardStock.set(typeId, remainingStock);
      else if (stockConsumed > 0) standardStock.delete(typeId);
      const existing = materials.get(typeId);
      updateMaterial(typeId, fallbackName, {
        quantity: (existing?.quantity ?? 0) + quantity - stockConsumed,
        requiredQuantity:
          (existing?.requiredQuantity ?? 0) + (demandAlreadyRecorded ? 0 : quantity),
        stockQuantity: (existing?.stockQuantity ?? 0) + (demandAlreadyRecorded ? 0 : stockConsumed),
        buyQuantity: (existing?.buyQuantity ?? 0) + quantity - stockConsumed,
        remainingStockQuantity: remainingStock,
        imageVariation,
      });
    });
  }

  async function expand(
    typeId: number,
    quantity: number,
    fallbackName: string,
    stack: Set<number>,
    efficiency: Efficiency,
    allowMarketOrderStock = false,
  ) {
    let phase = "stock";
    let activity = "unknown";
    const requestedQuantity = quantity;
    return profiler.measure(
      "expand",
      async () => {
        if (quantity <= 0) return;

        const standardAvailable = standardStock.get(typeId) ?? 0;
        const standardConsumed = Math.min(standardAvailable, quantity);
        const marketAvailable = allowMarketOrderStock ? (marketOrderStock.get(typeId) ?? 0) : 0;
        const marketConsumed = Math.min(marketAvailable, quantity - standardConsumed);
        const stockConsumed = standardConsumed + marketConsumed;
        updateMaterial(typeId, fallbackName, {
          requiredQuantity: (materials.get(typeId)?.requiredQuantity ?? 0) + requestedQuantity,
          stockQuantity: (materials.get(typeId)?.stockQuantity ?? 0) + stockConsumed,
        });
        if (stockConsumed > 0)
          consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
        if (stockConsumed > 0) {
          if (standardConsumed > 0) {
            const remainingStandard = standardAvailable - standardConsumed;
            if (remainingStandard > 0) standardStock.set(typeId, remainingStandard);
            else standardStock.delete(typeId);
          }
          if (marketConsumed > 0) {
            const remainingMarket = marketAvailable - marketConsumed;
            if (remainingMarket > 0) marketOrderStock.set(typeId, remainingMarket);
            else marketOrderStock.delete(typeId);
            consumedMarketOrderStock.add(typeId);
          }
          quantity -= stockConsumed;
          updateMaterial(typeId, fallbackName, {
            remainingStockQuantity:
              (standardStock.get(typeId) ?? 0) + (marketOrderStock.get(typeId) ?? 0),
            ...(marketConsumed > 0 ? { fromMarketOrder: true } : {}),
          });
        }
        if (quantity <= 0) return;

        const available = producedParts.get(typeId) ?? 0;
        const consumed = Math.min(available, quantity);
        if (consumed > 0) {
          const remaining = available - consumed;
          if (remaining > 0) producedParts.set(typeId, remaining);
          else producedParts.delete(typeId);
          quantity -= consumed;
        }
        if (quantity <= 0) return;

        if (stack.has(typeId) || buildBlacklist.has(typeId) || buyBlacklist.has(typeId)) {
          await addMaterial(typeId, quantity, fallbackName);
          return;
        }

        phase = "blueprint lookup";
        let buildBlueprint = buildBlueprintsByTypeId.get(typeId);
        if (!buildBlueprintsByTypeId.has(typeId)) {
          buildBlueprint = profiler.measure(
            "expand.buildBlueprintLookup",
            () => getBuildBlueprintByProductTypeId(typeId),
            () => ({ typeId }),
          );
          buildBlueprintsByTypeId.set(typeId, buildBlueprint);
        }
        const candidate = await buildBlueprint;
        const blueprint = candidate?.blueprint;

        if (!blueprint) {
          await addMaterial(typeId, quantity, fallbackName, true);
          return;
        }

        updateMaterial(typeId, fallbackName, {
          buildQuantity: (materials.get(typeId)?.buildQuantity ?? 0) + quantity,
        });

        activity = candidate.activity;
        const productQuantity =
          candidate.activity === "manufacturing"
            ? candidate.blueprint.activities.manufacturing!.products!.find(
                (product) => product.typeID === typeId,
              )!.quantity
            : candidate.blueprint.activities.reaction!.products!.find(
                (product) => product.typeID === typeId,
              )!.quantity;
        const runsNeeded = Math.ceil(quantity / productQuantity);
        const producedQuantity = runsNeeded * productQuantity;
        updateMaterial(typeId, fallbackName, {
          productionQuantity: (materials.get(typeId)?.productionQuantity ?? 0) + producedQuantity,
        });
        const surplus = producedQuantity - quantity;
        if (surplus > 0) producedParts.set(typeId, (producedParts.get(typeId) ?? 0) + surplus);
        const nextStack = new Set(stack).add(typeId);

        let remainingRuns = runsNeeded;
        const copyStock = blueprintCopyStock.get(blueprint._key);
        const alreadyUsedRuns = usedRunsByBlueprint.get(blueprint._key) ?? 0;
        const availableRuns = Math.max(0, (copyStock?.runs ?? 0) - alreadyUsedRuns);
        const runsFromStock = Math.min(remainingRuns, availableRuns);
        remainingRuns -= runsFromStock;
        usedRunsByBlueprint.set(blueprint._key, alreadyUsedRuns + runsFromStock);

        if (activity === "manufacturing") {
          const existing = manufacturingJobs.get(blueprint._key);
          manufacturingJobs.set(blueprint._key, {
            typeId: blueprint._key,
            name: typeName(blueprint._key, `${fallbackName} Blueprint`),
            runs: (existing?.runs ?? 0) + runsNeeded,
            totalTime:
              (existing?.totalTime ?? 0) +
              blueprint.activities.manufacturing!.time * (1 - efficiency.te / 100) * runsNeeded,
            ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
          });
          phase = "manufacturing materials";
          await profiler.measure("expand.materials", async () => {
            for (const material of blueprint.activities.manufacturing?.materials ?? []) {
              const materialQuantity = Math.ceil(
                material.quantity * runsNeeded * (1 - efficiency.me / 100),
              );
              await expand(
                material.typeID,
                materialQuantity,
                typeName(material.typeID, `Type ${material.typeID}`),
                nextStack,
                defaultEfficiency,
              );
            }
          });
          const bpoCount = blueprintOriginalCounts.get(blueprint._key) ?? 0;
          const bpcBuyQuantity =
            bpoCount > 0
              ? Math.ceil(Math.max(0, remainingRuns) / blueprint.maxProductionLimit)
              : Math.max(0, remainingRuns);
          bpcs.set(blueprint._key, {
            typeId: blueprint._key,
            name: typeName(blueprint._key, `${fallbackName} Blueprint`),
            quantity: (bpcs.get(blueprint._key)?.quantity ?? 0) + runsNeeded,
            neededQuantity: (bpcs.get(blueprint._key)?.neededQuantity ?? 0) + runsNeeded,
            stockQuantity: copyStock?.copies ?? 0,
            stockRuns: copyStock?.runs ?? 0,
            availableSourceCounts: sourceMetadata(blueprint._key)?.counts,
            bpoCount,
            buyQuantity: (bpcs.get(blueprint._key)?.buyQuantity ?? 0) + bpcBuyQuantity,
          });
          return;
        }

        const existing = reactionJobs.get(blueprint._key);
        reactionJobs.set(blueprint._key, {
          typeId: blueprint._key,
          name: typeName(blueprint._key, `${fallbackName} Blueprint`),
          runs: (existing?.runs ?? 0) + runsNeeded,
          totalTime:
            (existing?.totalTime ?? 0) +
            blueprint.activities.reaction!.time * (1 - efficiency.te / 100) * runsNeeded,
          ...(request.locations ? { locationId: request.locations.reactions } : {}),
        });
        const existingFormula = reactionFormulas.get(blueprint._key);
        const formulaCount = reactionFormulaCounts.get(blueprint._key) ?? 0;
        reactionFormulas.set(blueprint._key, {
          kind: "reaction",
          typeId: blueprint._key,
          name: typeName(blueprint._key, `${fallbackName} Formula`),
          runsNeeded:
            (existingFormula && existingFormula.kind === "reaction"
              ? existingFormula.runsNeeded
              : 0) + runsNeeded,
          availableQuantity: formulaCount,
        });
        if (runsNeeded > 0 && formulaCount === 0) {
          await addMaterial(blueprint._key, 1, `${fallbackName} Formula`, false, "bpc");
        }
        phase = "reaction materials";
        await profiler.measure("expand.materials", async () => {
          for (const material of blueprint.activities.reaction?.materials ?? []) {
            await expand(
              material.typeID,
              material.quantity * runsNeeded,
              typeName(material.typeID, `Type ${material.typeID}`),
              nextStack,
              defaultEfficiency,
            );
          }
        });
      },
      () => ({ typeId, quantity, depth: stack.size, activity, phase }),
    );
  }

  for (const item of request.items) {
    await expand(
      item.typeId,
      item.quantity,
      item.name,
      new Set(),
      {
        me: clampEfficiency(item.me, 10),
        te: clampEfficiency(item.te, 20),
      },
      true,
    );
  }

  await profiler.measure("invention", async () => {
    for (const bpc of [...bpcs.values()]) {
      const inventingBlueprints = await profiler.measure("inventionBlueprintLookup", () =>
        getBlueprintsByInventionProductId(bpc.typeId),
      );
      if (inventingBlueprints.length === 0) continue;
      const inventingBlueprint = inventingBlueprints[0];
      const invention = inventingBlueprint.activities.invention;
      const inventionProduct = invention?.products?.find(
        (product) => product.typeID === bpc.typeId,
      );
      if (!invention || !inventionProduct) continue;

      const successProbability = inventionProduct.probability ?? 1;
      const remainingBpcRuns = Math.max(0, bpc.neededQuantity - bpc.stockRuns);
      if (remainingBpcRuns <= 0) continue;

      inventedBpcTypeIds.add(bpc.typeId);

      const successfulBpcRuns = inventingBlueprint.maxProductionLimit;
      const successfulBpcQuantity = Math.ceil(remainingBpcRuns / successfulBpcRuns);
      const inventionAttempts = Math.ceil(successfulBpcQuantity / successProbability);
      const existing = inventionJobs.get(inventingBlueprint._key);
      inventionJobs.set(inventingBlueprint._key, {
        typeId: inventingBlueprint._key,
        name: typeName(inventingBlueprint._key, "Blueprint Copy"),
        runs: (existing?.runs ?? 0) + inventionAttempts,
        ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
      });
      const sourceBpc = bpcs.get(inventingBlueprint._key);
      const sourceBpoCount = blueprintOriginalCounts.get(inventingBlueprint._key) ?? 0;
      const sourceCopyStock = blueprintCopyStock.get(inventingBlueprint._key);
      const sourceNeededQuantity = (sourceBpc?.neededQuantity ?? 0) + inventionAttempts;
      const sourceRemainingRuns = Math.max(0, sourceNeededQuantity - (sourceCopyStock?.runs ?? 0));
      bpcs.set(inventingBlueprint._key, {
        typeId: inventingBlueprint._key,
        name: typeName(inventingBlueprint._key, "Blueprint Copy"),
        quantity: (sourceBpc?.quantity ?? 0) + inventionAttempts,
        neededQuantity: sourceNeededQuantity,
        stockQuantity: sourceBpc?.stockQuantity ?? 0,
        stockRuns: sourceBpc?.stockRuns ?? 0,
        availableSourceCounts: sourceMetadata(inventingBlueprint._key)?.counts,
        bpoCount: sourceBpoCount,
        buyQuantity:
          sourceBpoCount > 0
            ? Math.ceil(sourceRemainingRuns / inventingBlueprint.maxProductionLimit)
            : sourceRemainingRuns,
      });
      for (const material of invention.materials ?? []) {
        await addMaterial(
          material.typeID,
          material.quantity * inventionAttempts,
          typeName(material.typeID, `Type ${material.typeID}`),
        );
      }
    }
  });

  for (const material of materials.values()) {
    material.remainingProductionQuantity = producedParts.get(material.typeId) ?? 0;
  }

  const typeRecords = await profiler.measure("typeNameBatch", () => getTypes());
  const resolvedName = (typeId: number) => {
    const name = typeRecords.get(typeId)?.name;
    return name?.[language] ?? name?.en ?? fallbackByTypeId.get(typeId) ?? `Type ${typeId}`;
  };
  for (const material of materials.values()) material.name = resolvedName(material.typeId);
  for (const bpc of bpcs.values()) bpc.name = resolvedName(bpc.typeId);
  for (const job of manufacturingJobs.values()) job.name = resolvedName(job.typeId);
  for (const job of reactionJobs.values()) job.name = resolvedName(job.typeId);
  for (const job of inventionJobs.values()) job.name = resolvedName(job.typeId);
  for (const bpc of bpcs.values()) bpc.name = resolvedName(bpc.typeId);
  for (const formula of reactionFormulas.values()) formula.name = resolvedName(formula.typeId);

  const materialsToBuy = [...materials.values()];
  const bpcRequirements = [...bpcs.values()];
  const bpcsNeeded = bpcRequirements.filter(
    (bpc) => !inventedBpcTypeIds.has(bpc.typeId) && bpc.bpoCount > 0,
  );
  const bpcsToBuy = bpcRequirements.filter(
    (bpc) => !inventedBpcTypeIds.has(bpc.typeId) && bpc.bpoCount === 0,
  );
  const planItems: PlanResult["lists"]["planItems"] = [
    ...materialsToBuy.map((material) => ({ kind: "material" as const, ...material })),
    ...[...bpcs.values()].map((bpc) => ({ kind: "bpc" as const, ...bpc })),
    ...reactionFormulas.values(),
  ];
  const haulingTasks: PlanResult["lists"]["haulingTasks"] = [];
  const remainingConsumption = new Map(consumedStock);
  const planningStock = request.stock;
  for (const stock of planningStock) {
    if (!stock.sourceLocationId) continue;
    const quantity = Math.min(stock.quantity, remainingConsumption.get(stock.typeId) ?? 0);
    if (
      quantity <= 0 ||
      !request.locations ||
      stock.sourceLocationId === request.locations.manufacturing
    )
      continue;
    remainingConsumption.set(
      stock.typeId,
      (remainingConsumption.get(stock.typeId) ?? 0) - quantity,
    );
    haulingTasks.push({
      itemTypeId: stock.typeId,
      name: resolvedName(stock.typeId),
      quantity,
      volume: 0,
      fromLocationId: stock.sourceLocationId,
      toLocationId: request.locations.manufacturing,
      fromLocationName: stock.sourceLocationName,
      ownerType: stock.ownerType,
      ownerId: stock.ownerId,
    });
  }
  const result = {
    metadata: {
      generatedAt: new Date().toISOString(),
      assetsLastUpdated: null,
      jobsLastUpdated: null,
      unresolvedAssetCount: planningStock.length,
      corporationAssetSources: [
        ...new Set(
          planningStock
            .filter((stock) => stock.ownerType === "corporation")
            .map((stock) => stock.ownerId)
            .filter((id): id is number => id !== undefined),
        ),
      ],
    },
    lists: {
      planItems,
      materialsToBuy,
      bpcsNeeded,
      bpcsToBuy,
      inventionJobs: [...inventionJobs.values()],
      reactionJobs: [...reactionJobs.values()],
      manufacturingJobs: [...manufacturingJobs.values()],
      haulingTasks,
    },
  };
  if (profiler.isEnabled) {
    console.debug(
      `[plan] calculatePlan completed in ${(performance.now() - startedAt).toFixed(1)}ms`,
      {
        items: request.items.length,
        materials: materialsToBuy.length,
        manufacturingJobs: manufacturingJobs.size,
        reactionJobs: reactionJobs.size,
      },
    );
    profiler.logSummary();
  }
  return result;
}
