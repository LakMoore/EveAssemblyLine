import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { deleteCharacter, getSession, setCharacterOnDeployment } from "@/lib/auth/tokensStore";

const deploymentSchema = z.object({
  onDeployment: z.boolean(),
});

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterId = Number((await context.params).id);
  const characterIds = await getSessionCharacterIds(session);
  if (!Number.isInteger(characterId) || !characterIds.includes(characterId)) {
    return NextResponse.json(
      { error: "Character is not attached to this session." },
      { status: 404 },
    );
  }
  const current = await getSession(session.sessionId);
  if (!current) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (!current.collectionId) {
    return NextResponse.json({ error: "Collection not found." }, { status: 404 });
  }
  try {
    await deleteCharacter(characterId, current.collectionId);
  }
  catch (error) {
    if (
      error instanceof Error
      && error.message === "Character is not attached to this collection."
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
  current.lastSeenAt = new Date().toISOString();
  return NextResponse.json({ success: true });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const characterId = Number((await context.params).id);
  const characterIds = await getSessionCharacterIds(session);
  if (!Number.isInteger(characterId) || !characterIds.includes(characterId)) {
    return NextResponse.json(
      { error: "Character is not attached to this session." },
      { status: 404 },
    );
  }
  const current = await getSession(session.sessionId);
  if (!current?.collectionId) {
    return NextResponse.json({ error: "Collection not found." }, { status: 404 });
  }
  const parsed = deploymentSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid deployment status." }, { status: 400 });
  }
  try {
    await setCharacterOnDeployment(characterId, current.collectionId, parsed.data.onDeployment);
  }
  catch (error) {
    if (
      error instanceof Error
      && error.message === "Character is not attached to this collection."
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
  return NextResponse.json({ success: true, onDeployment: parsed.data.onDeployment });
}
