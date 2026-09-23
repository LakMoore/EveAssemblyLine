import type { PlanRequestLog } from "./planRequestLogger";

/** Validates the retained plan-log DTO returned to administrator pages. */
export function isPlanRequestLog(value: unknown): value is PlanRequestLog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string"
    && (candidate.endpoint === "plan" || candidate.endpoint === "simulate")
    && typeof candidate.requestedAt === "string"
    && typeof candidate.storagePath === "string"
    && typeof candidate.sizeBytes === "number"
    && Number.isFinite(candidate.sizeBytes)
    && candidate.sizeBytes >= 0
    && (
      candidate.sessionCollectionId === undefined
      || typeof candidate.sessionCollectionId === "string"
    )
    && typeof candidate.rawRequestBody === "string"
    && typeof candidate.rawResponseBody === "string"
    && typeof candidate.responseStatus === "number"
    && Number.isInteger(candidate.responseStatus)
  );
}
