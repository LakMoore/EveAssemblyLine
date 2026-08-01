import { NextResponse } from "next/server";
import { getMarketGroups, getTypes } from "@/cache/services/sdeCache";
import type { MarketGroupsRecord } from "@/lib/sde/generated";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const resultLimit = 12;
type ItemCategory = "bpo" | "bpc" | "reaction" | "item";

function marketCategory(
  marketGroupId: number | undefined,
  language: SdeLanguage,
  marketGroupById: Map<number, MarketGroupsRecord>,
) {
  let current = marketGroupId === undefined ? undefined : marketGroupById.get(marketGroupId);
  let child = current;
  while (current?.parentGroupID !== undefined) {
    const parent = marketGroupById.get(current.parentGroupID);
    if (!parent) break;
    if (parent.parentGroupID === undefined) return child?.name[language] ?? child?.name.en;
    child = current;
    current = parent;
  }
  return current?.name[language] ?? current?.name.en;
}

function itemCategory(name: string): ItemCategory {
  const normalized = name.toLocaleLowerCase();
  if (normalized.includes("reaction formula")) return "reaction";
  if (normalized.includes("blueprint") || normalized.includes("bpc")) return "bpc";
  return "item";
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("query")?.trim() ?? "";
  const typeIdValues = searchParams.getAll("typeId");
  const typeIds = typeIdValues.flatMap((value) => value.split(",")).map((value) => value.trim());
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  try {
    const [typeById, marketGroupById] = await Promise.all([getTypes(), getMarketGroups()]);
    if (typeIdValues.length > 0) {
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
            volume: item.volume ?? 0,
            category: itemCategory(item.name.en),
            marketCategory: marketCategory(item.marketGroupID, language, marketGroupById),
            name:
              item.name[language] ??
              item.name.en ??
              Object.values(item.name).find(Boolean) ??
              `Type ${item._key}`,
          },
        ];
      });
      return NextResponse.json({
        items,
      });
    }
    if (query.length < 2) return NextResponse.json({ items: [] });
    const normalizedQuery = query.toLocaleLowerCase();
    const numericQuery = /^\d+$/.test(query) ? Number(query) : null;
    const matches = [...typeById.values()]
      .filter((item) => {
        if (!item.published) return false;
        if (numericQuery !== null) return item._key.toString().startsWith(query);
        return Object.values(item.name).some((name) =>
          name?.toLocaleLowerCase(language).includes(normalizedQuery),
        );
      })
      .sort((left, right) => {
        if (numericQuery !== null) return left._key - right._key;
        const leftName =
          left.name[language]?.toLocaleLowerCase(language) ??
          left.name.en.toLocaleLowerCase(language);
        const rightName =
          right.name[language]?.toLocaleLowerCase(language) ??
          right.name.en.toLocaleLowerCase(language);
        const leftStarts = leftName.startsWith(normalizedQuery) ? 0 : 1;
        const rightStarts = rightName.startsWith(normalizedQuery) ? 0 : 1;
        return leftStarts - rightStarts || leftName.localeCompare(rightName);
      })
      .slice(0, resultLimit)
      .map((item) => ({
        typeId: item._key,
        name:
          item.name[language] ??
          item.name.en ??
          Object.values(item.name).find(Boolean) ??
          `Type ${item._key}`,
      }));

    return NextResponse.json({ items: matches });
  } catch (error) {
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
    if (!Array.isArray(body.items))
      return NextResponse.json(
        { error: "A list of item names and quantities is required." },
        { status: 400 },
      );

    const [typeById, marketGroupById] = await Promise.all([getTypes(), getMarketGroups()]);
    const byName = new Map<
      string,
      {
        typeId: number;
        name: string;
        volume: number;
        category: ItemCategory;
        marketCategory?: string;
      }
    >();
    for (const item of typeById.values()) {
      if (!item.published) continue;
      const name = item.name[language] ?? item.name.en ?? Object.values(item.name).find(Boolean);
      if (name)
        byName.set(name.toLocaleLowerCase(language), {
          typeId: item._key,
          name,
          volume: item.volume ?? 0,
          category: itemCategory(name),
          marketCategory: marketCategory(item.marketGroupID, language, marketGroupById),
        });
    }

    const resolved = body.items.map((item) => {
      const name = item.name?.trim() ?? "";
      const quantity = item.quantity;
      const match = byName.get(name.toLocaleLowerCase(language));
      const validQuantity = quantity === undefined || (Number.isInteger(quantity) && quantity > 0);
      if (!match || !validQuantity)
        return {
          name,
          quantity,
          error: !match ? "Item name was not found." : "Quantity must be a positive whole number.",
        };
      return { ...match, quantity: quantity ?? 1 };
    });
    return NextResponse.json({ items: resolved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The item list was not valid JSON.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
