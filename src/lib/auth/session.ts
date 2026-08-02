import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";
import type { SessionRecord } from "./model";
import { getSession, saveSession } from "./tokensStore";

export const sessionCookieName = "assembly_line_session";

export function getRequestCookie(request: Request, name: string) {
  return request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export async function createSession(accountId?: string): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const record: SessionRecord = {
    sessionId: randomUUID(),
    accountId,
    characterIds: [],
    createdAt: now,
    lastSeenAt: now,
  };
  await saveSession(record);
  return record;
}

export async function attachCharacter(sessionId: string, characterId: number) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (!session.characterIds.includes(characterId)) session.characterIds.push(characterId);
  session.lastSeenAt = new Date().toISOString();
  await saveSession(session);
  return session;
}

export async function getSessionFromRequest(request: Request) {
  const value = getRequestCookie(request, sessionCookieName);
  return value ? getSession(decodeURIComponent(value)) : null;
}

export function setSessionCookie(response: NextResponse, sessionId: string) {
  response.cookies.set(sessionCookieName, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(sessionCookieName, "", { httpOnly: true, path: "/", maxAge: 0 });
}
