import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createCodeVerifier,
  getAuthorizeUrl,
  authorizationScopes,
  savePendingAuth,
  pendingAuthTtlMs,
} from "@/lib/auth/eveSso";
import { getRequestCookie, sessionCookieName } from "@/lib/auth/session";

export async function GET(request: Request) {
  const state = randomUUID();
  const codeVerifier = createCodeVerifier();
  const redirectUri = process.env.EVE_CALLBACK_URL ?? new URL("/api/auth/eve/callback", request.url).toString();
  const sessionId = getRequestCookie(request, sessionCookieName);
  await savePendingAuth(state, {
    scopes: authorizationScopes,
    redirectUri,
    codeVerifier,
    sessionId,
    expiresAt: new Date(Date.now() + pendingAuthTtlMs).toISOString(),
  });
  const response = NextResponse.redirect(getAuthorizeUrl(state, codeVerifier, authorizationScopes, redirectUri));
  response.cookies.set("assembly_line_sso_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(pendingAuthTtlMs / 1000),
  });
  return response;
}
