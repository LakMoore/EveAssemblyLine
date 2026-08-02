import {
  getBlueprintsByInventionProductId,
  getBuildBlueprintByProductTypeId,
} from "@/cache/services/sdeCache";
import { getTypes } from "@/lib/sde/loader";
import { PlanRequest, PlanResult } from "./types";

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
        [...this.entries.entries()].map(([name, entry]) => [name, {
          count: entry.count,
          totalMs: Number(entry.totalMs.toFixed(1)),
          maxMs: Number(entry.maxMs.toFixed(1)),
        }]),
      ),
    );
  }
}

function clampEfficiency(value: number, maximum: number) {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

export async function calculatePlan(request: PlanRequest): Promise<PlanResult> {
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
  const manufacturingJobs = new Map<number, PlanResult["lists"]["manufacturingJobs"][number]>();
  const reactionJobs = new Map<number, PlanResult["lists"]["reactionJobs"][number]>();
  const inventionJobs = new Map<number, PlanResult["lists"]["inventionJobs"][number]>();
  const producedParts = new Map<number, number>();
  const availableStock = new Map<number, number>();
  const consumedStock = new Map<number, number>();
  const buildBlacklist = new Set(request.settings.buildBlacklist);
  const buyBlacklist = new Set(request.settings.buyBlacklist);
  const buildBlueprintsByTypeId = new Map<
    number,
    ReturnType<typeof getBuildBlueprintByProductTypeId>
  >();
  for (const item of request.stock ?? []) {
    if (item.quantity > 0) {
      availableStock.set(item.typeId, (availableStock.get(item.typeId) ?? 0) + item.quantity);
    }
  }
  const defaultEfficiency: Efficiency = {
    me: clampEfficiency(request.settings.defaultMe ?? 10, 10),
    te: clampEfficiency(request.settings.defaultTe ?? 20, 20),
  };

  async function addMaterial(typeId: number, quantity: number, fallbackName: string) {
    return profiler.measure("addMaterial", async () => {
      const stockAvailable = availableStock.get(typeId) ?? 0;
      const stockConsumed = Math.min(stockAvailable, quantity);
      if (stockConsumed > 0) consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
      const remainingStock = stockAvailable - stockConsumed;
      if (remainingStock > 0) availableStock.set(typeId, remainingStock);
      else if (stockConsumed > 0) availableStock.delete(typeId);
      const existing = materials.get(typeId);
      materials.set(typeId, {
        typeId,
        name: typeName(typeId, fallbackName),
        quantity: (existing?.quantity ?? 0) + quantity - stockConsumed,
        requiredQuantity: (existing?.requiredQuantity ?? 0) + quantity,
        stockQuantity: (existing?.stockQuantity ?? 0) + stockConsumed,
        remainingStockQuantity: remainingStock,
        ...(request.locations ? { locationId: request.locations.market } : {}),
      });
    });
  }

  async function expand(
    typeId: number,
    quantity: number,
    fallbackName: string,
    stack: Set<number>,
    efficiency: Efficiency,
  ) {
    let phase = "stock";
    let activity = "unknown";
    return profiler.measure("expand", async () => {
      if (quantity <= 0) return;

    const stockAvailable = availableStock.get(typeId) ?? 0;
    const stockConsumed = Math.min(stockAvailable, quantity);
      if (stockConsumed > 0) consumedStock.set(typeId, (consumedStock.get(typeId) ?? 0) + stockConsumed);
      if (stockConsumed > 0) {
      const remaining = stockAvailable - stockConsumed;
      if (remaining > 0) availableStock.set(typeId, remaining);
      else availableStock.delete(typeId);
      quantity -= stockConsumed;
      const existing = materials.get(typeId);
      materials.set(typeId, {
        typeId,
        name: typeName(typeId, fallbackName),
        quantity: existing?.quantity ?? 0,
        requiredQuantity: (existing?.requiredQuantity ?? 0) + stockConsumed,
        stockQuantity: (existing?.stockQuantity ?? 0) + stockConsumed,
        remainingStockQuantity: remaining,
        ...(request.locations ? { locationId: request.locations.market } : {}),
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

      if (
        stack.has(typeId) ||
        buildBlacklist.has(typeId) ||
        buyBlacklist.has(typeId)
      ) {
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
        await addMaterial(typeId, quantity, fallbackName);
        return;
      }

    activity = candidate.activity;
    const productQuantity =
      candidate.activity === "manufacturing"
        ? candidate.blueprint.activities.manufacturing!.products!.find(
            (product) => product.typeID === typeId,
          )!.quantity
        : candidate.blueprint.activities.reaction!.products!.find(
            (product) => product.typeID === typeId,
          )!.quantity;
    const runs = Math.ceil(quantity / productQuantity);
    const producedQuantity = runs * productQuantity;
    const surplus = producedQuantity - quantity;
    if (surplus > 0) producedParts.set(typeId, (producedParts.get(typeId) ?? 0) + surplus);
    const nextStack = new Set(stack).add(typeId);

      if (activity === "manufacturing") {
      const existing = manufacturingJobs.get(typeId);
      manufacturingJobs.set(typeId, {
        typeId,
        name: typeName(blueprint._key, `${fallbackName} Blueprint`),
        runs: (existing?.runs ?? 0) + runs,
        totalTime:
          (existing?.totalTime ?? 0) +
          blueprint.activities.manufacturing!.time * (1 - efficiency.te / 100) * runs,
        ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
      });
      bpcs.set(blueprint._key, {
        typeId: blueprint._key,
        name: typeName(blueprint._key, `${fallbackName} Blueprint`),
        quantity: (bpcs.get(blueprint._key)?.quantity ?? 0) + runs,
      });
        phase = "manufacturing materials";
        await profiler.measure("expand.materials", async () => {
          for (const material of blueprint.activities.manufacturing?.materials ?? []) {
            const materialQuantity = Math.ceil(material.quantity * runs * (1 - efficiency.me / 100));
            await expand(
              material.typeID,
              materialQuantity,
              typeName(material.typeID, `Type ${material.typeID}`),
              nextStack,
              defaultEfficiency,
            );
          }
        });
        return;
      }

    const existing = reactionJobs.get(typeId);
    reactionJobs.set(typeId, {
      typeId,
      name: typeName(blueprint._key, `${fallbackName} Blueprint`),
      runs: (existing?.runs ?? 0) + runs,
      totalTime:
        (existing?.totalTime ?? 0) +
        blueprint.activities.reaction!.time * (1 - efficiency.te / 100) * runs,
      ...(request.locations ? { locationId: request.locations.reactions } : {}),
    });
      phase = "reaction materials";
      await profiler.measure("expand.materials", async () => {
        for (const material of blueprint.activities.reaction?.materials ?? []) {
          await expand(
            material.typeID,
            material.quantity * runs,
            typeName(material.typeID, `Type ${material.typeID}`),
            nextStack,
            defaultEfficiency,
          );
        }
      });
    }, () => ({ typeId, quantity, depth: stack.size, activity, phase }));
  }

  for (const item of request.items) {
    await expand(item.typeId, item.quantity, item.name, new Set(), {
      me: clampEfficiency(item.me, 10),
      te: clampEfficiency(item.te, 20),
    });
  }

  await profiler.measure("invention", async () => {
    for (const bpc of [...bpcs.values()]) {
      const inventingBlueprints = await profiler.measure(
        "inventionBlueprintLookup",
        () => getBlueprintsByInventionProductId(bpc.typeId),
      );
      const inventingBlueprint = inventingBlueprints[0];
    const invention = inventingBlueprint?.activities.invention;
    const inventionProduct = invention?.products?.find((product) => product.typeID === bpc.typeId);
      if (!inventingBlueprint || !invention || !inventionProduct) continue;

    const successProbability = inventionProduct.probability ?? 1;
    const inventionRuns = Math.ceil(
      bpc.quantity / (inventionProduct.quantity * successProbability),
    );
    const existing = inventionJobs.get(inventingBlueprint._key);
    inventionJobs.set(inventingBlueprint._key, {
      typeId: inventingBlueprint._key,
      name: typeName(inventingBlueprint._key, "Blueprint Copy"),
      runs: (existing?.runs ?? 0) + inventionRuns,
      ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
    });
    const sourceBpc = bpcs.get(inventingBlueprint._key);
    bpcs.set(inventingBlueprint._key, {
      typeId: inventingBlueprint._key,
      name: typeName(inventingBlueprint._key, "Blueprint Copy"),
      quantity: (sourceBpc?.quantity ?? 0) + inventionRuns,
    });
      for (const material of invention.materials ?? []) {
        await addMaterial(
          material.typeID,
          material.quantity * inventionRuns,
          typeName(material.typeID, `Type ${material.typeID}`),
        );
      }
    }
  });

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

  const materialsToBuy = [...materials.values()];
  const haulingTasks: PlanResult["lists"]["haulingTasks"] = [];
  const remainingConsumption = new Map(consumedStock);
  const planningStock = request.stock ?? [];
  for (const stock of planningStock) {
    if (!stock.sourceLocationId || stock.locationResolved === false) continue;
    const quantity = Math.min(stock.quantity, remainingConsumption.get(stock.typeId) ?? 0);
    if (quantity <= 0 || !request.locations || stock.sourceLocationId === request.locations.manufacturing) continue;
    remainingConsumption.set(stock.typeId, (remainingConsumption.get(stock.typeId) ?? 0) - quantity);
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
      locationResolved: true,
    });
  }
  const result = {
    metadata: {
      generatedAt: new Date().toISOString(),
      assetsLastUpdated: null,
      jobsLastUpdated: null,
      unresolvedAssetCount: planningStock.filter((stock) => stock.locationResolved === false).length,
      corporationAssetSources: [...new Set(planningStock.filter((stock) => stock.ownerType === "corporation").map((stock) => stock.ownerId).filter((id): id is number => id !== undefined))],
    },
    lists: {
      materialsToBuy,
      bpcsNeeded: [...bpcs.values()],
      inventionJobs: [...inventionJobs.values()],
      reactionJobs: [...reactionJobs.values()],
      manufacturingJobs: [...manufacturingJobs.values()],
      haulingTasks,
    },
  };
  if (profiler.isEnabled) {
    console.debug(`[plan] calculatePlan completed in ${(performance.now() - startedAt).toFixed(1)}ms`, {
      items: request.items.length,
      materials: materialsToBuy.length,
      manufacturingJobs: manufacturingJobs.size,
      reactionJobs: reactionJobs.size,
    });
    profiler.logSummary();
  }
  return result;
}
