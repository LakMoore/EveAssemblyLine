import type { SimulationUpstreamReservation } from "./types";

const completionBucketMilliseconds = 24 * 60 * 60 * 1000;

/** Aggregates unique in-flight job output into 24-hour completion buckets. */
export function simulationCompletionBuckets(
  reservations: readonly SimulationUpstreamReservation[],
  now = Date.now(),
): Array<{ days: number; quantity: number }> {
  const quantitiesByDay = new Map<number, number>();
  const seenJobIds = new Set<string>();

  for (const reservation of reservations) {
    if (reservation.state === "planned") continue;
    const completionAt = getReservationCompletionTime(reservation, now);
    if (completionAt === undefined) continue;

    const jobId =
      reservation.sourceJobId === undefined ? undefined : String(reservation.sourceJobId);
    if (jobId !== undefined && seenJobIds.has(jobId)) continue;
    if (jobId !== undefined) seenJobIds.add(jobId);

    const days = Math.ceil(Math.max(0, completionAt - now) / completionBucketMilliseconds);
    const quantity = Math.max(
      0,
      Math.floor(reservation.sourceOutputQuantity ?? reservation.quantity),
    );
    quantitiesByDay.set(days, (quantitiesByDay.get(days) ?? 0) + quantity);
  }

  return [...quantitiesByDay]
    .sort(([left], [right]) => left - right)
    .map(([days, quantity]) => ({ days, quantity }));
}

/** Resolves an absolute completion timestamp or relative completion offset. */
function getReservationCompletionTime(
  reservation: SimulationUpstreamReservation,
  now: number,
): number | undefined {
  if (reservation.sourceCompletionAt !== undefined) {
    const completionAt = Date.parse(reservation.sourceCompletionAt);
    if (Number.isFinite(completionAt)) return completionAt;
  }
  if (reservation.sourceCompletionOffsetSeconds !== undefined) {
    return now + Math.max(0, reservation.sourceCompletionOffsetSeconds) * 1000;
  }
  return undefined;
}
