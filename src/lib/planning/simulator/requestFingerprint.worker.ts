import {
  createPlannerSimulationRequest,
  type PlannerSimulationRequestBase,
  type PlannerSimulationRequestOptions,
} from "./plannerRequest";
import { simulationRequestFingerprint } from "./requestFingerprint";

export type PlannerFingerprintWorkerMessage =
  | { type: "base"; revision: number; input: PlannerSimulationRequestBase }
  | { type: "options"; revision: number; options: PlannerSimulationRequestOptions };
export type PlannerFingerprintWorkerResult = {
  revision: number;
  fingerprint: string | null;
};

type PlannerFingerprintWorkerScope = {
  onmessage: ((event: MessageEvent<PlannerFingerprintWorkerMessage>) => void) | null;
  postMessage: (message: PlannerFingerprintWorkerResult) => void;
};

const workerScope = globalThis as unknown as PlannerFingerprintWorkerScope;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let latestRevision = 0;
let baseInput: PlannerSimulationRequestBase | undefined;
let options: PlannerSimulationRequestOptions | undefined;

/** Debounces the latest complete request and ignores work superseded by a newer message. */
function scheduleFingerprint(revision: number): void {
  if (pendingTimer !== undefined) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(
    () => {
      pendingTimer = undefined;
      if (!baseInput || !options) return;
      const request = createPlannerSimulationRequest({ ...baseInput, ...options });
      void simulationRequestFingerprint(request).then((fingerprint) => {
        if (revision !== latestRevision) return;
        workerScope.postMessage({ revision, fingerprint });
      });
    },
    180,
  );
}

/** Rebuilds and fingerprints the latest planner request after a short quiet period. */
workerScope.onmessage = (event) => {
  const message = event.data;
  latestRevision = message.revision;
  if (message.type === "base") baseInput = message.input;
  else options = message.options;
  scheduleFingerprint(message.revision);
};
