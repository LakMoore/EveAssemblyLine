import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
import {
  getAllAssetsRaw,
  getBlueprintInstances,
  getCorporationSourceCatalog,
  getResolvedAssets,
  getRootLocationsByItemId,
  getRunningIndustryJobs,
} from "@/lib/esi/cache";
import {
  assertCharacterOwner,
  assertCorporationOwner,
  getCorporationPolicy,
  type OwnerDataContext,
} from "./types";

export type OwnerAssetData = {
  assets: AssetRecord[];
  rawAssets: AssetRecord[];
  jobs: IndustryJobRecord[];
  blueprintInstances: BlueprintInstanceRecord[];
  rootLocationsByItemId: Map<number, AssetLocation>;
  corporationSources: Awaited<ReturnType<typeof getCorporationSourceCatalog>>;
};

async function loadOwnerAssetData(
  characterIds: readonly number[],
  includeCorporationData: boolean,
  context: OwnerDataContext,
  corporationIds?: readonly number[],
): Promise<OwnerAssetData> {
  const policies = includeCorporationData ? context.corporationPolicies : [];
  const [assets, rawAssets, jobs, blueprintInstances, rootLocationsByItemId, corporationSources] =
    await Promise.all([
      getResolvedAssets([...characterIds], includeCorporationData, context.sessionId, policies),
      getAllAssetsRaw([...characterIds], includeCorporationData, context.sessionId, policies),
      getRunningIndustryJobs(
        [...characterIds],
        includeCorporationData,
        context.sessionId,
        policies,
      ),
      getBlueprintInstances([...characterIds], includeCorporationData, context.sessionId, policies),
      getRootLocationsByItemId(
        [...characterIds],
        includeCorporationData,
        context.sessionId,
        policies,
      ),
      includeCorporationData
        ? getCorporationSourceCatalog(
            [...characterIds],
            policies,
            context.sessionId,
            context.authorizationCharacterId,
          )
        : Promise.resolve([]),
    ]);

  if (!corporationIds) {
    return {
      assets,
      rawAssets,
      jobs,
      blueprintInstances,
      rootLocationsByItemId,
      corporationSources,
    };
  }

  const ownerMatches = (ownerType: "character" | "corporation", ownerId: number) =>
    ownerType === "corporation" && corporationIds.includes(ownerId);
  const ownerAssetItemIds = new Set(
    assets
      .filter((asset) => ownerMatches(asset.ownerType, asset.ownerId))
      .map((asset) => asset.itemId),
  );
  const ownerRawAssetItemIds = new Set(
    rawAssets
      .filter((asset) => ownerMatches(asset.ownerType, asset.ownerId))
      .map((asset) => asset.itemId),
  );
  return {
    assets: assets.filter((asset) => ownerMatches(asset.ownerType, asset.ownerId)),
    rawAssets: rawAssets.filter((asset) => ownerMatches(asset.ownerType, asset.ownerId)),
    jobs: jobs.filter((job) => ownerMatches(job.ownerType, job.ownerId)),
    blueprintInstances: blueprintInstances.filter((blueprint) =>
      ownerMatches(blueprint.ownerType, blueprint.ownerId),
    ),
    rootLocationsByItemId: new Map(
      [...rootLocationsByItemId].filter(
        ([itemId]) => ownerAssetItemIds.has(itemId) || ownerRawAssetItemIds.has(itemId),
      ),
    ),
    corporationSources: corporationSources.filter((source) =>
      corporationIds.includes(source.corporationId),
    ),
  };
}

/** Loads the cached asset graph and related records for one attached character. */
export async function getAssetsForCharacter(
  characterId: number,
  context: OwnerDataContext,
): Promise<OwnerAssetData> {
  assertCharacterOwner(characterId, context);
  return loadOwnerAssetData([characterId], false, context);
}

/** Loads the source-filtered asset graph and related records for one corporation. */
export async function getAssetsForCorporation(
  corporationId: number,
  context: OwnerDataContext,
): Promise<OwnerAssetData> {
  assertCorporationOwner(corporationId, context);
  const policy = getCorporationPolicy(corporationId, context);
  return loadOwnerAssetData(
    context.characterIds,
    true,
    {
      ...context,
      corporationPolicies: policy ? [policy] : [],
    },
    [corporationId],
  );
}
