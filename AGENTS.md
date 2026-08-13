# AGENTS.md

This repo uses `.github/copilot-instructions.md` as the primary source of truth for coding standards, architecture, and review guidance. This file is a thin agent workflow supplement for automated tooling and the command sequence to use in this repository.

The workspace root is the application root, which contains `package.json`. Run all project commands from this directory unless the task explicitly says otherwise.

## Project overview

AssemblyLine is a Next.js 16 App Router application for planning large EVE Online manufacturing projects. It includes a server-backed planning engine, Firestore-backed auth/storage primitives, ESI/state refresh flow, SDE processing, and a dark technical UI for operations-focused planning.

## Repo layout

- `.github/copilot-instructions.md` — house style, architecture, security, API validation, and implementation guidance.
- `src/` — application code, planning logic, and server routes.
- `scripts/` — SDE fetch/parse/generation utilities.
- `sde/` and `data/` — processed or cached runtime data inputs.
- `README.md` — human-facing setup and environment notes.

## Build, lint, and validation workflow

Use the project commands from the repository root:

```bash
npm run lint
npm run format
npm run format:check
npm run typecheck
npm run build
```

Operational rule for agentic edits:

- Run `npm run lint` before formatting.
- Run `npm run format` after linting to apply Prettier to the edited codebase.
- Re-run the narrowest relevant validation for the change, then finish with the broader verification commands above when appropriate.
- Do not treat Prettier as a substitute for linting or TypeScript validation.

## Agent conventions

- Read the relevant implementation and nearby design notes before editing.
- Keep changes focused to the owning module and avoid unrelated refactors.
- Prefer strict TypeScript typing, double quotes, semicolons, and the `@/*` alias already used in the project.
- Keep API boundaries validated, server-only secrets out of client code, and mock data clearly isolated from production paths.
- For multiline boolean expressions, prefer the leading-operator style:

```ts
const allowed =
  boolA
  && (
    boolB
    || boolC
  );
```

This is a readability preference for review, not a replacement for the repo's lint and format checks.

## Notes for automation

- Keep `AGENTS.md` small and workflow-focused; use `.github/copilot-instructions.md` for detailed coding standards.
- Respect the current Next.js 16 App Router conventions and re-read the local `node_modules/next/dist/docs/` guidance before changing framework APIs.
- If SDE or environment setup is missing, do not hide the prerequisite; report the missing setup requirement clearly.
