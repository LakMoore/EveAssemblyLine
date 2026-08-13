import { cache } from "../src/cache/cache";
import { getSdeBuildNumber } from "../src/cache/services/sdeCache";

const deleteRequested = process.argv.includes("--delete");
const sdeKeyPattern = /^sde:([^:]+):/;
const deleteBatchSize = 500;

async function main() {
  const currentBuild = await getSdeBuildNumber();
  if (!/^\d+$/.test(currentBuild)) {
    throw new Error(`Cannot clean SDE cache: current build number is "${currentBuild}".`);
  }

  let matchingKeyCount = 0;
  let oldKeyCount = 0;
  let deleteBatch: string[] = [];
  for await (const key of cache.scan("sde:*:*")) {
    matchingKeyCount += 1;
    const version = key.match(sdeKeyPattern)?.[1];
    const isOldVersion =
      version !== undefined && /^\d+$/.test(version) && BigInt(version) < BigInt(currentBuild);
    if (!isOldVersion) continue;

    oldKeyCount += 1;
    if (deleteRequested) {
      deleteBatch.push(key);
      if (deleteBatch.length >= deleteBatchSize) {
        await cache.delete(deleteBatch);
        deleteBatch = [];
      }
    }
  }

  if (deleteRequested && deleteBatch.length > 0) await cache.delete(deleteBatch);

  console.log(`Current SDE build: ${currentBuild}`);
  console.log(`Matching SDE keys: ${matchingKeyCount}`);
  console.log(`Old SDE keys: ${oldKeyCount}`);

  if (!deleteRequested) {
    console.log("Dry run only. Re-run with --delete to remove old SDE keys.");
    return;
  }

  console.log(`Deleted old SDE keys: ${oldKeyCount}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
