import type { ClientPlanStockpile } from "@/lib/planning/types";

type StockpileActiveState = Pick<ClientPlanStockpile, "id" | "isActive">;

let pendingActiveStates = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** Subscribes the isolated planner action control to optimistic inclusion changes. */
export function subscribeToPendingStockpileActiveStates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Returns the stable pending-active snapshot for external-store subscribers. */
export function getPendingStockpileActiveStates(): ReadonlyMap<string, boolean> {
  return pendingActiveStates;
}

/** Records the immediate active value while the planner transition is pending. */
export function setPendingStockpileActiveState(id: string, isActive: boolean): void {
  const nextStates = new Map(pendingActiveStates).set(id, isActive);
  publish(nextStates);
}

/** Applies pending inclusion switches to a stockpile snapshot for request construction. */
export function applyPendingStockpileActiveStates<T extends StockpileActiveState>(
  stockpiles: readonly T[],
  activeStates: ReadonlyMap<string, boolean> = pendingActiveStates,
): T[] {
  return stockpiles.map((stockpile) => {
    const pendingValue = activeStates.get(stockpile.id);
    return pendingValue === undefined || pendingValue === (stockpile.isActive !== false)
      ? stockpile
      : { ...stockpile, isActive: pendingValue };
  });
}

/** Drops optimistic values once React state has committed the same values. */
export function clearCommittedStockpileActiveStates(
  stockpiles: readonly StockpileActiveState[],
): void {
  const committedActiveStates = new Map(
    stockpiles.map((stockpile) => [stockpile.id, stockpile.isActive !== false]),
  );
  let nextStates: Map<string, boolean> | undefined;
  for (const [stockpileId, pendingValue] of pendingActiveStates) {
    const committedValue = committedActiveStates.get(stockpileId);
    if (committedValue !== undefined && pendingValue !== committedValue) continue;
    nextStates ??= new Map(pendingActiveStates);
    nextStates.delete(stockpileId);
  }
  if (nextStates) publish(nextStates);
}

/** Removes optimistic values when the planner is disposed. */
export function resetPendingStockpileActiveStates(): void {
  if (pendingActiveStates.size > 0) publish(new Map());
}

/** Publishes pending values to the isolated subscribers. */
function publish(nextStates: Map<string, boolean>): void {
  if (
    nextStates.size === pendingActiveStates.size
    && [...nextStates].every(([id, value]) => pendingActiveStates.get(id) === value)
  ) return;
  pendingActiveStates = nextStates;
  for (const listener of listeners) listener();
}
