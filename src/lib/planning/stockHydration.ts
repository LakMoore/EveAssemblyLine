import { getGroups, getMarketGroups, getTypesByIds } from "@/cache/services/sdeCache";
import { categorizeType } from "@/lib/reference/category";
import type { PlanStockItem } from "./types";

export async function hydrateStockCategories(items: PlanStockItem[]) {
  if (items.length === 0) return items;

  const [types, groups, marketGroups] = await Promise.all([
    getTypesByIds([...new Set(items.map((item) => item.typeId))]),
    getGroups(),
    getMarketGroups(),
  ]);

  return items.map((item) => {
    const type = types.get(item.typeId);
    if (!type) return { ...item, category: "item" as const };

    const categorized = categorizeType(type, "en", marketGroups, groups);
    const category: NonNullable<PlanStockItem["category"]> = categorized.category;
    return {
      ...item,
      category,
    };
  });
}
