/** Converts a request into stable JSON using the simulator's canonical key and array order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((nestedValue) => {
        const canonicalValue = canonicalize(nestedValue);
        return { value: canonicalValue, sortKey: JSON.stringify(canonicalValue) };
      })
      .sort((left, right) => {
        if (left.value === undefined) return Number(right.value !== undefined);
        if (right.value === undefined) return -1;
        return left.sortKey.localeCompare(right.sortKey);
      })
      .map((entry) => entry.value);
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
