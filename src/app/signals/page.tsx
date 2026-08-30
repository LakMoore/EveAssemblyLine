"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, TrendingUp } from "lucide-react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  defaultSettings,
  readPlannerSettings,
  settingsStorageKey,
} from "@/lib/planning/preferences";
import { useAppLanguage } from "../AppShell";
import styles from "../page.module.css";

type SignalStation = {
  stationId: number;
  name: string;
  systemName: string;
};

type SignalItem = {
  stationId: number;
  stationName: string;
  typeId: number;
  name: string;
  quantity: number;
  averagePrice: number;
  averagePriceSource: "regional-history";
  dailyVolume: number;
  maxBuyPrice: number;
  minSellPrice: number;
  priceStandardDeviation: number;
  percentageOverAverage: number;
  totalPriceAfterTax: number;
};

type SignalsResponse = {
  generatedAt?: string;
  salesTaxPercent?: number;
  thresholdIsk?: number;
  stations?: SignalStation[];
  items?: SignalItem[];
  error?: string;
};

/** Formats an ISK value without hiding meaningful low-price decimals. */
function formatIsk(value: number) {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ISK`;
}

/** Formats quantities and recent daily volume for compact table display. */
function formatQuantity(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

/** Displays cached stock with unusually favorable current sell prices. */
export default function SignalsPage() {
  const { language } = useAppLanguage();
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [thresholdInput, setThresholdInput] = useState(() =>
    String(defaultSettings.marketSignalThresholdIsk),
  );
  const [appliedThresholdIsk, setAppliedThresholdIsk] = useState(
    defaultSettings.marketSignalThresholdIsk,
  );
  const thresholdIskRef = useRef(appliedThresholdIsk);

  const loadSignals = useCallback(
    async (thresholdIsk = thresholdIskRef.current) => {
      const settings = readPlannerSettings();
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch(
          "/api/signals",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              language,
              stationIds: settings.marketStations.map((station) => station.stationId),
              includeCorporationAssets: settings.includeCorporationAssets,
              salesTaxPercent: settings.marketSalesTaxPercent,
              thresholdIsk,
            }),
          },
        );
        const nextData = (await response.json()) as SignalsResponse;
        if (!response.ok) throw new Error(nextData.error ?? "Could not load market signals.");
        setData(nextData);
      }
      catch (caughtError) {
        setError(
          caughtError instanceof Error ? caughtError.message : "Could not load market signals.",
        );
      }
      finally {
        setIsLoading(false);
      }
    },
    [language],
  );

  function applyThreshold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedThreshold = Number(thresholdInput);
    const thresholdIsk = Number.isFinite(parsedThreshold) ? Math.max(0, parsedThreshold) : 0;
    const settings = readPlannerSettings();
    thresholdIskRef.current = thresholdIsk;
    setAppliedThresholdIsk(thresholdIsk);
    setThresholdInput(String(thresholdIsk));
    window.localStorage.setItem(
      settingsStorageKey,
      JSON.stringify({ ...settings, marketSignalThresholdIsk: thresholdIsk }),
    );
    void loadSignals(thresholdIsk);
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(
      () => {
        const settings = readPlannerSettings();
        const thresholdIsk = settings.marketSignalThresholdIsk;
        thresholdIskRef.current = thresholdIsk;
        setThresholdInput(String(thresholdIsk));
        setAppliedThresholdIsk(thresholdIsk);
        void loadSignals(thresholdIsk);
      },
      0,
    );
    const handleRefresh = () => void loadSignals();
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [loadSignals]);

  const stations = data?.stations ?? [];
  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-7">
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">TOOLS / SIGNALS</p>
          <h1>Signals</h1>
          <p className={styles.subtitle}>
            Stock worth listing now, based on regional order-book spreads and recent prices.
          </p>
        </div>
        <form className="flex flex-wrap items-end justify-end gap-2" onSubmit={applyThreshold}>
          <Field className="w-40">
            <FieldLabel htmlFor="signals-threshold">Threshold (ISK)</FieldLabel>
            <Input
              id="signals-threshold"
              type="number"
              min="0"
              step="100000"
              value={thresholdInput}
              onChange={(event) => setThresholdInput(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={isLoading}>
            Apply
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => void loadSignals()}
          >
            {isLoading ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
            )}
            {isLoading ? "Checking markets" : "Refresh signals"}
          </Button>
        </form>
      </div>

      <Alert>
        <TrendingUp aria-hidden="true" />
        <AlertTitle>Price basis</AlertTitle>
        <AlertDescription>
          Signals require regional minimum sell to exceed regional maximum buy, and the seven-day
          volume-weighted regional average to exceed maximum buy by more than one weighted standard
          deviation. Daily traded value and gross on-hand value must each meet the{" "}
          {formatIsk(data?.thresholdIsk ?? appliedThresholdIsk)} threshold.
        </AlertDescription>
      </Alert>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Signals unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {error ? null : isLoading && !data ? (
        <div className="flex flex-col gap-3" aria-label="Loading market signals">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : stations.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TrendingUp aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No market stations configured</EmptyTitle>
            <EmptyDescription>Add market locations on the Settings page.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        stations.map((station) => {
          const stationItems = items.filter((item) => item.stationId === station.stationId);
          return (
            <section className={styles.panel} key={station.stationId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className={styles.panelKicker}>{station.systemName.toUpperCase()}</p>
                  <h2>{station.name}</h2>
                </div>
                <Badge variant="outline">
                  {stationItems.length} signal{stationItems.length === 1 ? "" : "s"}
                </Badge>
              </div>
              {stationItems.length === 0 ? (
                <Empty className="mt-5 border">
                  <EmptyHeader>
                    <EmptyTitle>No sale signals</EmptyTitle>
                    <EmptyDescription>
                      No cached stock here currently meets the price threshold.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[1000px] table-fixed text-left text-xs">
                    <thead className="border-b text-muted-foreground">
                      <tr>
                        <th className="w-[29%] px-3 py-2 font-medium">Item</th>
                        <th className="w-[10%] px-3 py-2 text-right font-medium">On hand</th>
                        <th className="w-[11%] px-3 py-2 text-right font-medium">Daily volume</th>
                        <th className="w-[12%] px-3 py-2 text-right font-medium">Max buy</th>
                        <th className="w-[12%] px-3 py-2 text-right font-medium">Min sell</th>
                        <th className="w-[11%] px-3 py-2 text-right font-medium">Over average</th>
                        <th className="w-[15%] px-3 py-2 text-right font-medium">
                          Net after {data?.salesTaxPercent ?? 0}% tax
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {stationItems.map((item) => (
                        <tr key={item.typeId}>
                          <td className="px-3 py-3">
                            <TypeIdentity
                              name={item.name}
                              typeId={item.typeId}
                              subline={`7d regional average: ${formatIsk(item.averagePrice)}; standard deviation: ${formatIsk(item.priceStandardDeviation)}`}
                            />
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {formatQuantity(item.quantity)}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {formatQuantity(item.dailyVolume)}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {formatIsk(item.maxBuyPrice)}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {formatIsk(item.minSellPrice)}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <Badge>{item.percentageOverAverage.toFixed(1)}%</Badge>
                          </td>
                          <td className="px-3 py-3 text-right font-medium tabular-nums">
                            {formatIsk(item.totalPriceAfterTax)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
