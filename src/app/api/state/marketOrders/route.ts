import { NextRequest, NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { getCorporationSourcePolicies } from "@/lib/esi/cache";
import {
  getMarketOrdersForCharacter,
  getMarketOrdersForCorporation,
  type MarketOrderOptions,
} from "@/lib/data/marketOrders";

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
  const options: MarketOrderOptions = {
    personalSellOrdersAsStock: url.searchParams.get("personalSellOrdersAsStock") === "true",
    allCorporationSellOrdersAsStock:
      url.searchParams.get("allCorporationSellOrdersAsStock") === "true",
    myCorporationSellOrdersAsStock:
      url.searchParams.get("myCorporationSellOrdersAsStock") === "true",
  };
  const context = {
    sessionId: session.sessionId,
    characterIds: sessionCharacterIds,
    corporationPolicies,
  };
  const characterResponses = await Promise.all(
    characterIds.map((characterId) => getMarketOrdersForCharacter(characterId, context, options)),
  );
  const corporationResponses =
    options.allCorporationSellOrdersAsStock || options.myCorporationSellOrdersAsStock
      ? await Promise.all(
          corporationPolicies.map((policy) =>
            getMarketOrdersForCorporation(policy.corporationId, context, options),
          ),
        )
      : [];
  const ownerResponses = [...characterResponses, ...corporationResponses];
  const hasUsableMarketOrderSource = ownerResponses.some(
    (response) => response.marketOrderStock !== null,
  );
  const marketOrderStock = hasUsableMarketOrderSource
    ? ownerResponses.flatMap((response) => response.marketOrderStock ?? [])
    : null;
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
