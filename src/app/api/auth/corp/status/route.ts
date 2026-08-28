import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterIds = await getSessionCharacterIds(session);
  const characters = await getCharacters();
  return NextResponse.json(
    characters
      .filter((character) => characterIds.includes(character.characterId))
      .map(
        ({
          characterId,
          characterName,
          onDeployment,
          corporationId,
          corporationRoles,
          hasDirectorRole,
          hasAccountantRole,
          hasTraderRole,
        }) => ({
          characterId,
          characterName,
          onDeployment: Boolean(onDeployment),
          corporationId,
          corporationRoles: corporationRoles ?? [],
          hasDirectorRole: Boolean(hasDirectorRole),
          hasAccountantRole: Boolean(hasAccountantRole),
          hasTraderRole: Boolean(hasTraderRole),
        }),
      ),
  );
}
