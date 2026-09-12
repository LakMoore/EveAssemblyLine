import { NextResponse } from "next/server";
import { getGroups, getIndustryTargetFilters } from "@/cache/services/sdeCache";
import { getProductionGroupReferences } from "@/lib/planning/productionGroups";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

export async function GET(request: Request) {
  const requestedLanguage = new URL(request.url).searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  try {
    const [groups, targetFilters] = await Promise.all([getGroups(), getIndustryTargetFilters()]);
    return NextResponse.json({
      items: getProductionGroupReferences(targetFilters, groups, language),
    });
  }
  catch (error) {
    const message =
      error instanceof Error ? error.message : "SDE production group data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
