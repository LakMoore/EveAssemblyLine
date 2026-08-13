"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import styles from "./imagechecker.module.css";

const variations = ["icon", "render", "bp", "bpc", "relic"] as const;
type Variation = (typeof variations)[number];
type ImageStatus = "checking" | "ok" | "missing";
type ImageResults = Record<Variation, ImageStatus>;
type TypeItem = { typeId: number; name: string };
type BatchResponse = {
  items?: TypeItem[];
  startTypeId?: number | null;
  previousStartTypeId?: number | null;
  nextStartTypeId?: number | null;
  error?: string;
};

const emptyResults = (): ImageResults => ({
  icon: "checking",
  render: "checking",
  bp: "checking",
  bpc: "checking",
  relic: "checking",
});

function requestedStartTypeId() {
  const value = Number(new URLSearchParams(window.location.search).get("startTypeId") ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export default function ImageCheckerPage() {
  const [items, setItems] = useState<TypeItem[]>([]);
  const [results, setResults] = useState<Record<number, ImageResults>>({});
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [startTypeId, setStartTypeId] = useState("0");
  const [previousStartTypeId, setPreviousStartTypeId] = useState<number | null>(null);
  const [nextStartTypeId, setNextStartTypeId] = useState<number | null>(null);

  const loadBatch = useCallback(
    async (requestedStartId: number) => {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/imagechecker?startTypeId=${requestedStartId}`);
        const data = (await response.json()) as BatchResponse;
        if (!response.ok) throw new Error(data.error ?? "Could not load item types.");
        const loadedItems = data.items ?? [];
        const canonicalStartTypeId = data.startTypeId ?? requestedStartId;
        setItems(loadedItems);
        setResults(Object.fromEntries(loadedItems.map((item) => [item.typeId, emptyResults()])));
        setStartTypeId(String(canonicalStartTypeId));
        setPreviousStartTypeId(data.previousStartTypeId ?? null);
        setNextStartTypeId(data.nextStartTypeId ?? null);
        const url = new URL(window.location.href);
        url.searchParams.set("startTypeId", String(canonicalStartTypeId));
        window.history.replaceState(null, "", url);
      }
      catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Could not load item types.");
      }
      finally {
        setIsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadBatch(requestedStartTypeId()), 0);
    return () => window.clearTimeout(timer);
  }, [loadBatch]);

  function submitStartId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestedStartId = Number(startTypeId);
    if (!Number.isSafeInteger(requestedStartId) || requestedStartId < 0) {
      setError("Enter a non-negative whole number.");
      return;
    }
    void loadBatch(requestedStartId);
  }

  function pageTo(typeId: number | null) {
    if (typeId !== null) void loadBatch(typeId);
  }

  function updateStatus(typeId: number, variation: Variation, status: ImageStatus) {
    setResults((current) => ({
      ...current,
      [typeId]: { ...(current[typeId] ?? emptyResults()), [variation]: status },
    }));
  }

  const checkedCount = Object
    .values(results)
    .reduce(
      (total, result) =>
        total + variations.filter((variation) => result[variation] !== "checking").length,
      0,
    );
  const availableCount = Object
    .values(results)
    .reduce(
      (total, result) =>
        total + variations.filter((variation) => result[variation] === "ok").length,
      0,
    );

  return (
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>DIAGNOSTICS / IMAGE CDN</p>
          <h1>Image checker</h1>
          <p className={styles.subtitle}>
            Probe the EVE image service across a sample of 100 published item types.
          </p>
        </div>
        <div className={styles.summary}>
          <strong>{items.length || "--"}</strong>
          <span>types loaded</span>
          <strong>{isLoading ? "--" : `${availableCount}/${checkedCount}`}</strong>
          <span>images available</span>
        </div>
      </div>

      <form className={styles.paging} onSubmit={submitStartId}>
        <button
          type="button"
          className={styles.pageButton}
          aria-label="Previous batch"
          disabled={isLoading || previousStartTypeId === null}
          onClick={() => pageTo(previousStartTypeId)}
        >
          ←
        </button>
        <label className={styles.startField}>
          <span>FIRST TYPE ID</span>
          <input
            aria-label="First type ID"
            inputMode="numeric"
            min="0"
            step="1"
            type="number"
            value={startTypeId}
            onChange={(event) => setStartTypeId(event.target.value)}
          />
        </label>
        <button type="submit" className={styles.loadButton} disabled={isLoading}>
          Load batch
        </button>
        <button
          type="button"
          className={styles.pageButton}
          aria-label="Next batch"
          disabled={isLoading || nextStartTypeId === null}
          onClick={() => pageTo(nextStartTypeId)}
        >
          →
        </button>
        <span className={styles.batchNote}>100 published types per batch</span>
      </form>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>LIVE PROBE</p>
            <h2>Endpoint results</h2>
          </div>
          <span className={styles.statusNote}>
            {isLoading ? "Loading types..." : "Checks run in browser"}
          </span>
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
        {!error && isLoading ? (
          <div className={styles.empty}>Loading the selected batch...</div>
        ) : null}
        {!error && !isLoading ? (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">TYPE ID</th>
                  <th scope="col">TYPE NAME</th>
                  {variations.map((variation) => (
                    <th scope="col" key={variation}>
                      /{variation}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.typeId}>
                    <td className={styles.typeId}>{item.typeId}</td>
                    <td className={styles.typeName}>{item.name}</td>
                    {variations.map((variation) => (
                      <td key={variation}>
                        <ImageProbe
                          typeId={item.typeId}
                          variation={variation}
                          status={results[item.typeId]?.[variation] ?? "checking"}
                          onStatusChange={(status) => updateStatus(item.typeId, variation, status)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}

function ImageProbe({
  typeId,
  variation,
  status,
  onStatusChange,
}: {
  typeId: number;
  variation: Variation;
  status: ImageStatus;
  onStatusChange: (status: ImageStatus) => void;
}) {
  return (
    <div
      className={`${styles.probe} ${styles[`probe${status[0].toUpperCase()}${status.slice(1)}`]}`}
    >
      <img
        src={eveTypeImageUrl(typeId, variation, 32)}
        alt=""
        width={32}
        height={32}
        onLoad={() => onStatusChange("ok")}
        onError={() => onStatusChange("missing")}
      />
      <span>{status === "checking" ? "..." : status === "ok" ? "OK" : "MISS"}</span>
    </div>
  );
}
