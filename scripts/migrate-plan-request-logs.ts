import { initStorage } from "../src/lib/storage";
import {
  getPlanRequestLog,
  type PlanRequestLog,
  writePlanRequestLog,
} from "../src/lib/planning/planRequestLogger";

const legacyStorageKeyPrefix = "plan-request-log:";

type MigrationOptions = {
  apply: boolean;
};

function isLegacyPlanRequestLog(value: unknown): value is PlanRequestLog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlanRequestLog>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.requestedAt === "string"
    && typeof candidate.rawRequestBody === "string"
    && typeof candidate.rawResponseBody === "string"
    && typeof candidate.responseStatus === "number"
  );
}

function parseOptions(): MigrationOptions {
  return { apply: process.argv.includes("--apply") };
}

/** Copies legacy Firestore plan logs into Cloud Storage and metadata documents. */
async function migratePlanRequestLogs(options: MigrationOptions): Promise<void> {
  const storage = await initStorage();
  const stored = await storage.getItemsByPrefix<unknown>(legacyStorageKeyPrefix);
  let migrated = 0;
  let skipped = 0;
  let malformed = 0;
  let deletedMalformed = 0;

  for (const item of stored) {
    if (!isLegacyPlanRequestLog(item.value)) {
      malformed += 1;
      if (options.apply) {
        await storage.deleteItem(item.key);
        deletedMalformed += 1;
      }
      continue;
    }
    const existing = await getPlanRequestLog(item.value.id);
    if (existing?.storagePath) {
      skipped += 1;
      if (options.apply) await storage.deleteItem(item.key);
      continue;
    }
    if (options.apply) {
      await writePlanRequestLog(item.value);
      await storage.deleteItem(item.key);
    }
    migrated += 1;
  }

  console.log(
    `${options.apply ? "Migrated" : "Would migrate"} ${migrated} plan logs; skipped ${skipped} already migrated logs; ${options.apply ? "deleted" : "would delete"} ${options.apply ? deletedMalformed : malformed} malformed records.`,
  );
}

void migratePlanRequestLogs(parseOptions()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
