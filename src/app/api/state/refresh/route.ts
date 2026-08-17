import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import { refreshCharacterState, toClientEndpointStatus } from "@/lib/esi/cache";
import { getEsiRateLimitUntil } from "@/lib/esi/client";

const activeRefreshes = new Map<
  string,
  Promise<Awaited<ReturnType<typeof refreshCharacterState>>>
>();

function toClientRefreshResult(result: Awaited<ReturnType<typeof refreshCharacterState>>) {
  return {
    characters: result.characters.map((character) => ({
      characterId: character.characterId,
      ...(character.assets ? { assets: toClientEndpointStatus(character.assets) } : {}),
      ...(character.skills ? { skills: toClientEndpointStatus(character.skills) } : {}),
      ...(character.jobs ? { jobs: toClientEndpointStatus(character.jobs) } : {}),
      ...(character.marketOrders
        ? { marketOrders: toClientEndpointStatus(character.marketOrders) }
        : {}),
      ...(character.corporations
        ? {
            corporations: character.corporations.map((corporation) => ({
              corporationId: corporation.corporationId,
              ...(corporation.assets ? { assets: toClientEndpointStatus(corporation.assets) } : {}),
              ...(corporation.structures
                ? { structures: toClientEndpointStatus(corporation.structures) }
                : {}),
            })),
          }
        : {}),
    })),
  };
}

export async function POST(request: Request) {
  let session;
  try {
    session = await getSessionFromRequest(request);
  }
  catch {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterIds = await getSessionCharacterIds(session);
  if (characterIds.length === 0) {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  let characters;
  try {
    characters = await getCharacters();
  }
  catch {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }
  const connectedCharacterIds = new Set(
    characters
      .filter((character) => characterIds.includes(character.characterId))
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
  const key = `${session.sessionId}:${characterIds
    .slice()
    .sort((left, right) => left - right)
    .join(",")}`;
  const activeRefresh = activeRefreshes.get(key);
  if (activeRefresh) {
    const result = await activeRefresh;
    return NextResponse.json({
      ...toClientRefreshResult(result),
      success: true,
      refreshedAt: new Date().toISOString(),
      rateLimitedUntil: getEsiRateLimitUntil(),
    });
  }
  const refresh = refreshCharacterState(characterIds, session.sessionId);
  activeRefreshes.set(key, refresh);
  const result = await refresh.finally(() => activeRefreshes.delete(key));
  return NextResponse.json({
    ...toClientRefreshResult(result),
    success: true,
    refreshedAt: new Date().toISOString(),
    rateLimitedUntil: getEsiRateLimitUntil(),
  });
}
