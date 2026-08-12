import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { deleteCharacter, getSession } from "@/lib/auth/tokensStore";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterId = Number((await context.params).id);
  const characterIds = await getSessionCharacterIds(session);
  if (!Number.isInteger(characterId) || !characterIds.includes(characterId)) {
    return NextResponse.json({ error: "Character is not attached to this session." }, { status: 404 });
  }
  const current = await getSession(session.sessionId);
  if (!current) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (!current.collectionId) return NextResponse.json({ error: "Collection not found." }, { status: 404 });
  try {
    await deleteCharacter(characterId, current.collectionId);
  } catch (error) {
    if (error instanceof Error && error.message === "Character is not attached to this collection.") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
  current.lastSeenAt = new Date().toISOString();
  return NextResponse.json({ success: true });
}
