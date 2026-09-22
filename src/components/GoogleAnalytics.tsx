"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  analyticsConsentChangeEvent,
  getAnalyticsMeasurementId,
  readAnalyticsConsent,
  readAnalyticsConsentEvent,
  type AnalyticsConsent,
} from "@/lib/client/analyticsConsent";

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const measurementId = getAnalyticsMeasurementId();

/**
 * Loads GA4 only after optional analytics consent and records App Router page views.
 *
 * @returns The consent-gated Google Analytics scripts, or null when analytics is unavailable.
 */
export function GoogleAnalytics() {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);

  useEffect(() => {
    const handleConsentChange = (event?: Event) => {
      const nextConsent = event ? readAnalyticsConsentEvent(event) : readAnalyticsConsent();
      setConsent(nextConsent);

      if (nextConsent && window.gtag) {
        window.gtag(
          "consent",
          "update",
          {
            analytics_storage: nextConsent,
            ad_storage: "denied",
          },
        );
      }
    };

    handleConsentChange();
    window.addEventListener(analyticsConsentChangeEvent, handleConsentChange);
    return () => window.removeEventListener(analyticsConsentChangeEvent, handleConsentChange);
  }, []);

  useEffect(() => {
    if (consent !== "granted" || !measurementId || !scriptLoaded || !window.gtag) return;

    window.gtag(
      "config",
      measurementId,
      {
        page_path: pathname,
        page_location: `${window.location.origin}${pathname}`,
      },
    );
  }, [consent, pathname, scriptLoaded]);

  if (consent !== "granted" || !measurementId) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){window.dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('config', '${measurementId}', { send_page_view: false });`}
      </Script>
    </>
  );
}
