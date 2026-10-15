/** Converts a request into stable JSON using the simulator's canonical key and array order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object
      .entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
  );
}

/** Serializes request data in the same stable form used by simulator identity hashes. */
export function serializeStableSimulationRequest(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
