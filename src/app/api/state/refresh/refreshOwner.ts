import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  findCorporationDirector,
  getCharacter,
  getCollectionFacilities,
  getCollectionCorporationSettings,
} from "@/lib/auth/tokensStore";
import { getCorporationSourcePolicies } from "@/lib/esi/cache";
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
import { getOwnerSnapshot, type OwnerSnapshot } from "@/lib/data/ownerSnapshot";
import { calculateFacilities } from "@/lib/planning/facilitiesServer";

const refreshIdSchema = z.coerce.number().int().positive();
const refreshRequestSchema = z
  .object({
    eTags: z
      .object({
        assets: z.string().min(1).optional(),
        blueprintInstances: z.string().min(1).optional(),
        corporationSources: z.string().min(1).optional(),
        industryJobs: z.string().min(1).optional(),
        jobs: z.string().min(1).optional(),
        marketOrders: z.string().min(1).optional(),
        rootLocations: z.string().min(1).optional(),
        ships: z.string().min(1).optional(),
      })
      .strict()
      .optional()
      .default({}),
  })
  .strict();

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

async function refreshUnit(
  unit: RefreshUnit,
  sessionId: string,
  authorizationCharacter: NonNullable<Awaited<ReturnType<typeof getCharacter>>>,
  profiler: RefreshProfiler,
  materialContext?: Awaited<ReturnType<typeof calculateFacilities>>,
) {
  const source = await refreshCoordinator.run(
    unit.key,
    async () => {
      if (unit.kind === "character") {
        await refreshCharacterState(authorizationCharacter, sessionId, profiler, materialContext);
      }
      else {
        await refreshCorporationState(
          unit.ownerId,
          authorizationCharacter,
          sessionId,
          profiler,
          materialContext,
        );
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
  let previousETags: Parameters<typeof getOwnerSnapshot>[3] = {};
  try {
    const body = await request.json();
    const parsedBody = refreshRequestSchema.safeParse(body);
    if (!parsedBody.success) return json({ error: "Invalid refresh request." }, 400);
    previousETags = parsedBody.data.eTags;
  }
  catch {
    return json({ error: "Invalid refresh request." }, 400);
  }
  let characterIds: number[] = [];
  let authorizationCharacter: NonNullable<Awaited<ReturnType<typeof getCharacter>>> | null = null;
  let corporationPolicies: Awaited<ReturnType<typeof getCorporationSourcePolicies>> = [];
  let unit: RefreshUnit;
  if (kind === "character") {
    profiler.start("loadCharacter");
    try {
      const character = await getCharacter(ownerId);
      if (!character) return json({ error: "Character is unavailable." }, 404);
      authorizationCharacter = character;
    }
    catch {
      return json({ error: "ESI is not connected." }, 401);
    }
    finally {
      profiler.end("loadCharacter");
    }
    characterIds = [ownerId];
    unit = {
      key: `character:${ownerId}`,
      kind,
      ownerId,
    };
  }
  else {
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

    const requesterCharacterId =
      session.authenticatedCharacterId !== undefined
      && characterIds.includes(session.authenticatedCharacterId)
        ? session.authenticatedCharacterId
        : undefined;
    profiler.start("loadAuthorizationCharacter");
    try {
      if (!session.collectionId) return json({ error: "Session collection is unavailable." }, 400);
      const settings = await getCollectionCorporationSettings(session.collectionId);
      if (!settings.some((entry) => entry.corporationId === ownerId && entry.supportEnabled)) {
        return json(
          {
            error: "Corporation support is not enabled for this collection.",
            code: "CORPORATION_SUPPORT_DISABLED",
          },
          403,
        );
      }
      authorizationCharacter = await findCorporationDirector(ownerId, requesterCharacterId);
    }
    catch {
      return json({ error: "ESI is not connected." }, 401);
    }
    finally {
      profiler.end("loadAuthorizationCharacter");
    }
    if (!authorizationCharacter) {
      return json(
        {
          error: "No Director with the required corporation scopes is available for this refresh.",
          code: "CORPORATION_DIRECTOR_UNAVAILABLE",
        },
        403,
      );
    }
    unit = {
      key: `corporation:${ownerId}`,
      kind,
      ownerId,
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

  let materialContext: Awaited<ReturnType<typeof calculateFacilities>> | undefined;
  if (session.collectionId) {
    profiler.start("facilities");
    try {
      materialContext = await calculateFacilities(
        request,
        await getCollectionFacilities(session.collectionId),
      );
    }
    catch {
      // Facility bonuses are optional for reconciliation; the raw material quantity remains safe.
    }
    finally {
      profiler.end("facilities");
    }
  }

  let refreshError: unknown;
  profiler.start("refresh");
  try {
    await refreshUnit(unit, session.sessionId, authorizationCharacter, profiler, materialContext);
  }
  catch (error) {
    refreshError = error;
  }
  finally {
    profiler.end("refresh");
  }
  let ownerSnapshot: OwnerSnapshot | undefined;
  let snapshotError: unknown;
  if (!refreshError) {
    if (kind === "corporation") {
      profiler.start("loadCorporationPolicies");
      try {
        const settings = session.collectionId
          ? await getCollectionCorporationSettings(session.collectionId)
          : [];
        corporationPolicies = (
          await getCorporationSourcePolicies(characterIds, settings, session.sessionId)
        ).filter((policy) => policy.corporationId === ownerId);
        if (corporationPolicies.length === 0) {
          return json(
            {
              error: "Corporation source policy is unavailable for this refresh.",
              code: "CORPORATION_POLICY_UNAVAILABLE",
            },
            403,
          );
        }
      }
      catch {
        return json({ error: "ESI is not connected." }, 401);
      }
      finally {
        profiler.end("loadCorporationPolicies");
      }
    }
    profiler.start("snapshot");
    try {
      ownerSnapshot = await getOwnerSnapshot(
        { kind, id: ownerId },
        {
          sessionId: session.sessionId,
          characterIds,
          corporationPolicies,
          authorizationCharacterId: authorizationCharacter.characterId,
        },
        {
          personalSellOrdersAsStock: true,
          allCorporationSellOrdersAsStock: true,
          myCorporationSellOrdersAsStock: true,
        },
        previousETags,
      );
    }
    catch (error) {
      snapshotError = error;
    }
    finally {
      profiler.end("snapshot");
    }
  }
  profiler.start("status");
  try {
    const errors = [refreshError, snapshotError]
      .filter((error) => error !== undefined)
      .map((error) => (error instanceof Error ? error.message : "Refresh failed."));
    const uniqueErrors = [...new Set(errors)];
    return json({
      success: uniqueErrors.length === 0,
      completed: refreshError ? 0 : 1,
      total: 1,
      errors: uniqueErrors,
      refreshedAt: new Date().toISOString(),
      rateLimitedUntil: getEsiRateLimitUntil(),
      ...(ownerSnapshot ? { ownerSnapshot } : {}),
    });
  }
  finally {
    profiler.end("status");
  }
}
