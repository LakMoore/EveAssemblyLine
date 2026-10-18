import { NextResponse } from "next/server";
import { getTypes } from "@/cache/services/sdeCache";
import { getStationTaxPrices } from "@/lib/esi/marketHistory";
import { taxPriceRequestSchema } from "@/lib/market/taxes";
import { marketHubs } from "@/lib/reference/marketHubs";

/** Validates one selection and returns public hub or global PLEX prices without character tokens. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = taxPriceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Provide a positive type ID and a supported market hub." },
      { status: 400 },
    );
  }
  const market = marketHubs.find((hub) => hub.id === parsed.data.marketId);
  if (!market) return NextResponse.json({ error: "Unknown market hub." }, { status: 400 });
  try {
    const types = await getTypes();
    if (!types.has(parsed.data.typeId)) {
      return NextResponse.json({ error: "Unknown type ID." }, { status: 400 });
    }
    const quote = await getStationTaxPrices(market, parsed.data.typeId);
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) {
    const upstream = error as { status?: number; retryAfter?: string };
    const rateLimited = upstream.status === 420 || upstream.status === 429;
    return NextResponse.json(
      {
        error: rateLimited
          ? "ESI is rate limited. Try fetching prices again later."
          : "Market prices are unavailable. Please try again.",
      },
      {
        status: rateLimited ? 429 : 503,
        headers: upstream.retryAfter ? { "Retry-After": upstream.retryAfter } : undefined,
      },
    );
  }
}
