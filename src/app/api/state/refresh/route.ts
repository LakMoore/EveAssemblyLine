import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import { refreshCharacterState } from "@/lib/esi/cache";
import { getEsiRateLimitUntil } from "@/lib/esi/client";

const activeRefreshes = new Map<
  string,
  Promise<Awaited<ReturnType<typeof refreshCharacterState>>>
>();

export async function POST(request: Request) {
  let session;
  try {
    session = await getSessionFromRequest(request);
  } catch {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (session.characterIds.length === 0) {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  let characters;
  try {
    characters = await getCharacters();
  } catch {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  const connectedCharacterIds = new Set(
    characters
      .filter((character) => session.characterIds.includes(character.characterId) && character.personalAuth)
      .map((character) => character.characterId),
  );
  if (connectedCharacterIds.size === 0) {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  const rateLimitedUntil = getEsiRateLimitUntil();
  if (rateLimitedUntil) {
    return NextResponse.json({
      success: false,
      characters: [],
      rateLimitedUntil,
    });
  }
  const key = session.characterIds
    .slice()
    .sort((left, right) => left - right)
    .join(",");
  const activeRefresh = activeRefreshes.get(key);
  if (activeRefresh) {
    const result = await activeRefresh;
    return NextResponse.json({
      ...result,
      success: true,
      refreshedAt: new Date().toISOString(),
      rateLimitedUntil: getEsiRateLimitUntil(),
    });
  }
  const refresh = refreshCharacterState(session.characterIds);
  activeRefreshes.set(key, refresh);
  const result = await refresh.finally(() => activeRefreshes.delete(key));
  return NextResponse.json({
    ...result,
    success: true,
    refreshedAt: new Date().toISOString(),
    rateLimitedUntil: getEsiRateLimitUntil(),
  });
}
