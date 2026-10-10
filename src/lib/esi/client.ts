import { createHash } from "node:crypto";
import type {
  AssetRecord,
  BlueprintInstanceRecord,
  CharacterLocationRecord,
  CharacterShipRecord,
  CharacterSkillRecord,
  CharacterTokenRecord,
  IndustryJobRecord,
  MarketOrderRecord,
  TokenSet,
} from "@/lib/auth/model";
import { getCachedEsiResponse, setCachedEsiResponse } from "@/cache/services/esiCache";
import { refreshTokenSet } from "@/lib/auth/eveSso";
import { getCharacter, saveCharacterTokens } from "@/lib/auth/tokensStore";
import { logEsiRequest } from "@/lib/esi/logger";
import { z } from "zod";

const esiBaseUrl = process.env.ESI_BASE_URL ?? "https://esi.evetech.net/latest";
const refreshLocks = new Map<string, Promise<TokenSet>>();
type CorporationStructureRuntime = {
  requests: Map<number, Promise<CorporationStructureResult>>;
};
const runtime = globalThis as typeof globalThis & {
  __assemblyLineCorporationStructures?: CorporationStructureRuntime;
};
const corporationStructureRuntime =
  runtime.__assemblyLineCorporationStructures
  ?? (runtime.__assemblyLineCorporationStructures = {
    requests: new Map<number, Promise<CorporationStructureResult>>(),
  });
const corporationStructureRequests = corporationStructureRuntime.requests;
const tokenContexts = new WeakMap<TokenSet, { characterId: number }>();
const structureMetadataCache = new Map<
  string,
  { expiresAt: number; response: LocationMetadataResponse }
>();
const structureMetadataCacheTtlMs = 60 * 60 * 1000;
// Keep the guard conservative; EVE's spawned-item range begins at 1 billion.
const minimumStructureId = 1_000_000_000;
let esiRateLimitedUntil = 0;

type EsiRateLimitHeaders = {
  rateLimitGroup?: string;
  rateLimitLimit?: string;
  rateLimitRemaining?: string;
  rateLimitUsed?: string;
  errorLimitRemaining?: string;
  errorLimitReset?: string;
};

function getEsiRateLimitHeaders(headers: Headers): EsiRateLimitHeaders {
  const getHeader = (name: string) => headers.get(name) ?? undefined;
  return {
    ...(getHeader("x-ratelimit-group") ? { rateLimitGroup: getHeader("x-ratelimit-group") } : {}),
    ...(getHeader("x-ratelimit-limit") ? { rateLimitLimit: getHeader("x-ratelimit-limit") } : {}),
    ...(getHeader("x-ratelimit-remaining")
      ? { rateLimitRemaining: getHeader("x-ratelimit-remaining") }
      : {}),
    ...(getHeader("x-ratelimit-used") ? { rateLimitUsed: getHeader("x-ratelimit-used") } : {}),
    ...(getHeader("x-esi-error-limit-remain")
      ? { errorLimitRemaining: getHeader("x-esi-error-limit-remain") }
      : {}),
    ...(getHeader("x-esi-error-limit-reset")
      ? { errorLimitReset: getHeader("x-esi-error-limit-reset") }
      : {}),
  };
}

export type EsiAssetLocation = {
  item_id: number;
  position: { x: number; y: number; z: number };
};

export type EsiCharacterClone = {
  jump_clone_id?: number;
  implants?: number[];
};

export type EsiCharacterClones = {
  jump_clones?: EsiCharacterClone[];
};

/** Returns unique implant type IDs from the active clone and every jump clone reported by ESI. */
export function getCharacterCloneImplantIds(
  clones: EsiCharacterClones | null,
  activeImplants: number[] = [],
) {
  return [
    ...new Set([
      ...activeImplants,
      ...(clones?.jump_clones ?? []).flatMap((clone) => clone.implants ?? []),
    ]),
  ];
}

/** The complete public character body returned by ESI. */
export type EsiCharacterPublicInfo = {
  alliance_id?: number;
  ancestry_id?: number;
  bloodline_id?: number;
  birthday: string;
  character_id?: number;
  corporation_id: number;
  description: string;
  faction_id?: number;
  gender: string;
  name: string;
  race_id: number;
  security_status: number;
  title?: string;
};

export type EsiCharacterRoles = {
  roles: string[];
  rolesAtBase: string[];
  rolesAtHq: string[];
  rolesAtOther: string[];
};

export type EsiAsset = {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
  location_type: string;
  location_flag: string;
  is_singleton: boolean;
};

export type EsiBlueprint = {
  item_id: number;
  type_id: number;
  location_id: number;
  location_flag: string;
  quantity: number;
  runs: number;
  material_efficiency: number;
  time_efficiency: number;
};

type EsiIndustryJob = {
  job_id: number;
  installer_id: number;
  facility_id: number;
  location_id?: number;
  station_id?: number;
  output_location_id: number;
  activity_id: number;
  blueprint_id: number;
  blueprint_type_id: number;
  blueprint_location_id: number;
  runs: number;
  probability?: number;
  licensed_runs?: number;
  product_type_id?: number;
  status: string;
  successful_runs?: number;
  start_date: string;
  end_date: string;
  completed_date?: string;
};

type EsiMarketOrder = {
  order_id: number;
  type_id: number;
  location_id: number;
  issued: string;
  volume_remain: number;
  volume_total: number;
  is_buy_order?: boolean;
  is_corporation?: boolean;
  issued_by?: number;
};

export type EsiCorporationStructure = {
  structure_id: number;
  type_id: number;
  corporation_id: number;
  system_id: number;
  profile_id: number;
  name?: string;
  state: string;
  fuel_expires?: string;
  state_timer_start?: string;
  state_timer_end?: string;
  unanchors_at?: string;
  reinforce_hour?: number;
  services?: Array<{ name: string; state: "online" | "offline" | "cleanup" }>;
};

export type EsiCorporationPublicInfo = {
  corporation_id: number;
  alliance_id?: number;
  ceo_id?: number;
  date_founded?: string;
  description?: string;
  home_station_id?: number;
  member_count?: number;
  name: string;
  ticker: string;
  url?: string;
};

export type EsiCorporationDivision = {
  division: number;
  name?: string;
};

type LocationMetadata = {
  name: string;
  type_id?: number;
  system_id?: number;
  solar_system_id?: number;
  constellation_id?: number;
  region_id?: number;
  services?: Array<string | { name: string; state: "online" | "offline" | "cleanup" }>;
};

const optionalIntegerSchema = z
  .number()
  .int()
  .nullish()
  .transform((value) => value ?? undefined);
const optionalPositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .nullish()
  .transform((value) => value ?? undefined);
const optionalStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

const esiAssetNameSchema = z.looseObject({
  item_id: z.number().int().positive(),
  name: z.string(),
});
const esiBlueprintSchema = z.looseObject({
  item_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  location_id: z.number().int().positive(),
  location_flag: z.string(),
  quantity: z.number().int(),
  runs: z.number().int(),
  material_efficiency: z.number().int(),
  time_efficiency: z.number().int(),
});
const esiAssetSchema = z.looseObject({
  item_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  quantity: z.number().int(),
  location_id: z.number().int().positive(),
  location_type: z.string(),
  location_flag: z.string(),
  is_singleton: z.boolean(),
});
const esiCharacterLocationSchema = z.looseObject({
  solar_system_id: z.number().int().positive(),
  station_id: optionalPositiveIntegerSchema,
  structure_id: optionalPositiveIntegerSchema,
});
const esiCharacterShipSchema = z.looseObject({
  ship_item_id: z.number().int().positive(),
  ship_name: z.string(),
  ship_type_id: z.number().int().positive(),
});
const esiIndustryJobSchema = z.looseObject({
  job_id: z.number().int().positive(),
  installer_id: z.number().int().positive(),
  facility_id: z.number().int().positive(),
  location_id: optionalPositiveIntegerSchema,
  station_id: optionalPositiveIntegerSchema,
  output_location_id: z.number().int().positive(),
  activity_id: z.number().int().positive(),
  blueprint_id: z.number().int().positive(),
  blueprint_type_id: z.number().int().positive(),
  blueprint_location_id: z.number().int().positive(),
  runs: z.number().int().positive(),
  probability: z
    .number()
    .min(0)
    .max(1)
    .nullish()
    .transform((value) => value ?? undefined),
  licensed_runs: optionalIntegerSchema,
  product_type_id: optionalPositiveIntegerSchema,
  status: z.string(),
  successful_runs: optionalIntegerSchema,
  start_date: z.string(),
  end_date: z.string(),
  completed_date: optionalStringSchema,
});
const esiMarketOrderSchema = z.looseObject({
  order_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  location_id: z.number().int().positive(),
  issued: z.string(),
  volume_remain: z.number().int().nonnegative(),
  volume_total: z.number().int().nonnegative(),
  is_buy_order: z.boolean().optional(),
  is_corporation: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined),
  issued_by: optionalPositiveIntegerSchema,
});
const esiCorporationStructureSchema = z.looseObject({
  structure_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  corporation_id: z.number().int().positive(),
  system_id: z.number().int().positive(),
  profile_id: z.number().int().positive(),
  name: optionalStringSchema,
  state: z.string(),
  fuel_expires: optionalStringSchema,
  state_timer_start: optionalStringSchema,
  state_timer_end: optionalStringSchema,
  unanchors_at: optionalStringSchema,
  reinforce_hour: optionalIntegerSchema,
  services: z
    .array(
      z.looseObject({
        name: z.string(),
        state: z.enum(["online", "offline", "cleanup"]),
      }),
    )
    .nullish()
    .transform((value) => value ?? undefined),
});
const esiCorporationPublicInfoSchema = z.looseObject({
  corporation_id: z.number().int().positive(),
  alliance_id: optionalPositiveIntegerSchema,
  ceo_id: optionalPositiveIntegerSchema,
  date_founded: optionalStringSchema,
  description: optionalStringSchema,
  home_station_id: optionalPositiveIntegerSchema,
  member_count: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .transform((value) => value ?? undefined),
  name: z.string(),
  ticker: z.string(),
  url: optionalStringSchema,
});
const esiCorporationDivisionSchema = z.looseObject({
  division: z.number().int().positive(),
  name: optionalStringSchema,
});
const esiCharacterSkillSchema = z.looseObject({
  skill_id: z.number().int().positive(),
  active_skill_level: z.number().int().min(0).max(5),
});
const esiCharacterClonesSchema = z.looseObject({
  jump_clones: z
    .array(
      z.looseObject({
        jump_clone_id: optionalPositiveIntegerSchema,
        implants: z
          .array(z.number().int().positive())
          .nullish()
          .transform((value) => value ?? undefined),
      }),
    )
    .nullish()
    .transform((value) => value ?? undefined),
});
const esiNumberArraySchema = z.array(z.number().int().positive());
const esiAssetLocationSchema = z.looseObject({
  item_id: z.number().int().positive(),
  position: z.looseObject({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
});
const esiCharacterPublicInfoSchema = z.looseObject({
  alliance_id: optionalPositiveIntegerSchema,
  ancestry_id: optionalPositiveIntegerSchema,
  bloodline_id: optionalPositiveIntegerSchema,
  birthday: z.string(),
  character_id: optionalPositiveIntegerSchema,
  corporation_id: z.number().int().positive(),
  description: z.string(),
  faction_id: optionalPositiveIntegerSchema,
  gender: z.string(),
  name: z.string(),
  race_id: z.number().int().positive(),
  security_status: z.number(),
  title: optionalStringSchema,
});
const esiUniverseNameSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  category: z.string(),
});
const esiCharacterRolesResponseSchema = z.looseObject({
  roles: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? undefined),
  roles_at_base: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? undefined),
  roles_at_hq: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? undefined),
  roles_at_other: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? undefined),
});
const locationMetadataSchema = z.looseObject({
  name: z.string(),
  type_id: optionalPositiveIntegerSchema,
  system_id: optionalPositiveIntegerSchema,
  solar_system_id: optionalPositiveIntegerSchema,
  constellation_id: optionalPositiveIntegerSchema,
  region_id: optionalPositiveIntegerSchema,
  services: z
    .array(
      z.union([
        z.string(),
        z.looseObject({
          name: z.string(),
          state: z.enum(["online", "offline", "cleanup"]),
        }),
      ]),
    )
    .nullish()
    .transform((value) => value ?? undefined),
});
const esiIndustrySystemsSchema = z.array(
  z.looseObject({
    solar_system_id: z.number().int().positive(),
    cost_indices: z
      .array(
        z.looseObject({
          activity: z.string(),
          cost_index: z.number(),
        }),
      )
      .nullish()
      .transform((value) => value ?? undefined),
  }),
);
const esiCharacterSkillsResponseSchema = z.looseObject({
  skills: z
    .array(esiCharacterSkillSchema)
    .nullish()
    .transform((value) => value ?? undefined),
});
const esiCorporationDivisionsResponseSchema = z.looseObject({
  hangar: z
    .array(esiCorporationDivisionSchema)
    .nullish()
    .transform((value) => value ?? undefined),
  wallet: z
    .array(
      z.looseObject({
        division: z.number().int().positive(),
        name: z.string().optional(),
      }),
    )
    .nullish()
    .transform((value) => value ?? undefined),
});

type LocationMetadataResponse = {
  data: LocationMetadata | null;
  headers: Headers;
  status: number;
  fromCache: boolean;
};

async function getUsableToken(record: Pick<CharacterTokenRecord, "characterId" | "personalAuth">) {
  const tokenSet = record.personalAuth;
  tokenContexts.set(tokenSet, { characterId: record.characterId });
  if (Date.parse(tokenSet.accessTokenExpiresAt) > Date.now() + 5 * 60 * 1000) return tokenSet;
  const lockKey = `${record.characterId}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;
  const refresh = Promise.resolve()
    .then(async () => {
      const current = await getCharacter(record.characterId);
      const currentTokenSet = current?.personalAuth ?? tokenSet;
      if (Date.parse(currentTokenSet.accessTokenExpiresAt) > Date.now() + 5 * 60 * 1000) {
        tokenContexts.set(currentTokenSet, { characterId: record.characterId });
        return currentTokenSet;
      }
      const updated = await refreshTokenSet(currentTokenSet);
      const stored = await saveCharacterTokens(
        record.characterId,
        currentTokenSet.accessToken,
        updated,
      );
      tokenContexts.set(stored, { characterId: record.characterId });
      return stored;
    })
    .finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, refresh);
  return refresh;
}

async function refreshTokenAfterAuthorizationFailure(characterId: number, tokenSet: TokenSet) {
  const lockKey = `${characterId}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;
  const refresh = Promise.resolve()
    .then(async () => {
      const current = await getCharacter(characterId);
      const currentTokenSet = current?.personalAuth;
      if (!currentTokenSet) throw new Error("Character token is missing.");
      if (currentTokenSet.accessToken !== tokenSet.accessToken) return currentTokenSet;
      const updated = await refreshTokenSet(currentTokenSet);
      const stored = await saveCharacterTokens(characterId, currentTokenSet.accessToken, updated);
      tokenContexts.set(stored, { characterId });
      return stored;
    })
    .finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, refresh);
  return refresh;
}

async function requestEsi<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet?: TokenSet,
  init?: RequestInit,
  options: { skipCacheWrite?: boolean; retryAuthorization?: boolean } = {},
): Promise<{
  data: z.output<Schema> | null;
  headers: Headers;
  status: number;
  fromCache: boolean;
}> {
  const startedAt = Date.now();
  try {
    const result = await requestEsiAttempt(path, responseSchema, tokenSet, init, options);
    logEsiRequest({
      requestedAt: new Date(startedAt).toISOString(),
      method: init?.method ?? "GET",
      path,
      ...(tokenSet && tokenContexts.get(tokenSet)?.characterId !== undefined
        ? { characterId: tokenContexts.get(tokenSet)?.characterId }
        : {}),
      status: result.status,
      outcome: "success",
      durationMs: Date.now() - startedAt,
      ...getEsiRateLimitHeaders(result.headers),
    });
    return result;
  }
  catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    const accessDenied = status === 403 && path.startsWith("/universe/structures/");
    const esiHeaders =
      typeof (error as { esiRateLimitHeaders?: unknown }).esiRateLimitHeaders === "object"
        ? (error as { esiRateLimitHeaders: EsiRateLimitHeaders }).esiRateLimitHeaders
        : {};
    logEsiRequest({
      requestedAt: new Date(startedAt).toISOString(),
      method: init?.method ?? "GET",
      path,
      ...(tokenSet && tokenContexts.get(tokenSet)?.characterId !== undefined
        ? { characterId: tokenContexts.get(tokenSet)?.characterId }
        : {}),
      status,
      outcome: accessDenied ? "access_denied" : "error",
      durationMs: Date.now() - startedAt,
      ...esiHeaders,
      error: accessDenied
        ? "The character does not have permission to inspect this structure."
        : error instanceof Error
          ? error.message.slice(0, 240)
          : "ESI request failed",
    });
    throw error;
  }
}

async function requestEsiAttempt<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet?: TokenSet,
  init?: RequestInit,
  options: { skipCacheWrite?: boolean; retryAuthorization?: boolean } = {},
): Promise<{
  data: z.output<Schema> | null;
  headers: Headers;
  status: number;
  fromCache: boolean;
}> {
  if (esiRateLimitedUntil > Date.now()) {
    const error = new Error(
      `ESI requests paused until ${new Date(esiRateLimitedUntil).toISOString()}`,
    );
    (error as Error & { status?: number; retryAfter?: string }).status = 429;
    (error as Error & { status?: number; retryAfter?: string }).retryAfter = String(
      Math.ceil((esiRateLimitedUntil - Date.now()) / 1000),
    );
    throw error;
  }
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (tokenSet) headers.set("authorization", `Bearer ${tokenSet.accessToken}`);
  // store last used date
  if (tokenSet) tokenSet.lastUsedAt = Date.now();
  const response = await fetch(`${esiBaseUrl}${path}`, { ...init, headers, cache: "no-store" });
  if (response.status === 304) {
    return { data: null, headers: response.headers, status: response.status, fromCache: false };
  }
  if (!response.ok) {
    if (response.status === 401 && tokenSet && options.retryAuthorization !== false) {
      const context = tokenContexts.get(tokenSet);
      const current = context ? await getCharacter(context.characterId) : null;
      const currentTokenSet = context ? current?.personalAuth : undefined;
      const tokenChanged =
        currentTokenSet
        && (
          currentTokenSet.accessToken !== tokenSet.accessToken
          || currentTokenSet.accessTokenExpiresAt !== tokenSet.accessTokenExpiresAt
        );
      if (tokenChanged && context) {
        tokenContexts.set(currentTokenSet, context);
        return requestEsiAttempt(
          path,
          responseSchema,
          currentTokenSet,
          init,
          {
            retryAuthorization: false,
          },
        );
      }
      if (context) {
        try {
          const refreshedTokenSet = await refreshTokenAfterAuthorizationFailure(
            context.characterId,
            tokenSet,
          );
          return await requestEsiAttempt(
            path,
            responseSchema,
            refreshedTokenSet,
            init,
            {
              retryAuthorization: false,
            },
          );
        }
        catch {
          // Preserve the original authorization error when refresh is rejected.
        }
      }
    }
    const details = response.status === 401 ? await response.text() : "";
    const retryAfter = response.headers.get("retry-after");
    const errorLimitReset = response.headers.get("x-esi-error-limit-reset");
    if (response.status === 429 || response.status === 420) {
      const retryAfterMs = parseRetryAfterMs(
        response.status === 420 ? errorLimitReset : retryAfter,
      );
      esiRateLimitedUntil = Math.max(esiRateLimitedUntil, Date.now() + retryAfterMs);
    }
    let message = `ESI request failed (${response.status})`;
    if (response.status === 401) {
      try {
        const body = JSON.parse(details) as { error?: unknown };
        if (typeof body.error === "string") {
          message = `ESI authorization failed (401): ${body.error}`;
        }
      }
      catch {
        // Keep the generic status when ESI does not return JSON.
      }
    }
    const error = new Error(message);
    (error as Error & { esiRateLimitHeaders?: EsiRateLimitHeaders }).esiRateLimitHeaders =
      getEsiRateLimitHeaders(response.headers);
    (error as Error & { status?: number; retryAfter?: string }).status = response.status;
    (error as Error & { status?: number; retryAfter?: string }).retryAfter =
      retryAfter ?? (response.status === 420 ? errorLimitReset : undefined) ?? undefined;
    throw error;
  }
  const data = responseSchema.parse(await response.json());
  const remainingHeader = response.headers.get("x-esi-error-limit-remain");
  const resetHeader = response.headers.get("x-esi-error-limit-reset");
  const remaining = Number(remainingHeader);
  const resetSeconds = Number(resetHeader);
  if (remainingHeader && resetHeader && remaining <= 0 && Number.isFinite(resetSeconds)) {
    esiRateLimitedUntil = Math.max(
      esiRateLimitedUntil,
      Date.now() + Math.max(1, resetSeconds) * 1_000,
    );
  }
  return { data, headers: response.headers, status: response.status, fromCache: false };
}

export async function requestCachedEsi<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet?: TokenSet,
  init?: RequestInit,
  options: {
    skipCacheWrite?: boolean;
    retryAuthorization?: boolean;
    cacheKey?: string;
  } = {},
): Promise<{
  data: z.output<Schema> | null;
  headers: Headers;
  status: number;
  fromCache: boolean;
}> {
  const body = typeof init?.body === "string" ? init.body : "";
  const requestCachePath = body
    ? `${path}&body_hash=${createHash("sha256").update(body).digest("hex")}`
    : path;
  const cachePath = options.cacheKey ?? requestCachePath;
  const cached = await getCachedEsiResponse<unknown>(cachePath);
  if (cached) {
    const cachedHeaders = new Headers(cached.headers);
    cachedHeaders.delete("etag");
    return {
      data: cached.data === null ? null : responseSchema.parse(cached.data),
      headers: cachedHeaders,
      status: cached.status,
      fromCache: true,
    };
  }
  const result = await requestEsi(path, responseSchema, tokenSet, init, options);
  if (!options.skipCacheWrite && result.status !== 304) {
    const sharedHeaders = Object.fromEntries(
      [...result.headers.entries()].filter(([name]) => name.toLowerCase() !== "etag"),
    );
    await setCachedEsiResponse(
      cachePath,
      {
        data: result.data,
        headers: sharedHeaders,
        status: result.status,
      },
      result.headers.get("expires"),
      result.headers.get("cache-control"),
    );
  }
  return result;
}

export function getEsiRateLimitUntil() {
  return esiRateLimitedUntil > Date.now() ? new Date(esiRateLimitedUntil).toISOString() : null;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(1_000, timestamp - Date.now()) : 60_000;
}

export async function requestEsiConditional<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet: TokenSet,
  etag?: string,
) {
  const headers = etag ? { "if-none-match": etag } : undefined;
  return requestEsi(path, responseSchema, tokenSet, { headers });
}

type EsiEndpointResult<T> = {
  data: T | null;
  headers: Headers;
  notModified: boolean;
  fromCache: boolean;
};

export async function fetchEsiEndpoint<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet: TokenSet,
  etag: string | undefined,
  options: { paginated: true },
): Promise<EsiEndpointResult<z.output<Schema>[]>>;
export async function fetchEsiEndpoint<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet: TokenSet,
  etag: string | undefined,
  options?: { paginated?: false },
): Promise<EsiEndpointResult<z.output<Schema>>>;
export async function fetchEsiEndpoint<Schema extends z.ZodType>(
  path: string,
  responseSchema: Schema,
  tokenSet: TokenSet,
  etag: string | undefined,
  options: { paginated?: boolean } = {},
): Promise<EsiEndpointResult<z.output<Schema> | z.output<Schema>[]>> {
  const requestPath = options.paginated ? `${path}?page=1` : path;
  if (options.paginated) {
    const first = await requestEsiConditional(requestPath, z.array(responseSchema), tokenSet, etag);
    if (first.status === 304) {
      return { data: null, headers: first.headers, notModified: true, fromCache: false };
    }
    const pageCount = Number(first.headers.get("x-pages") ?? "1");
    if (pageCount <= 1) {
      return {
        data: first.data ?? [],
        headers: first.headers,
        notModified: false,
        fromCache: false,
      };
    }
    const rest: z.output<Schema>[][] = [];
    for (let page = 2; page <= pageCount; page += 1) {
      const result = await requestEsi(`${path}?page=${page}`, z.array(responseSchema), tokenSet);
      rest.push(result.data ?? []);
    }
    return {
      data: [first.data ?? [], ...rest].flat(),
      headers: first.headers,
      notModified: false,
      fromCache: false,
    };
  }
  const first = await requestEsiConditional(requestPath, responseSchema, tokenSet, etag);
  return {
    data: first.data,
    headers: first.headers,
    notModified: first.status === 304,
    fromCache: false,
  };
}

function mapAsset(
  asset: EsiAsset,
  ownerType: "character" | "corporation",
  ownerId: number,
): AssetRecord {
  return {
    itemId: asset.item_id,
    typeId: asset.type_id,
    quantity: asset.quantity,
    locationId: asset.location_id,
    locationType:
      asset.location_type === "station"
      || asset.location_type === "solar_system"
      || asset.location_type === "item"
      || asset.location_type === "structure"
        ? asset.location_type
        : "other",
    locationFlag: asset.location_flag,
    isSingleton: asset.is_singleton,
    ownerType,
    ownerId,
  };
}

/** Throws a reconnectable error before calling an endpoint whose scope is absent. */
function requireCharacterScope(record: CharacterTokenRecord, scope: string) {
  if (record.personalAuth.scopes.includes(scope)) return;
  const error = new Error(`Missing required ESI scope: ${scope}`);
  (error as Error & { reauthorizeRequired?: boolean }).reauthorizeRequired = true;
  throw error;
}

function mapBlueprintInstance(
  blueprint: EsiBlueprint,
  ownerType: BlueprintInstanceRecord["ownerType"],
  ownerId: number,
  discoveredByCharacterId: number,
): BlueprintInstanceRecord {
  return {
    itemId: blueprint.item_id,
    typeId: blueprint.type_id,
    locationId: blueprint.location_id,
    locationFlag: blueprint.location_flag,
    discoveredByCharacterId,
    quantity: blueprint.quantity,
    runs: blueprint.runs,
    me: blueprint.material_efficiency,
    te: blueprint.time_efficiency,
    ownerType,
    ownerId,
  };
}

export async function fetchCharacterBlueprints(record: CharacterTokenRecord, etag?: string) {
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/characters/${record.characterId}/blueprints/`,
    esiBlueprintSchema,
    token,
    etag,
    { paginated: true },
  );
  return {
    blueprints:
      result.data?.map((blueprint) =>
        mapBlueprintInstance(blueprint, "character", record.characterId, record.characterId),
      ) ?? null,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationBlueprints(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/corporations/${record.corporationId}/blueprints/`,
    esiBlueprintSchema,
    token,
    etag,
    { paginated: true },
  );
  const corporationId = record.corporationId;
  return {
    blueprints:
      result.data?.map((blueprint) =>
        mapBlueprintInstance(blueprint, "corporation", corporationId, record.characterId),
      ) ?? null,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchAssetNames(path: string, token: TokenSet, itemIds: number[]) {
  const names = new Map<number, string>();
  for (let index = 0; index < itemIds.length; index += 1000) {
    const result = await requestCachedEsi(
      path,
      z.array(esiAssetNameSchema),
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(itemIds.slice(index, index + 1000)),
      },
    );
    for (const asset of result.data ?? []) names.set(asset.item_id, asset.name);
  }
  return names;
}

export async function fetchCharacterAssets(record: CharacterTokenRecord, etag?: string) {
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/characters/${record.characterId}/assets/`,
    esiAssetSchema,
    token,
    etag,
    { paginated: true },
  );
  return {
    assets: result.data?.map((asset) => mapAsset(asset, "character", record.characterId)) ?? null,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationAssets(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/corporations/${record.corporationId}/assets/`,
    esiAssetSchema,
    token,
    etag,
    { paginated: true },
  );
  const corporationId = record.corporationId;
  return {
    assets: result.data?.map((asset) => mapAsset(asset, "corporation", corporationId)) ?? null,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

/**
 * Fetches the character's current solar system and optional docked location.
 * https://developers.eveonline.com/api-explorer#/operations/GetCharactersCharacterIdLocation
 */
export async function fetchCharacterLocation(record: CharacterTokenRecord, etag?: string) {
  requireCharacterScope(record, "esi-location.read_location.v1");
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/characters/${record.characterId}/location/`,
    esiCharacterLocationSchema,
    token,
    etag,
    { paginated: false },
  );
  const location: CharacterLocationRecord | null = result.data
    ? {
        solarSystemId: result.data.solar_system_id,
        ...(result.data.station_id !== undefined ? { stationId: result.data.station_id } : {}),
        ...(result.data.structure_id !== undefined
          ? { structureId: result.data.structure_id }
          : {}),
      }
    : null;
  return {
    location,
    headers: result.headers,
    notModified: result.notModified,
  };
}

/**
 * Fetches the ship currently piloted by the character.
 * https://developers.eveonline.com/api-explorer#/operations/GetCharactersCharacterIdShip
 */
export async function fetchCharacterShip(record: CharacterTokenRecord, etag?: string) {
  requireCharacterScope(record, "esi-location.read_ship_type.v1");
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/characters/${record.characterId}/ship/`,
    esiCharacterShipSchema,
    token,
    etag,
    { paginated: false },
  );
  const ship: CharacterShipRecord | null = result.data
    ? {
        characterId: record.characterId,
        itemId: result.data.ship_item_id,
        name: result.data.ship_name,
        typeId: result.data.ship_type_id,
      }
    : null;
  return {
    ship,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCharacterClones(record: CharacterTokenRecord) {
  requireCharacterScope(record, "esi-clones.read_clones.v1");
  const token = await getUsableToken(record);
  return requestCachedEsi(
    `/characters/${record.characterId}/clones/`,
    esiCharacterClonesSchema,
    token,
  );
}

/** Fetches implant type IDs installed in the character's active clone. */
export async function fetchCharacterImplants(record: CharacterTokenRecord) {
  requireCharacterScope(record, "esi-clones.read_implants.v1");
  const token = await getUsableToken(record);
  return requestCachedEsi(
    `/characters/${record.characterId}/implants/`,
    esiNumberArraySchema,
    token,
  );
}

function mapIndustryJob(
  job: EsiIndustryJob,
  ownerType: IndustryJobRecord["ownerType"],
  ownerId: number,
  discoveredByCharacterId: number,
): IndustryJobRecord {
  const installedRuns = job.successful_runs ?? Math.floor(job.runs * (job.probability ?? 1));
  return {
    jobId: job.job_id,
    installerId: job.installer_id,
    facilityId: job.facility_id,
    locationId: job.location_id ?? job.station_id ?? job.facility_id,
    outputLocationId: job.output_location_id,
    activityId: job.activity_id,
    blueprintId: job.blueprint_id,
    blueprintTypeId: job.blueprint_type_id,
    blueprintLocationId: job.blueprint_location_id,
    runs: job.runs,
    installedRuns,
    ...(job.probability !== undefined ? { probability: job.probability } : {}),
    ...(job.licensed_runs !== undefined ? { licensedRuns: job.licensed_runs } : {}),
    ...(job.product_type_id !== undefined ? { productTypeId: job.product_type_id } : {}),
    status: job.status,
    ...(job.successful_runs !== undefined ? { successfulRuns: job.successful_runs } : {}),
    startDate: job.start_date,
    endDate: job.end_date,
    discoveredByCharacterId,
    ...(job.completed_date !== undefined ? { completedDate: job.completed_date } : {}),
    ownerType,
    ownerId,
  };
}

function retainIndustryJobSinceAssetsModified(
  job: EsiIndustryJob,
  assetsLastModified: string | undefined,
) {
  if (!assetsLastModified) return true;
  if (!job.completed_date) return job.status !== "delivered";
  const completedAt = Date.parse(job.completed_date);
  const assetsModifiedAt = Date.parse(assetsLastModified);
  return (
    !Number.isFinite(completedAt)
    || !Number.isFinite(assetsModifiedAt)
    || completedAt >= assetsModifiedAt
  );
}

function mapIndustryJobs(
  jobs: EsiIndustryJob[],
  ownerType: IndustryJobRecord["ownerType"],
  ownerId: number,
  discoveredByCharacterId: number,
  assetsLastModified: string | undefined,
) {
  return jobs
    .filter((job) => job.status !== "cancelled" && job.status !== "reverted")
    .filter((job) => retainIndustryJobSinceAssetsModified(job, assetsLastModified))
    .map((job) => mapIndustryJob(job, ownerType, ownerId, discoveredByCharacterId));
}

export async function fetchCharacterIndustryJobs(
  record: CharacterTokenRecord,
  etag?: string,
  assetsLastModified?: string,
) {
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    // Completed jobs are required to reconcile assets and blueprints after installation.
    `/characters/${record.characterId}/industry/jobs/?include_completed=true`,
    z.array(esiIndustryJobSchema),
    token,
    etag,
    { paginated: false },
  );
  return {
    jobs:
      result.data === null
        ? null
        : mapIndustryJobs(
            result.data,
            "character",
            record.characterId,
            record.characterId,
            assetsLastModified,
          ),
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCharacterSkills(record: CharacterTokenRecord, etag?: string) {
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/characters/${record.characterId}/skills/`,
    esiCharacterSkillsResponseSchema,
    token,
    etag,
    { paginated: false },
  );
  return {
    skills:
      result.data?.skills?.map(
        (skill): CharacterSkillRecord => ({
          skillId: skill.skill_id,
          activeSkillLevel: skill.active_skill_level,
        }),
      ) ?? null,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationIndustryJobs(
  record: CharacterTokenRecord,
  etag?: string,
  assetsLastModified?: string,
) {
  if (!record.corporationId || !record.hasDirectorRole) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    // Completed jobs are required to reconcile assets and blueprints after installation.
    `/corporations/${record.corporationId}/industry/jobs/?include_completed=true`,
    z.array(esiIndustryJobSchema),
    token,
    etag,
    { paginated: false },
  );
  const corporationId = record.corporationId;
  return {
    jobs:
      result.data === null
        ? null
        : mapIndustryJobs(
            result.data,
            "corporation",
            corporationId,
            record.characterId,
            assetsLastModified,
          ),
    headers: result.headers,
    notModified: result.notModified,
  };
}

function mapMarketOrder(
  order: EsiMarketOrder,
  ownerType: MarketOrderRecord["ownerType"],
  ownerId: number,
  discoveredByCharacterId: number,
): MarketOrderRecord {
  return {
    orderId: order.order_id,
    typeId: order.type_id,
    locationId: order.location_id,
    discoveredByCharacterId,
    issuedAt: order.issued,
    volumeRemain: order.volume_remain,
    volumeTotal: order.volume_total,
    ...(order.is_buy_order === undefined ? {} : { isBuyOrder: order.is_buy_order }),
    ...(order.is_corporation !== undefined ? { isCorporation: order.is_corporation } : {}),
    ...(order.issued_by !== undefined ? { issuedBy: order.issued_by } : {}),
    ownerType,
    ownerId,
  };
}

export async function fetchCharacterMarketOrders(record: CharacterTokenRecord, etag?: string) {
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/characters/${record.characterId}/orders`,
    esiMarketOrderSchema,
    token,
    etag,
    { paginated: true },
  );
  return {
    orders:
      result.data?.map((order) =>
        mapMarketOrder(order, "character", record.characterId, record.characterId),
      ) ?? null,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchCorporationMarketOrders(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/corporations/${record.corporationId}/orders`,
    esiMarketOrderSchema,
    token,
    etag,
    { paginated: true },
  );
  const corporationId = record.corporationId;
  return {
    orders:
      result.data?.map((order) =>
        mapMarketOrder(order, "corporation", corporationId, record.characterId),
      ) ?? null,
    token,
    headers: result.headers,
    notModified: result.notModified,
  };
}

type CorporationStructureResult = {
  structures: EsiCorporationStructure[];
  headers: Headers;
  notModified: boolean;
};

export async function fetchCorporationStructures(
  record: CharacterTokenRecord,
  etag?: string,
): Promise<CorporationStructureResult> {
  if (!record.corporationId || (!record.hasStationManagerRole && !record.hasDirectorRole)) {
    throw new Error("Corporation structure authorization is incomplete");
  }
  const corporationId = record.corporationId;
  const existingRequest = corporationStructureRequests.get(corporationId);
  if (existingRequest) return existingRequest;
  const request = Promise.resolve()
    .then(async () => {
      const path = `/corporations/${corporationId}/structures/`;
      const token = await getUsableToken(record);
      const result = await fetchEsiEndpoint(
        path,
        z.array(esiCorporationStructureSchema),
        token,
        etag,
        { paginated: false },
      );
      return {
        structures: result.data ?? [],
        headers: result.headers,
        notModified: result.notModified,
      };
    })
    .finally(() => corporationStructureRequests.delete(corporationId));
  corporationStructureRequests.set(corporationId, request);
  return request;
}

/** Fetches public corporation identity and headquarters data through an eligible Director. */
export async function fetchCorporationPublicInfo(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole) {
    throw new Error("Corporation authorization is incomplete");
  }
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/corporations/${record.corporationId}/`,
    esiCorporationPublicInfoSchema,
    token,
    etag,
    { paginated: false },
  );
  return {
    corporation: result.data,
    headers: result.headers,
    notModified: result.notModified,
  };
}

/** Fetches corporation division names used to label corporation hangar sources. */
export async function fetchCorporationDivisions(record: CharacterTokenRecord, etag?: string) {
  if (!record.corporationId || !record.hasDirectorRole) {
    throw new Error("Corporation authorization is incomplete");
  }
  requireCharacterScope(record, "esi-corporations.read_divisions.v1");
  const token = await getUsableToken(record);
  const result = await fetchEsiEndpoint(
    `/corporations/${record.corporationId}/divisions/`,
    esiCorporationDivisionsResponseSchema,
    token,
    etag,
    { paginated: false },
  );
  return {
    divisions: result.data?.hangar ?? null,
    headers: result.headers,
    notModified: result.notModified,
  };
}

export async function fetchAssetLocations(
  owner: AssetRecord["ownerType"],
  ownerId: number,
  itemIds: number[],
  token: TokenSet,
) {
  if (itemIds.length === 0) return [];
  const path =
    owner === "character"
      ? `/characters/${ownerId}/assets/locations/`
      : `/corporations/${ownerId}/assets/locations/`;
  const batchSize = 1000;
  const uniqueItemIds = [...new Set(itemIds)];
  const batches = Array.from(
    { length: Math.ceil(uniqueItemIds.length / batchSize) },
    (_, index) => uniqueItemIds.slice(index * batchSize, (index + 1) * batchSize),
  );
  const locations: EsiAssetLocation[] = [];
  for (const batch of batches) {
    try {
      const result = await requestCachedEsi(
        path,
        z.array(esiAssetLocationSchema),
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        },
      );
      if (result.data) locations.push(...result.data);
    }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 420 && status !== 429) throw error;
    }
  }
  return locations;
}

export async function fetchCharacterPublicInfo(characterId: number) {
  const result = await requestCachedEsi(
    `/characters/${characterId}/`,
    esiCharacterPublicInfoSchema,
  );
  if (!result.data) {
    throw new Error("Missing character verification response");
  }
  return result.data;
}

export async function fetchCharacterCorporationId(characterId: number) {
  const characterInfo = await fetchCharacterPublicInfo(characterId);
  return characterInfo.corporation_id;
}

export async function fetchUniverseNames(ids: number[]) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map<number, string>();
  const names = await Promise.all(
    Array.from(
      { length: Math.ceil(uniqueIds.length / 1_000) },
      (_, index) =>
        requestCachedEsi(
          "/universe/names/",
          z.array(esiUniverseNameSchema),
          undefined,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(uniqueIds.slice(index * 1_000, (index + 1) * 1_000)),
          },
        ),
    ),
  );
  return new Map(
    names.flatMap((result) => (result.data ?? []).map((entry) => [entry.id, entry.name])),
  );
}

export async function fetchCharacterRoles(characterId: number, token: TokenSet) {
  const result = await requestCachedEsi(
    `/characters/${characterId}/roles/`,
    esiCharacterRolesResponseSchema,
    token,
  );
  if (!result.data) throw new Error("Missing roles verification response");
  return {
    roles: result.data.roles ?? [],
    rolesAtBase: result.data.roles_at_base ?? [],
    rolesAtHq: result.data.roles_at_hq ?? [],
    rolesAtOther: result.data.roles_at_other ?? [],
  };
}

/** Fetches the corporation member list with a cache entry scoped to this character's token. */
export async function fetchCorporationMembers(
  characterId: number,
  corporationId: number,
  token: TokenSet,
) {
  const membershipScope = "esi-corporations.read_corporation_membership.v1";
  if (!token.scopes.includes(membershipScope)) {
    const error = new Error(`Missing required ESI scope: ${membershipScope}`);
    (error as Error & { reauthorizeRequired?: boolean }).reauthorizeRequired = true;
    throw error;
  }
  const usableToken = await getUsableToken({
    characterId,
    personalAuth: token,
  });
  const result = await requestCachedEsi(
    `/corporations/${corporationId}/members/`,
    esiNumberArraySchema,
    usableToken,
    undefined,
    { cacheKey: `/corporations/${corporationId}/members/?character_id=${characterId}` },
  );
  if (!Array.isArray(result.data) || !result.data.every((memberId) => Number.isInteger(memberId))) {
    throw new Error("Missing corporation membership response");
  }
  return { members: result.data, token: usableToken };
}

export type CharacterCorporationAuthorization = {
  authorized: boolean;
  characterInfo: EsiCharacterPublicInfo;
  corporationId: number;
  roles: EsiCharacterRoles | null;
  token: TokenSet;
};

/** Revalidates current corporation membership before allowing corporation data access. */
export async function fetchCharacterCorporationAuthorization(
  characterId: number,
  token: TokenSet,
  expectedCorporationId?: number,
): Promise<CharacterCorporationAuthorization> {
  const characterInfo = await fetchCharacterPublicInfo(characterId);
  const corporationId = characterInfo.corporation_id;
  if (!token.scopes.includes("esi-corporations.read_corporation_membership.v1")) {
    return { authorized: false, characterInfo, corporationId, roles: null, token };
  }

  let membership: Awaited<ReturnType<typeof fetchCorporationMembers>>;
  try {
    membership = await fetchCorporationMembers(characterId, corporationId, token);
  }
  catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { authorized: false, characterInfo, corporationId, roles: null, token };
    }
    throw error;
  }
  if (
    !membership.members.includes(characterId)
    || (expectedCorporationId !== undefined && expectedCorporationId !== corporationId)
    || !token.scopes.includes("esi-characters.read_corporation_roles.v1")
  ) {
    return {
      authorized: false,
      characterInfo,
      corporationId,
      roles: null,
      token: membership.token,
    };
  }
  const roles = await fetchCharacterRoles(characterId, membership.token);
  return {
    authorized: true,
    characterInfo,
    corporationId,
    roles,
    token: membership.token,
  };
}

function fetchPublicLocationMetadata(path: string, token?: TokenSet) {
  return requestCachedEsi(path, locationMetadataSchema, token);
}

export function fetchStationMetadata(stationId: number, token?: TokenSet) {
  return fetchPublicLocationMetadata(`/universe/stations/${stationId}/`, token);
}

export function fetchSolarSystemMetadata(solarSystemId: number, token?: TokenSet) {
  return fetchPublicLocationMetadata(`/universe/systems/${solarSystemId}/`, token);
}

export function fetchIndustrySystems() {
  return requestCachedEsi("/industry/systems/", esiIndustrySystemsSchema);
}

/**
 * Fetches structure metadata for a specific character.
 * Response or 403 errors are cached for 1 hour to reduce ESI load.
 * https://developers.eveonline.com/api-explorer#/operations/GetUniverseStructuresStructureId
 *
 * @param structureId The ID of the structure.
 * @param token A token already associated with the character that reported the structure ID.
 * @returns The structure metadata response.
 */
export async function fetchStructureMetadataPerCharacter(structureId: number, token: TokenSet) {
  if (structureId < minimumStructureId) {
    return {
      data: null,
      headers: new Headers(),
      status: 400,
      fromCache: false,
    } satisfies LocationMetadataResponse;
  }
  const characterId = tokenContexts.get(token)?.characterId;
  if (characterId === undefined) {
    throw new Error("Structure metadata requires a character-associated token.");
  }
  const cacheKey = `${characterId}:${structureId}`;
  const cached = structureMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.response, fromCache: true };
  try {
    const response = await requestEsi(
      `/universe/structures/${structureId}/`,
      locationMetadataSchema,
      token,
    );
    if (response.data) {
      structureMetadataCache.set(
        cacheKey,
        {
          expiresAt: Date.now() + structureMetadataCacheTtlMs,
          response,
        },
      );
    }
    return response;
  }
  catch (error) {
    if ((error as { status?: number }).status !== 403) throw error;
    const response: LocationMetadataResponse = {
      data: null,
      headers: new Headers(),
      status: 403,
      fromCache: false,
    };
    structureMetadataCache.set(
      cacheKey,
      {
        expiresAt: Date.now() + structureMetadataCacheTtlMs,
        response,
      },
    );
    return response;
  }
}

export { getUsableToken };
