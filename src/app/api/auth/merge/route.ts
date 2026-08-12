import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { fetchCharacterCorporationId, fetchCharacterRoles } from "@/lib/esi/client";
import {
  deletePendingMerge,
  getCharacters,
  getCollection,
  getPendingMerge,
  getSession,
  mergeCollections,
  upsertCharacter,
} from "@/lib/auth/tokensStore";

async function getPending(request: Request) {
  const session = await getSessionFromRequest(request);
  const mergeId = request.headers.get("x-assembly-line-merge") ?? request.headers.get("cookie")?.match(/(?:^|; )assembly_line_merge=([^;]+)/)?.[1];
  const pending = mergeId ? await getPendingMerge(decodeURIComponent(mergeId)) : undefined;
  if (!session || !pending || pending.sessionId !== session.sessionId || Date.parse(pending.expiresAt) < Date.now()) return null;
  return { session, mergeId: decodeURIComponent(mergeId!), pending };
}

export async function GET(request: Request) {
  const value = await getPending(request);
  if (!value) return NextResponse.json({ mergeRequired: false });
  const [target, source, characters] = await Promise.all([
    getCollection(value.pending.targetCollectionId),
    getCollection(value.pending.sourceCollectionId),
    getCharacters(),
  ]);
  if (!target || !source) return NextResponse.json({ mergeRequired: false });
  const names = new Map(characters.map((character) => [character.characterId, character.characterName]));
  return NextResponse.json({
    mergeRequired: true,
    incomingCharacter: { characterId: value.pending.characterId, characterName: value.pending.characterName ?? `Character ${value.pending.characterId}` },
    currentCharacters: target.characterIds.map((id) => ({ characterId: id, characterName: names.get(id) ?? `Character ${id}` })),
    incomingCharacters: source.characterIds.map((id) => ({ characterId: id, characterName: names.get(id) ?? `Character ${id}` })),
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
    const corporationId = await fetchCharacterCorporationId(pending.characterId);
    const roles = pending.scopes.includes("esi-characters.read_corporation_roles.v1")
      ? await fetchCharacterRoles(pending.characterId, pending.tokenSet)
      : [];
    const existing = (await getCharacters()).find((character) => character.characterId === pending.characterId);
    await upsertCharacter({
      ...existing,
      characterId: pending.characterId,
      characterName: pending.characterName ?? `Character ${pending.characterId}`,
      collectionId: pending.targetCollectionId,
      personalAuth: pending.tokenSet,
      corporationId,
      corporationRoles: roles,
      hasDirectorRole: roles.includes("Director"),
      hasAccountantRole: roles.includes("Accountant"),
      hasTraderRole: roles.includes("Trader"),
      hasStationManagerRole: roles.includes("Station_Manager"),
      corpAuthCompleted: roles.includes("Director") || roles.includes("Station_Manager"),
    });
    await deletePendingMerge(value.mergeId);
    const response = NextResponse.json({ success: true });
    response.cookies.set("assembly_line_merge", "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    console.error("Account collection merge failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not merge character collections." }, { status: 500 });
  }
}
