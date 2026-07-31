import { NextResponse } from "next/server";
import { ensureSdeLoaded, systemById } from "@/lib/sde/loader";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const resultLimit = 12;

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("query")?.trim() ?? "";
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  try {
    ensureSdeLoaded();
    if (query.length < 2) return NextResponse.json({ items: [] });

    const normalizedQuery = query.toLocaleLowerCase(language);
    const matches = [...systemById.values()]
      .filter((system) => {
        const name = system.name[language] ?? system.name.en;
        return name?.toLocaleLowerCase(language).includes(normalizedQuery);
      })
      .sort((left, right) => {
        const leftName = (left.name[language] ?? left.name.en).toLocaleLowerCase(language);
        const rightName = (right.name[language] ?? right.name.en).toLocaleLowerCase(language);
        return (
          Number(!leftName.startsWith(normalizedQuery)) -
            Number(!rightName.startsWith(normalizedQuery)) ||
          leftName.localeCompare(rightName, language)
        );
      })
      .slice(0, resultLimit)
      .map((system) => ({
        systemId: system._key,
        name: system.name[language] ?? system.name.en,
      }));

    return NextResponse.json({ items: matches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
