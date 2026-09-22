export const analyticsConsentStorageKey = "assembly-line-analytics-consent";
export const analyticsConsentChangeEvent = "assembly-line-analytics-consent-change";

export type AnalyticsConsent = "granted" | "denied";

/**
 * Returns the configured GA4 measurement ID when it has the expected public format.
 *
 * @returns The valid measurement ID, or null when analytics is not configured.
 */
export function getAnalyticsMeasurementId(): string | null {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();
  return measurementId?.match(/^G-[A-Z0-9]+$/i) ? measurementId : null;
}

/**
 * Reads the locally stored analytics decision without failing during server rendering.
 *
 * @returns The stored decision, or null when the visitor has not chosen yet.
 */
export function readAnalyticsConsent(): AnalyticsConsent | null {
  if (typeof window === "undefined") return null;

  try {
    const value = window.localStorage.getItem(analyticsConsentStorageKey);
    return value === "granted" || value === "denied" ? value : null;
  }
  catch {
    return null;
  }
}

/**
 * Gets the consent value from a change event, falling back to browser storage for external events.
 *
 * @param event The analytics consent event received by a client component.
 * @returns The new decision, or null when the event has no valid decision.
 */
export function readAnalyticsConsentEvent(event: Event): AnalyticsConsent | null {
  if (event instanceof CustomEvent) {
    return event.detail === "granted" || event.detail === "denied" ? event.detail : null;
  }

  return readAnalyticsConsent();
}

/**
 * Stores and broadcasts a visitor's analytics decision to the client-side analytics components.
 *
 * @param consent The decision to grant or deny optional analytics.
 */
export function setAnalyticsConsent(consent: AnalyticsConsent): void {
  try {
    window.localStorage.setItem(analyticsConsentStorageKey, consent);
  }
  catch {
    // A storage-restricted browser still receives the in-memory event below.
  }

  window.dispatchEvent(
    new CustomEvent(
      analyticsConsentChangeEvent,
      {
        detail: consent,
      },
    ),
  );
}
