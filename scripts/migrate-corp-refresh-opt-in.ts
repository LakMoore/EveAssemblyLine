import { initStorage } from "../src/lib/storage";

const characterRecordPrefix = "character:";
const currentOptInField = "allowCorpRefreshOptIn";
const legacyOptInField = "allowCorporationRefreshSharing";
const applyRequested = process.argv.includes("--apply");

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function migrate() {
  const storage = await initStorage();
  return storage.runTransaction(async (transaction) => {
    const entries = await transaction.getItemsByPrefix<unknown>(characterRecordPrefix);
    let changed = 0;
    let malformed = 0;
    for (const entry of entries) {
      if (!isRecord(entry.value) || !Number.isSafeInteger(entry.value.characterId)) {
        malformed += 1;
        continue;
      }
      const hasCurrentValue = typeof entry.value[currentOptInField] === "boolean";
      const hasLegacyValue = typeof entry.value[legacyOptInField] === "boolean";
      if (hasCurrentValue && !hasLegacyValue) continue;
      changed += 1;
      if (!applyRequested) continue;
      const nextRecord: RawRecord = {
        ...entry.value,
        [currentOptInField]: hasCurrentValue
          ? entry.value[currentOptInField]
          : hasLegacyValue
            ? entry.value[legacyOptInField]
            : false,
      };
      delete nextRecord[legacyOptInField];
      transaction.setItem(entry.key, nextRecord);
    }
    return { found: entries.length, changed, malformed };
  });
}

migrate()
  .then((summary) => {
    console.log(`Character records found: ${summary.found}`);
    console.log(`Character records to update: ${summary.changed}`);
    console.log(`Malformed character records retained: ${summary.malformed}`);
    if (!applyRequested) console.log("Dry run only. Re-run with --apply to write the new schema.");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
