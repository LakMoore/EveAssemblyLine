import { NextResponse } from "next/server";
import { z } from "zod";
import { getGroups, getMarketGroups, getTypes } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType, type ItemCategory } from "@/lib/reference/category";

const typeMetadataRequestSchema = z.object({
  language: z.string().optional(),
  typeIds: z.array(z.number().int().safe().positive()),
});
const itemNameRequestSchema = z.object({
  language: z.string().optional(),
  items: z.array(
    z.object({
      name: z.string().optional(),
      quantity: z.number().optional(),
    }),
  ),
});

async function resolveTypeMetadata(typeIds: number[], language: SdeLanguage) {
  const [typeById, marketGroupById, groupById] = await Promise.all([
    getTypes(),
    getMarketGroups(),
    getGroups(),
  ]);
  return typeIds.flatMap((typeId) => {
    const item = typeById.get(typeId);
    if (!item || !item.published) return [];
    return [
      {
        typeId: item._key,
        techLevel: item.techLevel,
        assembledVolume: item.volume ?? 0,
        packagedVolume: item.packagedVolume,
        ...categorizeType(item, language, marketGroupById, groupById),
        name: item.name[language] ?? item.name.en,
      },
    ];
  });
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("query")?.trim() ?? "";
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  try {
    const typeById = await getTypes();
    if (query.length < 3) return NextResponse.json({ items: [] });
    const [marketGroupById, groupById] = await Promise.all([getMarketGroups(), getGroups()]);
    const normalizedQuery = query.toLocaleLowerCase();
    const numericQuery = /^\d+$/.test(query) ? Number(query) : null;
    const matches = [...typeById.values()]
      .filter((item) => {
        if (!item.published) return false;
        if (numericQuery !== null) return item._key.toString().startsWith(query);
        return Object
          .values(item.name)
          .some((name) => name?.toLocaleLowerCase(language).includes(normalizedQuery));
      })
      .sort((left, right) => {
        if (numericQuery !== null) return left._key - right._key;
        const leftName =
          left.name[language]?.toLocaleLowerCase(language)
          ?? left.name.en.toLocaleLowerCase(language);
        const rightName =
          right.name[language]?.toLocaleLowerCase(language)
          ?? right.name.en.toLocaleLowerCase(language);
        const leftStarts = leftName.startsWith(normalizedQuery) ? 0 : 1;
        const rightStarts = rightName.startsWith(normalizedQuery) ? 0 : 1;
        return leftStarts - rightStarts || leftName.localeCompare(rightName);
      })
      .map((item) => ({
        typeId: item._key,
        ...categorizeType(item, language, marketGroupById, groupById),
        name: item.name[language] ?? item.name.en,
      }));

    return NextResponse.json({ items: matches });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const metadataRequest = typeMetadataRequestSchema.safeParse(body);
    if (metadataRequest.success) {
      const requestedLanguage = metadataRequest.data.language ?? null;
      const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
      const items = await resolveTypeMetadata(metadataRequest.data.typeIds, language);
      return NextResponse.json({ items });
    }

    const itemRequest = itemNameRequestSchema.safeParse(body);
    if (!itemRequest.success) {
      return NextResponse.json(
        { error: "A language and list of type IDs is required." },
        { status: 400 },
      );
    }
    const requestedLanguage = itemRequest.data.language ?? null;
    const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

    const [typeById, marketGroupById, groupById] = await Promise.all([
      getTypes(),
      getMarketGroups(),
      getGroups(),
    ]);
    const byName = new Map<
      string,
      {
        typeId: number;
        name: string;
        assembledVolume: number;
        packagedVolume?: number;
        category: ItemCategory;
        marketCategory?: string;
      }
    >();
    for (const item of typeById.values()) {
      if (!item.published) continue;
      const name = item.name[language] ?? item.name.en;
      if (name) {
        byName.set(
          name.toLocaleLowerCase(language),
          {
            typeId: item._key,
            name,
            assembledVolume: item.volume ?? 0,
            packagedVolume: item.packagedVolume,
            ...categorizeType(item, language, marketGroupById, groupById),
          },
        );
      }
    }

    const resolved = itemRequest.data.items.map((item) => {
      const name = item.name?.trim() ?? "";
      const quantity = item.quantity;
      const match = byName.get(name.toLocaleLowerCase(language));
      const validQuantity = quantity === undefined || (Number.isInteger(quantity) && quantity > 0);
      if (!match || !validQuantity) {
        return {
          name,
          quantity,
          error: !match ? "Item name was not found." : "Quantity must be a positive whole number.",
        };
      }
      return { ...match, quantity: quantity ?? 1 };
    });
    return NextResponse.json({ items: resolved });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "The item list was not valid JSON.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
