import { NextResponse } from "next/server";
import { getBlueprints, getTypes } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

/** Searches published blueprint types that are outputs of an SDE invention activity. */
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("query")?.trim() ?? "";
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  if (query.length < 3) return NextResponse.json({ items: [] });

  try {
    const [blueprints, types] = await Promise.all([getBlueprints(), getTypes()]);
    const normalizedQuery = query.toLocaleLowerCase(language);
    const numericQuery = /^\d+$/.test(query) ? query : null;
    const items = [...blueprints.byInventionProductId.keys()]
      .flatMap((typeId) => {
        const type = types.get(typeId);
        if (!type?.published) return [];
        const name = type.name[language] ?? type.name.en;
        const matches = numericQuery
          ? typeId.toString().startsWith(numericQuery)
          : name.toLocaleLowerCase(language).includes(normalizedQuery);
        return matches ? [{ typeId, name, category: "blueprint" as const }] : [];
      })
      .sort((left, right) => {
        const leftStarts = left.name.toLocaleLowerCase(language).startsWith(normalizedQuery)
          ? 0
          : 1;
        const rightStarts = right.name.toLocaleLowerCase(language).startsWith(normalizedQuery)
          ? 0
          : 1;
        return leftStarts - rightStarts || left.name.localeCompare(right.name);
      });
    return NextResponse.json({ items });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE invention data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
