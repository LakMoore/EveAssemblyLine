import { randomUUID } from "node:crypto";
import { initStorage } from "@/lib/storage";

const storageKey = "esi-request-log";
const maximumLogEntries = 200;
const persistenceDelayMs = 15_000;

export type EsiRequestLog = {
  id: string;
  requestedAt: string;
  method: string;
  path: string;
  characterId?: number;
  status: number | null;
  outcome: "success" | "error";
  durationMs: number;
  error?: string;
  characterName?: string;
  corporationId?: number;
  corporationName?: string;
};

export type EsiRequestLogOutcome = EsiRequestLog["outcome"] | "all";

export type EsiRequestLogPage = {
  logs: EsiRequestLog[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type EsiLoggerRuntime = {
  entries: EsiRequestLog[];
  persistenceTimer?: ReturnType<typeof setTimeout>;
  persistenceRequest?: Promise<void>;
};

const runtime = globalThis as typeof globalThis & {
  __assemblyLineEsiLogger?: EsiLoggerRuntime;
};
const loggerRuntime =
  runtime.__assemblyLineEsiLogger ?? (runtime.__assemblyLineEsiLogger = { entries: [] });

function trimEntries(entries: EsiRequestLog[]) {
  return entries.slice(-maximumLogEntries);
}

function schedulePersistence() {
  if (loggerRuntime.persistenceTimer) return;
  loggerRuntime.persistenceTimer = setTimeout(
    () => {
      loggerRuntime.persistenceTimer = undefined;
      void persistEsiRequestLogs();
    },
    persistenceDelayMs,
  );
}

async function persistEsiRequestLogs() {
  if (loggerRuntime.persistenceRequest) return loggerRuntime.persistenceRequest;
  const request = Promise.resolve()
    .then(async () => {
      const storage = await initStorage();
      const stored = await storage.getItem<EsiRequestLog[]>(storageKey);
      const storedEntries = Array.isArray(stored) ? stored : [];
      await storage.setItem(storageKey, trimEntries([...storedEntries, ...loggerRuntime.entries]));
      loggerRuntime.entries = [];
    })
    .catch(() => {
      // Logging must never make an ESI request fail.
    })
    .finally(() => {
      loggerRuntime.persistenceRequest = undefined;
    });
  loggerRuntime.persistenceRequest = request;
  return request;
}

/** Records one ESI attempt in memory and schedules an asynchronous durable snapshot. */
export function logEsiRequest(entry: Omit<EsiRequestLog, "id">) {
  loggerRuntime.entries = trimEntries([...loggerRuntime.entries, { ...entry, id: randomUUID() }]);
  schedulePersistence();
}

/** Returns recent ESI attempts from Firestore and the current process memory buffer. */
export async function getEsiRequestLogPage(
  page: number,
  pageSize: number,
  outcome: EsiRequestLogOutcome,
): Promise<EsiRequestLogPage> {
  await persistEsiRequestLogs();
  const storage = await initStorage();
  const stored = await storage.getItem<EsiRequestLog[]>(storageKey);
  const entries = Array.isArray(stored) ? stored : [];
  const filteredEntries = [...entries, ...loggerRuntime.entries]
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    .filter((entry) => outcome === "all" || entry.outcome === outcome);
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / pageSize));
  return {
    logs: filteredEntries.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: filteredEntries.length,
    totalPages,
  };
}

/** Purges the in-memory and durable ESI request log. */
export async function clearEsiRequestLogs(): Promise<void> {
  if (loggerRuntime.persistenceTimer) {
    clearTimeout(loggerRuntime.persistenceTimer);
    loggerRuntime.persistenceTimer = undefined;
  }
  await loggerRuntime.persistenceRequest;
  const storage = await initStorage();
  await storage.deleteItem(storageKey);
  loggerRuntime.entries = [];
}
