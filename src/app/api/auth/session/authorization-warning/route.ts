import { NextResponse } from "next/server";
import { createSession, getSessionFromRequest, setSessionCookie } from "@/lib/auth/session";
import { saveSession } from "@/lib/auth/tokensStore";

/** Returns whether this browser session has acknowledged the EVE authorization warning. */
export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  return NextResponse.json({ acknowledgedAt: session?.authorizationWarningAcknowledgedAt ?? null });
}

/** Records the time at which the current browser session acknowledged the warning. */
export async function POST(request: Request) {
  const existingSession = await getSessionFromRequest(request);
  const session = existingSession ?? (await createSession());
  const acknowledgedAt = new Date().toISOString();
  await saveSession({ ...session, authorizationWarningAcknowledgedAt: acknowledgedAt });

  const response = NextResponse.json({ acknowledgedAt });
  if (!existingSession) setSessionCookie(response, session.sessionId);
  return response;
}

/** Clears the acknowledgement for the current browser session. */
export async function DELETE(request: Request) {
  const session = await getSessionFromRequest(request);
  if (session?.authorizationWarningAcknowledgedAt) {
    const { authorizationWarningAcknowledgedAt: _, ...sessionWithoutAcknowledgement } = session;
    await saveSession(sessionWithoutAcknowledgement);
  }
  return NextResponse.json({ acknowledgedAt: null });
}
