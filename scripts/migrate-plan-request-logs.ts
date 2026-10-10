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

type LegacyStoredRequestLog = {
  id: string;
  endpoint?: unknown;
  requestedAt: string;
  sessionCollectionId?: string;
  rawRequestBody: string;
  rawResponseBody: string;
  responseStatus: number;
};

function isLegacyPlanRequestLog(value: unknown): value is LegacyStoredRequestLog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyStoredRequestLog>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.requestedAt === "string"
    && typeof candidate.rawRequestBody === "string"
    && typeof candidate.rawResponseBody === "string"
    && typeof candidate.responseStatus === "number"
    && (candidate.endpoint === undefined || typeof candidate.endpoint === "string")
  );
}

function parseOptions(): MigrationOptions {
  return { apply: process.argv.includes("--apply") };
}

/** Copies legacy Firestore plan logs into Cloud Storage and metadata documents. */
async function migratePlanRequestLogs(options: MigrationOptions): Promise<void> {
  const storage = await initStorage();
  const stored = await storage.getItemsByPrefix(legacyStorageKeyPrefix);
  let migrated = 0;
  let skipped = 0;
  let malformed = 0;
  let legacyPlanLogs = 0;

  for (const item of stored) {
    if (!isLegacyPlanRequestLog(item.value)) {
      malformed += 1;
      continue;
    }
    if (item.value.endpoint !== "simulate") {
      legacyPlanLogs += 1;
      continue;
    }
    const simulationLog: PlanRequestLog = {
      id: item.value.id,
      endpoint: "simulate",
      requestedAt: item.value.requestedAt,
      storagePath: "",
      sizeBytes: 0,
      sessionCollectionId: item.value.sessionCollectionId,
      rawRequestBody: item.value.rawRequestBody,
      rawResponseBody: item.value.rawResponseBody,
      responseStatus: item.value.responseStatus,
    };
    const existing = await getPlanRequestLog(simulationLog.id);
    if (existing?.storagePath) {
      skipped += 1;
      if (options.apply) await storage.deleteItem(item.key);
      continue;
    }
    if (options.apply) {
      await writePlanRequestLog(simulationLog);
      await storage.deleteItem(item.key);
    }
    migrated += 1;
  }

  console.log(
    `${options.apply ? "Migrated" : "Would migrate"} ${migrated} simulator logs; skipped ${skipped} already migrated simulator logs; left ${legacyPlanLogs} legacy plan logs and ${malformed} malformed records in place.`,
  );
}

void migratePlanRequestLogs(parseOptions()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
