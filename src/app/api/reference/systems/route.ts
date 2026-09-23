import { NextResponse } from "next/server";
import { z } from "zod";
import { getSystems } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const resultLimit = 12;
const systemIdsRequestSchema = z.object({
  language: z.string().optional(),
  systemIds: z.array(z.number().int().safe().positive()).min(1).max(2_000),
});

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const requestedSystemIdValue = searchParams.get("systemId");
  const requestedSystemId =
    requestedSystemIdValue === null ? undefined : Number(requestedSystemIdValue);
  const query = searchParams.get("query")?.trim() ?? "";
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  try {
    const systemById = await getSystems();
    if (requestedSystemId !== undefined && Number.isInteger(requestedSystemId)) {
      const system = systemById.get(requestedSystemId);
      return NextResponse.json({
        item: system
          ? {
              systemId: system._key,
              name: system.name[language],
              securityStatus: system.securityStatus,
            }
          : null,
      });
    }
    if (query.length < 2) return NextResponse.json({ items: [] });

    const normalizedQuery = query.toLocaleLowerCase(language);
    const matches = [...systemById.values()]
      .filter((system) => {
        const name = system.name[language];
        return name.toLocaleLowerCase(language).includes(normalizedQuery);
      })
      .sort((left, right) => {
        const leftName = left.name[language].toLocaleLowerCase(language);
        const rightName = right.name[language].toLocaleLowerCase(language);
        return (
          Number(!leftName.startsWith(normalizedQuery))
            - Number(!rightName.startsWith(normalizedQuery))
          || leftName.localeCompare(rightName, language)
        );
      })
      .slice(0, resultLimit)
      .map((system) => ({
        systemId: system._key,
        name: system.name[language],
        securityStatus: system.securityStatus,
      }));

    return NextResponse.json({ items: matches });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const parsed = systemIdsRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A non-empty list of system IDs is required." },
      { status: 400 },
    );
  }
  const requestedLanguage = parsed.data.language ?? null;
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  try {
    const systemById = await getSystems();
    const items = [...new Set(parsed.data.systemIds)].flatMap((systemId) => {
      const system = systemById.get(systemId);
      return system
        ? [
            {
              systemId: system._key,
              name: system.name[language],
              securityStatus: system.securityStatus,
            },
          ]
        : [];
    });
    return NextResponse.json({ items });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
