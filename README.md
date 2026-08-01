# AssemblyLine

## SDE preparation

SDE files are build/runtime inputs and are intentionally ignored by git. To prepare them locally:

```bash
npm install
npm run sde:prepare
```

The pipeline checks the official CCP/EVE build manifest at `https://developers.eveonline.com/static-data/tranquility/latest.jsonl`, which contains the current `buildNumber`. If `.next/cache/assemblyline-sde/raw/version.json` has the same build number, no archive is downloaded. Otherwise it downloads the official JSONL archive from `https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip`. The archive URL can be overridden with `SDE_URL`, or an existing archive can be used with `SDE_ARCHIVE=/path/to/sde.zip`. The pipeline caches raw JSONL files under `.next/cache/assemblyline-sde/raw/`, converts them to compact JSON arrays in `sde/processed/`, and generates one TypeScript file per table under `src/lib/sde/generated/`, with `src/lib/sde/generated/index.ts` as the barrel export. If the Vercel build cache is unavailable, the raw archive is downloaded again automatically.

Without SDE data the application still builds, but SDE-backed routes should call `ensureSdeLoaded()` and report its setup error.This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

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
