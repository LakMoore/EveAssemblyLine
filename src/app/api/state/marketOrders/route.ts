import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getMarketOrderStock } from "@/lib/esi/cache";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const url = new URL(request.url);
  const requested = (url.searchParams.get("characterIds") ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && session.characterIds.includes(id));
  const characterIds = requested.length > 0 ? requested : session.characterIds;
  const marketOrderStock = await getMarketOrderStock(characterIds, {
    personalSellOrdersAsStock: url.searchParams.get("personalSellOrdersAsStock") === "true",
    allCorporationSellOrdersAsStock: url.searchParams.get("allCorporationSellOrdersAsStock") === "true",
    myCorporationSellOrdersAsStock: url.searchParams.get("myCorporationSellOrdersAsStock") === "true",
  });
  if (marketOrderStock === null) {
    return NextResponse.json(
      { error: "Market order data is not currently available from ESI." },
      { status: 503 },
    );
  }
  return NextResponse.json({
    marketOrderStock,
  });
}
