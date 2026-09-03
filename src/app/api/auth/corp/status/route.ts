import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacter } from "@/lib/auth/tokensStore";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterIds = await getSessionCharacterIds(session);
  const characters = (await Promise.all(characterIds.map((id) => getCharacter(id)))).filter(
    (character) => character !== null,
  );
  return NextResponse.json(
    characters.map(
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
        hasAccountantRole: Boolean(hasAccountantRole),
        hasTraderRole: Boolean(hasTraderRole),
      }),
    ),
  );
}
