import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterIds = await getSessionCharacterIds(session);
  const records = await getCharacters();
  return NextResponse.json(records
    .filter((record) => characterIds.includes(record.characterId))
    .map(({ characterId, characterName, corporationId, corporationRoles, hasDirectorRole, hasAccountantRole, hasTraderRole, corpAuthCompleted }) => ({
      characterId,
      characterName,
      corporationId,
      corporationRoles: corporationRoles ?? [],
      hasDirectorRole: Boolean(hasDirectorRole),
      hasAccountantRole: Boolean(hasAccountantRole),
      hasTraderRole: Boolean(hasTraderRole),
      corpAuthCompleted: Boolean(corpAuthCompleted),
    })));
}
