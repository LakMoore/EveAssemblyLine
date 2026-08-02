import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const records = await getCharacters();
  return NextResponse.json(records
    .filter((record) => session.characterIds.includes(record.characterId))
    .map(({ characterId, characterName, corporationId, hasDirectorRole, corpAuthCompleted }) => ({
      characterId,
      characterName,
      corporationId,
      hasDirectorRole: Boolean(hasDirectorRole),
      corpAuthCompleted: Boolean(corpAuthCompleted),
    })));
}
