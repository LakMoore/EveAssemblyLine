import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { TokenSet } from "./model";
import { initStorage } from "../storage";

const ssoBaseUrl = "https://login.eveonline.com";
const issuer = "https://login.eveonline.com";
const pendingAuthPrefix = "pending-auth:";
const pendingAuthTtlMs = 10 * 60 * 1000;

export const personalScopes = [
  "esi-assets.read_assets.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-characters.read_blueprints.v1",
  "esi-markets.read_character_orders.v1",
];

export const corporationScopes = [
  ...personalScopes,
  "esi-assets.read_corporation_assets.v1",
  "esi-characters.read_corporation_roles.v1",
  "esi-corporations.read_blueprints.v1",
  "esi-industry.read_corporation_jobs.v1",
  "esi-markets.read_corporation_orders.v1",
  "esi-universe.read_structures.v1",
];

export const authorizationScopes = corporationScopes;

type PendingAuth = {
  sessionId?: string;
  characterId?: number;
  scopes: string[];
  redirectUri: string;
  codeVerifier: string;
  expiresAt: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

type ValidatedToken = {
  characterId: number;
  characterName?: string;
  scopes: string[];
};

function getConfig() {
  const clientId = process.env.EVE_CLIENT_ID;
  if (!clientId) throw new Error("EVE_CLIENT_ID is not configured");
  return { clientId, clientSecret: process.env.EVE_CLIENT_SECRET };
}

function base64Url(value: Buffer) {
  return value.toString("base64url");
}

export function createCodeVerifier() {
  return base64Url(randomBytes(32));
}

export function createCodeChallenge(codeVerifier: string) {
  return base64Url(createHash("sha256").update(codeVerifier).digest());
}

export function getAuthorizeUrl(
  state: string,
  codeVerifier: string,
  scopes: string[],
  redirectUri: string,
) {
  const { clientId } = getConfig();
  const url = new URL(`${ssoBaseUrl}/v2/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createCodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function savePendingAuth(state: string, pending: PendingAuth) {
  const storage = await initStorage();
  await storage.setItem(`${pendingAuthPrefix}${state}`, pending);
}

export async function consumePendingAuth(state: string) {
  const storage = await initStorage();
  const key = `${pendingAuthPrefix}${state}`;
  const pending = await storage.getItem<PendingAuth>(key);
  await storage.setItem(key, null);
  if (!pending || Date.parse(pending.expiresAt) < Date.now()) return null;
  return pending;
}

async function tokenRequest(body: URLSearchParams, useClientSecret = true) {
  const { clientId, clientSecret } = getConfig();
  const headers: HeadersInit = { "content-type": "application/x-www-form-urlencoded" };
  if (useClientSecret && clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
  }
  const response = await fetch(`${ssoBaseUrl}/v2/oauth/token`, { method: "POST", headers, body });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`EVE SSO token exchange failed (${response.status}): ${details.slice(0, 300)}`);
  }
  return response.json() as Promise<TokenResponse>;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenSet> {
  const response = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    false,
  );
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? "",
    accessTokenExpiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    scopes: [],
  };
}

export async function refreshTokenSet(tokenSet: TokenSet): Promise<TokenSet> {
  const response = await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenSet.refreshToken,
    }),
  );
  return {
    ...tokenSet,
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? tokenSet.refreshToken,
    accessTokenExpiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
  };
}

function decodePart(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function verifyJwt(token: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Invalid EVE token");
  const header = decodePart(encodedHeader);
  const payload = decodePart(encodedPayload);
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw new Error("Unsupported EVE token");
  if (
    payload.iss !== issuer ||
    (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now())
  ) {
    throw new Error("Expired or invalid EVE token");
  }
  const config = getConfig();
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.clientId) && !audiences.includes("EVE Online"))
    throw new Error("Invalid EVE token audience");
  const jwksResponse = await fetch(`${ssoBaseUrl}/oauth/jwks`);
  if (!jwksResponse.ok) throw new Error("Could not load EVE token keys");
  const jwks = (await jwksResponse.json()) as { keys?: Array<Record<string, unknown>> };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("Unknown EVE token key");
  const publicKey = createPublicKey({
    key: jwk as unknown as import("node:crypto").JsonWebKey,
    format: "jwk",
  });
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!valid) throw new Error("Invalid EVE token signature");
  return payload;
}

export async function validateToken(accessToken: string): Promise<ValidatedToken> {
  const payload = await verifyJwt(accessToken);
  const subject =
    typeof payload.sub === "string" ? payload.sub.match(/^CHARACTER:EVE:(\d+)$/) : null;
  if (!subject) throw new Error("Invalid EVE character subject");
  return {
    characterId: Number(subject[1]),
    characterName: typeof payload.name === "string" ? payload.name : undefined,
    scopes: Array.isArray(payload.scp)
      ? payload.scp.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

export function sameState(expected: string, received: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export { pendingAuthTtlMs };
export type { PendingAuth, ValidatedToken };
