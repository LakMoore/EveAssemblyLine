import { NextResponse } from "next/server";
import { clearSessionCookie, getSessionFromRequest } from "@/lib/auth/session";
import { deleteSession } from "@/lib/auth/tokensStore";

export async function POST(request: Request) {
  const session = await getSessionFromRequest(request);
  if (session) await deleteSession(session.sessionId);
  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  return response;
}
