import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { getCorporationSourcePolicies } from "@/lib/esi/cache";
import { getShipsForCharacter, getShipsForCorporation } from "@/lib/data/ships";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const characterIds = await getSessionCharacterIds(session);
  const corporationSettings = session.collectionId
    ? await getCollectionCorporationSettings(session.collectionId)
    : [];
  const corporationPolicies = await getCorporationSourcePolicies(
    characterIds,
    corporationSettings,
    session.sessionId,
  );
  const context = {
    sessionId: session.sessionId,
    characterIds,
    corporationPolicies,
  };
  const characterResponses = await Promise.all(
    characterIds.map((characterId) => getShipsForCharacter(characterId, context)),
  );
  const corporationResponses = await Promise.all(
    corporationPolicies.map((policy) => getShipsForCorporation(policy.corporationId, context)),
  );
  const ownerResponses = [...characterResponses, ...corporationResponses];
  return NextResponse.json({
    assets: ownerResponses.flatMap((response) => response.assets),
    ships: ownerResponses.flatMap((response) => response.ships),
    types: [
      ...new Map(
        ownerResponses.flatMap((response) => response.types).map((type) => [type.typeId, type]),
      ).values(),
    ],
  });
}
