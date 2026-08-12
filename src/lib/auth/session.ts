import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";
import type { SessionRecord } from "./model";
import { getCollection, getSession, saveSession } from "./tokensStore";

export const sessionCookieName = "assembly_line_session";

export function getRequestCookie(request: Request, name: string) {
  return request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export async function createSession(collectionId?: string): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const record: SessionRecord = {
    sessionId: randomUUID(),
    collectionId,
    createdAt: now,
    lastSeenAt: now,
  };
  await saveSession(record);
  return record;
}

export async function getSessionCharacterIds(session: SessionRecord) {
  if (!session.collectionId) return [];
  return (await getCollection(session.collectionId))?.characterIds ?? [];
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
