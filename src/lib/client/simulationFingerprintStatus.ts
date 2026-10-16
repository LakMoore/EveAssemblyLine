/** Fingerprint state shared by the planner worker and its isolated status indicator. */
export type SimulationFingerprintStatus = {
  fingerprint: string | null | undefined;
  working: boolean;
};

const initialStatus: SimulationFingerprintStatus = {
  fingerprint: undefined,
  working: false,
};

const statuses = new Map<string, SimulationFingerprintStatus>();
const listeners = new Map<string, Set<() => void>>();

/** Subscribes a UI consumer to fingerprint status updates. */
export function subscribeToSimulationFingerprintStatus(
  instanceId: string,
  listener: () => void,
): () => void {
  const instanceListeners = listeners.get(instanceId) ?? new Set<() => void>();
  instanceListeners.add(listener);
  listeners.set(instanceId, instanceListeners);
  return () => {
    instanceListeners.delete(listener);
    if (instanceListeners.size === 0) listeners.delete(instanceId);
  };
}

/** Returns the stable snapshot used by client and server rendering. */
export function getSimulationFingerprintStatus(instanceId: string): SimulationFingerprintStatus {
  return statuses.get(instanceId) ?? initialStatus;
}

/** Updates only the working indicator while a new fingerprint is being calculated. */
export function setSimulationFingerprintWorking(instanceId: string, working: boolean): void {
  updateStatus(instanceId, { ...getSimulationFingerprintStatus(instanceId), working });
}

/** Records the latest fingerprint returned by the worker. */
export function setSimulationFingerprint(instanceId: string, fingerprint: string | null): void {
  updateStatus(instanceId, { fingerprint, working: false });
}

/** Notifies subscribers only when the observable status changes. */
function updateStatus(instanceId: string, nextStatus: SimulationFingerprintStatus): void {
  const status = getSimulationFingerprintStatus(instanceId);
  if (nextStatus.fingerprint === status.fingerprint && nextStatus.working === status.working) {
    return;
  }
  statuses.set(instanceId, nextStatus);
  for (const listener of listeners.get(instanceId) ?? []) listener();
}

/** Clears transient fingerprint state when its owning planner is disposed. */
export function resetSimulationFingerprintStatus(instanceId: string): void {
  updateStatus(instanceId, initialStatus);
}
