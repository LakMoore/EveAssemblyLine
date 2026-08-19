import { NextResponse } from "next/server";
import { z } from "zod";
import { getTypes } from "@/cache/services/sdeCache";
import { getMarketSellOrders } from "@/lib/esi/marketHistory";
import { marketHubs } from "@/lib/reference/marketHubs";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const appraiseRequestSchema = z.object({
  language: z.string().optional(),
  marketId: z.enum(marketHubs.map((market) => market.id) as [string, ...string[]]).default("jita"),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        quantity: z.number().int().positive().default(1),
      }),
    )
    .min(1),
});

export async function POST(request: Request) {
  const parsed = appraiseRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Provide a non-empty list of item names and quantities." },
      { status: 400 },
    );
  }

  const requestedLanguage = parsed.data.language ?? null;
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const market =
    marketHubs.find((candidate) => candidate.id === parsed.data.marketId) ?? marketHubs[0];
  try {
    const types = await getTypes();
    const typesByName = new Map(
      [...types.values()]
        .filter((type) => type.published)
        .map((type) => [(type.name[language] ?? type.name.en).toLocaleLowerCase(language), type]),
    );
    const items = await Promise.all(
      parsed.data.items.map(async (item) => {
        const type = typesByName.get(item.name.toLocaleLowerCase(language));
        if (!type) return { ...item, error: "Item name was not found." };
        const orders = await getMarketSellOrders(market.regionId, type._key).catch(() => []);
        const price =
          orders.length > 0 ? Math.min(...orders.map((order) => order.price)) : undefined;
        return {
          name: type.name[language] ?? type.name.en,
          typeId: type._key,
          quantity: item.quantity,
          price,
          volume: (type.packagedVolume ?? type.volume ?? 0) * item.quantity,
          total: price === undefined ? undefined : price * item.quantity,
          error: price === undefined ? "No current sell order found." : undefined,
        };
      }),
    );
    return NextResponse.json({ market: market.name, items });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Market data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
