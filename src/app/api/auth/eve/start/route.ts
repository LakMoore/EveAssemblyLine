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

function getPublicOrigin(request: Request) {
  const configuredCallback = process.env.EVE_CALLBACK_URL;
  if (configuredCallback) return new URL(configuredCallback).origin;
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const forwardedProtocol =
    request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  return `${forwardedProtocol}://${forwardedHost}`;
}

function getReturnPath(request: Request) {
  const referer = request.headers.get("referer");
  if (!referer) return "/";
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== getPublicOrigin(request)) return "/";
    return `${refererUrl.pathname}${refererUrl.search}`;
  }
  catch {
    return "/";
  }
}

export async function GET(request: Request) {
  const requestedCharacterId = Number(new URL(request.url).searchParams.get("characterId"));
  const state = randomUUID();
  const codeVerifier = createCodeVerifier();
  const redirectUri =
    process.env.EVE_CALLBACK_URL ?? `${getPublicOrigin(request)}/api/auth/eve/callback`;
  const sessionId = getRequestCookie(request, sessionCookieName);
  await savePendingAuth(
    state,
    {
      scopes: authorizationScopes,
      redirectUri,
      codeVerifier,
      sessionId,
      returnPath: getReturnPath(request),
      ...(Number.isInteger(requestedCharacterId) && requestedCharacterId > 0
        ? { reauthorizeCharacterId: requestedCharacterId }
        : {}),
      expiresAt: new Date(Date.now() + pendingAuthTtlMs).toISOString(),
    },
  );
  const response = NextResponse.redirect(
    getAuthorizeUrl(state, codeVerifier, authorizationScopes, redirectUri),
  );
  response.cookies.set(
    "assembly_line_sso_state",
    state,
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: Math.floor(pendingAuthTtlMs / 1000),
    },
  );
  return response;
}
