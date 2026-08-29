import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import { getStateStatus, refreshCharacterState } from "@/lib/esi/cache";
import { getEsiRateLimitUntil } from "@/lib/esi/client";

const activeRefreshes = new Map<
  string,
  Promise<Awaited<ReturnType<typeof refreshCharacterState>>>
>();

function firstRefreshError(status: Awaited<ReturnType<typeof getStateStatus>>) {
  for (const character of status.characters) {
    const endpoints = [
      character.assets,
      character.skills,
      character.location,
      character.ship,
      character.blueprints,
      character.jobs,
      character.orders,
      ...character.corporations.flatMap((corporation) => [
        corporation.assets,
        corporation.blueprints,
        corporation.jobs,
        corporation.orders,
        corporation.structures,
      ]),
    ];
    const error = endpoints.find((endpoint) => endpoint.status === "error")?.error;
    if (error) return error;
  }
  return undefined;
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
    await activeRefresh;
    const status = await getStateStatus(characterIds, session.sessionId);
    const error = firstRefreshError(status);
    return NextResponse.json({
      success: !error,
      errors: error ? [error] : [],
      refreshedAt: new Date().toISOString(),
      rateLimitedUntil: getEsiRateLimitUntil(),
    });
  }
  const refresh = refreshCharacterState(characterIds, session.sessionId);
  activeRefreshes.set(key, refresh);
  await refresh.finally(() => activeRefreshes.delete(key));
  const status = await getStateStatus(characterIds, session.sessionId);
  const error = firstRefreshError(status);
  return NextResponse.json({
    success: !error,
    errors: error ? [error] : [],
    refreshedAt: new Date().toISOString(),
    rateLimitedUntil: getEsiRateLimitUntil(),
  });
}
