import { NextResponse } from "next/server";
import { attachCharacter, createSession, getRequestCookie, setSessionCookie } from "@/lib/auth/session";
import { consumePendingAuth, exchangeCodeForTokens, sameState, validateToken } from "@/lib/auth/eveSso";
import { fetchCharacterCorporationId, fetchCharacterRoles } from "@/lib/esi/client";
import { createAccount, getAccount, getAccountForCharacter, getCharacter, getSession, upsertCharacter } from "@/lib/auth/tokensStore";

function getPublicOrigin(request: Request, callbackUrl: string) {
  const configuredCallback = process.env.EVE_CALLBACK_URL;
  if (configuredCallback) return new URL(configuredCallback).origin;
  if (callbackUrl) return new URL(callbackUrl).origin;
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  return `${forwardedProtocol}://${forwardedHost}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "Missing SSO callback parameters." }, { status: 400 });
  const cookieState = getRequestCookie(request, "assembly_line_sso_state");
  if (!cookieState || !sameState(cookieState, state)) return NextResponse.json({ error: "Invalid SSO state." }, { status: 400 });

  const pending = await consumePendingAuth(state);
  if (!pending) return NextResponse.json({ error: "The SSO authorization expired or was already used." }, { status: 400 });

  try {
    const tokenSet = await exchangeCodeForTokens(code, pending.codeVerifier, pending.redirectUri);
    const identity = await validateToken(tokenSet.accessToken);
    tokenSet.scopes = identity.scopes.length > 0 ? identity.scopes : pending.scopes;
    const existingCharacter = await getCharacter(identity.characterId);
    const existingSession = pending.sessionId ? await getSession(pending.sessionId) : null;
    const accountId = existingSession?.accountId ?? existingCharacter?.accountId ?? (await getAccountForCharacter(identity.characterId))?.accountId;
    if (existingSession?.accountId && existingCharacter?.accountId && existingSession.accountId !== existingCharacter.accountId) {
      throw new Error("Character belongs to another account");
    }
    const resolvedAccountId = accountId ?? (await createAccount()).accountId;
    const session = existingSession ?? await createSession(resolvedAccountId);
    const corporationId = await fetchCharacterCorporationId(identity.characterId);
    const roles = tokenSet.scopes.includes("esi-characters.read_corporation_roles.v1")
      ? await fetchCharacterRoles(identity.characterId, tokenSet)
      : [];
    await upsertCharacter({
      ...existingCharacter,
      characterId: identity.characterId,
      characterName: identity.characterName ?? `Character ${identity.characterId}`,
      accountId: resolvedAccountId,
      personalAuth: tokenSet,
      corporationId,
      corporationRoles: roles,
      hasDirectorRole: roles.includes("Director"),
      hasAccountantRole: roles.includes("Accountant"),
      hasTraderRole: roles.includes("Trader"),
      hasStationManagerRole: roles.includes("Station_Manager"),
      corpAuthCompleted: roles.includes("Director") || roles.includes("Station_Manager"),
    });
    if (!session.accountId && resolvedAccountId) session.accountId = resolvedAccountId;
    const account = await getAccount(resolvedAccountId);
    for (const characterId of account?.characterIds ?? [identity.characterId]) {
      await attachCharacter(session.sessionId, characterId);
    }
    const response = NextResponse.redirect(`${getPublicOrigin(request, pending.redirectUri)}/`);
    setSessionCookie(response, session.sessionId);
    response.cookies.set("assembly_line_sso_state", "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    console.error("EVE SSO callback failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "EVE authentication failed." }, { status: 502 });
  }
}
