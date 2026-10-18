import { z } from "zod";
import { requestCachedEsi } from "./client";

const routeSchema = z.array(z.number().int().positive()).min(1);
const jumpDistances = new Map<string, Promise<number | null>>();

/**
 * Loads the shortest stargate distance; null means ESI reports no route.
 * @param originSystemId Origin solar system ID.
 * @param destinationSystemId Destination solar system ID.
 * @returns Number of jumps, or null when the systems are disconnected.
 * @see https://esi.evetech.net/latest/route/30000142/30000144/?flag=shortest
 */
async function fetchJumpDistance(
  originSystemId: number,
  destinationSystemId: number,
): Promise<number | null> {
  try {
    const response = await requestCachedEsi(
      `/route/${originSystemId}/${destinationSystemId}/?flag=shortest`,
      routeSchema.refine(
        (route) => route[0] === originSystemId && route.at(-1) === destinationSystemId,
        "ESI returned a route with incorrect endpoints.",
      ),
    );
    const route = response.data;
    if (route?.[0] !== originSystemId || route.at(-1) !== destinationSystemId) {
      throw new Error("ESI returned a route with incorrect endpoints.");
    }
    return route.length - 1;
  }
  catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) return null;
    throw error;
  }
}

/**
 * Reuses symmetric distances and in-flight lookups for the server process lifetime.
 * Restart the process after an SDE/topology update; failed requests remain retryable.
 * @param originSystemId Positive safe-integer solar system ID.
 * @param destinationSystemId Positive safe-integer solar system ID.
 * @returns Shortest stargate jump count, or null for disconnected systems.
 */
export async function getSystemJumpDistance(
  originSystemId: number,
  destinationSystemId: number,
): Promise<number | null> {
  for (const systemId of [originSystemId, destinationSystemId]) {
    if (!Number.isSafeInteger(systemId) || systemId <= 0) {
      throw new Error("Route endpoints must be positive safe-integer system IDs.");
    }
  }
  if (originSystemId === destinationSystemId) return 0;
  const origin = Math.min(originSystemId, destinationSystemId);
  const destination = Math.max(originSystemId, destinationSystemId);
  const key = `${origin}:${destination}`;
  const cached = jumpDistances.get(key);
  if (cached) return cached;
  // Retaining the promise also coalesces concurrent requests for the same pair.
  const distance = fetchJumpDistance(origin, destination).catch((error: unknown) => {
    jumpDistances.delete(key);
    throw error;
  });
  jumpDistances.set(key, distance);
  return distance;
}
