import { NextResponse } from "next/server";
import { getGroups, getMarketGroups, getTypes } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType, type ItemCategory } from "@/lib/reference/category";

const resultLimit = 12;

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("query")?.trim() ?? "";
  const typeIdValues = searchParams.getAll("typeId");
  const typeIds = typeIdValues.flatMap((value) => value.split(",")).map((value) => value.trim());
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  try {
    const typeById = await getTypes();
    if (typeIdValues.length > 0) {
      const [marketGroupById, groupById] = await Promise.all([getMarketGroups(), getGroups()]);
      const requestedTypeIds = typeIds
        .filter((value) => /^\d+$/.test(value))
        .map(Number)
        .filter((typeId) => Number.isSafeInteger(typeId));
      const items = requestedTypeIds.flatMap((typeId) => {
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
      return NextResponse.json({
        items,
      });
    }
    if (query.length < 2) return NextResponse.json({ items: [] });
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
      .slice(0, resultLimit)
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
    const body = (await request.json()) as {
      language?: string;
      items?: Array<{ name?: string; quantity?: number }>;
    };
    const requestedLanguage = body.language ?? null;
    const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
    if (!Array.isArray(body.items)) {
      return NextResponse.json(
        { error: "A list of item names and quantities is required." },
        { status: 400 },
      );
    }

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

    const resolved = body.items.map((item) => {
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
