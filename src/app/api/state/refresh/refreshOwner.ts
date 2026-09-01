import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacter } from "@/lib/auth/tokensStore";
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

const noAuthorizationCharacter = Symbol("no authorization character");

const runtime = globalThis as typeof globalThis & {
  __assemblyLineRefreshCoordinator?: RefreshCoordinator;
};
const refreshCoordinator =
  runtime.__assemblyLineRefreshCoordinator
  ?? (runtime.__assemblyLineRefreshCoordinator = new RefreshCoordinator());

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { ...responseOptions, status });
}

async function findAuthorizationCharacter(characterIds: number[], corporationId: number) {
  try {
    return await Promise.any(
      characterIds.map(async (characterId) => {
        const character = await getCharacter(characterId);
        if (!character || character.corporationId !== corporationId || !character.hasDirectorRole) {
          throw noAuthorizationCharacter;
        }
        return character;
      }),
    );
  }
  catch (error) {
    if (error instanceof AggregateError) {
      const readError = error.errors.find((reason) => reason !== noAuthorizationCharacter);
      if (readError !== undefined) throw readError;
      return null;
    }
    throw error;
  }
}

async function refreshUnit(
  unit: RefreshUnit,
  sessionId: string,
  authorizationCharacter: NonNullable<Awaited<ReturnType<typeof getCharacter>>>,
  profiler: RefreshProfiler,
) {
  const source = await refreshCoordinator.run(
    unit.key,
    async () => {
      if (unit.kind === "character") {
        await refreshCharacterState(authorizationCharacter, sessionId, profiler);
      }
      else {
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

  const ownerId = parsedId.data;
  let characterIds: number[];
  profiler.start("loadCollectionCharacterIds");
  try {
    characterIds = await getSessionCharacterIds(session);
  }
  catch {
    return json({ error: "ESI is not connected." }, 401);
  }
  finally {
    profiler.end("loadCollectionCharacterIds");
  }
  if (characterIds.length === 0) return json({ error: "ESI is not connected." }, 401);

  if (kind === "character" && !characterIds.includes(ownerId)) {
    return json({ error: "Character is not attached to this session." }, 403);
  }

  let authorizationCharacter;
  let unit: RefreshUnit;
  if (kind === "character") {
    profiler.start("loadCharacter");
    try {
      const character = await getCharacter(ownerId);
      if (!character) return json({ error: "Character is not attached to this session." }, 403);
      authorizationCharacter = character;
    }
    catch {
      return json({ error: "ESI is not connected." }, 401);
    }
    finally {
      profiler.end("loadCharacter");
    }
    unit = {
      key: `character:${ownerId}`,
      kind,
      ownerId,
    };
  }
  else {
    profiler.start("loadAuthorizationCharacter");
    try {
      authorizationCharacter = await findAuthorizationCharacter(characterIds, ownerId);
    }
    catch {
      return json({ error: "ESI is not connected." }, 401);
    }
    finally {
      profiler.end("loadAuthorizationCharacter");
    }
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
    await refreshUnit(unit, session.sessionId, authorizationCharacter, profiler);
  }
  catch (error) {
    refreshError = error;
  }
  finally {
    profiler.end("refresh");
  }
  profiler.start("status");
  try {
    const errors = refreshError
      ? [refreshError instanceof Error ? refreshError.message : "Refresh failed."]
      : [];
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
