import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import {
  buildRefreshUnits,
  RefreshCoordinator,
  runRefreshUnits,
  type RefreshUnit,
} from "@/lib/esi/refreshOrchestration";
import {
  copyRefreshCache,
  getStateStatus,
  refreshCharacterState,
  refreshCorporationState,
} from "@/lib/esi/cache";
import { getEsiRateLimitUntil } from "@/lib/esi/client";

const refreshRequestSchema = z
  .object({
    kind: z.enum(["character", "corporation"]).optional(),
    id: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    ({ kind, id }) => (kind === undefined) === (id === undefined),
    {
      message: "kind and id must be provided together",
    },
  );

const runtime = globalThis as typeof globalThis & {
  __assemblyLineRefreshCoordinator?: RefreshCoordinator;
};
const refreshCoordinator =
  runtime.__assemblyLineRefreshCoordinator
  ?? (runtime.__assemblyLineRefreshCoordinator = new RefreshCoordinator());

function firstRefreshError(status: Awaited<ReturnType<typeof getStateStatus>>, unit?: RefreshUnit) {
  for (const character of status.characters) {
    if (unit?.kind === "character" && character.characterId !== unit.ownerId) continue;
    const endpoints =
      unit?.kind === "corporation"
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
            ...(unit
              ? []
              : character.corporations.flatMap((corporation) => [
                  corporation.assets,
                  corporation.blueprints,
                  corporation.jobs,
                  corporation.orders,
                  corporation.structures,
                ])),
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
) {
  const source = await refreshCoordinator.run(
    unit.key,
    async () => {
      if (unit.kind === "character") {
        await refreshCharacterState([unit.ownerId], sessionId, { mode: "character" });
      }
      else {
        const authorizationCharacter = characters.find(
          (character) =>
            character.characterId === unit.authorizationCharacterId
            && character.corporationId === unit.ownerId
            && character.hasDirectorRole,
        );
        if (!authorizationCharacter) throw new Error("Corporation authorization is incomplete");
        await refreshCorporationState(unit.ownerId, authorizationCharacter.characterId, sessionId);
      }
      return { sessionId };
    },
  );
  copyRefreshCache(unit.kind, unit.ownerId, source.sessionId, sessionId);
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

  const parsedRequest = refreshRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedRequest.success) {
    return NextResponse.json({ error: "Invalid refresh request." }, { status: 400 });
  }

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
  const sessionCharacters = characters.filter((character) =>
    characterIds.includes(character.characterId),
  );
  if (sessionCharacters.length === 0) {
    return NextResponse.json({ error: "ESI is not connected." }, { status: 401 });
  }

  const requested = parsedRequest.data;
  let targets = sessionCharacters.map((character) => ({
    characterId: character.characterId,
    corporationId: character.corporationId,
    hasDirectorRole: Boolean(character.hasDirectorRole),
  }));
  if (requested.kind === "character") {
    if (!sessionCharacters.some((character) => character.characterId === requested.id)) {
      return NextResponse.json(
        { error: "Character is not attached to this session." },
        { status: 403 },
      );
    }
    targets = targets.filter((target) => target.characterId === requested.id);
  }
  else if (requested.kind === "corporation") {
    const hasAuthorization = sessionCharacters.some(
      (character) => character.corporationId === requested.id && character.hasDirectorRole,
    );
    if (!hasAuthorization) {
      return NextResponse.json(
        { error: "Corporation authorization is incomplete." },
        { status: 403 },
      );
    }
    targets = targets.filter(
      (target) => target.corporationId === requested.id && target.hasDirectorRole,
    );
  }

  const units = buildRefreshUnits(targets).filter(
    (unit) =>
      requested.kind === undefined
      || (unit.kind === requested.kind && unit.ownerId === requested.id),
  );
  const rateLimitedUntil = getEsiRateLimitUntil();
  if (rateLimitedUntil) {
    return NextResponse.json({
      success: false,
      completed: 0,
      total: units.length,
      rateLimitedUntil,
    });
  }

  const results = await runRefreshUnits(
    units,
    (unit) => refreshUnit(unit, session.sessionId, characters),
    { concurrency: 2 },
  );
  const status = await getStateStatus(characterIds, session.sessionId);
  const errors = results
    .filter((result) => !result.success)
    .map((result) => (result.error instanceof Error ? result.error.message : "Refresh failed."));
  const statusError = firstRefreshError(status, requested.kind ? units[0] : undefined);
  if (statusError) errors.push(statusError);
  const uniqueErrors = [...new Set(errors)];
  return NextResponse.json({
    success: uniqueErrors.length === 0,
    completed: results.length,
    total: units.length,
    errors: uniqueErrors,
    refreshedAt: new Date().toISOString(),
    rateLimitedUntil: getEsiRateLimitUntil(),
  });
}
