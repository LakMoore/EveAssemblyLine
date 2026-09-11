import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacter, getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { isCorpRefreshOptInEnabled } from "@/lib/auth/corpRefreshOptIn";
import { fetchUniverseNames } from "@/lib/esi/client";
import { getStateStatus } from "@/lib/esi/cache";

export async function GET(request: Request) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) return NextResponse.json({ authenticated: false, characters: [] });
    const characterIds = await getSessionCharacterIds(session);
    const corporationSettings = await getCollectionCorporationSettings(session.collectionId);
    const corporationSupport = new Map(
      corporationSettings.map((settings) => [settings.corporationId, settings.supportEnabled]),
    );
    const corpRefreshOptInEnabled = isCorpRefreshOptInEnabled();
    const characters = (await Promise.all(characterIds.map((id) => getCharacter(id)))).filter(
      (record): record is NonNullable<typeof record> => record !== null,
    );
    let corporationNames = new Map<number, string>();
    try {
      corporationNames = await fetchUniverseNames(
        characters.flatMap((character) => character.corporationId ?? []),
      );
    }
    catch {}
    const projectedCharacters = characters.map(
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
        corporationName: corporationId ? corporationNames.get(corporationId) : undefined,
        corporationRoles: corporationRoles ?? [],
        rolesAtBase: rolesAtBase ?? [],
        rolesAtHq: rolesAtHq ?? [],
        rolesAtOther: rolesAtOther ?? [],
        hasDirectorRole: Boolean(hasDirectorRole),
        allowCorpRefreshOptIn: Boolean(allowCorpRefreshOptIn),
        canManageCorpRefreshOptIn: corpRefreshOptInEnabled && Boolean(hasDirectorRole),
        corpRefreshOptInEnabled,
        hasAccountantRole: Boolean(hasAccountantRole),
        hasTraderRole: Boolean(hasTraderRole),
        corporationSupportEnabled: corporationId
          ? corporationSupport.get(corporationId) === true
          : false,
      }),
    );
    const state = await getStateStatus(characterIds, session.sessionId, characters);
    return NextResponse.json({
      authenticated: projectedCharacters.length > 0,
      characters: projectedCharacters,
      state,
    });
  }
  catch {
    return NextResponse.json({ authenticated: false, characters: [] });
  }
}
