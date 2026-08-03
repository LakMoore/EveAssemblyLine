"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import AppShell, { languageStorageKey } from "./AppShell";
import type { PlanResult } from "@/lib/planning/types";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { loadBuildList, saveBuildList } from "@/lib/planning/buildListStore";
import { loadStockRecords, type StockItem } from "@/lib/planning/stockStore";
import {
  defaultLocations,
  defaultSettings,
  locationsStorageKey,
  settingsStorageKey,
  type PlannerLocations,
  type PlannerSettings,
} from "@/lib/planning/preferences";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { fetchTypeMetadata } from "@/lib/reference/types";
import styles from "./page.module.css";

const tabs = ["Plan", "Shopping", "BPCs", "Invention", "Reactions", "Manufacturing"];
type BuildItem = { name: string; typeId: number; quantity: number; me: number; te: number };
type TypeResult = { name: string; typeId: number };
type PasteResult = { name: string; quantity?: number; typeId?: number; error?: string };
function formatDuration(totalSeconds: number) {
  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push("0m");
  return parts.join(" ");
}

async function localizeItems(buildItems: BuildItem[], targetLanguage: SdeLanguage) {
  try {
    const metadata = await fetchTypeMetadata(
      buildItems.map((item) => item.typeId),
      targetLanguage,
    );
    const metadataByTypeId = new Map(metadata.map((item) => [item.typeId, item]));
    return buildItems.map((item) => {
      const localizedItem = metadataByTypeId.get(item.typeId);
      return localizedItem ? { ...item, name: localizedItem.name } : item;
    });
  } catch {
    return buildItems;
  }
}

export default function Home() {
  const [items, setItems] = useState<BuildItem[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [language, setLanguage] = useState<SdeLanguage>(() => {
    if (typeof window === "undefined") return "en";
    const savedLanguage = window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  });
  const [isBuildListLoaded, setIsBuildListLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState("Plan");
  const [planStatus, setPlanStatus] = useState("Ready to calculate");
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [locations] = useState<PlannerLocations>(() => {
    if (typeof window === "undefined") return defaultLocations;
    try {
      const stored = window.localStorage.getItem(locationsStorageKey);
      return stored ? { ...defaultLocations, ...JSON.parse(stored) } : defaultLocations;
    } catch {
      return defaultLocations;
    }
  });
  const [settings] = useState<PlannerSettings>(() => {
    if (typeof window === "undefined") return defaultSettings;
    try {
      const stored = window.localStorage.getItem(settingsStorageKey);
      return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  });

  useEffect(() => {
    loadBuildList()
      .then((savedItems) => localizeItems(savedItems, language).then(setItems))
      .catch(() => setItems([]))
      .finally(() => setIsBuildListLoaded(true));
  }, [language]);

  useEffect(() => {
    loadStockRecords()
      .then((records) => setStock(records.flatMap((record) => record.items)))
      .catch(() => setStock([]));
  }, []);

  useEffect(() => {
    if (isBuildListLoaded) void saveBuildList(items);
  }, [isBuildListLoaded, items]);

  async function calculatePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (items.length === 0 || isPlanLoading) return;
    setIsPlanLoading(true);
    setPlanStatus("Calculating...");
    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          items,
          assets: stock,
          locations,
          settings: {
            includeCorporationAssets: settings.includeCorporationAssets,
            buildBlacklist: [],
            buyBlacklist: [],
            defaultMe: settings.defaultMe,
            defaultTe: settings.defaultTe,
          },
        }),
      });
      const data = (await response.json()) as PlanResult | { error?: string };
      if (!response.ok) {
        setPlanStatus(
          data && "error" in data && data.error ? data.error : "Could not calculate plan",
        );
        return;
      }
      setPlan(data as PlanResult);
      setPlanStatus("Plan updated just now");
    } catch {
      setPlanStatus("Could not reach the planning service");
    } finally {
      setIsPlanLoading(false);
    }
  }

  function importItems(importedItems: Array<{ name: string; typeId: number; quantity: number }>) {
    setItems((current) => {
      const next = [...current];
      for (const imported of importedItems) {
        const existing = next.find((item) => item.typeId === imported.typeId);
        if (existing) existing.quantity += imported.quantity;
        else next.push({ ...imported, me: 0, te: 0 });
      }
      return next;
    });
    setIsPasteModalOpen(false);
  }

  return (
    <AppShell activePage="planner" language={language} onLanguageChange={setLanguage}>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>PRODUCTION CONTROL</p>
          <h1>Build queue</h1>
          <p className={styles.subtitle}>
            Turn your project requirements into a clean, actionable production plan.
          </p>
        </div>
      </div>
      <form onSubmit={calculatePlan}>
        <div className={styles.workspaceGrid}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelKicker}>01 / REQUIREMENTS</p>
                <h2>Build list</h2>
              </div>
              <button
                type="button"
                className={styles.importButton}
                onClick={() => setIsPasteModalOpen(true)}
              >
                Paste list
              </button>
            </div>
            <p className={styles.panelDescription}>What are you making?</p>
            <TypeSearch
              language={language}
              onSelect={(item) =>
                setItems((current) => {
                  const existing = current.find((entry) => entry.typeId === item.typeId);
                  return existing
                    ? current.map((entry) =>
                        entry.typeId === item.typeId
                          ? { ...entry, quantity: entry.quantity + 1 }
                          : entry,
                      )
                    : [...current, { ...item, quantity: 1, me: 0, te: 0 }];
                })
              }
            />
            <div className={styles.tableHead}>
              <span>ITEM</span>
              <span>QUANTITY</span>
              <span>ME</span>
              <span>TE</span>
              <span />
            </div>
            {items.length === 0 ? (
              <div className={styles.emptyBuildList}>
                Search for an item above to start your build list.
              </div>
            ) : (
              items.map((item, index) => (
                <div className={styles.itemRow} key={item.typeId}>
                  <Image
                    className={styles.typeImage}
                    src={eveTypeImageUrl(item.typeId)}
                    alt=""
                    width={32}
                    height={32}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <small>Type ID {item.typeId}</small>
                  </span>
                  <input
                    aria-label={`${item.name} quantity`}
                    type="number"
                    min="1"
                    step="1"
                    value={item.quantity}
                    onChange={(event) =>
                      setItems(
                        items.map((entry, itemIndex) =>
                          itemIndex === index
                            ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    aria-label={`${item.name} material efficiency`}
                    type="number"
                    min="0"
                    max="10"
                    step="1"
                    value={item.me}
                    onChange={(event) =>
                      setItems(
                        items.map((entry, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...entry,
                                me: Math.min(10, Math.max(0, Number(event.target.value) || 0)),
                              }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    aria-label={`${item.name} time efficiency`}
                    type="number"
                    min="0"
                    max="20"
                    step="1"
                    value={item.te}
                    onChange={(event) =>
                      setItems(
                        items.map((entry, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...entry,
                                te: Math.min(20, Math.max(0, Number(event.target.value) || 0)),
                              }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove ${item.name}`}
                    onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
            <button
              className={styles.calculate}
              type="submit"
              disabled={isPlanLoading || items.length === 0}
            >
              <span>{isPlanLoading ? "Calculating..." : "Calculate production plan"}</span>
              <b>→</b>
            </button>
          </div>
        </div>
      </form>
      {isPasteModalOpen && (
        <PasteListModal
          language={language}
          onCancel={() => setIsPasteModalOpen(false)}
          onImport={importItems}
        />
      )}
      <div className={styles.results}>
        <div className={styles.resultsHeader}>
          <div>
            <p className={styles.panelKicker}>03 / OUTPUT</p>
            <h2>Plan breakdown</h2>
          </div>
          <span className={styles.planStatus}>
            <i /> {planStatus}
          </span>
        </div>
        <div className={styles.tabs}>
          {tabs.map((tab, index) => (
            <button
              type="button"
              key={tab}
              className={activeTab === tab ? styles.tabActive : ""}
              onClick={() => setActiveTab(tab)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {tab}
            </button>
          ))}
        </div>
        {plan ? (
          <PlanList activeTab={activeTab} plan={plan} />
        ) : (
          <div className={styles.emptyResult}>
            <div className={styles.resultGlyph}>↗</div>
            <strong>Your {activeTab.toLowerCase()} list will appear here</strong>
            <p>Calculate a plan to see the work required for this project.</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function PasteListModal({
  language,
  onCancel,
  onImport,
}: {
  language: SdeLanguage;
  onCancel: () => void;
  onImport: (items: Array<{ name: string; typeId: number; quantity: number }>) => void;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<PasteResult[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState("");

  async function resolveItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const parsed = lines.map((line) => {
      const match = line.match(/^(.*?)\s+(\d+)$/);
      return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line };
    });
    if (parsed.length === 0) {
      setError("Paste at least one item and quantity.");
      setResults([]);
      return;
    }
    setIsResolving(true);
    setError("");
    try {
      const response = await fetch("/api/reference/types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, items: parsed }),
      });
      const data = (await response.json()) as { items?: PasteResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not resolve the pasted list.");
      const resolvedItems = data.items ?? [];
      setResults(resolvedItems);
      if (resolvedItems.length > 0 && resolvedItems.every((item) => !item.error)) {
        onImport(
          resolvedItems.map((item) => ({
            name: item.name,
            typeId: item.typeId!,
            quantity: item.quantity!,
          })),
        );
      }
    } catch (resolveError) {
      setResults([]);
      setError(
        resolveError instanceof Error ? resolveError.message : "Could not resolve the pasted list.",
      );
    } finally {
      setIsResolving(false);
    }
  }

  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        className={styles.importModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-list-title"
        onSubmit={resolveItems}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>BATCH IMPORT</p>
            <h2 id="paste-list-title">Paste build list</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close paste list dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <p className={styles.panelDescription}>
          One item per line. Put the quantity at the end of each line.
        </p>
        <textarea
          className={styles.importTextarea}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setResults([]);
            setError("");
          }}
          placeholder={"Raven 2\nVargur 1"}
          aria-label="Build items and quantities"
          autoFocus
        />
        {error && <p className={styles.importError}>{error}</p>}
        {results.length > 0 && (
          <div className={styles.importResults}>
            {results.map((item, index) => (
              <div
                className={item.error ? styles.importResultInvalid : styles.importResult}
                key={`${item.name}-${index}`}
              >
                <span>
                  {item.name}
                  {item.quantity ? ` × ${item.quantity}` : ""}
                </span>
                <small>{item.error ?? `Type ID ${item.typeId}`}</small>
              </div>
            ))}
          </div>
        )}
        <div className={styles.modalActions}>
          <button type="button" className={styles.refresh} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={styles.calculate}
            disabled={isResolving || text.trim().length === 0}
          >
            <span>{isResolving ? "Checking list..." : "OK"}</span>
            <b>→</b>
          </button>
        </div>
      </form>
    </div>
  );
}

function TypeSearch({
  language,
  onSelect,
}: {
  language: SdeLanguage;
  onSelect: (item: TypeResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeResult[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) return;
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const response = await fetch(
          `/api/reference/types?query=${encodeURIComponent(trimmedQuery)}&language=${language}`,
          { signal: controller.signal },
        );
        const data = (await response.json()) as { items?: TypeResult[] };
        if (currentRequestId === requestId.current) {
          setResults(data.items ?? []);
          setHighlightedIndex(0);
          setIsOpen(true);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResults([]);
      } finally {
        if (currentRequestId === requestId.current) setIsLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [language, query]);

  function selectItem(item: TypeResult) {
    onSelect(item);
    setQuery("");
    setResults([]);
    setIsOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && isOpen && results[highlightedIndex]) {
      event.preventDefault();
      selectItem(results[highlightedIndex]);
    } else if (event.key === "Escape") {
      setIsOpen(false);
    }
  }

  return (
    <div className={styles.searchWrap}>
      <div className={styles.search}>
        ⌕{" "}
        <input
          data-type-search
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            setIsOpen(true);
            if (value.trim().length < 2) {
              setResults([]);
              setIsLoading(false);
            }
          }}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search items by name or type ID"
          aria-label="Search items by name or type ID"
          aria-autocomplete="list"
        />
        <kbd>⌘ K</kbd>
        {isLoading && <span className={styles.searchSpinner} />}
      </div>
      {isOpen && query.trim().length >= 2 && (
        <div className={styles.searchResults} role="listbox">
          {results.length > 0
            ? results.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlightedIndex}
                  className={
                    index === highlightedIndex ? styles.searchResultActive : styles.searchResult
                  }
                  key={item.typeId}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectItem(item);
                  }}
                >
                  <span>{item.name}</span>
                  <small>Type ID {item.typeId}</small>
                </button>
              ))
            : !isLoading && (
                <div className={styles.noSearchResults}>No matching published items.</div>
              )}
        </div>
      )}
    </div>
  );
}

function PlanList({ activeTab, plan }: { activeTab: string; plan: PlanResult }) {
  const [copyStatus, setCopyStatus] = useState("");
  const list =
    activeTab === "Plan"
      ? plan.lists.planItems
      : activeTab === "Shopping"
        ? plan.lists.materialsToBuy.filter((entry) => entry.buyQuantity > 0)
        : activeTab === "BPCs"
        ? plan.lists.bpcsNeeded.filter((entry) => entry.buyQuantity > 0)
        : activeTab === "Invention"
          ? plan.lists.inventionJobs
          : activeTab === "Reactions"
            ? plan.lists.reactionJobs
            : activeTab === "Manufacturing"
              ? plan.lists.manufacturingJobs
              : plan.lists.haulingTasks;
  async function copyList() {
    const entriesToCopy = list;
    const lines = entriesToCopy.map((entry) => {
      const name = entry.name;
      const amount =
        "runsNeeded" in entry
          ? entry.runsNeeded
          : "runs" in entry
            ? entry.runs
            : "buyQuantity" in entry
              ? entry.buyQuantity
              : entry.quantity;
      return `${name}\t${amount}`;
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("Copied");
      window.setTimeout(() => setCopyStatus(""), 1600);
    } catch {
      setCopyStatus("Copy failed");
    }
  }

  if (list.length === 0)
    return (
      <div className={styles.emptyResult}>
        <div className={styles.resultGlyph}>✓</div>
        <strong>No {activeTab.toLowerCase()} required</strong>
        <p>The current project has no work in this category.</p>
      </div>
    );
  return (
    <>
      <div className={styles.planActions}>
        <button type="button" className={styles.copyButton} onClick={copyList}>
          {copyStatus || "Copy list"}
        </button>
      </div>
      <div className={styles.planList}>
        {list.map((entry, index) => {
          const typeId = "itemTypeId" in entry ? entry.itemTypeId : entry.typeId;
          const name = entry.name;
          const isPlanBpc = "kind" in entry && entry.kind === "bpc";
          const isPlanReaction = "kind" in entry && entry.kind === "reaction";
          const detail =
            "fromLocationId" in entry
              ? `From ${entry.fromLocationId} to ${entry.toLocationId}`
              : "locationId" in entry
                ? `Location ${entry.locationId}`
                : "";
          const totalTime =
            "totalTime" in entry && typeof entry.totalTime === "number" ? entry.totalTime : null;
          const materialEntry =
            activeTab === "Shopping" || (activeTab === "Plan" && "kind" in entry && entry.kind === "material")
              ? (entry as PlanResult["lists"]["materialsToBuy"][number])
              : null;
          const amount =
            "volume" in entry
              ? `${entry.quantity.toLocaleString()} units | ${Math.ceil(entry.volume).toLocaleString()} m3`
              : isPlanBpc
                ? `${entry.neededQuantity.toLocaleString()} needed`
                : isPlanReaction
                  ? `${entry.runsNeeded.toLocaleString()} runs`
                  : materialEntry
                    ? `${(materialEntry.buildQuantity || materialEntry.buyQuantity).toLocaleString()} units`
              : "quantity" in entry
                ? `${entry.quantity.toLocaleString()} ${activeTab === "BPCs" ? "runs" : "units"}`
                : "runs" in entry
                  ? `${entry.runs.toLocaleString()} runs${totalTime !== null ? ` | ${formatDuration(totalTime)}` : ""}`
                  : "";
          const planDetail = isPlanBpc
            ? `${entry.neededQuantity.toLocaleString()} needed | ${entry.stockRuns.toLocaleString()} runs on ${entry.stockQuantity.toLocaleString()} prints available | ${Math.max(0, entry.neededQuantity - entry.stockRuns).toLocaleString()} runs to buy/copy${entry.bpoCount > 0 ? ` | ${entry.bpoCount.toLocaleString()} BPOs owned` : ""}`
            : isPlanReaction
              ? `${entry.runsNeeded.toLocaleString()} runs needed | ${entry.availableQuantity.toLocaleString()} prints available | ${entry.availableQuantity > 0 ? Math.ceil(entry.runsNeeded / entry.availableQuantity).toLocaleString() : 0} runs per install`
              : materialEntry
                ? `${materialEntry.requiredQuantity.toLocaleString()} needed | ${materialEntry.stockQuantity.toLocaleString()} from stock | ${materialEntry.buildQuantity.toLocaleString()} to build | ${materialEntry.buyQuantity.toLocaleString()} to buy | ${materialEntry.remainingStockQuantity.toLocaleString()} left`
                : null;
          const imageVariation =
            "imageVariation" in entry && entry.imageVariation
              ? entry.imageVariation
              : isPlanBpc && entry.bpoCount > 0
                ? "bp"
                : isPlanBpc || isPlanReaction || activeTab === "BPCs" || activeTab === "Invention"
                ? "bpc"
                : "icon";
          return (
            <div className={styles.planRow} key={`${activeTab}-${index}`}>
              <Image
                className={styles.typeImage}
                src={eveTypeImageUrl(typeId, imageVariation)}
                alt=""
                width={40}
                height={40}
              />
              <span className={styles.planRowMain}>
                <strong>{name}</strong>
                {activeTab !== "Shopping" && <small>{planDetail || detail || `Type ID ${typeId}`}</small>}
              </span>
              <span className={styles.planRowAmount}>
                <strong>{amount}</strong>
                {detail && <small>{detail}</small>}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
