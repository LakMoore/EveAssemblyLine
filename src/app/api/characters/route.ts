import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacter } from "@/lib/auth/tokensStore";
import { fetchUniverseNames } from "@/lib/esi/client";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterIds = await getSessionCharacterIds(session);
  const sessionRecords = (await Promise.all(characterIds.map((id) => getCharacter(id)))).filter(
    (record) => record !== null,
  );
  let corporationNames = new Map<number, string>();
  try {
    corporationNames = await fetchUniverseNames(
      sessionRecords.flatMap((record) => record.corporationId ?? []),
    );
  }
  catch {}
  return NextResponse.json(
    sessionRecords.map(
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
        corporationName: corporationId ? corporationNames.get(corporationId) : undefined,
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
