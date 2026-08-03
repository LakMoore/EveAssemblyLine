# AssemblyLine agent instructions

## Project context

AssemblyLine is a Next.js App Router application for planning large EVE Online manufacturing projects. The authoritative product and architecture plan is [FullPlan.md](../../FullPlan.md). The application must eventually support EVE SSO, multiple attached characters, server-side ESI calls, static SDE data, node-persist storage, inventory-aware planning, and six plan output lists.

The repository is currently an early prototype, not a completed implementation of FullPlan.md:

- `src/app/page.tsx` is a client-side prototype with hard-coded characters, locations, and sample build items.
- `src/lib/planning/planEngine.ts` uses two hard-coded recipes and does not yet use SDE or cached assets.
- `src/app/api/plan/route.ts` validates only a small part of the request and does not yet validate a session or character ownership.
- `src/lib/storage.ts`, `src/lib/auth/model.ts`, and `src/lib/auth/tokensStore.ts` provide only the initial node-persist primitives.
- EVE SSO, app sessions, ESI clients/cache, SDE processing/loading, character/corporation routes, state refresh routes, reference routes, and automated planning tests are not yet implemented.

Do not present prototype data as live EVE data. When replacing a mock path, keep the UI usable and make loading, unauthenticated, stale, rate-limited, and error states explicit.

## Working rules

- Read the nearby implementation and relevant section of `FullPlan.md` before editing. Keep changes focused on the owning module.
- Preserve existing user changes and avoid unrelated refactors.
- Follow the existing TypeScript style: strict typing, double quotes, semicolons, the `@/*` alias, and small focused modules.
- Keep server-only code and secrets out of client components. Never send access tokens or refresh tokens to the browser, log them, or include them in error messages.
- Validate and narrow all external input at API boundaries. Do not rely on a TypeScript cast as runtime validation. Reject malformed IDs, quantities, locations, settings, and character selections with useful 4xx responses.
- Use Next.js App Router conventions already in the project. This project uses Next.js 16; before changing framework APIs, consult the relevant guide under `node_modules/next/dist/docs/` as required by `AGENTS.md`.
- Prefer existing platform and repository APIs over new abstractions. Do not add a database: node-persist is the minimal persistent store and SDE is static build/runtime data.
- Do not add fake ESI responses or silently fall back to hard-coded recipes in production paths. Test fixtures belong in tests or explicitly named fixture modules.
- Keep UI changes consistent with the current visual language: dark technical workspace, Manrope and DM Mono, restrained cyan/teal/lime accents, dense operational layouts, and responsive controls. Do not replace the planner with a generic dashboard or marketing page.

## Architecture boundaries

### Authentication and sessions

Use HttpOnly, secure-in-production, same-site cookies for the app session. A session owns a list of attached character IDs; every character, corp, state, and plan operation must verify that requested IDs belong to the current session. Store character tokens only through the auth store and refresh/persist rotated refresh tokens.

EVE SSO state and PKCE values must be unpredictable, bound to the initiating session/character, single-use, and checked on callback. Validate token issuer, audience, expiry, subject, and signature according to EVE documentation. Keep corp authorization separate from ordinary character login and verify the required corporation role before enabling corporation assets.

### ESI and state cache

All ESI calls are server-side. Centralize token refresh and ESI request behavior in the ESI client. Respect access-token expiry, ETags, `304`, `429`, `Retry-After`, cache-control, and ESI rate-limit/error-limit headers. `/api/plan` must use cached state only and must never call ESI synchronously.

Cache entries must make freshness and rate limiting observable. A refresh response should distinguish `fresh`, `cached`, and `rate_limited` per character and endpoint. Avoid concurrent duplicate refreshes for the same character/endpoint where practical.

### SDE

SDE files are build/runtime inputs, not source files checked into the repository. Keep download, JSONL parsing, type generation, loading, and indexing separate. Load processed SDE data once per server process and expose indexed lookups for types, products/blueprints, activities/materials, systems, and stations. Handle missing SDE files with a clear server error and document the setup/build prerequisite.

Do not assume one SDE schema without checking the actual downloaded data. Normalize field naming and activity structure at the loader boundary. Model products-per-run, activity type, blueprint relationships, invention outputs, reaction inputs, and locations explicitly rather than encoding them in plan-engine conditionals.

HoboLeaks provides supplemental EVE static data at [sde.hoboleaks.space](https://sde.hoboleaks.space/). Use it when CCP's official SDE or ESI does not expose a needed value, while keeping the official CCP SDE as the primary source. In particular, `https://sde.hoboleaks.space/tq/repackagedvolumes.json` is a JSON object mapping type IDs to packaged volumes in cubic meters; use it for packaged/unassembled volumes when the official `types.json` `volume` field represents assembled volume. Keep these concepts separate in application names and DTOs, for example `assembledVolume` and `packagedVolume`.

Before consuming a HoboLeaks file, inspect `https://sde.hoboleaks.space/tq/meta.json`. Check the file's `deprecated` and `stale` flags, record its `revision`, and use its `md5` hash for change detection. Do not silently use a stale or deprecated file as current data; surface the condition or fall back to the official source when possible. HoboLeaks updates automatically after TQ patches and may briefly lag or have schema changes, so validate its shape at the loader boundary and keep the source URL, revision, and freshness status observable.

HoboLeaks data is a conversion of CCP-owned data, not an independent authority. Do not commit downloaded HoboLeaks files or hard-code values copied from them. Keep supplemental downloads/cache data outside source control, pin or record the revision used by reproducible builds, and document any HoboLeaks-specific fallback or precedence rule in the relevant loader and README.

### EVE image server

Use CCP's official EVE Image Server directly for EVE artwork; do not download or commit image assets. The base URL is `https://images.evetech.net/{category}/{id}/{variation}`. For type artwork use `https://images.evetech.net/types/{typeId}/icon?size=64`; other supported type variations include `render`, `bpo`, `bpc`, and `relic`. Supported sizes are powers of two from 32 through 1024. The server returns PNGs for these images and is intended to be used as a CDN. Keep the host allowlisted in Next image configuration when using `next/image`.

### Planning

Keep the plan engine deterministic and independent of HTTP, cookies, and React. Give it validated request data, SDE indices, cached inventory, and cached jobs as inputs. It should:

1. Merge eligible character assets and eligible corporation assets.
2. Expand the requested build list through manufacturing, reaction, and invention activities.
3. Apply build and buy blacklists with a documented precedence rule.
4. Subtract available inventory and account for active jobs where enabled.
5. Produce materials-to-buy, BPCs-needed, invention jobs, reaction jobs, manufacturing jobs, and hauling tasks.

Use integer quantities and explicit rounding for runs and products-per-run. Track asset locations when creating hauling tasks. Avoid repeated file reads and unbounded graph traversal; target less than three seconds for typical plans and add bounded/cycle-safe expansion for blueprint graphs.

The current prototype's `quantity` equals runs only by accident. Do not preserve that assumption when introducing real SDE recipes: distinguish requested product quantity, runs, output quantity, and material quantity in the domain types.

## Recommended implementation order

1. Add runtime schemas and focused tests for planning requests/results and shared auth/session data.
2. Complete session helpers and auth/session endpoints, including ownership checks and safe response DTOs.
3. Implement EVE SSO character attach flow, token validation, refresh, and corp authorization.
4. Implement the ESI client and ETag/rate-limit-aware cache plus state refresh/status routes.
5. Add the SDE fetch/parse/type-generation pipeline, loader, normalization, and indices.
6. Replace hard-coded recipes with deterministic SDE-backed planning and test BOM expansion, inventory merge, blacklists, runs, and all six outputs.
7. Add reference endpoints and connect the UI to real characters, item search, locations, refresh status, and plan results.
8. Add deployment/build documentation and a Dockerfile only after the local pipeline is reproducible.

Keep each step independently testable. Avoid broad UI rewrites while server contracts are still settling.

## API and data conventions

- Use `NextResponse.json` with appropriate status codes and stable error shapes.
- Treat request JSON, query strings, ESI responses, and SDE records as untrusted external data.
- Do not expose internal token records. Map them to public character/session DTOs.
- Keep `/api/plan` fast and side-effect free. Refresh belongs in `/api/state/refresh`.
- Include timestamps and cache status in plan/state metadata so stale data is visible to users.
- Preserve the six-list response names in `FullPlan.md` unless a deliberate, documented contract change is required.

## Validation commands

From `eveassemblyline/` run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Run the narrowest relevant test or check first after an edit, then run the broader checks before finishing. If a command cannot run because SDE data or environment variables are missing, report that prerequisite clearly rather than weakening the implementation to hide the failure.

Required environment/configuration should be documented before use, including `EVE_CLIENT_ID`, `EVE_CLIENT_SECRET`, `EVE_CALLBACK_URL`, and `STORAGE_DIR`. Never commit secrets, downloaded SDE data, node-persist data, or generated local artifacts unless the repository explicitly changes that policy.
