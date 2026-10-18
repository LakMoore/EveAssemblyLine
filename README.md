# AssemblyLine

## Google Analytics

To enable optional Google Analytics 4, set the public measurement ID in the deployment environment:

```env
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

The application loads GA4 only after the visitor allows analytics in the consent banner. The
choice is stored in browser local storage and can be changed from the [cookie policy](/cookies).
If the variable is omitted or invalid, analytics and the consent banner remain disabled.

## SDE preparation

SDE files are build/runtime inputs and are intentionally ignored by git. To prepare them locally:

```bash
npm install
npm run sde:prepare
```

The pipeline checks the official CCP/EVE build manifest at `https://developers.eveonline.com/static-data/tranquility/latest.jsonl`, which contains the current `buildNumber`. If `.next/cache/assemblyline-sde/raw/version.json` has the same build number, no archive is downloaded. Otherwise it downloads the official JSONL archive from `https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip`. The archive URL can be overridden with `SDE_URL`, or an existing archive can be used with `SDE_ARCHIVE=/path/to/sde.zip`. The pipeline caches raw JSONL files under `.next/cache/assemblyline-sde/raw/`, converts them to compact JSON arrays in `sde/processed/`, and generates one TypeScript file per table under `src/lib/sde/generated/`, with `src/lib/sde/generated/index.ts` as the barrel export. If the Vercel build cache is unavailable, the raw archive is downloaded again automatically.

Each preparation also fetches HoboLeaks metadata and `https://sde.hoboleaks.space/tq/repackagedvolumes.json`. The file is validated for shape, copied through the ignored raw/processed SDE cache, and merged by the SDE loader into the in-memory type map as `packagedVolume`; the official type `volume` remains the assembled volume. The existing SDE cache upload therefore stores both values with each versioned type entry. If HoboLeaks marks the file stale, preparation warns but uses the data after shape validation and records its stale status in the raw cache metadata; estimates may therefore use outdated packaged volumes. Data marked deprecated is skipped and recorded as such. Other download and validation errors still fail preparation.

The final `sde:prepare` step bulk uploads the SDE-backed cache entries when the configured cache provider is shared and the build number differs from its last successful upload. Uploading is skipped for the default in-memory provider because its process-local cache is not useful after preparation exits. Upstash Redis uses bounded pipelined writes, and the version marker is written only after all entries have been accepted.

Without SDE data the application still builds, but SDE-backed routes should call `ensureSdeLoaded()` and report its setup error. This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Taxes tool

`/taxes` compares placing sell/buy orders and immediately filling existing orders at Jita,
Amarr, Hek, Dodixie, or Rens. `POST /api/taxes` validates `{ typeId, marketId }` against the
SDE and supported hubs, then loads public ESI order-book pages through the shared cache.
Sell prices are restricted to the selected hub station. Buy prices use the highest regional order
whose range covers that station: Station orders must be at the hub; other same-system orders
and region-wide orders qualify without routing. Higher-priced remote jump-range orders are checked
in descending price order against ESI's public shortest stargate route. Lower or equal prices,
remote Station/System orders, and inactive orders never require a route lookup; checking stops at
the first qualifying candidate. Distances are shared across items and hubs, symmetric, cached for
the server process lifetime without expiry, and deduplicated while in flight. Restart the server
after an SDE/topology update to invalidate them. Disconnected systems are excluded; routing failures
and rate limits fail the quote rather than silently substituting a lower buy price.
PLEX (type `44992`) overrides any selected hub and uses the complete global market in
[region `19000001` (GPMR-01)](https://esi.evetech.net/latest/universe/regions/19000001/), without
station filtering. This override also applies to the shared appraisal, sell-order, and market-history
helpers. Quotes expose source time, expiry, and cache status. Missing sides remain unavailable;
ESI failures and rate limiting are reported rather than replaced with sample prices.

Fees follow [CCP's NPC market rules](https://support.eveonline.com/hc/en-us/articles/203218962):
7.5% sales tax reduced by 11% per Accounting level; 3% broker fee minus 0.3 percentage points
per Broker Relations level, 0.03 points per unmodified faction standing, and 0.02 points per
unmodified station-corporation standing. Broker fees have a 100 ISK minimum per order.
Only sellers pay sales tax; only newly placed orders incur broker fees. Character skills use
the existing session snapshot, with All zero/IV/V presets available without authentication.
Selecting a character fills and disables both standing inputs using full-precision, unmodified
[ESI standings](https://developers.eveonline.com/api-explorer#/operations/GetCharactersCharacterIdStandings)
from the session-scoped server cache. Character refresh requests the standings endpoint alongside
skills, respects ETags and expiry, and retains last-known values with a warning on failure or rate
limiting. The safe session response exposes only standings, cache status, and a scope-availability
flag, never tokens. Existing characters must reconnect to grant `esi-characters.read_standings.v1`
and then refresh; enable this scope in the EVE developer application's permitted scopes too.
Unavailable standings do not silently become zero. A successfully fetched response without an
entry for the relevant corporation/faction means neutral standing. Skill presets keep editable
manual standings, initially neutral, and preserve those inputs when switching to/from a character.

The applicable standings are Caldari Navy/Caldari State at Jita, Emperor Family/Amarr Empire at
Amarr, Boundless Creation/Minmatar Republic at Hek, Federation Navy/Gallente Federation at Dodixie,
and Brutor Tribe/Minmatar Republic at Rens. Station owners were verified against public ESI and
their faction IDs against CCP's local SDE; corporation/faction IDs are matched by standing type,
never by localized names. A quote's global PLEX override does not change the retained hub's
NPC fee assumptions. No standing or intermediate broker rate is rounded for fee calculations.

The Taxes settings include **Create Buy Orders in Player Owned Structure**. When enabled, only
the placed buy order itemizes the mandatory **0.5% SCC Surcharge** separately from the
**structure owner's broker fee**, using the percentage in the settings box. The broker fee has
a 100 ISK per-order minimum, including when its configured percentage is 0%; the SCC surcharge
has no such minimum. Each charge is rounded independently to ISK cents before both are added
to the order value. Broker Relations and NPC standings do not discount either charge. The owner
percentage is an explicit manual input, initially 0%; actual structure rates can differ.
Sell orders retain NPC fees and immediate trades remain unchanged. This changes
fees only, not the source of the selected hub/global PLEX quote, and does not fetch structure data.
These rules were checked on 2026-10-18 against
[CCP's guide](https://support.eveonline.com/hc/en-us/articles/203218962-Broker-Fee-and-Sales-Tax)
(marked updated seven months ago) and [EVE University Trading](https://wiki.eveuniversity.org/Trading)
(last edited 2026-08-04), both within the preceding 18 months.

Placed sell orders use the nearest valid price strictly below the lowest sell quote, and placed
buy orders use the nearest valid price strictly above the highest buy quote, following CCP's
[four-significant-figure market ticks](https://www.eveonline.com/news/view/broker-relations) with
cent precision as the minimum tick. Magnitude boundaries use the adjacent valid price, for example
a sell quote of 1,000,000 ISK is undercut at 999,900 ISK, while a buy quote of 999,900 ISK is outbid
at 1,000,000 ISK. Order values and all associated fees use the adjusted unit price. Immediate trades
keep the original quotes. A one-cent sell quote cannot be undercut, so that placed-sell scenario
and the Using Orders split are unavailable rather than quoting zero or silently matching the order.

Quantity, skill profile, standings, and buy-order fee settings recalculate entirely in the browser.
Totals assume all units trade at the displayed scenario price and exclude market depth and relisting
fees. Split before fees remains the original bid/ask midpoint, independent of competitive ticks.
After fees averages the highest available selling receipt and lowest available buying cost.
Using Orders averages the placed sell-order receipt and placed buy-order cost; Immediate averages
the immediate sell receipt and immediate buy cost. These three post-fee splits use totals for the
selected quantity, including competitive ticks, minimum broker fees, and SCC where applicable.
Unavailable required scenarios leave the affected split unavailable. Wallet totals and post-fee
splits are rounded to ISK cents; the before-fee unit reference preserves fractional cents.

## Industry simulator

`POST /api/plan/simulate` is the application's only planning calculation endpoint. It accepts
client-supplied planning state and a `simulation` object, uses the cached SDE, and never authenticates
or calls ESI. Responses use `Cache-Control: no-store`.

The simulator reports availability at `now`, `after-hauling`, `after-upstream`, and
`after-purchase` horizons. Physical item lots and finite BPC runs are conserved once across all
stockpiles. Manufacturing and reaction installs are assigned to reusable character capacity lanes
when character profiles are supplied; known upstream completion times constrain dependent starts.
Science assignments likewise require known input availability. Work waiting on an undated purchase
or haul remains unscheduled rather than receiving a time-zero install. Planned and active outputs
are credited at their producing location, with a future transfer when demand is elsewhere; those
transfers are not presented as actionable hauling until the output exists as an asset.
Reprocessing runs after industry expansion and is limited to eligible ore, compressed gas, and
scrap types. Committed sources round up to complete SDE portions; buying is the final settlement
phase.

The request policy defaults to a 1.2 expected invention-output factor, level-3 fallback invention
skills, no decryptor, a 10,000-node graph limit, and a depth limit of 100. A type cannot appear in
both build and buy blacklists. The response contains native result lists, stable input and policy
metadata, warnings, and invariant counts. Presentation lists
are grouped on the server and include per-lot hauling and per-job reprocessing details; the ledger
views are diagnostic and are not required for the planner to display the native result.

## Firebase persistence

Durable server-side accounts, sessions, EVE tokens, and pending SSO state are stored in Cloud Firestore through the Firebase Admin SDK. The application uses one document per storage key in the `assemblyLineStorage` collection. Simulator request logs use the dedicated `planRequests/{requestId}` collection for metadata and store their compressed request/response JSON in Cloud Storage at `plan-logs/{requestId}.json.gz`. The migration leaves historic Calculate and malformed records in place rather than exposing or relabeling them as simulator logs. SDE data remains a build/runtime input loaded into process memory; it is not stored in Firestore.

For Firebase App Hosting, no Firebase-specific `.env` variables are required. App Hosting provides `FIREBASE_CONFIG` automatically and the Firebase Admin SDK uses Application Default Credentials from the backend's runtime service account. The backend service account must have permission to access Firestore.

For local development, either use Google Application Default Credentials with `gcloud auth application-default login` and set `FIREBASE_PROJECT_ID`, or provide these server-only variables in `.env.local`:

```env
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@your-firebase-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=your-firebase-project-id.firebasestorage.app
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-id/your-webhook-token
```

Use a dedicated service account with access limited to the required Firestore database and Cloud Storage bucket. The service account needs Firestore read/write access and permission to create, read, and delete objects in the plan-log bucket. Never expose these variables to the browser or commit them.

`DISCORD_WEBHOOK_URL` is optional. When configured, server-side persistence errors are sent to Discord from the request lifecycle callback. Configure the same value as a runtime secret for App Hosting.

The Firestore database must be created in the Firebase project before the first authenticated request. Existing `data/` files are intentionally not migrated; they contain disposable pre-Firestore state and will be abandoned on deployment.

### Corporation refresh opt-in

Explicit Director consent for shared corporation refreshes is disabled by default. Set the
server-only environment variable below to require each Director to opt in from the Characters
page:

```env
CORP_REFRESH_OPT_IN=true
```

When the variable is omitted or has any value other than `true`, every eligible Director token can
be used for a non-Director corporation refresh and the opt-in switch is hidden. When enabled, only
Directors with consent can be selected for non-Director refreshes. A Director's own authenticated
session can always refresh that Director's corporation when the required scopes are available.

### Create the Firestore database

1. Open the [Firebase console](https://console.firebase.google.com/) and select the project used by the App Hosting backend.
2. Open **Databases & Storage > Firestore Database** and click **Create database**.
3. Choose **Production mode**, not Test mode. This server uses the Admin SDK and IAM; browser clients should not have direct access to the token collection.
4. Select a database location close to the App Hosting backend and confirm **Create**. The default `(default)` database is sufficient.
5. Open **Project settings > Service accounts** and identify the service account used by the App Hosting backend. Grant it a Firestore role such as **Cloud Datastore User** (`roles/datastore.user`) at the project level if it does not already have access.
6. Confirm the App Hosting backend service account can create, read, and delete objects in the default Firebase Storage bucket.
7. Roll out the App Hosting backend. The normal build runs `next build` and does not run the plan-log migration; use the migration commands below when existing request logs need migration.

For local ADC setup, install the Google Cloud CLI, run `gcloud auth application-default login`, set `FIREBASE_PROJECT_ID` in `.env.local`, and run the app from the application root. Do not use production credentials for local experiments; use a separate Firebase project or the Firestore emulator.

If existing plan logs were created before the Cloud Storage migration, run the migration from the application root. It is a dry run by default:

```bash
npm run migrate-plan-request-logs
npm run migrate-plan-request-logs -- --apply
```

Plan logs can be culled with a dry run first. The default retention period is 30 days; use
`--days=N` to choose another period. Cloud Storage objects are deleted before their Firestore
metadata, and failed deletions are reported:

```bash
npm run cleanup-plan-request-logs -- --days=30
npm run cleanup-plan-request-logs -- --days=30 --apply
```

### Migrate corporation settings

Collection corporation support and planning-source settings are stored in the collection record. The
App Hosting build runs the idempotent migration before compiling the application. For a local
deployment or a database change, run a dry run first, then apply it with credentials for the target
Firestore project:

```bash
npm run migrate-corporation-settings
npm run migrate-corporation-settings -- --apply
```

Malformed collection records and corporation settings are retained and reported by the migration;
they are not silently discarded.

## Fitting Library

`/fittings` (Information > Fittings) maintains a ship-fitting library for the active character
collection. Names are unique within a collection, ignoring case and Unicode compatibility variants.
The import dialog accepts one EFT, native EVE XML, DNA, or ESI JSON fitting at a time. Type names and
DNA module slots are resolved from the server's SDE; stored fittings use numeric type IDs.

The list endpoint is `GET /api/fittings` (names, IDs, ship type IDs and revisions); details use
`GET /api/fittings/{id}`. Create with `POST /api/fittings`; existing fittings are read-only and can
be viewed or copied to the clipboard in EFT format. Manually added fittings may be deleted with
`DELETE /api/fittings/{id}`, using the current `revision`. ESI-imported fittings cannot be deleted.
Updates are rejected with HTTP 405.
Every request is authorized against the session collection. Fitting bodies and the collection index
are stored separately in Firestore; browser lists and opened fitting bodies are cached in the existing
IndexedDB endpoint store, scoped to the authenticated session. Offline data is explicitly marked stale;
writes require server confirmation. The library allows 1,000 saved fittings per collection.

The planner's stockpile item search also matches collection fitting names. Selecting a fitting saves
a by-value snapshot of its numeric hull and item contents in that stockpile, so deleting the library
entry does not break existing plans. Repeated selections of the same fitting increase its existing
row quantity; distinct fittings and ordinary hull rows remain separate. Before simulation, each
included fitting expands to its hull and all modules, charges, drones and cargo, multiplied by the
stockpile quantity. Snapshots survive browser storage and plan JSON export/import, and do not change
when the library entry changes. Ordinary type selection and pasted type lists remain independent.

Personal `GET /characters/{character_id}/fittings/` responses are fetched only during
`/api/state/refresh`, using `esi-fittings.read_fittings.v1`. Reconnect characters without that scope.
Each newly discovered personal fitting seeds the collection once; name clashes receive numeric
suffixes. Refresh does not overwrite existing library entries. Endpoint freshness, errors and
reauthorization requirements appear on the Data page.

The additive `fittings:v1:` storage namespace is initialized on the first fitting creation or ESI
import. No fitting migration or schema marker is required. Existing alpha fitting records remain
compatible; Firestore credentials/ADC are required at runtime, not by a fitting build hook.

## Cache configuration

The cache layer is available through `src/cache/cache.ts` and defaults to an in-memory provider:

```env
CACHE_PROVIDER=inmemory

# For shared production caching:
# CACHE_PROVIDER=upstash-redis
# UPSTASH_REDIS_REST_URL=https://...
# UPSTASH_REDIS_REST_TOKEN=...
```

Use the typed helpers for stable keys and TTL policy:

```ts
const cachedType = await getSdeType(typeId);
await setSdeType(typeId, typeData);

const cachedResponse = await getEsiResponse<EsiResponse>(path, queryParams);
await setEsiResponse(path, responseData, response.headers.get("cache-control"), queryParams);
```

`InMemoryCacheProvider` is process-local and useful for development and tests. `UpstashRedisCacheProvider` stores JSON values in Redis and translates positive TTL values from milliseconds to Redis seconds.

In development, each refresh GET logs one `[ESI refresh profile]` record per character or corporation request. Each record includes the full request duration, outer request phases, and the named character or corporation cache-section durations in milliseconds; profiling is disabled outside development.

SDE cache entries do not use a time-based TTL. Every SDE key is namespaced by the build number reported in `sde/processed/_sde.json`, for example `sde:123456:type:34`. Entries remain usable until the SDE build changes; a new build automatically uses a new namespace and cannot read the previous build's entries.

To reclaim old Redis namespaces, run the cleanup command after the new SDE build is available:

```bash
npm run cache:cleanup-old-sde                 # dry run
npm run cache:cleanup-old-sde -- --delete     # delete old keys
```

Run the dry run after deployment, then schedule the destructive run as a low-priority post-deploy job or during an off-peak period. Redis `SCAN` is incremental, and the script deletes only keys from numerically older SDE builds, so cleanup can be deferred without affecting request correctness or user-visible freshness.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## UI controls

Numeric fields currently use standard browser controls. If native control styling or behavior becomes limiting, we may add a dependency on a library of prebuilt HTML controls.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
