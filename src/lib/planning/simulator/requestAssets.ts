import type { StockItem } from "@/lib/planning/types";

/** Returns whether an inventory item can contribute to a simulation request. */
function isSimulationAssetEligible(item: StockItem): boolean {
  return (
    item.source === "marketOrder"
    || item.isPackaged === true
    || item.blueprintPrints !== undefined
    || item.category === "blueprint"
    || item.category === "reactionformula"
  );
}

function blueprintAssetKey(item: StockItem): string {
  return [
    item.typeId,
    item.rootLocationId ?? item.sourceLocationId ?? item.locationId ?? "unlocated",
    item.ownerType ?? "",
    item.ownerId ?? "",
    item.inUse === true ? "in-use" : "available",
  ].join(":");
}

/** Filters unusable stock and merges blueprint prints by type, location, and owner. */
export function prepareSimulationAssets(items: readonly StockItem[]): StockItem[] {
  const prepared: StockItem[] = [];
  const blueprintIndexes = new Map<string, number>();
  for (const item of items) {
    if (!isSimulationAssetEligible(item)) continue;
    const isBlueprint =
      item.blueprintPrints !== undefined
      || item.category === "blueprint"
      || item.category === "reactionformula";
    if (!isBlueprint) {
      prepared.push(item);
      continue;
    }
    const key = blueprintAssetKey(item);
    const existingIndex = blueprintIndexes.get(key);
    if (existingIndex === undefined) {
      blueprintIndexes.set(key, prepared.length);
      prepared.push({
        ...item,
        blueprintPrints: item.blueprintPrints ? [...item.blueprintPrints] : undefined,
      });
      continue;
    }
    const existing = prepared[existingIndex];
    const printsByItemId = new Map(
      (existing.blueprintPrints ?? []).map((print) => [print.itemId, print]),
    );
    for (const print of item.blueprintPrints ?? []) printsByItemId.set(print.itemId, print);
    prepared[existingIndex] = {
      ...existing,
      quantity: existing.quantity + item.quantity,
      blueprintPrints: [...printsByItemId.values()],
    };
  }
  return prepared;
}
