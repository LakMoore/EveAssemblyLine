import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { fetchCharacterCorporationAuthorization } from "@/lib/esi/client";
import { invalidateCorporationCache } from "@/lib/esi/cache";
import {
  deletePendingMerge,
  getCharacter,
  getCollection,
  getPendingMerge,
  getSession,
  mergeCollections,
  saveCharacter,
} from "@/lib/auth/tokensStore";

async function getPending(request: Request) {
  const session = await getSessionFromRequest(request);
  const mergeId =
    request.headers.get("x-assembly-line-merge")
    ?? request.headers.get("cookie")?.match(/(?:^|; )assembly_line_merge=([^;]+)/)?.[1];
  const pending = mergeId ? await getPendingMerge(decodeURIComponent(mergeId)) : undefined;
  if (
    !session
    || !pending
    || pending.sessionId !== session.sessionId
    || Date.parse(pending.expiresAt) < Date.now()
  ) return null;
  return { session, mergeId: decodeURIComponent(mergeId!), pending };
}

export async function GET(request: Request) {
  const value = await getPending(request);
  if (!value) return NextResponse.json({ mergeRequired: false });
  const [target, source] = await Promise.all([
    getCollection(value.pending.targetCollectionId),
    getCollection(value.pending.sourceCollectionId),
  ]);
  if (!target || !source) return NextResponse.json({ mergeRequired: false });
  const characters = (
    await Promise.all(
      [...new Set([...target.characterIds, ...source.characterIds])].map((id) => getCharacter(id)),
    )
  ).filter((character) => character !== null);
  const names = new Map(
    characters.map((character) => [character.characterId, character.characterName]),
  );
  return NextResponse.json({
    mergeRequired: true,
    incomingCharacter: {
      characterId: value.pending.characterId,
      characterName: value.pending.characterName ?? `Character ${value.pending.characterId}`,
    },
    currentCharacters: target.characterIds.map((id) => ({
      characterId: id,
      characterName: names.get(id) ?? `Character ${id}`,
    })),
    incomingCharacters: source.characterIds.map((id) => ({
      characterId: id,
      characterName: names.get(id) ?? `Character ${id}`,
    })),
  });
}

export async function POST(request: Request) {
  const value = await getPending(request);
  if (!value) return NextResponse.json({ error: "Merge request expired." }, { status: 410 });
  const { pending } = value;
  const session = await getSession(pending.sessionId);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  try {
    await mergeCollections(pending.targetCollectionId, pending.sourceCollectionId);
    const corporationAuthorization = await fetchCharacterCorporationAuthorization(
      pending.characterId,
      pending.tokenSet,
    );
    const roles = corporationAuthorization.roles ?? {
      roles: [],
      rolesAtBase: [],
      rolesAtHq: [],
      rolesAtOther: [],
    };
    const existing = await getCharacter(pending.characterId);
    if (!corporationAuthorization.authorized && existing?.corporationId !== undefined) {
      invalidateCorporationCache(existing.corporationId, session.sessionId);
    }
    await saveCharacter({
      ...existing,
      characterId: pending.characterId,
      characterName: pending.characterName ?? `Character ${pending.characterId}`,
      collectionId: pending.targetCollectionId,
      personalAuth: corporationAuthorization.token,
      corporationId: corporationAuthorization.authorized
        ? corporationAuthorization.corporationId
        : undefined,
      allianceId: corporationAuthorization.authorized
        ? corporationAuthorization.characterInfo.alliance_id
        : undefined,
      corporationRoles: roles.roles,
      rolesAtBase: roles.rolesAtBase,
      rolesAtHq: roles.rolesAtHq,
      rolesAtOther: roles.rolesAtOther,
      hasDirectorRole: roles.roles.includes("Director"),
      hasAccountantRole: roles.roles.includes("Accountant"),
      hasTraderRole: roles.roles.includes("Trader"),
      hasStationManagerRole: roles.roles.includes("Station_Manager"),
    });
    await deletePendingMerge(value.mergeId);
    const response = NextResponse.json({ success: true });
    response.cookies.set("assembly_line_merge", "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  }
  catch (error) {
    console.error(
      "Account collection merge failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "Could not merge character collections." }, { status: 500 });
  }
}
