import {
  blueprintByProductTypeId,
  blueprintByReactionProductTypeId,
  blueprintByInventionProductId,
  ensureSdeLoaded,
  typeById,
} from "@/lib/sde/loader";
import type { SdeLanguage } from "@/lib/reference/languages";
import { PlanRequest, PlanResult } from "./types";

type Material = PlanResult["lists"]["materialsToBuy"][number];
type Efficiency = { me: number; te: number };

function clampEfficiency(value: number, maximum: number) {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

function typeName(typeId: number, fallback: string, language: SdeLanguage) {
  const name = typeById.get(typeId)?.name;
  return name?.[language] ?? name?.en ?? fallback;
}

export function calculatePlan(request: PlanRequest): PlanResult {
  ensureSdeLoaded();
  const language = request.language ?? "en";
  const materials = new Map<number, Material>();
  const bpcs = new Map<number, PlanResult["lists"]["bpcsNeeded"][number]>();
  const manufacturingJobs = new Map<number, PlanResult["lists"]["manufacturingJobs"][number]>();
  const reactionJobs = new Map<number, PlanResult["lists"]["reactionJobs"][number]>();
  const inventionJobs = new Map<number, PlanResult["lists"]["inventionJobs"][number]>();
  const producedParts = new Map<number, number>();
  const availableStock = new Map<number, number>();
  for (const item of request.stock ?? []) {
    if (item.quantity > 0) {
      availableStock.set(item.typeId, (availableStock.get(item.typeId) ?? 0) + item.quantity);
    }
  }
  const defaultEfficiency: Efficiency = {
    me: clampEfficiency(request.settings.defaultMe ?? 10, 10),
    te: clampEfficiency(request.settings.defaultTe ?? 20, 20),
  };

  function addMaterial(typeId: number, quantity: number, fallbackName: string) {
    const stockAvailable = availableStock.get(typeId) ?? 0;
    const stockConsumed = Math.min(stockAvailable, quantity);
    const remainingStock = stockAvailable - stockConsumed;
    if (remainingStock > 0) availableStock.set(typeId, remainingStock);
    else if (stockConsumed > 0) availableStock.delete(typeId);
    const existing = materials.get(typeId);
    materials.set(typeId, {
      typeId,
      name: typeName(typeId, fallbackName, language),
      quantity: (existing?.quantity ?? 0) + quantity - stockConsumed,
      requiredQuantity: (existing?.requiredQuantity ?? 0) + quantity,
      stockQuantity: (existing?.stockQuantity ?? 0) + stockConsumed,
      remainingStockQuantity: remainingStock,
      ...(request.locations ? { locationId: request.locations.market } : {}),
    });
  }

  function expand(
    typeId: number,
    quantity: number,
    fallbackName: string,
    stack: Set<number>,
    efficiency: Efficiency,
  ) {
    if (quantity <= 0) return;

    const stockAvailable = availableStock.get(typeId) ?? 0;
    const stockConsumed = Math.min(stockAvailable, quantity);
    if (stockConsumed > 0) {
      const remaining = stockAvailable - stockConsumed;
      if (remaining > 0) availableStock.set(typeId, remaining);
      else availableStock.delete(typeId);
      quantity -= stockConsumed;
      const existing = materials.get(typeId);
      materials.set(typeId, {
        typeId,
        name: typeName(typeId, fallbackName, language),
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
      request.settings.buildBlacklist.includes(typeId) ||
      request.settings.buyBlacklist.includes(typeId)
    ) {
      addMaterial(typeId, quantity, fallbackName);
      return;
    }

    const manufacturingBlueprint = blueprintByProductTypeId.get(typeId)?.[0];
    const manufacturingProduct = manufacturingBlueprint?.activities.manufacturing?.products?.find(
      (product) => product.typeID === typeId,
    );
    const reactionBlueprint = blueprintByReactionProductTypeId.get(typeId)?.[0];
    const reactionProduct = reactionBlueprint?.activities.reaction?.products?.find(
      (product) => product.typeID === typeId,
    );
    const blueprint =
      manufacturingBlueprint && manufacturingProduct
        ? manufacturingBlueprint
        : reactionBlueprint && reactionProduct
          ? reactionBlueprint
          : undefined;

    if (!blueprint) {
      addMaterial(typeId, quantity, fallbackName);
      return;
    }

    const activity = manufacturingBlueprint && manufacturingProduct ? "manufacturing" : "reaction";
    const productQuantity =
      activity === "manufacturing" ? manufacturingProduct!.quantity : reactionProduct!.quantity;
    const runs = Math.ceil(quantity / productQuantity);
    const producedQuantity = runs * productQuantity;
    const surplus = producedQuantity - quantity;
    if (surplus > 0) producedParts.set(typeId, (producedParts.get(typeId) ?? 0) + surplus);
    const nextStack = new Set(stack).add(typeId);

    if (activity === "manufacturing") {
      const existing = manufacturingJobs.get(typeId);
      manufacturingJobs.set(typeId, {
        typeId,
        name: typeName(blueprint._key, `${fallbackName} Blueprint`, language),
        runs: (existing?.runs ?? 0) + runs,
        totalTime:
          (existing?.totalTime ?? 0) +
          blueprint.activities.manufacturing!.time * (1 - efficiency.te / 100) * runs,
        ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
      });
      bpcs.set(blueprint._key, {
        typeId: blueprint._key,
        name: typeName(blueprint._key, `${fallbackName} Blueprint`, language),
        quantity: (bpcs.get(blueprint._key)?.quantity ?? 0) + runs,
      });
      for (const material of blueprint.activities.manufacturing?.materials ?? []) {
        const materialQuantity = Math.ceil(material.quantity * runs * (1 - efficiency.me / 100));
        expand(
          material.typeID,
          materialQuantity,
          typeName(material.typeID, `Type ${material.typeID}`, language),
          nextStack,
          defaultEfficiency,
        );
      }
      return;
    }

    const existing = reactionJobs.get(typeId);
    reactionJobs.set(typeId, {
      typeId,
      name: typeName(blueprint._key, `${fallbackName} Blueprint`, language),
      runs: (existing?.runs ?? 0) + runs,
      totalTime:
        (existing?.totalTime ?? 0) +
        blueprint.activities.reaction!.time * (1 - efficiency.te / 100) * runs,
      ...(request.locations ? { locationId: request.locations.reactions } : {}),
    });
    for (const material of blueprint.activities.reaction?.materials ?? []) {
      expand(
        material.typeID,
        material.quantity * runs,
        typeName(material.typeID, `Type ${material.typeID}`, language),
        nextStack,
        defaultEfficiency,
      );
    }
  }

  for (const item of request.items) {
    expand(item.typeId, item.quantity, item.name, new Set(), {
      me: clampEfficiency(item.me, 10),
      te: clampEfficiency(item.te, 20),
    });
  }

  for (const bpc of [...bpcs.values()]) {
    const inventingBlueprint = blueprintByInventionProductId.get(bpc.typeId)?.[0];
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
      name: typeName(inventingBlueprint._key, "Blueprint Copy", language),
      runs: (existing?.runs ?? 0) + inventionRuns,
      ...(request.locations ? { locationId: request.locations.manufacturing } : {}),
    });
    const sourceBpc = bpcs.get(inventingBlueprint._key);
    bpcs.set(inventingBlueprint._key, {
      typeId: inventingBlueprint._key,
      name: typeName(inventingBlueprint._key, "Blueprint Copy", language),
      quantity: (sourceBpc?.quantity ?? 0) + inventionRuns,
    });
    for (const material of invention.materials ?? []) {
      addMaterial(
        material.typeID,
        material.quantity * inventionRuns,
        typeName(material.typeID, `Type ${material.typeID}`, language),
      );
    }
  }

  const materialsToBuy = [...materials.values()];
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      assetsLastUpdated: null,
      jobsLastUpdated: null,
    },
    lists: {
      materialsToBuy,
      bpcsNeeded: [...bpcs.values()],
      inventionJobs: [...inventionJobs.values()],
      reactionJobs: [...reactionJobs.values()],
      manufacturingJobs: [...manufacturingJobs.values()],
      haulingTasks: [],
    },
  };
}
