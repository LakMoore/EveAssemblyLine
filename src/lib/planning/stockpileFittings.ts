import { savedFittingSchema, type SavedFitting } from "@/lib/fittings/model";
import type { ClientBuildItem, PlanBuildItem } from "./types";
import { reconcilePasteListItems, type PasteListMode } from "@/lib/reference/pasteListOperations";

/** By-value fitting contents remain usable even after the library entry is deleted. */
export const stockpileFittingSnapshotSchema = savedFittingSchema.pick({
  id: true,
  shipTypeId: true,
  items: true,
});

/** Immutable numeric contents stored alongside the fitting's stockpile quantity. */
export type StockpileFittingSnapshot = ReturnType<typeof stockpileFittingSnapshotSchema.parse>;

/** Reconciles type paste results without retaining fitting demand when replacing the whole list. */
export function reconcileStockpilePaste(
  current: ClientBuildItem[],
  result: Array<{ typeId: number; name: string; quantity?: number; category?: string }>,
  mode: PasteListMode,
): ClientBuildItem[] {
  return [
    ...(mode === "replace" ? [] : current.filter((item) => item.fitting)),
    ...reconcilePasteListItems(
      current.filter((item) => !item.fitting),
      result,
      (item) => ({
        name: item.name,
        categoryName: item.category ?? "Unknown",
        typeId: item.typeId,
        quantity: item.quantity ?? 1,
        me: 0,
        te: 0,
        fromCompression: false,
        isIncluded: true,
      }),
    ),
  ];
}

/** Adds one fitting, incrementing its existing row without refreshing its saved snapshot. */
export function addStockpileFitting(
  items: ClientBuildItem[],
  fitting: SavedFitting,
): ClientBuildItem[] {
  const existing = items.find((item) => item.fitting?.id === fitting.id);
  if (existing) {
    const quantity = checkedQuantity(existing.quantity + 1);
    return items.map((item) => (item === existing ? { ...item, quantity } : item));
  }
  return [
    {
      name: fitting.name,
      typeId: fitting.shipTypeId,
      categoryName: "Fitting",
      quantity: 1,
      me: 0,
      te: 0,
      fromCompression: false,
      isIncluded: true,
      fitting: {
        id: fitting.id,
        shipTypeId: fitting.shipTypeId,
        items: fitting.items.map((item) => ({ ...item })),
      },
    },
    ...items,
  ];
}

/** Rejects unsafe multiplication/addition rather than sending rounded quantities to the simulator. */
function checkedQuantity(quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Stockpile quantities must be positive safe integers.");
  }
  return quantity;
}

/** Expands included fitting snapshots to hull and item demand at the simulator boundary. */
export function expandStockpileItems(items: readonly ClientBuildItem[]): PlanBuildItem[] {
  const expanded: PlanBuildItem[] = [];
  for (const item of items) {
    if (item.isIncluded === false) continue;
    const quantity = checkedQuantity(item.quantity);
    if (!item.fitting) {
      expanded.push({
        typeId: item.typeId,
        quantity,
        me: item.me,
        te: item.te,
        fromCompression: item.fromCompression,
      });
      continue;
    }
    const snapshot = stockpileFittingSnapshotSchema.safeParse(item.fitting);
    if (!snapshot.success) throw new Error(`Invalid saved fitting contents for ${item.name}.`);
    const totals = new Map<number, number>([[snapshot.data.shipTypeId, quantity]]);
    for (const component of snapshot.data.items) {
      totals.set(
        component.type_id,
        checkedQuantity(
          (totals.get(component.type_id) ?? 0) + checkedQuantity(component.quantity * quantity),
        ),
      );
    }
    for (const [typeId, total] of totals) {
      expanded.push({ typeId, quantity: total, me: 0, te: 0, fromCompression: false });
    }
  }
  return expanded;
}
