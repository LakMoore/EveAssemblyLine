import { NextResponse } from "next/server";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { loadProductionGroupReferences } from "@/lib/reference/productionGroupsServer";

export async function GET(request: Request) {
  const requestedLanguage = new URL(request.url).searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  try {
    return NextResponse.json({
      items: await loadProductionGroupReferences(language),
    });
  }
  catch (error) {
    const message =
      error instanceof Error ? error.message : "SDE production group data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
