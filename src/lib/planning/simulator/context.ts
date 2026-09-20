import {
  getBlueprints,
  getCompressibleTypes,
  getGroups,
  getIndustryTargetFilters,
  getMarketGroups,
  getSdeBuildNumber,
  getSkillPrerequisites,
  getTypeDogma,
  getTypeMaterials,
  getTypes,
} from "@/lib/sde/loader";
import { getProductionGroupReferences } from "@/lib/planning/productionGroups";

/** Immutable SDE indexes used throughout one simulator request. */
export interface SimulationContext {
  types: Awaited<ReturnType<typeof getTypes>>;
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>;
  blueprints: Awaited<ReturnType<typeof getBlueprints>>;
  compressibleTypes: Awaited<ReturnType<typeof getCompressibleTypes>>;
  typeMaterials: Awaited<ReturnType<typeof getTypeMaterials>>;
  groups: Awaited<ReturnType<typeof getGroups>>;
  productionGroups: ReturnType<typeof getProductionGroupReferences>;
  skillPrerequisites: Awaited<ReturnType<typeof getSkillPrerequisites>>;
  typeDogma: Awaited<ReturnType<typeof getTypeDogma>>;
  sdeRevision: string;
}

/** Loads all simulator SDE indexes once and shares their process-level caches. */
export async function loadSimulationContext(): Promise<SimulationContext> {
  const [
    types,
    marketGroups,
    blueprints,
    compressibleTypes,
    typeMaterials,
    groups,
    targetFilters,
    skillPrerequisites,
    typeDogma,
    sdeRevision,
  ] = await Promise.all([
    getTypes(),
    getMarketGroups(),
    getBlueprints(),
    getCompressibleTypes(),
    getTypeMaterials(),
    getGroups(),
    getIndustryTargetFilters(),
    getSkillPrerequisites(),
    getTypeDogma(),
    getSdeBuildNumber(),
  ]);
  return {
    types,
    marketGroups,
    blueprints,
    compressibleTypes,
    typeMaterials,
    groups,
    productionGroups: getProductionGroupReferences(targetFilters, groups),
    skillPrerequisites,
    typeDogma,
    sdeRevision,
  };
}
