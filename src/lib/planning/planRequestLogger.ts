import { randomUUID } from "node:crypto";
import { initStorage } from "@/lib/storage";

const storageKeyPrefix = "plan-request-log:";
const maximumMemoryEntries = 100;

/** The raw request and response retained for one plan calculation. */
export type PlanRequestLog = {
  id: string;
  requestedAt: string;
  sessionCollectionId?: string;
  rawRequestBody: string;
  rawResponseBody: string;
  responseStatus: number;
};

export type PlanRequestLogPage = {
  logs: PlanRequestLog[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type PlanLoggerRuntime = {
  entries: Map<string, PlanRequestLog>;
};

const runtime = globalThis as typeof globalThis & {
  __assemblyLinePlanLogger?: PlanLoggerRuntime;
};
const loggerRuntime =
  runtime.__assemblyLinePlanLogger ?? (runtime.__assemblyLinePlanLogger = { entries: new Map() });

function storageKey(id: string) {
  return `${storageKeyPrefix}${id}`;
}

function remember(entry: PlanRequestLog) {
  loggerRuntime.entries.set(entry.id, entry);
  while (loggerRuntime.entries.size > maximumMemoryEntries) {
    const oldestId = loggerRuntime.entries.keys().next().value;
    if (oldestId === undefined) break;
    loggerRuntime.entries.delete(oldestId);
  }
}

/** Writes one log to its own Firestore document so concurrent requests do not overwrite each other. */
async function persistPlanRequestLog(entry: PlanRequestLog): Promise<void> {
  const storage = await initStorage();
  await storage.setItem(storageKey(entry.id), entry);
}

/** Assigns an ID and waits for durable persistence to complete. */
export async function logPlanRequest(
  entry: Omit<PlanRequestLog, "id"> & { id?: string },
): Promise<string> {
  const id = entry.id ?? randomUUID();
  const completeEntry = { ...entry, id };
  remember(completeEntry);
  await persistPlanRequestLog(completeEntry);
  return id;
}

/** Loads one plan request log, preferring the current process memory. */
export async function getPlanRequestLog(id: string): Promise<PlanRequestLog | undefined> {
  const remembered = loggerRuntime.entries.get(id);
  if (remembered) return remembered;
  const storage = await initStorage();
  return storage.getItem<PlanRequestLog>(storageKey(id));
}

/** Loads a time-ordered page of plan request logs from Firestore and process memory. */
export async function getPlanRequestLogPage(
  page: number,
  pageSize: number,
): Promise<PlanRequestLogPage> {
  const storage = await initStorage();
  const stored = await storage.getItemsByPrefix<PlanRequestLog>(storageKeyPrefix);
  const entries = new Map<string, PlanRequestLog>();
  for (const item of stored) {
    if (item.value) entries.set(item.value.id, item.value);
  }
  for (const entry of loggerRuntime.entries.values()) entries.set(entry.id, entry);
  const orderedEntries = [...entries.values()].sort((left, right) =>
    right.requestedAt.localeCompare(left.requestedAt),
  );
  const totalPages = Math.max(1, Math.ceil(orderedEntries.length / pageSize));
  return {
    logs: orderedEntries.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: orderedEntries.length,
    totalPages,
  };
}
