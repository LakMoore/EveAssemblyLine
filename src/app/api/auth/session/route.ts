import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacter, getCollectionCorporationSettings } from "@/lib/auth/tokensStore";

export async function GET(request: Request) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) return NextResponse.json({ authenticated: false, characters: [] });
    const characterIds = await getSessionCharacterIds(session);
    const corporationSettings = await getCollectionCorporationSettings(session.collectionId!);
    const corporationSupport = new Map(
      corporationSettings.map((settings) => [settings.corporationId, settings.supportEnabled]),
    );
    const characters = (await Promise.all(characterIds.map((id) => getCharacter(id))))
      .filter((record) => record !== null)
      .map(
        ({
          characterId,
          characterName,
          onDeployment,
          corporationId,
          allianceId,
          corporationRoles,
          rolesAtBase,
          rolesAtHq,
          rolesAtOther,
          hasDirectorRole,
          allowCorpRefreshOptIn,
          hasAccountantRole,
          hasTraderRole,
        }) => ({
          characterId,
          characterName,
          onDeployment: Boolean(onDeployment),
          corporationId,
          allianceId,
          corporationRoles: corporationRoles ?? [],
          rolesAtBase: rolesAtBase ?? [],
          rolesAtHq: rolesAtHq ?? [],
          rolesAtOther: rolesAtOther ?? [],
          hasDirectorRole: Boolean(hasDirectorRole),
          allowCorpRefreshOptIn: Boolean(allowCorpRefreshOptIn),
          hasAccountantRole: Boolean(hasAccountantRole),
          hasTraderRole: Boolean(hasTraderRole),
          corporationSupportEnabled: corporationId
            ? corporationSupport.get(corporationId) === true
            : false,
        }),
      );
    return NextResponse.json({ authenticated: characters.length > 0, characters });
  }
  catch {
    return NextResponse.json({ authenticated: false, characters: [] });
  }
}
