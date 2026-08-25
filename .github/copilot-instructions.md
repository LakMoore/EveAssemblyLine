# AssemblyLine agent instructions

## Project context

AssemblyLine is a Next.js App Router application for planning large EVE Online manufacturing projects. The authoritative product and architecture plan is [CurrentPlan.md](../CurrentPlan.md). The application supports EVE SSO, multiple attached characters, server-side ESI calls, static SDE data, Firestore persistence, inventory-aware planning, and six plan output lists.

The repository root is the application root and contains `package.json`. Run project commands from this directory unless a task explicitly requires a different working directory.

The repository is currently an early prototype, not a completed implementation of CurrentPlan.md:

- `src/app/page.tsx` is a client-side prototype with hard-coded characters, locations, and sample build items.
- `src/lib/planning/planEngine.ts` uses two hard-coded recipes and does not yet use SDE or cached assets.
- `src/app/api/plan/route.ts` validates only a small part of the request and does not yet validate a session or character ownership.
- `src/lib/storage.ts`, `src/lib/auth/model.ts`, and `src/lib/auth/tokensStore.ts` provide the initial Firestore-backed persistence primitives.
- EVE SSO, app sessions, ESI clients/cache, SDE processing/loading, character/corporation routes, state refresh routes, reference routes, and automated planning tests are not yet implemented.

Do not present prototype data as live EVE data. When replacing a mock path, keep the UI usable and make loading, unauthenticated, stale, rate-limited, and error states explicit.

## Working rules

- Create well commented and easily readable code.
- The SDE is in place and cached in memory on the server.  Don't use hard-coded recipes or fallback values in production paths. Group IDs or Type IDs may be used when dealing with the large Dogma dataset in the SDE, but do not hard-code values or lists for build recipes, materials, or products.
- Prioritise readability of the main function over local convenience. Nested helper functions are acceptable only when they are very small and obvious; otherwise, extract them so the caller reads linearly from top to bottom. Treat closures as a useful tool, not the default, and prefer explicit parameters if that makes the code easier to follow.
- Read the nearby implementation and relevant section of `CurrentPlan.md` before editing. Keep changes focused on the owning module.
- Keep methods short, with low complexity and a single responsibility.
- Name methods and variables clearly, using descriptive names that convey their purpose and intent.
- Rename variables and methods when their purpose changes, rather than leaving misleading names in place.
- Follow the existing TypeScript style: strict typing, double quotes, semicolons, the `@/*` alias, and small focused modules.
- Generate well-commented code: add concise comments before non-obvious algorithms, data-flow boundaries, and important invariants.
- Add JSDoc-style comments to all functions, classes, and types. Include parameter and return types, and describe the purpose of the function or class. Add links to relevant EVE Online documentation or SDE/ESI references when applicable.
- Keep server-only code and secrets out of client components. Never send access tokens or refresh tokens to the browser, log them, or include them in error messages.
- Validate and narrow all external input at API boundaries by defining the API schema and using Zod's safeParse and associated methods. Do not rely on a TypeScript cast as runtime validation. Reject malformed IDs, quantities, locations, settings, and character selections with useful 4xx responses.
- Use Next.js App Router conventions already in the project. This project uses Next.js 16; before changing framework APIs, consult the relevant guide under `node_modules/next/dist/docs/` as required by `AGENTS.md`.
- Prefer existing platform and repository APIs over new abstractions. Firestore is the durable server-side store for accounts, sessions, tokens, and pending SSO state; SDE remains static build/runtime data.
- Do not add fake ESI responses or silently fall back to hard-coded recipes in production paths. Test fixtures belong in tests or explicitly named fixture modules.
- ESI endpoints that require a character token must be called server-side. Do not call ESI from the client or expose a character token to the browser.  The call should not be made as part of any request except `/api/state/refresh`.  The refresh route should be called from the client, but the ESI call itself must be server-side.  Cache the various responses from the ESI endpoints, with useful indexes and cache the status of the most recent request.  Report the status of the refresh in `/api/state`.
- For formatting workflow, run `npm run lint`, then `npm run format`, and only then do additional validation or issue triage. Prettier is the final style pass, not a substitute for linting.

### Component reuse and UI consistency

- Components in `src/components/ui/` (e.g. `button.tsx`, `card.tsx`, `dialog.tsx`) are base shadcn/ui components. Treat them as mostly immutable.
-	Do not modify files in `src/components/ui/` directly unless explicitly instructed.
-	For project-specific behaviour, layout, or styling:
    -	Create wrapper components outside `src/components/ui/` (e.g.  `src/components/app-button.tsx`,  `src/components/app-card.tsx`,  `src/components/app-dialog.tsx`).
    -	Import the base shadcn/ui component and apply custom Tailwind classes, props, or logic in the wrapper.
    -	Use these wrappers throughout the app instead of the raw `src/components/ui/*` components when custom behaviour is needed.
-	When an upstream update is needed for a base component:
    -	Use `npx shadcn@latest diff` (or `npx shadcn@latest diff <component> `) to inspect changes to an individual components.
    - Use the local script `npm run shadcn:drift` to inspect all components for drift from the upstream shadcn/ui registry.
    -	Use `npx shadcn@latest add <component> --overwrite ` only after confirming there are no important local changes.
    - Manually migrate the changes to a wrapper first, if you have customised the base file.
    -	If you are unsure whether to edit a base component or create a wrapper, default to creating a wrapper.

- Before creating or copying a UI component, inspect `src/components/ui` and `src/components`, nearby page components, and the relevant shadcn configuration and agent skill for an existing solution. Reuse the existing component or wrapper when it covers the behavior, and extend it by making a new wrapper only when the missing behavior is broadly useful.
- If a shadcn component exists for the required control or feedback state, import and use that shadcn component rather than implementing a native or app-local replacement. Follow the installed `base-nova`/Base UI implementation and existing local APIs; do not introduce a second primitive library or a competing wrapper for the same behavior.
- Components added or substantially changed earlier in the current task or thread are especially strong reuse candidates. In this codebase, check for and use the shared `Alert`, `Badge`, `Button`, `Dialog`, `Empty`, `Field`, `Input`, `Label`, `Select`, `Skeleton`, `Spinner`, `Switch`, `Tabs`, and `Textarea` components.  Do not create a new component that duplicates the behavior of an existing shared component.  If a new component is needed, first confirm that the behavior is genuinely new. Create components that wrap one or more shadcn ui components in `src/components`, for easy ingestion on other pages. Document the reason in the change when the new component intentionally does not use an available shadcn primitive.
- Treat an official shadcn component and a project-local wrapper as different things. A wrapper that uses Base UI primitives is not permission to claim or recreate a shadcn component; reuse it as an existing project component, but do not create another competing implementation.
- If the official shadcn registry or package runner is unavailable, do not hand-author a replacement "shadcn-style" component and do not silently substitute a different primitive library. Leave the current control in place when it remains usable, report the registry/install blocker, and defer the migration until the official component can be installed or explicitly approved as a new project-local component.
- When updating an existing page, preserve its domain-specific copy, data flow, and behavior while also taking the opportunity to migrate to shadcn primitives or a wrapper of those primitives. Remove legacy CSS style and defer to Tailwind in the primitive, wrapper, or on the page for structural placement.
- Do not make a new component solely to avoid adapting an existing shared component.

***

## Styling architecture: shadcn/ui + Tailwind (no new CSS Modules)

This project uses **shadcn/ui components** as the primary UI building blocks, with **Tailwind CSS** for layout/structure and **CSS variable tokens** in `globals.css` for theming. The goal is:

- Rely on shadcn/ui’s **default styling** unless there is an explicit reason to override.
- Use Tailwind utilities **only for structural needs** (layout, spacing, sizing, positioning).
- Work towards **no `.module.css` files** for UI components.

### 1. Prefer shadcn/ui defaults

shadcn/ui components already include Tailwind classes that implement the design system. They are styled via semantic CSS variables such as:

- `--background`, `--foreground`
- `--primary`, `--primary-foreground`
- `--secondary`, `--muted`, `--accent`
- `--border`, `--ring`, `--radius`
- etc.

These variables are defined in `app/globals.css` under `:root` and `.dark`.

**Agent rules:**

- When using a shadcn/ui component (e.g. `Button`, `Card`, `Input`, `Dialog`):
  - Assume its **default appearance is correct** unless the user explicitly requests a visual change.
  - Do **not** add colour, font, radius, shadow, or other thematic overrides “just in case”.
  - Do **not** assume you must provide styling for the component to look correct.
- If a visual change is requested:
  - First consider changing the relevant **CSS variable in `globals.css`** (e.g. `--primary`, `--radius`) so all components update consistently.
  - Only override styles, using tailwind, on a specific component instance if the request is clearly scoped to that instance (e.g. “this button should be full‑width and muted”).

### 2. Use Tailwind for structure, not theme

Tailwind is used primarily for **structural concerns**:

- Layout: `flex`, `grid`, `block`, `inline-flex`, etc.
- Spacing: `p-*`, `m-*`, `gap-*`
- Sizing: `w-*`, `h-*`, `min-w-*`, `max-w-*`
- Positioning: `relative`, `absolute`, `sticky`, `top-*`, `z-*`
- Alignment: `items-*`, `justify-*`, `self-*`

Thematic concerns (colours, fonts, radii, shadows) should **normally come from shadcn/ui’s defaults** or from **CSS variables**, not from arbitrary Tailwind colour/font utilities.

**Agent rules:**

- When wrapping or arranging shadcn/ui components:
  - Add Tailwind classes to the **wrapper** or to the component’s `className` prop **only for structural needs**.
  - Examples:
    - `<div className="flex flex-col gap-4">` to layout a form.
    - `<Card className="w-full max-w-md">` to control width.
    - `<Button className="w-full">` to make a button full‑width.
- Do not add thematic Tailwind classes (e.g. `bg-blue-600`, `text-gray-500`, `rounded-lg`, `shadow-md`) unless:
  - The user explicitly asks for a non‑standard visual treatment, **and**
  - It cannot be achieved more cleanly by adjusting tokens in `globals.css`.

### 3. Theming via `globals.css` tokens

All visual design decisions live in **`app/globals.css`** via CSS variables.

**Agent rules:**

- If you identify a genuine, reusable thematic need (e.g. a new semantic colour like “success” or a new surface variant):
  - Propose adding a new CSS variable in `globals.css` (for both `:root` and `.dark`), using a semantic name (e.g. `--success`, `--success-foreground`, `--surface-muted`).
  - Propose the corresponding Tailwind mapping if needed (e.g. via `@theme inline` or `tailwind.config`), so utilities like `bg-success` can be used.
  - Use the new token via utilities (e.g. `bg-success`, `text-success-foreground`) instead of hard‑coded values.
- Do **not** hard‑code colours, fonts, radii, or shadows in components. Always go through:
  - shadcn/ui’s existing tokens (`bg-background`, `text-primary`, etc.), or
  - New/extended tokens in `globals.css`.

### 4. No new `.module.css` files

The long‑term goal is **no per‑component CSS Modules** for UI.

**Agent rules:**

- Do **not** create new `.module.css` files for components that use shadcn/ui or standard Tailwind.
- When editing an existing component that has a `.module.css` file:
  - If the styles are structural (layout, spacing, sizing, positioning):
    - Consider removing the style rule so that the layout is expressed via Tailwind classes from the component or primitive instead.
    - If unique to that component, migrate them to Tailwind utilities in TSX.
  - If the styles are thematic (colours, fonts, radii, shadows):
    - Replace them with token‑based utilities (`bg-background`, `text-foreground`, etc.) or adjust tokens in `globals.css` if the change should be global.
  - Once the component no longer needs its `.module.css` file, **delete it**.
- Keep `.module.css` only for exceptional cases that truly cannot be expressed with Tailwind + shadcn/ui (e.g. complex animations, very specific selectors), and only when migration cost is not justified yet.
- If we're ever concerned that the UI components are drifting from shadcn/ui defaults, run `npm run shadcn:drift` to report on the differences between local and upstream versions.

### 5. Typical patterns

Use patterns like:

```tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function Example() {
  return (
    <div className="flex flex-col gap-4 w-full max-w-md">
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground">
            This card uses shadcn/ui defaults; only structural classes are added.
          </p>
        </CardContent>
      </Card>

      <Button className="w-full">Full-width button, default theme</Button>
    </div>
  );
}
```

Notes:

- No `.module.css` is created or assumed.
- shadcn/ui components keep their default look.
- Tailwind classes are used only for layout/size/spacing.

### 6. Summary of agent behaviour

When working on UI:

1. **Default to shadcn/ui styling** – assume components look correct as‑is.
2. **Add Tailwind classes only for structure** (layout, spacing, sizing, positioning).
3. **Change theme via `globals.css` tokens**, not by hard‑coding styles in components.
4. **Do not create new `.module.css` files**; migrate existing ones away over time.
5. If a new thematic token is needed, propose the exact `globals.css` changes and Tailwind mapping.

Follow this architecture consistently. Do not fall back to adding rules in `.module.css` or other CSS files unless there is a clearly justified exception as described above.

## Formatting and readability rules

- Add comments to explain non-obvious algorithms, data-flow boundaries, and important invariants and methods.
- Keep methods short, with low complexity and a single responsibility.
- Name methods and variables clearly, using descriptive names that convey their purpose and intent.
- Rename variables and methods when their purpose changes, rather than leaving misleading names in place.
- Keep code formatted in the repo's current style: semicolons, double quotes, trailing commas, and a 100-column line width.
- Prefer the leading-operator layout for multiline boolean expressions so the condition reads naturally in review:

```ts
const allowed =
  boolA
  && (
    boolB
    || boolC
  );
```

- Do not reformat unrelated code while making a targeted fix. Keep the edit focused and let the repo-wide format pass clean up simple style drift only after linting succeeds.
- Do not format or lint generated SDE JSONL or TypeScript files.  These files are generated by the SDE pipeline and should not be edited or reformatted manually.
- Do not format or lint shadcn/ui components in `src/components/ui/`.  These files are generated by the shadcn registry and should not be edited or reformatted manually.

## Architecture boundaries

### Authentication and sessions

Use HttpOnly, secure-in-production, same-site cookies for the app session. A session owns a list of attached character IDs; every character, corp, state, and plan operation must verify that requested IDs belong to the current session. Store character tokens only through the auth store and refresh/persist rotated refresh tokens.

EVE SSO state and PKCE values must be unpredictable, bound to the initiating session/character, single-use, and checked on callback. Validate token issuer, audience, expiry, subject, and signature according to EVE documentation. Corp authorization will be implicit based primarily on the Director Role.  There is no separate Corp Auth.Verify the required corporation role before enabling corporation assets.

### ESI and state cache

All ESI calls are server-side. Centralize token refresh and ESI request behavior in the ESI client. Respect access-token expiry, `304`, `429`, `Retry-After`, cache-control, and ESI rate-limit/error-limit headers.  ETag may be used in-memory only and should not be committed to the shared cache with tokens. `/api/plan` must use cached state only and must never call ESI synchronously.

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
- Validate all external input at the API boundary and narrow it to a safe internal type before passing it to the plan engine or other internal modules. Use Zod's `safeParse` and associated methods for validation.
- Persist and transmit stable numeric IDs rather than localized or display type names. Users may change language at any time, so names must never be the identifier used by a stored record or API request.
- Do not expose internal token records. Map them to public character/session DTOs.
- Keep `/api/plan` fast and side-effect free. Refresh belongs in `/api/state/refresh`.
- Include timestamps and cache status in plan/state metadata so stale data is visible to users.
- Preserve the six-list response names in `CurrentPlan.md` unless a deliberate, documented contract change is required.

## Validation commands

From `eveassemblyline/` run:

```bash
npm run typecheck
npm run lint
npm run format
npm run build
```

Run the narrowest relevant test or check first after an edit, then run the broader checks before finishing. If a command cannot run because SDE data or environment variables are missing, report that prerequisite clearly rather than weakening the implementation to hide the failure.

## Local development notes

- The root contains the Next.js App Router project (`package.json`, `src/`, `scripts/`, `sde/`, `data/`, and `node_modules/`) and repository-level planning documents such as `CurrentPlan.md`.
- `src/lib/storage.ts` uses Firebase Admin Firestore and stores one document per logical key in the `assemblyLineStorage` collection. Firebase App Hosting may use Application Default Credentials; local development can use `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`. Keep all service-account values server-only and never log tokens.
- Firestore is the durable store, not the full SDE cache. Keep processed SDE data in build/runtime inputs and process memory. Upstash Redis is not the production SDE cache because its observed latency was too high for that workload.
- For one-off TypeScript probes, use `tsx -e` from the application root. Because the project uses CommonJS output, put asynchronous code in an async IIFE rather than using top-level `await`:

  ```bash
  npx tsx -e '(async () => { const loaded = await import("./src/lib/storage.ts"); const api = loaded.initStorage ? loaded : loaded.default; const store = await api.initStorage(); console.log(await store.getItem("accounts")); })();'
  ```

  Dynamic imports from `tsx -e` may be exposed through a CommonJS default wrapper, so support both `loaded.initStorage` and `loaded.default` when probing local modules.

- For isolated storage probes, use a separate Firebase project/database or emulator configuration. Do not point probes at production Firestore or attempt to recreate the old `STORAGE_DIR` behavior:

  ```bash
  FIREBASE_PROJECT_ID=assembly-line-test npx tsx -e '/* async probe */'
  ```

- `npm install` fails with an `EPERM` error because of root-owned cache files. Do not change ownership or use `sudo` from the agent. Use a writable temporary cache instead:

  ```bash
  npm_config_cache="$TMPDIR/assemblyline-npm-cache" npm install <package>
  ```

Required environment/configuration should be documented before use, including `EVE_CLIENT_ID`, `EVE_CLIENT_SECRET`, and `EVE_CALLBACK_URL`. Firebase App Hosting requires no Firebase-specific variables when its runtime service account and `FIREBASE_CONFIG` are available; local ADC or the optional `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` variables may be used for development. Never commit secrets, downloaded SDE data, Firestore credentials, or generated local artifacts unless the repository explicitly changes that policy.
