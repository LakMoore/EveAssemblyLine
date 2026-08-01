import { NextResponse } from "next/server";
import { calculatePlan } from "@/lib/planning/planEngine";
import { PlanRequest } from "@/lib/planning/types";

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PlanRequest;
    if (!Array.isArray(input.items) || input.items.length === 0) return NextResponse.json({ error: "Add at least one build item." }, { status: 400 });
    if (input.items.some((item) => !Number.isInteger(item.typeId) || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      return NextResponse.json({ error: "Every item needs a positive quantity and integer type ID." }, { status: 400 });
    }
    return NextResponse.json(await calculatePlan(input));
  } catch { return NextResponse.json({ error: "The plan request was not valid JSON." }, { status: 400 }); }
}