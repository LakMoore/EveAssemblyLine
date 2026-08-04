import { NextResponse } from "next/server";
import { calculatePlan } from "@/lib/planning/planEngine";
import { hydrateStockCategories } from "@/lib/planning/stockHydration";
import { PlanRequest } from "@/lib/planning/types";

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PlanRequest;
    if (!Array.isArray(input.items) || input.items.length === 0) return NextResponse.json({ error: "Add at least one build item." }, { status: 400 });
    if (input.items.some((item) => !Number.isInteger(item.typeId) || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      return NextResponse.json({ error: "Every item needs a positive quantity and integer type ID." }, { status: 400 });
    }
    const [stock, assets] = await Promise.all([
      hydrateStockCategories(input.stock ?? []),
      hydrateStockCategories(input.assets ?? []),
    ]);
    const result = await calculatePlan({
      ...input,
      stock: [...stock, ...assets],
    });
    result.metadata.unresolvedAssetCount = assets.filter((asset) => asset.locationResolved === false).length;
    result.metadata.corporationAssetSources = [...new Set(
      assets
        .filter((asset) => asset.ownerType === "corporation" && asset.ownerId !== undefined)
        .map((asset) => asset.ownerId!),
    )];
    return NextResponse.json(result);
  } catch { return NextResponse.json({ error: "The plan request was not valid JSON." }, { status: 400 }); }
}