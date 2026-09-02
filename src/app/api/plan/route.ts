import { NextResponse } from "next/server";
import { z } from "zod";
import { calculatePlan } from "@/lib/planning/planEngine";
import { hydrateStockCategories } from "@/lib/planning/stockHydration";
import {
  getBlueprintById,
  getBuildBlueprintByProductTypeId,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import type {
  BuildItem,
  PlanBuildItem,
  PlanIndustryInput,
  PlanItemInput,
  PlanMarketInput,
  PlanRequest,
  PlanFacilityProfile,
  PlanStockItem,
} from "@/lib/planning/types";
import { productionGroupDefinitions } from "@/lib/planning/productionGroups";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreResponseInit: ResponseInit = {
  headers: { "Cache-Control": "no-store" },
};

const reprocessingEfficienciesSchema = z.record(
  z.string().regex(/^\d+$/, "Reprocessable type IDs must be numeric."),
  z.number().finite().min(0).max(100),
);
const facilityTimeMultipliersSchema = z.object({
  manufacturing: z.number().finite().min(0).max(1),
  reactions: z.number().finite().min(0).max(1),
});
const skillTimeMultipliersSchema = facilityTimeMultipliersSchema;
const planBuildItemSchema = z.object({
  typeId: z.number().int().positive(),
  quantity: z.number().finite().positive(),
  me: z.number().finite().min(0).max(10),
  te: z.number().finite().min(0).max(20),
  fromCompression: z.boolean(),
});
const productionGroupKeys = new Set(productionGroupDefinitions.map((group) => group.key));
const groupAssignmentsSchema = z
  .record(z.string(), z.number().int().positive())
  .superRefine((assignments, context) => {
    for (const key of Object.keys(assignments)) {
      if (!productionGroupKeys.has(key as (typeof productionGroupDefinitions)[number]["key"])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown production group: ${key}`,
        });
      }
    }
  });
const planBucketSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  locations: z.object({
    stock: z.number().int().positive(),
    manufacturing: z.number().int().positive(),
    reactions: z.number().int().positive(),
    reprocessing: z.number().int().positive(),
    copying: z.number().int().positive(),
    invention: z.number().int().positive(),
  }),
  groupAssignments: groupAssignmentsSchema.optional(),
  items: z.array(planBuildItemSchema),
});
const facilityGroupBonusSchema = z.object({
  manufacturingMaterialMultiplier: z.number().finite().min(0).max(2),
  manufacturingMaterialPercentage: z.number().finite().min(-100).max(100),
  manufacturingTimeMultiplier: z.number().finite().min(0).max(2),
  manufacturingTimePercentage: z.number().finite().min(-100).max(100),
  reactionMaterialMultiplier: z.number().finite().min(0).max(2),
  reactionMaterialPercentage: z.number().finite().min(-100).max(100),
  reactionTimeMultiplier: z.number().finite().min(0).max(2),
  reactionTimePercentage: z.number().finite().min(-100).max(100),
});
const facilityProfilesSchema = z
  .array(
    z.object({
      locationId: z.number().int().positive(),
      sizeId: z.number().finite().min(0),
      buildTypeGroups: z.record(z.string(), facilityGroupBonusSchema),
    }),
  )
  .max(100);
const planBucketsSchema = z
  .array(planBucketSchema)
  .min(1)
  .max(100)
  .superRefine((buckets, context) => {
    const seen = new Set<string>();
    for (const [index, bucket] of buckets.entries()) {
      const key = `${bucket.locations.stock}:${bucket.locations.manufacturing}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "locations"],
          message: "Stock and build locations must be unique across buckets",
        });
      }
      seen.add(key);
    }
  });

function validLocation(value: { locationId: number; rootLocationId: number }) {
  return Number.isInteger(value.locationId) && Number.isInteger(value.rootLocationId);
}

function validQuantity(value: number) {
  return Number.isFinite(value) && value > 0;
}

function stockItem(
  item: PlanItemInput | PlanMarketInput | PlanIndustryInput,
  extra: Partial<PlanStockItem> = {},
): PlanStockItem {
  return {
    typeId: item.typeId,
    name: `Type ${item.typeId}`,
    quantity: item.quantity,
    locationId: item.locationId,
    rootLocationId: item.rootLocationId,
    ...extra,
  };
}

function industryProduct(
  job: PlanIndustryInput,
  blueprint: Awaited<ReturnType<typeof getBlueprintById>>,
) {
  if (!blueprint) return undefined;
  if (job.activity === "Copying") {
    const licensedRuns = job.licensedRuns ?? 1;
    return {
      typeId: job.blueprintTypeId ?? job.typeId,
      quantity: job.runs * licensedRuns,
      blueprint: true,
      runs: licensedRuns,
    };
  }
  const activity =
    job.activity === "Invention"
      ? blueprint.activities.invention
      : job.activity === "Reactions"
        ? blueprint.activities.reaction
        : blueprint.activities.manufacturing;
  const product = activity?.products?.[0];
  if (!product) return undefined;
  return {
    typeId: product.typeID,
    quantity: job.runs * product.quantity,
    blueprint: job.activity === "Invention",
    runs: job.activity === "Invention" ? product.quantity : undefined,
  };
}

async function calculateWorkingAssetsPlan(input: PlanRequest, assets: PlanStockItem[]) {
  const requestedItems = input.buckets?.flatMap((bucket) => bucket.items) ?? input.toBuild ?? [];
  const types = await getTypesByIds([
    ...new Set([
      ...requestedItems.map((item) => item.typeId),
      ...assets.map((item) => item.typeId),
    ]),
  ]);
  const resolveBuildItem = (item: PlanBuildItem): BuildItem => ({
    ...item,
    fromCompression: item.fromCompression === true,
    name:
      types.get(item.typeId)?.name[input.language ?? "en"]
      ?? types.get(item.typeId)?.name.en
      ?? `Type ${item.typeId}`,
  });
  const buildItems = requestedItems.map(resolveBuildItem);
  const buckets = input.buckets?.map((bucket) => ({
    ...bucket,
    items: bucket.items.map(resolveBuildItem),
  }));
  const result = await calculatePlan({
    language: input.language,
    items: buildItems,
    buckets,
    reprocessingEfficiencies: input.reprocessingEfficiencies,
    stock: await hydrateStockCategories(assets),
    locations: input.locations,
    facilityTimeMultipliers: input.facilityTimeMultipliers,
    facilityProfiles: input.facilityProfiles,
    skillTimeMultipliers: input.skillTimeMultipliers,
    settings: input.settings,
  });
  result.metadata.unresolvedAssetCount = 0;
  return result;
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PlanRequest;
    const parsedEfficiencies = reprocessingEfficienciesSchema.safeParse(
      input.reprocessingEfficiencies ?? {},
    );
    if (!parsedEfficiencies.success) {
      return NextResponse.json(
        { error: "Reprocessing efficiencies must map numeric type IDs to percentages." },
        { status: 400 },
      );
    }
    input.reprocessingEfficiencies = parsedEfficiencies.data;
    if (input.facilityTimeMultipliers !== undefined) {
      const parsedMultipliers = facilityTimeMultipliersSchema.safeParse(
        input.facilityTimeMultipliers,
      );
      if (!parsedMultipliers.success) {
        return NextResponse.json(
          { error: "Facility time multipliers must be between 0 and 1." },
          { status: 400 },
        );
      }
      input.facilityTimeMultipliers = parsedMultipliers.data;
    }
    if (input.skillTimeMultipliers !== undefined) {
      const parsedMultipliers = skillTimeMultipliersSchema.safeParse(input.skillTimeMultipliers);
      if (!parsedMultipliers.success) {
        return NextResponse.json(
          { error: "Skill time multipliers must be between 0 and 1." },
          { status: 400 },
        );
      }
      input.skillTimeMultipliers = parsedMultipliers.data;
    }
    if (input.facilityProfiles !== undefined) {
      const parsedProfiles = facilityProfilesSchema.safeParse(input.facilityProfiles);
      if (!parsedProfiles.success) {
        return NextResponse.json(
          { error: "Facility group profiles are not valid." },
          { status: 400 },
        );
      }
      input.facilityProfiles = parsedProfiles.data as PlanFacilityProfile[];
    }
    const parsedBuckets =
      input.buckets === undefined ? undefined : planBucketsSchema.safeParse(input.buckets);
    if (parsedBuckets && !parsedBuckets.success) {
      return NextResponse.json(
        { error: "Every bucket needs a name, six valid locations, and valid build items." },
        { status: 400 },
      );
    }
    if (parsedBuckets?.success) {
      const populatedBuckets = parsedBuckets.data.filter((bucket) => bucket.items.length > 0);
      input.buckets = populatedBuckets.length > 0 ? populatedBuckets : undefined;
    }
    const requestedItems = input.buckets?.flatMap((bucket) => bucket.items) ?? input.toBuild ?? [];
    if (requestedItems.length === 0) {
      return NextResponse.json({ error: "Add at least one build item." }, { status: 400 });
    }
    input.toBuild = requestedItems;
    const workingAssets = Array.isArray(input.assets) ? input.assets : input.stock;
    if (Array.isArray(workingAssets)) {
      return NextResponse.json(
        await calculateWorkingAssetsPlan(input, workingAssets),
        noStoreResponseInit,
      );
    }
    const assets = input.assets;
    if (
      !assets
      || Array.isArray(assets)
      || !Array.isArray(assets.items)
      || !Array.isArray(assets.blueprints)
      || !Array.isArray(assets.industry)
      || !Array.isArray(assets.market)
    ) {
      return NextResponse.json({ error: "The assets payload is incomplete." }, { status: 400 });
    }
    const allRows = [...assets.items, ...assets.blueprints, ...assets.industry, ...assets.market];
    if (
      requestedItems.some((item) => !Number.isInteger(item.typeId) || !validQuantity(item.quantity))
      || allRows.some(
        (item) =>
          !Number.isInteger(item.typeId) || !validQuantity(item.quantity) || !validLocation(item),
      )
    ) {
      return NextResponse.json(
        { error: "Every plan input needs valid IDs and a positive quantity." },
        { status: 400 },
      );
    }
    if (
      assets.industry.some(
        (job) => !Number.isInteger(job.jobId) || !Number.isFinite(job.runs) || job.runs < 0,
      )
    ) {
      return NextResponse.json(
        { error: "Every industry entry needs a valid job and run count." },
        { status: 400 },
      );
    }
    const typeIds = [
      ...requestedItems.map((item) => item.typeId),
      ...allRows.flatMap((item) => [
        item.typeId,
        "blueprintTypeId" in item ? item.blueprintTypeId : undefined,
      ]),
    ].filter((typeId): typeId is number => typeId !== undefined);
    const types = await getTypesByIds([...new Set(typeIds)]);
    const resolveBuildItem = (item: PlanBuildItem): BuildItem => ({
      ...item,
      fromCompression: item.fromCompression === true,
      name:
        types.get(item.typeId)?.name[input.language ?? "en"]
        ?? types.get(item.typeId)?.name.en
        ?? `Type ${item.typeId}`,
    });
    const buildItems = requestedItems.map(resolveBuildItem);
    const buckets = input.buckets?.map((bucket) => ({
      ...bucket,
      items: bucket.items.map(resolveBuildItem),
    }));
    const normalizedBlueprints = assets.blueprints.map((blueprint) => ({ ...blueprint }));
    const industryStock: PlanStockItem[] = [];
    for (const job of assets.industry) {
      const blueprint =
        job.blueprintTypeId !== undefined
          ? await getBlueprintById(job.blueprintTypeId)
          : ((await getBuildBlueprintByProductTypeId(job.typeId))?.blueprint ?? null);
      const product = industryProduct(job, blueprint);
      if (!product) continue;
      const remainingRuns =
        job.blueprintRunsAtInstall === undefined
          ? job.activity === "Copying"
            ? -1
            : job.activity === "Manufacturing" && job.licensedRuns !== undefined
              ? Math.max(0, job.licensedRuns - job.runs)
              : undefined
          : job.blueprintRunsAtInstall === -1
            ? -1
            : job.activity === "Invention"
              ? 0
              : Math.max(0, job.blueprintRunsAtInstall - job.runs);
      if (remainingRuns !== undefined && job.blueprintTypeId !== undefined) {
        const matchingBlueprint = normalizedBlueprints.find(
          (candidate) =>
            (job.blueprintId !== undefined && candidate.itemId === job.blueprintId)
            || (
              candidate.typeId === job.blueprintTypeId
              && candidate.locationId === job.locationId
              && candidate.rootLocationId === job.rootLocationId
              && candidate.type === (job.blueprintRunsAtInstall === -1 ? "bpo" : "bpc")
            ),
        );
        if (matchingBlueprint) {
          if (matchingBlueprint.type === "bpc") matchingBlueprint.runs = remainingRuns;
        }
        else if (
          remainingRuns === -1
          || job.activity === "Manufacturing"
          || job.activity === "Copying"
        ) {
          normalizedBlueprints.push({
            ...(job.blueprintId !== undefined ? { itemId: job.blueprintId } : {}),
            typeId: job.blueprintTypeId,
            type: remainingRuns === -1 ? "bpo" : "bpc",
            locationId: job.locationId,
            rootLocationId: job.rootLocationId,
            quantity: 1,
            runs: remainingRuns,
          });
        }
      }
      industryStock.push(
        product.blueprint
          ? stockItem(
              { ...job, typeId: product.typeId, quantity: product.quantity },
              {
                category: "blueprint",
                blueprintPrints: Array.from(
                  { length: job.runs },
                  (_, index) => ({
                    itemId: -(job.jobId * 1_000_000 + index + 1),
                    runs: product.runs ?? 1,
                    type: "bpc" as const,
                  }),
                ),
                inBuild: true,
                inBuildQuantity: product.quantity,
                jobId: job.jobId,
                jobRuns: job.runs,
                activityName: job.activity,
                ...(job.status ? { industryJobStatus: job.status } : {}),
                blueprintRunsAtInstall: job.blueprintRunsAtInstall,
                licensedRuns: job.licensedRuns,
              },
            )
          : stockItem(
              { ...job, typeId: product.typeId, quantity: product.quantity },
              {
                category: "item",
                inBuild: true,
                inBuildQuantity: product.quantity,
                jobId: job.jobId,
                jobRuns: job.runs,
                activityName: job.activity,
                ...(job.status ? { industryJobStatus: job.status } : {}),
              },
            ),
      );
    }
    const rawStock: PlanStockItem[] = [
      ...assets.items.map((item) => stockItem(item)),
      ...assets.market.map((item) => stockItem(item, { source: "marketOrder" })),
      ...normalizedBlueprints.map((blueprint, index) =>
        stockItem(
          blueprint,
          {
            category: "blueprint",
            blueprintPrints: [
              {
                itemId: blueprint.itemId ?? -(index + 1),
                runs: blueprint.runs,
                type: blueprint.type,
                me: blueprint.me,
                te: blueprint.te,
              },
            ],
          },
        ),
      ),
      ...industryStock,
    ];
    const stock = await hydrateStockCategories(rawStock);
    const result = await calculatePlan({
      language: input.language,
      items: buildItems,
      buckets,
      reprocessingEfficiencies: input.reprocessingEfficiencies,
      stock,
      locations: input.locations,
      facilityTimeMultipliers: input.facilityTimeMultipliers,
      facilityProfiles: input.facilityProfiles,
      skillTimeMultipliers: input.skillTimeMultipliers,
      settings: input.settings,
    });
    result.metadata.unresolvedAssetCount = 0;
    return NextResponse.json(result, noStoreResponseInit);
  }
  catch {
    return NextResponse.json({ error: "The plan request was not valid JSON." }, { status: 400 });
  }
}
