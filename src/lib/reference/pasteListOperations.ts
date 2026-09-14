export type PasteListMode = "add" | "replace" | "subtract";

export type PasteListQuantityItem = {
  typeId: number;
  quantity?: number;
};

/** Applies a paste mode while preserving existing rows that are reduced to zero. */
export function applyPasteListMode<T extends PasteListQuantityItem>(
  currentItems: T[],
  importedItems: T[],
  mode: PasteListMode,
): T[] {
  if (mode === "replace") return importedItems;

  const merged = currentItems.map((item) => ({ ...item }));
  for (const item of importedItems) {
    const existingIndex = merged.findIndex((entry) => entry.typeId === item.typeId);
    if (existingIndex === -1) {
      if (mode === "add") merged.push(item);
      continue;
    }

    const existing = merged[existingIndex];
    const currentQuantity = existing.quantity ?? 0;
    const importedQuantity = item.quantity ?? 0;
    merged[existingIndex] = {
      ...existing,
      quantity:
        mode === "subtract"
          ? Math.max(0, currentQuantity - importedQuantity)
          : currentQuantity + importedQuantity,
    };
  }
  return merged;
}
