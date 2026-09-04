import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  deleteCharacter,
  getSession,
  setCharacterCorpRefreshOptIn,
  setCharacterOnDeployment,
} from "@/lib/auth/tokensStore";
import { isCorpRefreshOptInEnabled } from "@/lib/auth/corpRefreshOptIn";

const characterUpdateSchema = z
  .object({
    onDeployment: z.boolean().optional(),
    allowCorpRefreshOptIn: z.boolean().optional(),
  })
  .refine((value) => value.onDeployment !== undefined || value.allowCorpRefreshOptIn !== undefined);

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
  const parsed = characterUpdateSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid character settings." }, { status: 400 });
  }
  if (parsed.data.allowCorpRefreshOptIn !== undefined && !isCorpRefreshOptInEnabled()) {
    return NextResponse.json({ error: "Corporation refresh opt-in is disabled." }, { status: 403 });
  }
  try {
    if (parsed.data.onDeployment !== undefined) {
      await setCharacterOnDeployment(characterId, current.collectionId, parsed.data.onDeployment);
    }
    if (parsed.data.allowCorpRefreshOptIn !== undefined) {
      await setCharacterCorpRefreshOptIn(
        characterId,
        current.collectionId,
        parsed.data.allowCorpRefreshOptIn,
      );
    }
  }
  catch (error) {
    if (
      error instanceof Error
      && error.message === "Character is not attached to this collection."
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof Error
      && error.message === "Only a Director can change corporation refresh opt-in."
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
  return NextResponse.json({ success: true, ...parsed.data });
}
