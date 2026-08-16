# 1. Project overview

Build a single-container web application as a 3rd party support tool for completing large manufacturing projects in the MMO Eve Online. The app should:

- Authenticates users via **EVE SSO**, supports multiple characters per app session.
- Performs **server-side** ESI calls and SDE-based planning.
- Uses the official **EVE SDE** as a build/runtime input, prepared into generated table data and exposed through the SDE/cache services.
- Uses **Firebase Admin Firestore** for durable server-side application data:
  - EVE character token records.
  - Accounts, character collections, and sessions.
  - Pending SSO state and other small application records.
- Uses a cache abstraction for SDE and ESI data. SDE entries are namespaced by SDE build; the default provider is in-memory.  An Upstash Redis provider was developed for shared deployements but was found not to be performant.
- Provides a **React/Next.js production-control UI** where users:
  - Attach multiple characters (including corp director characters).
  - Define a “build list” of items (typeId + quantity).
  - Choose locations (systems/stations/structures) for manufacturing, reactions, market.
  - Set simple preferences (include corp assets, basic build/buy blacklists).
  - Refresh character and corp state (subject to ESI rate limits).
  - Review stock assets, industry jobs, ship stocks, ship fittings, location settings, and general settings.

- Primary tool is a Planning Engine, which computes a plan that outputs results in lists, including:

    1. Raw materials to buy
    2. BPCs needed
    3. Invention jobs to install
    4. Reaction jobs to install
    5. Manufacturing jobs to install
    6. Hauling tasks needed

Performance constraint: `/plan` must respond in **< 3 seconds** for typical use.

  - Additional tools to support the primary tool and industry actions in general:
    - Additional material Compression calculator with associated settings.
    - Invention success cost calculator and associated settings
    - Asset list appraisal tool
    - Ability to add ship fittings atomically to the build list and have their contents unpacked by the app ahead of being sent to the planning engine. (Ship fitting may need a results list of its own).

## Current implementation decisions

This section is authoritative where the older design below differs from the running application. Future work must extend these flows rather than restoring the earlier model:

- Authentication uses the custom EVE SSO PKCE flow in `src/lib/auth/eveSso.ts` and the `/api/auth/eve/start` and `/api/auth/eve/callback` routes. There is no NextAuth integration and no separate corporation-auth callback. The callback records corporation identity and roles from the authenticated character's token scopes and corporation roles.
- A durable character belongs to a `CharacterCollectionRecord`. A session points to one collection through `collectionId`; it is not itself the account or the authoritative character list. Attaching a character that belongs to another collection enters an explicit merge flow.
- ESI refresh is session-scoped in the in-process cache. It refreshes the selected collection's character data and eligible corporation data, including assets, blueprints, industry jobs, skills, market orders, and structure/location data. The refresh endpoint deduplicates concurrent refreshes and exposes endpoint status without exposing tokens.
- `/api/state/stock` is the boundary between ESI state and planning. It resolves and groups stock by root location, includes blueprint/job/market-order context, filters special ship and structure records as appropriate, and carries personal/corporation ownership into the planner input.
- `/api/plan` is intentionally unauthenticated and makes no ESI calls. It accepts a build list plus client-supplied working stock, locations, and settings. Do not reintroduce `characterIds` ownership checks or server-side refreshes into this endpoint; authenticated state preparation belongs in the state routes.
- The planner is stock-aware and supports compressed/reprocessable material handling, blueprint print/run accounting, industry-in-progress output, market orders, localized SDE names, ME/TE settings, and source metadata. Its request model is not the original minimal `typeId + quantity` plus raw assets model.
- The UI is a multi-page production-control application. The build planner is one workflow alongside stock, jobs, ships, compression, locations, characters, and settings. The original component-only single-page layout is descriptive history, not an implementation requirement.
- The deployment target is Firebase App Hosting with a Cloud Run backend configuration and Firestore. The repository does not currently define a Dockerfile-based deployment contract; do not add container-specific storage assumptions without deciding whether App Hosting remains the target.

The original goals that remain deliberately future-facing include the hauling output/view, richer offline plan recovery, Invention success cost calculator, Asset list appraisal tool, ship fittings builder a and broader automated coverage. Their absence from a current screen or test suite must not be interpreted as permission to remove the corresponding domain requirement.

## Future Direction

- **Stock selection:** Full stock lists will always be fetched from server and cached locally, but in a future version the user will be able to select subsets of held stocks for submission to the planning engine.  Those subsets should be easily configured but may be per-character, corp (or non-corp) only, location restrictions, per-container inclusion and/or exclusion. Refresh will always provide all available stock to the client but the client will provide tools to filter what stock is sent to planning.
- **Corporation "Type":** The nature of the game causes some corporations to be created specifically to house industry activities. In these "solo" corps, one player will retain Director roles on most or all of their characters and they have full access and ownership of all assets.  However, traditional corp structure is that our user will control a collection of characters that do not have Director roles but do have sufficient roles to view, access and control assets in a sub-set of corporation locations.  This project aims to (eventually) solve the problem of planning industry jobs within a Typical Corp setup where access is restricted by role.
- **Hauling workflow:** In a future version, hauling will be derived automatically from resolved stock origins and target facilities, at the time of writing stock is sent to the planning engine without location data.  This contract shape will need to change and the engine will need to be location aware, preferring to draw stock that is already at the activity site and building a hauling plan noting the asset type, quantity, source and destination root locations when the stocks levels globally are sufficient but the stock levels at the activity site are not.
- **Reference APIs:** Are unified blueprint, location, and settings-preset endpoints desired, or should the existing specialized systems/structures/rigs/settings workflows remain the permanent interface?
- **Offline recovery:** Offline recovery of the plan results is not a priority goal, but a potential convenience feature.  The most recent plan response could be cached and reloaded.  However, the plan input is quickly/easily invalidated. So we would need to track that and display warnings when the currently visible plan is outdated.  While executing the plan remains fast, this is a low priority need.
- **Completion Tracking:** The plan creates lists of things to buy and jobs to install, we should devise a simple system for the user to track what tasks have been completed and what remain.  The completion tracker data can be persisted while the stock inputs to the planner remain identical.  If the assets or jobs endpoint refreshes while the user is installing jobs that will create a new plan that *should* include the user's recent actions therefore taking into account some or all of actions taking.  Alternatively, we could track the plan's creation time and the industry job's installation time to determine how to adjust the user's manually entered completed count to keep the user on track.

---

# 2. Technology stack and project structure

## 2.1 Tech choices

- **Runtime**: Node.js (latest LTS).
- **Framework**: Next.js (App Router) with TypeScript.
- **Frontend**: React (within Next.js), TypeScript, basic CSS/Styling.
- **Persistent storage**: Firebase Admin Firestore for accounts, sessions, tokens, pending SSO state, and other durable application records.
- **SDE processing**: custom preparation scripts that download and validate the official JSONL SDE, incorporate validated HoboLeaks packaged-volume data, strip bulky descriptions, produce processed tables, and generate TypeScript table modules consumed by the cache services.[^3][^4]
- **Auth/session**:
  - Custom EVE SSO authorization-code flow with PKCE, JWT validation, token refresh, and Firestore-backed pending-auth records.[^5][^6][^7]
  - App session via HttpOnly cookies and Firestore-backed session/collection records.

## 2.2 Directory layout (suggested)

```text
package.json
next.config.js
tsconfig.json

scripts/
  fetch-sde.ts          # Download and validate the current SDE and supplemental data
  parse-sde.ts          # Convert JSONL tables into processed JSON data
  generate-types.ts      # Generate TypeScript table modules and cache metadata

sde/
  raw/                  # Processed build/runtime inputs (not committed)
  processed/            # Processed tables and SDE metadata (not committed)

src/
  app/
    page.tsx            # Main planner UI
    api/
      auth/eve/start/route.ts       # Custom PKCE SSO start
      auth/eve/callback/route.ts    # Custom single SSO callback
      auth/session/route.ts         # Session/collection summary
      auth/logout/route.ts          # Clear session cookie
      auth/corp/status/route.ts     # Corporation eligibility summary
      characters/route.ts           # Attached characters
      characters/[id]/route.ts      # Remove attached character
      plan/route.ts                 # Stock-driven plan calculation
      state/refresh/route.ts        # Refresh active collection state
      state/status/route.ts         # Cache status
      state/stock/route.ts          # Planner stock projection
      state/jobs/route.ts           # Industry jobs projection
      state/marketOrders/route.ts   # Market-order projection
      state/ships/route.ts          # Ship projection
      reference/types/route.ts      # Type search
      reference/rigs/route.ts       # Rig reference data
      reference/structure-types/route.ts
      reference/structures/route.ts
      reference/systems/route.ts
      compress/route.ts
      compress/options/route.ts
      compress/base-yield/route.ts

  lib/
    storage.ts           # Firestore-backed storage initialization
    auth/
      model.ts           # CharacterTokenRecord, SessionRecord types
      tokensStore.ts     # Get/save characters, collections, sessions, and tokens via Firestore
      session.ts         # Session management helpers (cookie, sessionId)
      eveSso.ts          # Custom SSO utilities (token exchange, JWT validation)
    esi/
      client.ts          # ESI client wrapper (assets, jobs, corp assets)
      cache.ts           # ETag & rate-limit aware caching for ESI responses
    sde/
      generated/**.ts    # generated SDE table modules (not committed)
      loader.ts          # Load sde/processed/*.json into in-memory maps
      indices.ts         # Precomputed lookup tables/graphs for planning
    planning/
      types.ts           # Types for /plan inputs and outputs
      planEngine.ts      # Main planning logic: compute 6 action lists
      util.ts            # Helper functions (e.g., BOM expansion)

  components/
    Layout.tsx
    AuthBanner.tsx
    CharacterManagement.tsx
    BuildListEditor.tsx
    LocationSelectors.tsx
    SettingsPanel.tsx
    RefreshStatusSummary.tsx
    DataStatusPage.tsx
    PlanTabs.tsx         # Planner output navigation, including the future hauling view
```

---

# 3. Build-time SDE processing and cache integration

The current implementation:

- Downloads the current official CCP JSONL SDE and validates every downloaded table.
- Captures HoboLeaks packaged volumes after checking its metadata, freshness, revision, and shape.
- Stores raw and processed build inputs in ignored cache directories.
- Converts JSONL tables to compact processed JSON and generates TypeScript table modules.
- Loads the generated tables through the SDE cache services and namespaces cache keys by SDE build number.
- Uses an in-memory cache by default, with Upstash Redis available for shared deployments.

This replaces the earlier QuickType-based model-generation proposal. Generated table modules and the cache service are the source of truth for runtime SDE access; application code must not assume that a hand-maintained `model.ts` exists.

## 3.1 SDE files and fields of interest

Use EVE’s SDE documentation to locate the following JSONL files:[^4][^8][^3]

- **Types** (items):
  - `types.jsonl`
  - Fields: `type_id`, `name`, `group_id`, `category_id`, `market_group_id`, other basic attributes.
- **Blueprints**:
  - `blueprints.jsonl` (or equivalent).
  - Fields: `blueprint_type_id`, `product_type_id`, `activities` including `manufacturing`, `reaction`, `invention`.
- **Materials (bill of materials)**: - `typeMaterials.jsonl` or per-activity materials files. - Fields: `blueprint_type_id`, `activity`, `material_type_id`, `quantity`.
  -- **Systems and NPC stations**:
  - `solarSystems.jsonl`, `npcStations.jsonl`.[^8][^4]

## 3.2 `scripts/fetch-sde.ts`

The current fetch script obtains the SDE build manifest, downloads and extracts the JSONL inputs, validates the files, and records the build metadata before parsing and table generation.

```ts
const currentVersion = fs.existsSync(versionFile)
    ? JSON.parse(fs.readFileSync(versionFile, 'utf-8')).version
    : null;

  const latestVersion = await getLatestSdeVersion(); // via HTTP or configured

  if (currentVersion !== latestVersion) {
    await downloadAndExtractSde(latestVersion);
    fs.writeFileSync(versionFile, JSON.stringify({ version: latestVersion }));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

## 3.3 `scripts/parse-sde.ts`

Convert JSONL files from `.next/cache/assemblyline-sde/raw/` to processed JSON tables:

- For each `*.jsonl` in `.next/cache/assemblyline-sde/raw/`:
  - Stream line by line, parse JSON, push to array.
  - Save to `sde/processed/*.json`.

Example:

```ts
// scripts/parse-sde.ts
import fs from "fs";
import readline from "readline";
import path from "path";

async function jsonlToJson(inputPath: string, outputPath: string) {
  const fileStream = fs.createReadStream(inputPath);
  const rl = readline.createInterface({ input: fileStream });
  const arr: any[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    arr.push(JSON.parse(line));
  }

  fs.writeFileSync(outputPath, JSON.stringify(arr));
}

async function main() {
  await jsonlToJson("sde/raw/types.jsonl", "sde/processed/types.json");
  await jsonlToJson(
    "sde/raw/blueprints.jsonl",
    "sde/processed/blueprints.json",
  );
  await jsonlToJson(
    "sde/raw/typeMaterials.jsonl",
    "sde/processed/typeMaterials.json",
  );
  await jsonlToJson(
    "sde/raw/solarSystems.jsonl",
    "sde/processed/solarSystems.json",
  );
  await jsonlToJson(
    "sde/raw/npcStations.jsonl",
    "sde/processed/npcStations.json",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

# 4. Persistent storage with Firebase Admin Firestore

Firestore is the durable server-side store. The application uses the Firebase Admin SDK and stores one document per logical key in the `assemblyLineStorage` collection. It is not the SDE store: SDE inputs remain build/runtime data and are accessed through the SDE/cache services.

For Firebase App Hosting, use the runtime-provided `FIREBASE_CONFIG` and Application Default Credentials. Local development may use ADC or the server-only `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` variables. Never expose service-account values or token records to the browser.

`src/lib/storage.ts` initializes and reuses the Firebase Admin app and Firestore client. `src/lib/auth/tokensStore.ts` provides typed helpers for accounts, character collections, sessions, pending SSO state, and token records. Local `data/` files are disposable legacy state and are not a supported persistence mechanism.

## 4.1 Auth and asset storage model (`src/lib/auth/model.ts`)

```ts
// src/lib/auth/model.ts
export interface CharacterTokenRecord {
  characterId: number;
  characterName: string;
  collectionId?: string;
  personalAuth: TokenSet;
  corporationId?: number;
  corporationRoles?: string[];
  hasDirectorRole?: boolean;
  hasAccountantRole?: boolean;
  hasTraderRole?: boolean;
  hasStationManagerRole?: boolean;
}

export interface TokenSet {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string; // ISO string
  scopes: string[];
  lastUsedAt: number;
}

export interface AssetRecord {
  itemId: number;
  typeId: number;
  quantity: number;
  locationId: number;
  locationType:
    | "facility"
    | "station"
    | "solar_system"
    | "item"
    | "structure"
    | "container"
    | "other";
  locationFlag: string;
  isSingleton: boolean;
  ownerType: "character" | "corporation";
  ownerId: number;
}

export interface AssetLocation {
  locationId: number;
  kind: "station" | "structure" | "solar_system";
  name?: string;
  systemId?: number;
  regionId?: number;
  parentLocationId?: number;
  resolved: boolean;
}

export interface ResolvedAssetRecord extends AssetRecord {
  location: AssetLocation;
  sourceLocationId: number;
  sourceLocationName?: string;
}

export interface SessionRecord {
  sessionId: string;
  collectionId?: string;
  createdAt: string;
  lastSeenAt: string;
}
```

## 4.2 Token/session store (`src/lib/auth/tokensStore.ts`)

The store must keep token records server-side, update rotated refresh tokens, and expose only safe character/session DTOs to routes. Account ownership is represented by the durable account/collection records; a session identifies the active collection and is not a substitute for account ownership. Pending SSO records are short-lived and single-use.

---

# 5. Session management and EVE SSO

The application uses a custom SSO implementation based on EVE's authorization-code flow with PKCE. Do not substitute NextAuth/Auth.js without an explicit architecture decision: the current callback handles collection ownership, character attachment, and collection-merge cases that are not represented by a generic provider session.[^6][^7][^12][^13]

## 5.1 Session helper (`src/lib/auth/session.ts`)

The implemented session model is collection-based:

- `createSession(collectionId?): SessionRecord`
- Attach characters by assigning their durable `collectionId`; collection membership, not a session-local character list, is authoritative.
- `getSessionFromRequest(req)` (read cookie).
- `setSessionCookie(res, sessionId)`
- `clearSessionCookie(res)`

Sessions store a `collectionId`, and `getSessionCharacterIds()` derives the attached characters from that collection. Cookie management uses the HttpOnly `assembly_line_session` cookie. Character attachment and removal must update the durable character and collection records transactionally; do not add a session-local `characterIds` field.

## 5.2 EVE SSO flow (`eveSso.ts`)

Use the authorization-code flow with PKCE for every character connection. Generate a cryptographically random `state` and `code_verifier`, store a short-lived pending-auth record containing the session ID, requested scopes, redirect URI, and expiry, and reject callbacks with a missing, expired, or mismatched state. Never put tokens in query parameters, browser storage, logs, or API responses.

Every character connection uses one authorization request with these scopes:

- `esi-assets.read_assets.v1` for personal assets and asset locations.
- `esi-industry.read_character_jobs.v1` for personal industry jobs.

- `esi-assets.read_corporation_assets.v1` for corporation assets and asset locations.
- `esi-characters.read_corporation_roles.v1` to verify the required corporation role.
- `esi-universe.read_structures.v1` when private structure names or metadata are needed.

There is no separate corp-auth flow or second callback URL. A Director-capable authenticated character makes their corporation a build candidate. A corporation without an authenticated Director is not eligible for corporation asset planning.

Preserve the granted scope list returned by SSO and fail with a clear, non-sensitive error if a required scope was not granted.

The callback must:

1. `getAuthorizeUrl(state, codeChallenge, scopes)`:
   - Build EVE SSO authorize URL.[^7][^14][^5][^6]
2. `exchangeCodeForTokens(code, codeVerifier)`:
   - Call `POST https://login.eveonline.com/v2/oauth/token` with appropriate body.[^15][^6]
   - Return `access_token`, `refresh_token`, `expires_in`.
3. `validateToken(accessToken)`:
   - Decode JWT, validate signature, `iss`, `aud`, `exp`, and `sub`.[^16]
   - Extract character ID and name.
4. `refreshToken(tokenSet)`:

- Call the SSO token endpoint with `grant_type=refresh_token`.
- Replace the access token, expiry, and refresh token when a new refresh token is returned.
- Store the token on the authenticated character account record. The same authorized character token is used for personal data and, when Director eligibility is verified, that corporation's data.

The AI agent should follow EVE SSO docs exactly.[^17][^6][^7]

---

# 6. Account and corporation eligibility

## 6.1 Collection creation and character attachment

The first successfully authenticated character creates a `CharacterCollectionRecord`. Later character authentications attach the character to the active collection. If the authenticated character already belongs to another collection, the callback creates a pending merge record and redirects to an explicit merge workflow; it must not silently merge collections. If there is no session cookie but the character already belongs to a collection, a session is created for that collection.

The callback validates the token subject, fetches the character corporation and available roles, stores the granted scopes, and records Director eligibility. A collection is the durable ownership boundary; a session is only the active browser context.

## 6.2 `GET /api/auth/corp/status`

**Purpose:** Allow the frontend to display which characters have the roles and granted scopes required for corporation asset retrieval.

**Behavior:**

- Get the current session.
- Fetch attached characters from `tokensStore`.
- Return:

```json
[
  {
    "characterId": 123,
    "characterName": "Pilot One",
    "hasDirectorRole": true,
    "corporationId": 999999999
  },
  {
    "characterId": 456,
    "characterName": "Pilot Two",
    "hasDirectorRole": false
  }
]
```

The frontend can use this to:

- Show which characters can contribute corp assets.
- Identify which account characters make their corporations eligible for corporation asset retrieval.

---

# 7. ESI client and caching

## 7.1 ESI client (`src/lib/esi/client.ts`)

The implemented wrapper:

- Uses the authenticated character's personal token for personal endpoints and for eligible corporation endpoints. Token refresh is serialized per character/purpose, rotated refresh tokens are persisted, and authorization failures may trigger one retry. Never log authorization headers or token response bodies.
- Supports assets, asset names/locations, blueprints, industry jobs, skills, market orders, corporation state, and station/system/structure metadata. The supported endpoint set is broader than the original asset/job-only list and is owned by the client/cache modules.

1. **Character assets**
   `GET /characters/{character_id}/assets/`
2. **Character asset locations**
   `POST /characters/{character_id}/assets/locations/`
3. **Character industry jobs**
   `GET /characters/{character_id}/industry/jobs/`
4. **Corporation assets** (for director characters)
   `GET /corporations/{corporation_id}/assets/`
5. **Corporation asset locations** (for director characters)
   `POST /corporations/{corporation_id}/assets/locations/`
6. **Location metadata**
   `GET /universe/stations/{station_id}/`, `GET /universe/systems/{system_id}/`, and `GET /universe/structures/{structure_id}/` when the structure is accessible to the authorized character.

### Asset collection and location normalization

`fetchCharacterAssets(characterId)` and `fetchCorporationAssets(characterId, corporationId)` must fetch every asset page using the `X-Pages` response header, with bounded concurrency and retry handling for transient 5xx responses. Retain `item_id`, `type_id`, `quantity`, `location_id`, `location_type`, `location_flag`, and `is_singleton` from each raw asset.

After fetching assets, batch the returned `item_id` values through the corresponding asset-locations endpoint. Asset locations endpoints provide names and metadata for asset location IDs; they do not replace the need to preserve the raw `location_id` and `location_type`.

For assets whose `location_type` is `station`, `solar_system`, or `structure`, resolve the location directly. For assets whose `location_type` is `item`, follow the parent asset/container chain until a station, solar system, structure, or unresolved root is found. Detect cycles and missing parents, mark those records `resolved: false`, and keep them visible for diagnostics rather than silently assigning them to a system. A resolved asset must include both its immediate location and its effective hauling origin.

Corporation state is fetched only when the character has the required granted scopes, a verified Director role, and a corporation ID. The current token model stores one personal token set; there is no separate `corpAuth` token record. If multiple characters authorize the same corporation, corporation cache work should be deduplicated.

### Token refresh (per character)

For each ESI call:

- Check the selected token set's `accessTokenExpiresAt` against the current time with a safety window (for example, five minutes).
- If expired or near expiry:
  - Use that token set's `refreshToken` to obtain new tokens via SSO token endpoint (`grant_type=refresh_token`).
  - Update and persist the matching `personalAuth` record with the new access token, refresh token (refresh may change), and expiry.[^26][^27]

Refresh operations must be serialized per character and token purpose so concurrent asset requests cannot rotate the same refresh token twice.

---

## 7.2 ESI caching and rate limits (`src/lib/esi/cache.ts`)

Cache each session/owner and endpoint to respect rate limits and reduce ESI load.[^28][^29][^30]

### Cache model

The current cache is keyed by session plus owner ID. This prevents one browser collection's selected state from leaking into another collection while preserving normalized indexes for that session:

```ts
interface EndpointCache {
  etag?: string;
  lastBody: any; // raw ESI response data
  lastUpdated: string; // ISO timestamp
  nextRefreshAllowed: string; // ISO
  rateLimitedUntil?: string; // ISO
  status: "fresh" | "cached" | "rate_limited";
}
```

Maintain an in-memory map:

```ts
const characterCaches = new Map<string, OwnerCache>();
const corporationCaches = new Map<string, OwnerCache>();

`OwnerCache` includes raw assets, resolved root locations, blueprints, jobs, skills, market orders, ship/rig indexes, and unresolved counts. Endpoint statuses include `fresh`, `cached`, `stale`, `rate_limited`, and `error`.
```

Cache persistence is optional and belongs behind the cache provider abstraction; durable application records belong in Firestore. The default in-memory provider is sufficient for development, while shared deployments may use Upstash Redis.

### Refresh function

Implement:

```ts
export async function refreshCharacterState(
  characterIds: number[],
  sessionId: string,
): Promise<StateRefreshSummary>;
```

Behavior:

- For each character in the active session collection:
  - Look up the `CharacterTokenRecord` (for the token, corporation, scopes, and roles).
  - For each supported endpoint:
    - If the process-wide ESI pause or endpoint rate limit is active, set `status = 'rate_limited'`, skip, and preserve the last body.
    - If the endpoint cache is still usable, return its current status without another request.
      - Otherwise:
        - Send an ESI request with `If-None-Match` header using `etag` if present.
        - On **200 OK**:
          - Update `lastBody` with response.
          - Update `etag` from `ETag` header.
          - Update `lastUpdated`.
          - Derive `nextRefreshAllowed` from ESI caching headers (`Cache-Control`, etc.).[^8]
          - Set `status = 'fresh'`.
          - Parse rate-limit headers to update internal counters.[^9]
        - On **304 Not Modified**:
          - Keep `lastBody`.
          - Update `lastUpdated`, `nextRefreshAllowed`.
          - Set `status = 'cached'` (but current).
        - On **429 Too Many Requests**:
          - Read any `Retry-After` or rate-limit headers.
          - Set `rateLimitedUntil` and `nextRefreshAllowed`.
          - Set `status = 'rate_limited'`.

Return a summary:

```ts
interface StateRefreshSummary {
  characters: {
    characterId: number;
    assets?: EndpointCacheSummary;
    assetLocations?: EndpointCacheSummary;
    jobs?: EndpointCacheSummary;
    skills?: EndpointCacheSummary;
    marketOrders?: EndpointCacheSummary;
    corporations?: {
      corporationId: number;
      assets?: EndpointCacheSummary;
      blueprints?: EndpointCacheSummary;
      jobs?: EndpointCacheSummary;
      marketOrders?: EndpointCacheSummary;
    }[];
  }[];
}

interface EndpointCacheSummary {
  status: "fresh" | "cached" | "rate_limited";
  lastUpdated?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
}
```

The refresh summary must identify the owner of every cache entry. Cache keys include the session ID plus character or corporation ID. A successful asset refresh must update the normalized resolved-asset and stock indexes used by planning, while a failed location lookup must leave the raw asset available with `resolved: false`.

---

# 8. API endpoints (details and behavior)

## 8.1 Auth/session endpoints

### 8.1.1 `GET /api/auth/session`

- Use `session.ts` to:
  - Read session cookie.
  - Look up `SessionRecord` from storage.
  - Load attached `CharacterTokenRecord`s.
- Return:

```json
{
  "authenticated": true,
  "characters": [
    {
      "characterId": 123,
      "name": "Pilot One",
      "hasDirectorRole": true,
      "corporationId": 999999999
    }
  ]
}
```

### 8.1.2 `POST /api/auth/logout`

- Clear session cookie.
- Optionally remove `SessionRecord` from storage.
- Return `{ "success": true }`.

## 8.2 Character endpoints

### 8.2.1 `GET /api/characters`

- Validate session.
- Return list of characters attached to session:

```json
[
  {
    "characterId": 123,
    "name": "Pilot One",
    "hasDirectorRole": true,
    "corporationId": 999999999
  },
  {
    "characterId": 456,
    "name": "Pilot Two",
    "hasDirectorRole": false
  }
]
```

### 8.2.2 `POST /api/characters/connect`

- Start the same SSO flow to add a character.
- Restore or create the collection associated with the authenticated character.
- If the authenticated character belongs to another collection, persist a pending merge and require an explicit merge workflow rather than silently combining collections.

### 8.2.3 `DELETE /api/characters/[id]`

- Validate session.
- Remove the character from its durable collection membership and update related collection records transactionally.
- Optionally revoke that character’s tokens via SSO revoke endpoint.

## 8.3 Reference endpoints

### 8.3.1 `GET /api/reference/types?query=...`

- Ensure SDE loaded.
- Use `typeById` and/or a precomputed name index.
- Perform simple case-insensitive substring search on `name`.
- Return:

```json
[
  { "typeId": 34, "name": "Tritanium" },
  { "typeId": 16275, "name": "Some Module" }
]
```

### 8.3.2 `GET /api/reference/blueprints?query=...`

This is a future reference capability, not a current route. Blueprint data is currently loaded through the SDE/cache services and exposed as part of stock and planning workflows.

- Use `blueprintByProductId` and `typeById`.
- Filter blueprint products where the type name matches `query`.
- Return:

```json
[
  {
    "productTypeId": 16275,
    "productName": "Some Module",
    "blueprintTypeId": 123456
  }
]
```

### 8.3.3 `GET /api/reference/locations?query=...&kind=system|station|structure|region`

This is a future unified reference capability, not a current route. Current location selection is supplied by the systems, structures, rigs, and compression-option routes and by persisted structure-rig configuration.

- For `system`, `station`, `region`:
  - Use `systemById` and `stationById` (and region from system’s metadata).
- For `structure`:
  - Either:
    - Return nothing (UI expects manual ID entry), or
    - Query ESI for accessible structures (if implemented).
- Response example:

```json
[
  { "id": 30000142, "name": "Jita", "kind": "system" },
  {
    "id": 60003760,
    "name": "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    "kind": "station"
  }
]
```

### 8.3.4 `GET /api/reference/settings-presets`

This is not currently implemented. Settings are persisted and loaded by the settings/planning preference flows rather than through a preset endpoint.

- Simple placeholder for now:

```json
{
  "default": {
    "includeCorporationAssets": true,
    "buildBlacklist": [],
    "buyBlacklist": []
  }
}
```

## 8.4 State endpoints

### 8.4.1 `POST /api/state/refresh`

- Validate the session and use all characters in its collection; the current route does not accept caller-selected `characterIds` or a `force` option.
- Deduplicate an identical active refresh for the same session and character set.
- Call `refreshCharacterState(characterIds, session.sessionId)` and return endpoint summaries suitable for display near the refresh button.

### 8.4.2 `GET /api/state/status`

- Validate session.
- Return detailed per-character, per-endpoint cache status:

```json
{
  "characters": [
    {
      "characterId": 123,
      "assets": {
        "status": "cached",
        "lastUpdated": "2026-07-28T11:45:00Z",
        "nextRefreshAllowed": "2026-07-28T12:00:00Z",
        "rateLimitedUntil": null
      },
      "jobs": {
        "status": "fresh",
        "lastUpdated": "2026-07-28T12:03:00Z",
        "nextRefreshAllowed": "2026-07-28T12:18:00Z",
        "rateLimitedUntil": null
      },
      "corpAssets": {
        "status": "rate_limited",
        "lastUpdated": "2026-07-28T10:30:00Z",
        "nextRefreshAllowed": "2026-07-28T13:00:00Z",
        "rateLimitedUntil": "2026-07-28T13:00:00Z"
      }
    }
  ]
}
```

### 8.4.3 Stock and production state

The original standalone `/api/state/assets` contract has been replaced by `/api/state/stock` and related state endpoints for jobs, market orders, ships, and refresh/status. These endpoints validate session ownership, return no tokens, and combine cached ESI data into the stock representation used by the planner and stock page:

```json
{
  "stock": [
    {
      "ownerType": "character",
      "ownerId": 123,
      "itemId": 987654321,
      "typeId": 34,
      "quantity": 500000,
      "location": {
        "locationId": 60003760,
        "kind": "station",
        "name": "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
        "systemId": 30000142,
        "resolved": true
      },
      "sourceLocationId": 60003760
    }
  ],
  "unresolvedAssetCount": 0,
  "lastUpdated": "2026-07-28T12:03:00Z"
}
```

The stock endpoint defaults to cached data. Refresh remains an explicit operation through `/api/state/refresh` and normal rate-limit controls. Stock must distinguish a container's immediate location from its effective hauling origin and expose unresolved records rather than guessing. A future dedicated asset-diagnostics endpoint may expose lower-level normalized asset records, but it is not a separate required API contract at present.

## 8.5 `/api/plan` endpoint

### 8.5.1 Request schema

The current request has two supported forms:

- The normal UI sends `language`, `toBuild`, `stock`, `locations`, and `settings`. `stock` is the working stock produced by `/api/state/stock` and client-side selections.
- A lower-level compatibility form may send `toBuild` plus categorized `assets` (`items`, `blueprints`, `industry`, and `market`); the route normalizes these rows into working stock before calculation.

The request does not contain `characterIds` or a `lists` selector. The route calculates the complete `PlanResult`; the client chooses which result view to display.

### 8.5.2 Behavior

Implement in `planning/planEngine.ts`:

1. **Validate the request**

- `/api/plan` does not require an authenticated session.
- The caller supplies `toBuild`, working `stock` (or categorized compatibility assets), `locations`, and `settings` in the request. The endpoint makes no secured ESI calls.

2. **Merge inventory**
   - Combine the supplied working stock and manually supplied stock into a unified inventory map:
     - `availableQuantity[typeId] = sum of all relevant assets`.
     - Also retain `availableByLocation[typeId][effectiveLocationId]` and the owning character or corporation for hauling decisions.
     - Exclude unresolved assets from location-specific hauling tasks, but include them in an explicit planning warning and do not count them as safely available for a location-constrained job.
3. **SDE-based expansion**
   - For each item in `items`:
     - Use SDE maps to:
       - Find associated blueprint (product -> blueprint).
       - Determine manufacturing BOM (materials and quantities).
       - Determine reaction chains needed (if item is produced via reactions).
       - Determine invention jobs needed for BPCs if T2 item, etc.
   - Apply **build/buy blacklists**:
     - If an item is in build blacklist:
       - Mark it as “must buy”, not “build”.
     - If in buy blacklist:
       - Mark it as “must build”, not “buy”.
4. **Compute six lists**
   - **1. Raw materials to buy**
     - For each required material:
       - Compare required quantity to available inventory (character + corp).
       - If required > available and material is not in build blacklist:
         - Add to “materialsToBuy” list with quantity difference, target `locations.market`.
   - **2. BPCs needed**
     - Determine which blueprints/BPCs are required for the planned builds.
     - Check inventory and active jobs for existing BPCs.
     - List missing BPCs in “bpcsNeeded”.
   - **3. Invention jobs**
     - For required BPCs that must be invented (T2, etc.):
       - Use SDE blueprint activities and invention data to compute required invention jobs.
       - Add each job with location `locations.manufacturing` or user-selected structure.
   - **4. Reaction jobs**
     - For materials produced via reactions:
       - Determine reaction formulas (from SDE).
       - Determine number of runs needed.
       - Add reaction jobs with location `locations.reactions`.
   - **5. Manufacturing jobs**
     - For final items to build and intermediary items (due to buy blacklist):
       - Compute manufacturing job requirements:
         - number of runs,
         - locations (manufacturing system/station or structure),
         - required input materials.
       - Add to “manufacturingJobs”.
   - **6. Hauling tasks**
     - Simple from X to Y (no route planning):
       - For each manufacturing/reaction/market location:
         - Determine where required items currently sit from resolved asset records, using the effective location after nested-container resolution.
           - Compute tasks like:
             - “Move X units of typeId from system/station A to location B.”
       - Represent tasks as:

```json
{
  "itemTypeId": 34,
  "quantity": 100000,
  "fromLocationId": 60003760,
  "toLocationId": 10234567,
  "fromLocationName": "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
  "toLocationName": "Reaction structure",
  "ownerType": "character",
  "ownerId": 123
}
```

Never create a hauling task with a guessed origin. If assets are unresolved, return them in `unresolvedAssets` and surface a warning in the response metadata.

6. **Performance**
   - Use precomputed lookup tables and avoid repeated deep graph traversals for each item.
   - Aim for `< 3 seconds` response time by:
     - Ensuring BOM expansion is efficient.
     - Keeping SDE in memory.
     - Limiting complexity of graph traversal per `/plan` call.
7. **Response**

```json
{
  "metadata": {
    "assetsLastUpdated": "2026-07-28T12:03:00Z",
    "jobsLastUpdated": "2026-07-28T11:45:00Z",
    "unresolvedAssetCount": 0,
    "corporationAssetSources": [999999999]
  },
  "lists": {
    "materialsToBuy": [...],
    "bpcsNeeded": [...],
    "inventionJobs": [...],
    "reactionJobs": [...],
    "manufacturingJobs": [...],
    "haulingTasks": [...]
  }
}
```

---

# 9. Frontend UI behavior

## 9.1 characters/auth/state workflows

### On load

- Call `GET /api/auth/session`.
- If not authenticated:
  - Take no extra action
- If authenticated:
  - Consider whether local data is stale and call /refresh endpoint as necessary


### On Refresh
- Look up the endpoints required by the currently active route and call them to refresh local caches with the latest data

### On Auth
- After successfully adding or removing a character from the collection the client app should re-call '/refresh' and update local caches

### On Navigation
- Check the timestamp of the endpoints required by the current route.
- Refresh local data required for current route only if /refresh has returned more recently.

## 9.2 Planner and production-control UI

The original generic planner has evolved into a broader production-control application. In addition to the planner, the product includes first-class stock, jobs, ships, compression, locations, characters, and settings workflows. The planner still owns the six required outputs, including hauling; the hauling view may be temporarily hidden while that workflow is being completed, but it remains a planned capability.

The current planner does not perform character selection or refresh orchestration itself. Authentication, character attachment, collection management, and state refresh are handled by the characters/auth/state workflows. The planner loads working stock, build-list preferences, locations, and settings, then sends the unauthenticated stock-driven request to `/api/plan`.

Components:

- **Character and collection management**:
  - Character attachment, collection membership, merge handling, roles, and SSO status belong on the characters/auth workflows rather than inside the planner form.
  - Additionally, show summary from `POST /api/state/refresh`:
  - For each refreshed character:
    - Assets, skills, jobs, and market-order ESI status.
    - Corporation asset, jobs, and market-order status where the character is eligible.
  - Last updated timestamps.
  - Next refresh allowed, if available.
- **BuildListEditor**:
  - Item search autocomplete using `/api/reference/types`.
  - Adding/removing items (stores `typeId + quantity`).
- **LocationDetails**:
  - Manufacturing location (system/station via `/api/reference/locations`).
  - Reactions location.
  - Market location.
  - Structure configuration:
    - Inputs for `structureId`, `structure typeId`, and installed rigs.
- **SettingsPanel**:
  - Checkbox: “Include corporation assets”.
  - Simple build blacklist editor:
    - Item search (using `/api/reference/types`) to add typeIds to `buildBlacklist`.
  - Simple buy blacklist editor:
    - Same as above for `buyBlacklist`.
  - For now, no complex presets; just basic lists.
- **PlanTabs**:
  - Tabs or vertical navigation for the six lists, plus a plan overview
    - Plan Overview.
    - Materials to buy.
    - BPCs needed.
    - Invention jobs.
    - Reaction jobs.
    - Manufacturing jobs.
    - Hauling tasks.
  - Displays only one list at a time, but keeps all loaded in memory.

### Planner workflow

1. User, optionally, logs in via EVE SSO and attaches one or more characters to a collection.
2. The callback records corporation roles; there is no separate corp-auth step.
3. User refreshes collection state through the state workflow. Refresh includes all characters in the active collection and eligible corporation state.
4. User defines build list:
   - Uses item search to add items (`typeId`, quantity).
5. User selects locations:
   - Manufacturing, reactions, market.
   - Optional structures and rigs.
6. User sets settings:
   - Include corp assets.
   - Build/buy blacklists.
7. User clicks **“Refresh data”**:
   - Frontend sends `POST /api/state/refresh` for the active session collection.
   - Shows summary from response.
8. User clicks **“Calculate plan”**:
   - Frontend sends `POST /api/plan` with the build list, cached/working stock, locations, and settings.
   - On response:
     - Populates the planner output views with the six lists.
9. User navigates between tabs to inspect each resulting list.

Optional UX enhancements:

- Auto-mark plan as “stale” when build list or settings change.
- Auto-compute plan after a small debounce when the user finishes editing.
- Auto-refresh state and recompute plan when `nextRefreshAllowed` passes (if user desires).

---

## 9.3 Offline/partial-offline considerations

You mentioned offline would be a benefit but not mandatory. Given our design:

- ESI calls and SDE usage are server-side.
- The client can cache:
  - The last successful plan response (six lists), once client-side plan recovery is implemented.
    - The current build list and settings.
- For partial offline behavior:
  - When the app cannot reach the server:
    - Show the last cached plan and clearly mark it as outdated.
    - Do not attempt `/state/refresh` or `/plan`.
  - This can be implemented via:
    - IndexedDB or localStorage storing:
      - Last `/plan` result.
      - Current build list and locations/settings.

Requires simple caching on the frontend and the ability to manually build stock lists, if the user requires stock to be considered.  Any automatic stock calcluatons remains server-dependent due to ESI and SDE.

---

## 10. Performance and correctness constraints

To guide implementation and testing:

### 10.1 `/plan` performance

- Must complete in **< 3 seconds** in typical scenarios:
  - Build list sizes expected: you should specify a rough upper bound (e.g., 50–100 items).
- Implementation strategies:
  - Ensure SDE maps are fully in memory and indexed.
  - Precompute:
    - `productTypeId -> blueprintTypeId`.
    - `blueprintTypeId -> materials[] per activity`.
  - Avoid repeated SDE file reads inside `/plan`; use a singleton loader.
  - Avoid repeated deep graph traversals; cache intermediate results when necessary.

### 10.2 ESI rate-limit correctness

- Must honor:
  - ETag-based conditional requests. ETag should remain in memory and NOT be sent to the shared cache (firestore).[^41]
  - Error-limit and rate-limit headers.[^42][^43]
  - `Retry-After` semantics.
- `/state/refresh` must:
  - Never spam ESI if rate-limited.
  - Report accurate statuses so the user understands when fresh data will be available.

### 10.3 Token security and persistence

- `CharacterTokenRecord.personalAuth` contains sensitive refresh and access tokens.
- Requirements:
  - Do not log tokens.
  - Do not expose tokens to the frontend.
  - Persist tokens only through the server-side Firestore token store. Never expose or log them.
  - Ensure refresh tokens are updated whenever SSO returns a new one.[^44][^45]

### 10.4 Planning correctness

- The plan engine must:
  - Correctly interpret SDE data for blueprints, materials, and activities.
  - Use stock assets, if provided in the request, before adding a build item to the plan.
  - Respect build/buy blacklists.
  - Produce accurate counts for:
    - Required materials, after stocks.
    - Required BPCs, after stocks.
    - Number and type of jobs.
    - Hauling tasks.

Unit tests should be written for the planning logic, especially:

- BOM expansion from SDE.
- Inventory merging.
- Blacklist handling.
- Each of the six lists.
- PKCE state and callback character matching.
- Access-token refresh for character token sets, including refresh-token rotation.
- Pagination and rate-limit handling for personal and corporation assets.
- Nested asset/container location resolution, cycle detection, and unresolved-asset reporting.
- Hauling origins for station, solar-system, structure, and container-held assets.

---

## 11. NPM scripts and build pipeline

There is a range of `package.json` scripts like:

```json
{
  "scripts": {
    "fetch-sde": "ts-node scripts/fetch-sde.ts",
    "parse-sde": "ts-node scripts/parse-sde.ts",
    "generate-types": "tsx scripts/generate-types.ts",
    "sde:prepare": "npm run fetch-sde && npm run parse-sde && npm run generate-types",
    "build": "next build",
    "dev": "next dev",
    "start": "next start",
    "format": "npx prettier",
    "lint": "npx eslint"
  }
}
```

Order:

1. `fetch-sde`: ensure latest SDE files are present.
2. `parse-sde`: convert JSONL to JSON arrays.
3. `generate-types`: generate the TypeScript SDE table modules and cache metadata.
4. `build`: compile and bundle Next.js app.

---

## 12. Deployment and environment configuration

If we move the project to Docker:

- Create a Dockerfile that:
  - Installs Node, dependencies.
  - Copies project files.
  - Runs `npm run build`.
  - Uses `next start` as the container entrypoint.
- Environment variables:
  - `EVE_CLIENT_ID`
  - `EVE_CLIENT_SECRET`
  - `EVE_CALLBACK_URL`
  - Firebase/App Hosting configuration for Firestore, plus the EVE SSO variables.
  - Optional: SDE download URL override.

The container must:

- Have access to Firestore for durable application records and read access to the prepared SDE inputs.
- Have read permissions for `sde/processed/*.json`.

---

<div align="center">⁂</div>

[^3]: https://apis.io/apis/eve-online/static-data-export/

[^4]: https://sde.riftforeve.online/

[^5]: https://apis.io/apis/eve-online/eve-sso/

[^6]: https://wiki.eveuniversity.org/EVE_SSO

[^7]: https://docs.esi.evetech.net/docs/sso/sso_authorization_flow.html

[^8]: https://developers.eveonline.com/docs/guides/map-data/

[^9]: https://developers.eveonline.com/docs/services/sde/

[^10]: https://next-auth.js.org/providers/eveonline

[^11]: https://authjs.dev/getting-started/providers/eveonline

[^12]: https://github.com/MichielvdVelde/eve-sso

[^13]: https://github.com/eve-scout/passport-eveonline-sso

[^14]: https://developers.eveonline.com/docs/services/sso/

[^15]: https://docs.esi.evetech.net/docs/sso/migrate_v1_v2.html

[^16]: https://docs.esi.evetech.net/docs/sso/validating_eve_jwt.html

[^17]: https://docs.esi.evetech.net/docs/sso/

[^21]: https://wiki.eveuniversity.org/EVE_SSO

[^22]: https://docs.esi.evetech.net/docs/sso/migrate_v1_v2.html

[^23]: https://docs.esi.evetech.net/docs/sso/validating_eve_jwt.html

[^24]: https://docs.rs/eve_esi/latest/eve_esi/endpoints/index.html

[^25]: https://docs.esi.evetech.net/docs/esi_introduction.html

[^26]: https://docs.esi.evetech.net/docs/sso/refreshing_access_tokens.html

[^27]: https://forums.eveonline.com/t/sso-refresh-tokens/338373

[^28]: https://developers.eveonline.com/blog/esi-etag-best-practices

[^29]: https://developers.eveonline.com/docs/services/esi/rate-limiting/

[^30]: https://developers.eveonline.com/blog/hold-your-horses-introducing-rate-limiting-to-esi

[^31]: https://www.fuzzwork.co.uk/2021/07/17/understanding-the-eve-online-sde-1/

[^41]: https://developers.eveonline.com/blog/esi-etag-best-practices

[^42]: https://developers.eveonline.com/docs/services/esi/rate-limiting/

[^43]: https://developers.eveonline.com/blog/hold-your-horses-introducing-rate-limiting-to-esi

[^44]: https://docs.esi.evetech.net/docs/sso/refreshing_access_tokens.html

[^45]: https://forums.eveonline.com/t/sso-refresh-tokens/338373
