"use client";

import { useEffect, useState } from "react";
import { NoPrefetchLink } from "@/components/NoPrefetchLink";
import { Button } from "@/components/ui/button";
import {
  analyticsConsentChangeEvent,
  getAnalyticsMeasurementId,
  readAnalyticsConsent,
  readAnalyticsConsentEvent,
  setAnalyticsConsent,
  type AnalyticsConsent,
} from "@/lib/client/analyticsConsent";

const analyticsConfigured = Boolean(getAnalyticsMeasurementId());

/**
 * Shows the first-visit analytics choice when GA4 is configured.
 *
 * @returns The consent banner, or null after a decision has been recorded.
 */
export function AnalyticsConsent() {
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);

  useEffect(() => {
    const handleConsentChange = (event?: Event) =>
      setConsent(event ? readAnalyticsConsentEvent(event) : readAnalyticsConsent());
    handleConsentChange();
    window.addEventListener(analyticsConsentChangeEvent, handleConsentChange);
    return () => window.removeEventListener(analyticsConsentChangeEvent, handleConsentChange);
  }, []);

  if (!analyticsConfigured || consent) return null;

  return (
    <aside
      aria-label="Analytics consent"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-3xl flex-col gap-3 border bg-popover p-4 text-xs text-popover-foreground shadow-lg sm:right-4 sm:left-auto sm:mx-0 sm:max-w-md"
    >
      <div>
        <p className="font-medium">Help improve AssemblyLine</p>
        <p className="mt-1 text-muted-foreground">
          Optional Google Analytics helps us understand which parts of the app are useful. It does
          not receive EVE credentials, characters, assets, or planning data.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <NoPrefetchLink className="mr-auto text-muted-foreground underline" href="/cookies">
          Details
        </NoPrefetchLink>
        <Button variant="outline" onClick={() => setAnalyticsConsent("denied")}>
          Decline
        </Button>
        <Button onClick={() => setAnalyticsConsent("granted")}>Allow analytics</Button>
      </div>
    </aside>
  );
}

/**
 * Provides a consent control for the public cookie policy page.
 *
 * @returns The current analytics status and a control to change it.
 */
export function AnalyticsConsentSettings() {
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);

  useEffect(() => {
    const handleConsentChange = (event?: Event) =>
      setConsent(event ? readAnalyticsConsentEvent(event) : readAnalyticsConsent());
    handleConsentChange();
    window.addEventListener(analyticsConsentChangeEvent, handleConsentChange);
    return () => window.removeEventListener(analyticsConsentChangeEvent, handleConsentChange);
  }, []);

  if (!analyticsConfigured) {
    return (
      <p className="text-muted-foreground">Analytics is not configured for this deployment.</p>
    );
  }

  const nextConsent = consent === "granted" ? "denied" : "granted";
  const actionLabel = consent === "granted" ? "Withdraw analytics consent" : "Allow analytics";
  const status = consent === "granted" ? "Analytics is enabled." : "Analytics is disabled.";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border border-border p-3">
      <p className="mr-auto text-muted-foreground">{status}</p>
      <Button
        variant="outline"
        onClick={() => {
          setAnalyticsConsent(nextConsent);
          setConsent(nextConsent);
        }}
      >
        {actionLabel}
      </Button>
    </div>
  );
}
