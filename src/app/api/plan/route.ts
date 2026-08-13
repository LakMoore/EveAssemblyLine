import { NextResponse } from "next/server";
import { calculatePlan } from "@/lib/planning/planEngine";
import { hydrateStockCategories } from "@/lib/planning/stockHydration";
import { getBlueprintById, getTypesByIds } from "@/cache/services/sdeCache";
import type {
  BuildItem,
  PlanBlueprintInput,
  PlanIndustryInput,
  PlanItemInput,
  PlanMarketInput,
  PlanRequest,
  PlanStockItem,
} from "@/lib/planning/types";

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

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PlanRequest;
    if (!Array.isArray(input.toBuild) || input.toBuild.length === 0) {
      return NextResponse.json({ error: "Add at least one build item." }, { status: 400 });
    }
    const assets = input.assets;
    if (
      !assets ||
      !Array.isArray(assets.items) ||
      !Array.isArray(assets.blueprints) ||
      !Array.isArray(assets.industry) ||
      !Array.isArray(assets.market)
    ) {
      return NextResponse.json({ error: "The assets payload is incomplete." }, { status: 400 });
    }
    const allRows = [...assets.items, ...assets.blueprints, ...assets.industry, ...assets.market];
    if (
      input.toBuild.some(
        (item) => !Number.isInteger(item.typeId) || !validQuantity(item.quantity),
      ) ||
      allRows.some(
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
      assets.blueprints.some(
        (blueprint) =>
          !Number.isInteger(blueprint.runs) ||
          blueprint.runs < -1 ||
          (blueprint.type !== "bpc" && blueprint.type !== "bpo"),
      )
    ) {
      return NextResponse.json(
        { error: "Every blueprint needs a valid type and run count." },
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
      name:
        types.get(item.typeId)?.name[input.language ?? "en"] ??
        types.get(item.typeId)?.name.en ??
        `Type ${item.typeId}`,
    }));
    const normalizedBlueprints = assets.blueprints.map((blueprint) => ({ ...blueprint }));
    const industryStock: PlanStockItem[] = [];
    for (const job of assets.industry) {
      const blueprint = await getBlueprintById(job.blueprintTypeId ?? job.typeId);
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
            (job.blueprintId !== undefined && candidate.itemId === job.blueprintId) ||
            (candidate.typeId === job.blueprintTypeId &&
              candidate.locationId === job.locationId &&
              candidate.rootLocationId === job.rootLocationId &&
              candidate.type === (job.blueprintRunsAtInstall === -1 ? "bpo" : "bpc") &&
              candidate.runs !== remainingRuns),
        );
        if (matchingBlueprint) matchingBlueprint.runs = remainingRuns;
        else if (
          job.blueprintId !== undefined &&
          job.blueprintTypeId !== undefined &&
          remainingRuns !== undefined &&
          (remainingRuns === -1 || job.activity === "Manufacturing" || job.activity === "Copying")
        ) {
          normalizedBlueprints.push({
            itemId: job.blueprintId,
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
                category: "bp",
                type: "bpc",
                blueprintPrints: [
                  {
                    itemId: -job.jobId,
                    runs: product.runs ?? 1,
                    type: "bpc",
                  },
                ],
                inBuild: true,
                inBuildQuantity: product.quantity,
                jobId: job.jobId,
                jobRuns: job.runs,
                activityName: job.activity,
                blueprintTypeId: job.blueprintTypeId,
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
        stockItem(blueprint, {
          category: "bp",
          type: blueprint.type,
          blueprintPrints: [
            {
              itemId: -(index + 1),
              runs: blueprint.runs,
              type: blueprint.type,
              me: blueprint.me,
              te: blueprint.te,
            },
          ],
        }),
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
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "The plan request was not valid JSON." }, { status: 400 });
  }
}
