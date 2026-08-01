import { loadEnvConfig } from "@next/env";
import type { CacheSetEntry } from "../src/cache/CacheProvider";

function entriesForMap(
  namespace: string,
  version: string,
  values: Map<number, unknown>,
  makeKey: (namespace: string, id: number) => string,
): CacheSetEntry[] {
  return [...values].map(([id, value]) => ({
    key: makeKey(`${version}:${namespace}`, id),
    value,
  }));
}

async function main() {
  loadEnvConfig(process.cwd());
  const { cache } = await import("../src/cache/cache");
  const { SDE_VERSION_KEY, sdeKey } = await import("../src/cache/keys");
  const {
    getBlueprints,
    getBonusDogmaAttributes,
    getMarketGroups,
    getRigDogma,
    getSdeBuildNumber,
    getStations,
    getSystems,
    getTypes,
  } = await import("../src/lib/sde/loader");

  const version = await getSdeBuildNumber();
  if (!/^\d+$/.test(version))
    throw new Error(`Cannot upload SDE cache: build number is "${version}".`);

  if ((await cache.getVersion(SDE_VERSION_KEY)) === version) {
    console.log(`SDE cache for build ${version} is already uploaded; nothing to do.`);
    return;
  }

  const entries: CacheSetEntry[] = [
    entriesForMap("type", version, await getTypes(), sdeKey),
    entriesForMap("marketGroup", version, await getMarketGroups(), sdeKey),
    entriesForMap("system", version, await getSystems(), sdeKey),
    entriesForMap("station", version, await getStations(), sdeKey),
    entriesForMap("rigDogma", version, await getRigDogma(), sdeKey),
    entriesForMap("bonusDogmaAttribute", version, await getBonusDogmaAttributes(), sdeKey),
  ].flat();

  const blueprints = await getBlueprints();
  for (const [namespace, values] of Object.entries(blueprints)) {
    entries.push(...entriesForMap(namespace, version, values as Map<number, unknown>, sdeKey));
  }

  entries.push({ key: SDE_VERSION_KEY, value: version });
  await cache.setMany(entries);
  console.log(`Uploaded ${entries.length} SDE cache entries for build ${version}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
