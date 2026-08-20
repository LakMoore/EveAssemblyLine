import type { TypeMaterialsRecord } from "@/lib/sde/generated";

type ReprocessTypeRecord = { portionSize?: number };

export const specialReprocessableTypeIds = [15331, 30497] as const;

export type ReprocessStockResult = {
  stock: Map<number, number>;
  consumedCompressed: Map<number, number>;
  producedMaterials: Map<number, number>;
};

/**
 * Converts available compressed stock into its SDE material yields before planning starts.
 * Only complete reprocessing portions are consumed; partial compressed stacks remain available.
 */
export function reprocessCompressedStock(
  stock: Map<number, number>,
  requiredCompressedQuantities: ReadonlyMap<number, number>,
  compressibleTypes: ReadonlyMap<number, number>,
  typeMaterials: ReadonlyMap<number, TypeMaterialsRecord>,
  types: ReadonlyMap<number, ReprocessTypeRecord>,
  additionalCompressedTypeIds: readonly number[] = specialReprocessableTypeIds,
  efficiencyByTypeId: ReadonlyMap<number, number> = new Map(),
): ReprocessStockResult {
  const nextStock = new Map(stock);
  const consumedCompressed = new Map<number, number>();
  const producedMaterials = new Map<number, number>();
  const reprocessableTypeIds = new Set([
    ...compressibleTypes.values(),
    ...additionalCompressedTypeIds,
  ]);
  for (const compressedTypeId of reprocessableTypeIds) {
    const materialRecord = typeMaterials.get(compressedTypeId);
    const portionSize = types.get(compressedTypeId)?.portionSize ?? 1;
    if (!materialRecord || portionSize <= 0) continue;
    const available = nextStock.get(compressedTypeId) ?? 0;
    const reserved = Math.min(available, requiredCompressedQuantities.get(compressedTypeId) ?? 0);
    const processable = Math.floor((available - reserved) / portionSize) * portionSize;
    if (processable <= 0) continue;
    const remaining = available - processable;
    if (remaining > 0) nextStock.set(compressedTypeId, remaining);
    else nextStock.delete(compressedTypeId);
    consumedCompressed.set(compressedTypeId, processable);
    const runs = processable / portionSize;
    const efficiency = efficiencyByTypeId.get(compressedTypeId) ?? 50;
    for (const material of materialRecord.materials ?? []) {
      producedMaterials.set(
        material.materialTypeID,
        (producedMaterials.get(material.materialTypeID) ?? 0)
          + Math.floor((material.quantity * runs * efficiency) / 100),
      );
    }
  }
  for (const [typeId, quantity] of producedMaterials) {
    nextStock.set(typeId, (nextStock.get(typeId) ?? 0) + quantity);
  }
  return { stock: nextStock, consumedCompressed, producedMaterials };
}
