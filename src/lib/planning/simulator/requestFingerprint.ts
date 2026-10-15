import { simulatorRequestSchema } from "./schema";
import { serializeStableSimulationRequest } from "./stableRequest";

/** Validates and fingerprints a simulator request using browser-compatible Web Crypto. */
export async function simulationRequestFingerprint(input: unknown): Promise<string | null> {
  const parsed = simulatorRequestSchema.safeParse(input);
  if (!parsed.success) return null;

  try {
    const request = new TextEncoder().encode(serializeStableSimulationRequest(parsed.data));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", request);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  catch {
    return null;
  }
}
