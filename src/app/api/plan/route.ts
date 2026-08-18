import { NextResponse } from "next/server";
import { calculatePlan } from "@/lib/planning/planEngine";
import { hydrateStockCategories } from "@/lib/planning/stockHydration";
import {
  getBlueprintById,
  getBuildBlueprintByProductTypeId,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import type {
  BuildItem,
  ClientBuildItem,
  PlanBlueprintInput,
  PlanIndustryInput,
  PlanItemInput,
  PlanMarketInput,
  PlanRequest,
  PlanStockItem,
} from "@/lib/planning/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreResponseInit: ResponseInit = {
  headers: { "Cache-Control": "no-store" },
};

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

async function calculateWorkingStockPlan(input: PlanRequest, stock: PlanStockItem[]) {
  const types = await getTypesByIds([
    ...new Set([...input.toBuild.map((item) => item.typeId), ...stock.map((item) => item.typeId)]),
  ]);
  const buildItems: BuildItem[] = input.toBuild.map((item) => ({
    ...item,
    fromCompression: item.fromCompression === true,
    name:
      types.get(item.typeId)?.name[input.language ?? "en"]
      ?? types.get(item.typeId)?.name.en
      ?? `Type ${item.typeId}`,
  }));
  const result = await calculatePlan({
    language: input.language,
    items: buildItems,
    stock: await hydrateStockCategories(stock),
    locations: input.locations,
    settings: input.settings,
  });
  result.metadata.unresolvedAssetCount = 0;
  return result;
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PlanRequest;
    if (!Array.isArray(input.toBuild) || input.toBuild.length === 0) {
      return NextResponse.json({ error: "Add at least one build item." }, { status: 400 });
    }
    if (Array.isArray(input.stock)) {
      return NextResponse.json(
        await calculateWorkingStockPlan(input, input.stock),
        noStoreResponseInit,
      );
    }
    const assets = input.assets;
    if (
      !assets
      || !Array.isArray(assets.items)
      || !Array.isArray(assets.blueprints)
      || !Array.isArray(assets.industry)
      || !Array.isArray(assets.market)
    ) {
      return NextResponse.json({ error: "The assets payload is incomplete." }, { status: 400 });
    }
    const allRows = [...assets.items, ...assets.blueprints, ...assets.industry, ...assets.market];
    if (
      input.toBuild.some((item) => !Number.isInteger(item.typeId) || !validQuantity(item.quantity))
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
      ...input.toBuild.map((item) => item.typeId),
      ...allRows.flatMap((item) => [
        item.typeId,
        "blueprintTypeId" in item ? item.blueprintTypeId : undefined,
      ]),
    ].filter((typeId): typeId is number => typeId !== undefined);
    const types = await getTypesByIds([...new Set(typeIds)]);
    const buildItems: BuildItem[] = input.toBuild.map((item) => ({
      ...item,
      fromCompression: item.fromCompression === true,
      name:
        types.get(item.typeId)?.name[input.language ?? "en"]
        ?? types.get(item.typeId)?.name.en
        ?? `Type ${item.typeId}`,
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
      stock,
      locations: input.locations,
      settings: input.settings,
    });
    result.metadata.unresolvedAssetCount = 0;
    return NextResponse.json(result, noStoreResponseInit);
  }
  catch {
    return NextResponse.json({ error: "The plan request was not valid JSON." }, { status: 400 });
  }
}
