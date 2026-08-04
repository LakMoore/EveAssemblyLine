import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import { fetchUniverseNames } from "@/lib/esi/client";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const records = await getCharacters();
  const sessionRecords = records.filter((record) => session.characterIds.includes(record.characterId));
  let corporationNames = new Map<number, string>();
  try {
    corporationNames = await fetchUniverseNames(
      sessionRecords.flatMap((record) => record.corporationId ?? []),
    );
  } catch {}
  return NextResponse.json(
    sessionRecords
      .map(({ characterId, characterName, corporationId, corporationRoles, hasDirectorRole, hasAccountantRole, hasTraderRole, corpAuthCompleted }) => ({
        characterId,
        characterName,
        corporationId,
        corporationName: corporationId ? corporationNames.get(corporationId) : undefined,
        corporationRoles: corporationRoles ?? [],
        hasDirectorRole: Boolean(hasDirectorRole),
        hasAccountantRole: Boolean(hasAccountantRole),
        hasTraderRole: Boolean(hasTraderRole),
        corpAuthCompleted: Boolean(corpAuthCompleted),
      })),
  );
}
