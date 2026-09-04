import { NextRequest, NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { getCorporationSourcePolicies, getMarketOrderStock } from "@/lib/esi/cache";

export async function GET(request: NextRequest) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const sessionCharacterIds = await getSessionCharacterIds(session);
  const corporationSettings = session.collectionId
    ? await getCollectionCorporationSettings(session.collectionId)
    : [];
  const corporationPolicies = await getCorporationSourcePolicies(
    sessionCharacterIds,
    corporationSettings,
    session.sessionId,
  );
  const url = new URL(request.url);
  const requested = (url.searchParams.get("characterIds") ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && sessionCharacterIds.includes(id));
  const characterIds = requested.length > 0 ? requested : sessionCharacterIds;
  const marketOrderStock = await getMarketOrderStock(
    characterIds,
    {
      personalSellOrdersAsStock: url.searchParams.get("personalSellOrdersAsStock") === "true",
      allCorporationSellOrdersAsStock:
        url.searchParams.get("allCorporationSellOrdersAsStock") === "true",
      myCorporationSellOrdersAsStock:
        url.searchParams.get("myCorporationSellOrdersAsStock") === "true",
    },
    session.sessionId,
    corporationPolicies,
  );
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
