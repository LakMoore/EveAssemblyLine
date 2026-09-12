import type { ProductionGroupReference } from "@/lib/planning/productionGroups";
import type { SdeLanguage } from "./languages";

const productionGroupsCache = new Map<string, Promise<ProductionGroupReference[]>>();

export function fetchProductionGroups(language: SdeLanguage) {
  const cached = productionGroupsCache.get(language);
  if (cached) return cached;

  const request = fetch(`/api/reference/production-groups?language=${language}`).then(
    async (response) => {
      const data = (await response.json()) as {
        items?: ProductionGroupReference[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "SDE production group data is unavailable.");
      if (!Array.isArray(data.items) || data.items.length === 0) {
        throw new Error("SDE production group data is unavailable.");
      }
      return data.items;
    },
  );
  productionGroupsCache.set(language, request);
  void request.catch(() => productionGroupsCache.delete(language));
  return request;
}
