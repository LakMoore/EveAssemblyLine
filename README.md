# AssemblyLine

## SDE preparation

SDE files are build/runtime inputs and are intentionally ignored by git. To prepare them locally:

```bash
npm install
npm run sde:prepare
```

The pipeline checks the official CCP/EVE build manifest at `https://developers.eveonline.com/static-data/tranquility/latest.jsonl`, which contains the current `buildNumber`. If `.next/cache/assemblyline-sde/raw/version.json` has the same build number, no archive is downloaded. Otherwise it downloads the official JSONL archive from `https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip`. The archive URL can be overridden with `SDE_URL`, or an existing archive can be used with `SDE_ARCHIVE=/path/to/sde.zip`. The pipeline caches raw JSONL files under `.next/cache/assemblyline-sde/raw/`, converts them to compact JSON arrays in `sde/processed/`, and generates one TypeScript file per table under `src/lib/sde/generated/`, with `src/lib/sde/generated/index.ts` as the barrel export. If the Vercel build cache is unavailable, the raw archive is downloaded again automatically.

Each preparation also fetches HoboLeaks metadata and `https://sde.hoboleaks.space/tq/repackagedvolumes.json`. The file is validated for freshness and shape, copied through the ignored raw/processed SDE cache, and merged by the SDE loader into the in-memory type map as `packagedVolume`; the official type `volume` remains the assembled volume. The existing SDE cache upload therefore stores both values with each versioned type entry. Preparation fails clearly if the HoboLeaks file is missing, stale, deprecated, or malformed.

The final `sde:prepare` step bulk uploads the SDE-backed cache entries when the configured cache provider is shared and the build number differs from its last successful upload. Uploading is skipped for the default in-memory provider because its process-local cache is not useful after preparation exits. Upstash Redis uses bounded pipelined writes, and the version marker is written only after all entries have been accepted.

Without SDE data the application still builds, but SDE-backed routes should call `ensureSdeLoaded()` and report its setup error. This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Firebase persistence

Durable server-side accounts, sessions, EVE tokens, and pending SSO state are stored in Cloud Firestore through the Firebase Admin SDK. The application uses one document per storage key in the `assemblyLineStorage` collection. SDE data remains a build/runtime input loaded into process memory; it is not stored in Firestore.

For Firebase App Hosting, no Firebase-specific `.env` variables are required. App Hosting provides `FIREBASE_CONFIG` automatically and the Firebase Admin SDK uses Application Default Credentials from the backend's runtime service account. The backend service account must have permission to access Firestore.

For local development, either use Google Application Default Credentials with `gcloud auth application-default login` and set `FIREBASE_PROJECT_ID`, or provide these server-only variables in `.env.local`:

```env
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@your-firebase-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Use a dedicated service account with access limited to the required Firestore database. Never expose these variables to the browser or commit them.

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
6. Roll out the App Hosting backend. The first successful authenticated request creates the `assemblyLineStorage` collection and its documents automatically; no manual collection creation is needed.

For local ADC setup, install the Google Cloud CLI, run `gcloud auth application-default login`, set `FIREBASE_PROJECT_ID` in `.env.local`, and run the app from the application root. Do not use production credentials for local experiments; use a separate Firebase project or the Firestore emulator.

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
