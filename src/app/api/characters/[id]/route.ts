import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getSession, saveSession } from "@/lib/auth/tokensStore";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterId = Number((await context.params).id);
  if (!Number.isInteger(characterId) || !session.characterIds.includes(characterId)) {
    return NextResponse.json({ error: "Character is not attached to this session." }, { status: 404 });
  }
  const current = await getSession(session.sessionId);
  if (!current) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  current.characterIds = current.characterIds.filter((id) => id !== characterId);
  current.lastSeenAt = new Date().toISOString();
  await saveSession(current);
  return NextResponse.json({ success: true });
}
