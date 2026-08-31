import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import { RefreshCoordinator, type RefreshUnit } from "@/lib/esi/refreshOrchestration";
import {
  copyRefreshCache,
  createRefreshProfiler,
  getStateStatus,
  refreshCharacterState,
  refreshCorporationState,
  type RefreshProfiler,
} from "@/lib/esi/cache";
import { getEsiRateLimitUntil } from "@/lib/esi/client";

const refreshIdSchema = z.coerce.number().int().positive();

const responseOptions = {
  headers: { "Cache-Control": "no-store" },
};

const runtime = globalThis as typeof globalThis & {
  __assemblyLineRefreshCoordinator?: RefreshCoordinator;
};
const refreshCoordinator =
  runtime.__assemblyLineRefreshCoordinator
  ?? (runtime.__assemblyLineRefreshCoordinator = new RefreshCoordinator());

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { ...responseOptions, status });
}

function firstRefreshError(status: Awaited<ReturnType<typeof getStateStatus>>, unit: RefreshUnit) {
  for (const character of status.characters) {
    if (unit.kind === "character" && character.characterId !== unit.ownerId) continue;
    const endpoints =
      unit.kind === "corporation"
        ? character.corporations
            .filter((corporation) => corporation.corporationId === unit.ownerId)
            .flatMap((corporation) => [
              corporation.assets,
              corporation.blueprints,
              corporation.jobs,
              corporation.orders,
              corporation.structures,
            ])
        : [
            character.assets,
            character.skills,
            character.location,
            character.ship,
            character.blueprints,
            character.jobs,
            character.orders,
          ];
    const error = endpoints.find((endpoint) => endpoint.status === "error")?.error;
    if (error) return error;
  }
  return undefined;
}

async function refreshUnit(
  unit: RefreshUnit,
  sessionId: string,
  characters: Awaited<ReturnType<typeof getCharacters>>,
  profiler: RefreshProfiler,
) {
  const source = await refreshCoordinator.run(
    unit.key,
    async () => {
      if (unit.kind === "character") {
        const character = characters.find((record) => record.characterId === unit.ownerId);
        if (!character) throw new Error("Character is not attached to this session.");
        await refreshCharacterState(character, sessionId, profiler);
      }
      else {
        const authorizationCharacter = characters.find(
          (character) =>
            character.characterId === unit.authorizationCharacterId
            && character.corporationId === unit.ownerId
            && character.hasDirectorRole,
        );
        if (!authorizationCharacter) throw new Error("Corporation authorization is incomplete");
        await refreshCorporationState(unit.ownerId, authorizationCharacter, sessionId, profiler);
      }
      return { sessionId };
    },
  );
  copyRefreshCache(unit.kind, unit.ownerId, source.sessionId, sessionId);
}

/** Refreshes one attached character or authorized corporation owner. */
export async function handleRefreshRequest(
  request: Request,
  kind: RefreshUnit["kind"],
  rawId: string,
) {
  const profiler = createRefreshProfiler(kind, rawId);
  try {
    return await handleRefreshRequestInternal(request, kind, rawId, profiler);
  }
  finally {
    profiler.finish();
  }
}

async function handleRefreshRequestInternal(
  request: Request,
  kind: RefreshUnit["kind"],
  rawId: string,
  profiler: RefreshProfiler,
) {
  profiler.start("session");
  let session;
  try {
    session = await getSessionFromRequest(request);
  }
  catch {
    return json({ error: "ESI is not connected." }, 401);
  }
  finally {
    profiler.end("session");
  }
  if (!session) return json({ error: "Not authenticated." }, 401);

  profiler.start("parseId");
  const parsedId = refreshIdSchema.safeParse(rawId);
  profiler.end("parseId");
  if (!parsedId.success) return json({ error: "Invalid refresh request." }, 400);

  let characters;
  profiler.start("loadCharacters");
  try {
    characters = await getCharacters();
  }
  catch {
    return json({ error: "ESI is not connected." }, 401);
  }
  finally {
    profiler.end("loadCharacters");
  }
  profiler.start("loadSessionCharacters");
  let characterIds: number[];
  try {
    characterIds = await getSessionCharacterIds(session, characters);
  }
  finally {
    profiler.end("loadSessionCharacters");
  }
  if (characterIds.length === 0) return json({ error: "ESI is not connected." }, 401);
  const sessionCharacters = characters.filter((character) =>
    characterIds.includes(character.characterId),
  );
  if (sessionCharacters.length === 0) {
    return json({ error: "ESI is not connected." }, 401);
  }

  const ownerId = parsedId.data;
  let unit: RefreshUnit;
  if (kind === "character") {
    if (!sessionCharacters.some((character) => character.characterId === ownerId)) {
      return json({ error: "Character is not attached to this session." }, 403);
    }
    unit = {
      key: `character:${ownerId}`,
      kind,
      ownerId,
    };
  }
  else {
    const authorizationCharacter = sessionCharacters.find(
      (character) => character.corporationId === ownerId && character.hasDirectorRole,
    );
    if (!authorizationCharacter) {
      return json({ error: "Corporation authorization is incomplete." }, 403);
    }
    unit = {
      key: `corporation:${ownerId}`,
      kind,
      ownerId,
      authorizationCharacterId: authorizationCharacter.characterId,
    };
  }
  const rateLimitedUntil = getEsiRateLimitUntil();
  if (rateLimitedUntil) {
    return json({
      success: false,
      completed: 0,
      total: 1,
      rateLimitedUntil,
    });
  }

  let refreshError: unknown;
  profiler.start("refresh");
  try {
    await refreshUnit(unit, session.sessionId, characters, profiler);
  }
  catch (error) {
    refreshError = error;
  }
  finally {
    profiler.end("refresh");
  }
  profiler.start("status");
  try {
    const status = await getStateStatus(characterIds, session.sessionId, characters);
    const errors = refreshError
      ? [refreshError instanceof Error ? refreshError.message : "Refresh failed."]
      : [];
    const statusError = firstRefreshError(status, unit);
    if (statusError) errors.push(statusError);
    const uniqueErrors = [...new Set(errors)];
    return json({
      success: uniqueErrors.length === 0,
      completed: refreshError ? 0 : 1,
      total: 1,
      errors: uniqueErrors,
      refreshedAt: new Date().toISOString(),
      rateLimitedUntil: getEsiRateLimitUntil(),
    });
  }
  finally {
    profiler.end("status");
  }
}
