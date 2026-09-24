import { getGroups, getIndustryTargetFilters } from "@/cache/services/sdeCache";
import {
  getProductionGroupReferences,
  type ProductionGroupReference,
} from "@/lib/planning/productionGroups";
import type { SdeLanguage } from "./languages";

/** Loads the production-group reference data shared by server-side consumers. */
export async function loadProductionGroupReferences(
  language: SdeLanguage,
): Promise<ProductionGroupReference[]> {
  const [groups, targetFilters] = await Promise.all([getGroups(), getIndustryTargetFilters()]);
  return getProductionGroupReferences(targetFilters, groups, language);
}
