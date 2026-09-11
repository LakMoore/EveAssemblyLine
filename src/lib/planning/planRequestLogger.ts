import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { after } from "next/server";
import { discordLogger } from "@/lib/discordLogger";
import { getFirebaseApp } from "@/lib/storage";

const planRequestsCollection = "planRequests";
const planLogStoragePrefix = "plan-logs";
const maximumMemoryEntries = 100;

/** The raw request and response retained for one plan calculation. */
export type PlanRequestLog = {
  id: string;
  requestedAt: string;
  storagePath: string;
  sizeBytes: number;
  sessionCollectionId?: string;
  rawRequestBody: string;
  rawResponseBody: string;
  responseStatus: number;
};

export type PlanRequestLogMetadata = Omit<PlanRequestLog, "rawRequestBody" | "rawResponseBody">;

export type PlanRequestLogPage = {
  logs: PlanRequestLogMetadata[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type PlanRequestLogCleanupResult = {
  eligible: number;
  deleted: number;
  failed: number;
};

type PlanRequestLogInput = Omit<PlanRequestLog, "id" | "storagePath" | "sizeBytes"> & {
  id?: string;
};

type PlanLoggerRuntime = {
  entries: Map<string, PlanRequestLog>;
};

const runtime = globalThis as typeof globalThis & {
  __assemblyLinePlanLogger?: PlanLoggerRuntime;
};
const loggerRuntime =
  runtime.__assemblyLinePlanLogger ?? (runtime.__assemblyLinePlanLogger = { entries: new Map() });

function storagePath(id: string) {
  return `${planLogStoragePrefix}/${id}.json.gz`;
}

function remember(entry: PlanRequestLog) {
  loggerRuntime.entries.set(entry.id, entry);
  while (loggerRuntime.entries.size > maximumMemoryEntries) {
    const oldestId = loggerRuntime.entries.keys().next().value;
    if (oldestId === undefined) break;
    loggerRuntime.entries.delete(oldestId);
  }
}

function toMetadata(entry: PlanRequestLog): PlanRequestLogMetadata {
  const { rawRequestBody: _rawRequestBody, rawResponseBody: _rawResponseBody, ...metadata } = entry;
  return metadata;
}

function getStorageBucket() {
  const app = getFirebaseApp();
  const storage = getStorage(app);
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET ?? app.options.storageBucket;
  if (!bucketName) {
    throw new Error(
      "Firebase Storage bucket is not configured. Set FIREBASE_STORAGE_BUCKET for plan logs.",
    );
  }
  return storage.bucket(bucketName);
}

function parseStoredBlob(value: Buffer, id: string): PlanRequestLog | undefined {
  try {
    const content =
      value[0] === 0x1f && value[1] === 0x8b
        ? gunzipSync(value).toString("utf8")
        : value.toString("utf8");
    const parsed = JSON.parse(content) as {
      requestId?: unknown;
      rawRequestBody?: unknown;
      rawResponseBody?: unknown;
    };
    if (
      parsed.requestId !== id
      || typeof parsed.rawRequestBody !== "string"
      || typeof parsed.rawResponseBody !== "string"
    ) {
      return undefined;
    }
    return {
      id,
      requestedAt: "",
      storagePath: storagePath(id),
      sizeBytes: value.byteLength,
      rawRequestBody: parsed.rawRequestBody,
      rawResponseBody: parsed.rawResponseBody,
      responseStatus: 0,
    };
  }
  catch {
    return undefined;
  }
}

/** Writes the compressed request blob before its metadata reference. */
export async function writePlanRequestLog(entry: PlanRequestLog): Promise<void> {
  const blob = gzipSync(
    JSON.stringify({
      requestId: entry.id,
      rawRequestBody: entry.rawRequestBody,
      rawResponseBody: entry.rawResponseBody,
    }),
  );
  const path = storagePath(entry.id);
  remember({ ...entry, storagePath: path, sizeBytes: blob.byteLength });
  try {
    const bucket = getStorageBucket();
    await bucket
      .file(path)
      .save(
        blob,
        {
          resumable: false,
          metadata: {
            contentType: "application/json",
            contentEncoding: "gzip",
          },
        },
      );
    const database = getFirestore(getFirebaseApp());
    await database
      .collection(planRequestsCollection)
      .doc(entry.id)
      .set({
        requestId: entry.id,
        storagePath: path,
        sizeBytes: blob.byteLength,
        createdAt: Timestamp.fromDate(new Date(entry.requestedAt)),
        summary: {
          responseStatus: entry.responseStatus,
          ...(entry.sessionCollectionId ? { sessionCollectionId: entry.sessionCollectionId } : {}),
        },
      });
  }
  catch (error) {
    try {
      await getStorageBucket().file(path).delete({ ignoreNotFound: true });
    }
    catch {
      // Cleanup is best effort because logging must never affect plan requests.
    }
    throw error;
  }
}

async function persistPlanRequestLog(entry: PlanRequestLog): Promise<void> {
  try {
    await writePlanRequestLog(entry);
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error";
    console.error("Could not persist plan request log", entry.id, errorMessage);
    await discordLogger.error(
      "Could not persist plan request log",
      {
        requestId: entry.id,
        error: errorMessage,
      },
    );
  }
}

/** Assigns an ID and schedules durable persistence without delaying the plan response. */
export function logPlanRequest(entry: PlanRequestLogInput): string {
  const id = entry.id ?? randomUUID();
  const completeEntry: PlanRequestLog = {
    ...entry,
    id,
    storagePath: storagePath(id),
    sizeBytes: 0,
  };
  remember(completeEntry);
  after(() => persistPlanRequestLog(completeEntry));
  return id;
}

/** Loads one plan request log, preferring the current process memory. */
export async function getPlanRequestLog(id: string): Promise<PlanRequestLog | undefined> {
  const remembered = loggerRuntime.entries.get(id);
  if (remembered) return remembered;
  const database = getFirestore(getFirebaseApp());
  const snapshot = await database.collection(planRequestsCollection).doc(id).get();
  if (snapshot.exists) {
    const metadata = snapshot.data() as {
      requestId?: string;
      storagePath?: string;
      sizeBytes?: number;
      createdAt?: Timestamp;
      summary?: { responseStatus?: number; sessionCollectionId?: string };
    };
    if (metadata.requestId === id && metadata.storagePath) {
      const [contents] = await getStorageBucket().file(metadata.storagePath).download();
      const blob = parseStoredBlob(contents, id);
      if (blob) {
        return {
          ...blob,
          requestedAt: metadata.createdAt?.toDate().toISOString() ?? "",
          storagePath: metadata.storagePath,
          sizeBytes: metadata.sizeBytes ?? contents.byteLength,
          responseStatus: metadata.summary?.responseStatus ?? 0,
          sessionCollectionId: metadata.summary?.sessionCollectionId,
        };
      }
    }
  }

  return undefined;
}

/** Loads a time-ordered page of plan request logs from Firestore and process memory. */
export async function getPlanRequestLogPage(
  page: number,
  pageSize: number,
): Promise<PlanRequestLogPage> {
  const database = getFirestore(getFirebaseApp());
  const collection = database.collection(planRequestsCollection);

  const [snapshot, countSnapshot] = await Promise.all([
    collection
      .orderBy("createdAt", "desc")
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
    collection.count().get(),
  ]);
  const entries = new Map<string, PlanRequestLogMetadata>();
  for (const document of snapshot.docs) {
    const value = document.data() as {
      requestId?: string;
      storagePath?: string;
      sizeBytes?: number;
      createdAt?: Timestamp;
      summary?: { responseStatus?: number; sessionCollectionId?: string };
    };
    if (!value.requestId || !value.storagePath) continue;
    entries.set(
      value.requestId,
      {
        id: value.requestId,
        requestedAt: value.createdAt?.toDate().toISOString() ?? "",
        storagePath: value.storagePath,
        sizeBytes: value.sizeBytes ?? 0,
        responseStatus: value.summary?.responseStatus ?? 0,
        sessionCollectionId: value.summary?.sessionCollectionId,
      },
    );
  }

  if (page === 1) {
    for (const entry of loggerRuntime.entries.values()) entries.set(entry.id, toMetadata(entry));
  }
  const orderedEntries = [...entries.values()].sort((left, right) =>
    right.requestedAt.localeCompare(left.requestedAt),
  );
  const total = Math.max(countSnapshot.data().count, orderedEntries.length);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    logs: page === 1 ? orderedEntries.slice(0, pageSize) : orderedEntries,
    page,
    pageSize,
    total,
    totalPages,
  };
}

/** Removes old Cloud Storage blobs and their Firestore metadata references. */
export async function cullPlanRequestLogs(
  before: Date,
  apply: boolean,
): Promise<PlanRequestLogCleanupResult> {
  const database = getFirestore(getFirebaseApp());
  const snapshot = await database
    .collection(planRequestsCollection)
    .where("createdAt", "<", Timestamp.fromDate(before))
    .orderBy("createdAt", "asc")
    .get();
  const bucket = apply ? getStorageBucket() : undefined;
  const result: PlanRequestLogCleanupResult = { eligible: snapshot.size, deleted: 0, failed: 0 };

  for (const document of snapshot.docs) {
    const value = document.data() as { requestId?: string; storagePath?: string };
    if (!value.requestId || !value.storagePath) {
      result.failed += 1;
      continue;
    }
    if (!apply) continue;
    try {
      if (!bucket) throw new Error("Plan request log storage is unavailable.");
      await bucket.file(value.storagePath).delete({ ignoreNotFound: true });
      await document.ref.delete();
      loggerRuntime.entries.delete(value.requestId);
      result.deleted += 1;
    }
    catch {
      result.failed += 1;
    }
  }

  return result;
}
