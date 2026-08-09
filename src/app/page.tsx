"use client";

import { FormEvent, KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { PlanResult, PlanSourceCounts, PlanSourceIcon } from "@/lib/planning/types";
import { loadBuildList, saveBuildList } from "@/lib/planning/buildListStore";
import {
  loadStockRecords,
  replaceMarketOrderStock,
  type StockRecord,
} from "@/lib/planning/stockStore";
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
import AppShell, { languageStorageKey } from "./AppShell";
import TypeIdentity from "./components/TypeIdentity";
import styles from "./page.module.css";
import { ChartLine, Factory, Microscope, TestTubes } from "lucide-react";

type PlannerTab = "Plan" | "Buy" | "Copy" | "Invent" | "React" | "Manufacture";
const tabs: PlannerTab[] = ["Plan", "Buy", "Copy", "Invent", "React", "Manufacture"];
type BuildItem = {
  name: string;
  typeId: number;
  quantity: number;
  me: number;
  te: number;
  category?: "blueprint" | "bpo" | "bpc" | "reaction" | "item";
};
type TypeResult = { name: string; typeId: number; category?: BuildItem["category"] };
type PasteResult = {
  name: string;
  quantity?: number;
  typeId?: number;
  category?: BuildItem["category"];
  error?: string;
};

function AvailableSourceIcons({
  icons,
  counts,
}: {
  icons?: PlanSourceIcon[];
  counts?: PlanSourceCounts;
}) {
  if (!icons?.length) return null;
  return (
    <span className={styles.availableSourceIcons} aria-label="Available sources">
      {icons.map((icon) => {
        const Icon =
          icon === "market"
            ? ChartLine
            : icon === "industry"
              ? Factory
              : icon === "invention"
                ? Microscope
                : TestTubes;
        const quantity = counts?.[icon] ?? 0;
        const label =
          icon === "market"
            ? `${quantity.toLocaleString()} in Sell Orders`
            : icon === "industry"
              ? `${quantity.toLocaleString()} in Production`
              : icon === "invention"
                ? `${quantity.toLocaleString()} being Invented`
                : `${quantity.toLocaleString()} being Copied`;
        return (
          <span
            key={icon}
            className={styles.availableSourceIcon}
            data-source={icon}
            data-tooltip={label}
            aria-label={label}
            role="img"
            tabIndex={0}
          >
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
          </span>
        );
      })}
    </span>
  );
}

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

function ScrollTopButton({
  targetRef,
  headerRef,
}: {
  targetRef: RefObject<HTMLElement | null>;
  headerRef: RefObject<HTMLElement | null>;
}) {
  const [isFloating, setIsFloating] = useState(false);

  useEffect(() => {
    function updateFloatingState() {
      const isDesktop = window.matchMedia("(min-width: 901px)").matches;
      const headerTop = headerRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      setIsFloating(isDesktop && headerTop <= 0);
    }

    updateFloatingState();
    window.addEventListener("scroll", updateFloatingState, { passive: true });
    window.addEventListener("resize", updateFloatingState);
    return () => {
      window.removeEventListener("scroll", updateFloatingState);
      window.removeEventListener("resize", updateFloatingState);
    };
  }, [headerRef]);

  return (
    <button
      type="button"
      className={`${styles.scrollTopButton} ${isFloating ? "" : styles.scrollTopButtonHidden}`}
      onClick={() => targetRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
      aria-label="Scroll to top of list"
      title="Scroll to top of list"
    >
      ↑
    </button>
  );
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
      return localizedItem
        ? { ...item, name: localizedItem.name, category: localizedItem.category }
        : item;
    });
  } catch {
    return buildItems;
  }
}

export default function Home() {
  const [items, setItems] = useState<BuildItem[]>([]);
  const requirementsHeaderRef = useRef<HTMLParagraphElement>(null);
  const buildListHeaderRef = useRef<HTMLDivElement>(null);
  const resultsHeaderRef = useRef<HTMLDivElement>(null);
  const stockLoadPromiseRef = useRef<Promise<StockRecord[]> | null>(null);
  const [language, setLanguage] = useState<SdeLanguage>(() => {
    if (typeof window === "undefined") return "en";
    const savedLanguage = window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  });
  const [isBuildListLoaded, setIsBuildListLoaded] = useState(false);
  const [isStockLoaded, setIsStockLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<PlannerTab>("Plan");
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
    async function loadCachedStock() {
      try {
        const response = await fetch(
          `/api/state/marketOrders?${new URLSearchParams({
            personalSellOrdersAsStock: String(settings.personalSellOrdersAsStock),
            allCorporationSellOrdersAsStock: String(settings.allCorporationSellOrdersAsStock),
            myCorporationSellOrdersAsStock: String(settings.myCorporationSellOrdersAsStock),
          }).toString()}`,
          { cache: "no-store" },
        );
        if (response.ok) {
          const data = (await response.json()) as { marketOrderStock?: Parameters<typeof replaceMarketOrderStock>[0] };
          await replaceMarketOrderStock(data.marketOrderStock ?? []);
        }
      } catch {
        // Keep cached stock available when market orders cannot be loaded.
      }
      const stockLoad = loadStockRecords();
      stockLoadPromiseRef.current = stockLoad;
      stockLoad.then(
        () => setIsStockLoaded(true),
        () => setIsStockLoaded(true),
      );
    }

    loadCachedStock();
    const handleRefresh = () => {
      setIsStockLoaded(false);
      loadCachedStock();
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, [settings]);

  useEffect(() => {
    if (isBuildListLoaded) void saveBuildList(items);
  }, [isBuildListLoaded, items]);

  async function calculatePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (items.length === 0 || isPlanLoading) return;
    setIsPlanLoading(true);
    setPlanStatus("Calculating...");
    try {
      const stockLoad = stockLoadPromiseRef.current ?? loadStockRecords();
      stockLoadPromiseRef.current = stockLoad;
      const localRecords = await stockLoad;
      const requestedStock = localRecords.flatMap((record) => record.items);
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          items,
          assets: requestedStock,
          locations,
          settings: {
            includeCorporationAssets: settings.includeCorporationAssets,
            personalSellOrdersAsStock: settings.personalSellOrdersAsStock,
            allCorporationSellOrdersAsStock: settings.allCorporationSellOrdersAsStock,
            myCorporationSellOrdersAsStock: settings.myCorporationSellOrdersAsStock,
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

  function importItems(
    importedItems: Array<{
      name: string;
      typeId: number;
      quantity: number;
      category?: BuildItem["category"];
    }>,
  ) {
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
          <h1>Build plan</h1>
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
                <p className={styles.panelKicker} ref={requirementsHeaderRef}>01 / REQUIREMENTS</p>
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
            <div className={styles.tableHead} ref={buildListHeaderRef}>
              <ScrollTopButton targetRef={requirementsHeaderRef} headerRef={buildListHeaderRef} />
              <span>Quantity</span>
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
                  <TypeIdentity
                    name={item.name}
                    typeId={item.typeId}
                    variation={
                      item.category === "blueprint" || item.category === "bpo"
                        ? "bp"
                        : item.category === "bpc" || item.category === "reaction"
                          ? "bpc"
                          : "icon"
                    }
                  />
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
              disabled={isPlanLoading || items.length === 0 || !isStockLoaded}
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
        <div className={styles.resultsHeader} ref={resultsHeaderRef}>
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
          <PlanList activeTab={activeTab} plan={plan} resultsHeaderRef={resultsHeaderRef} />
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
  onImport: (
    items: Array<{
      name: string;
      typeId: number;
      quantity: number;
      category?: BuildItem["category"];
    }>,
  ) => void;
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
            category: item.category,
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
                {item.typeId ? (
                  <TypeIdentity
                    name={item.name}
                    typeId={item.typeId}
                    variation={
                      item.category === "blueprint" || item.category === "bpo"
                        ? "bp"
                        : item.category === "bpc"
                          ? "bpc"
                          : "icon"
                    }
                  />
                ) : (
                  <span>{item.name}</span>
                )}
                {item.quantity ? <small>Quantity {item.quantity}</small> : null}
                {item.error ? <small>{item.error}</small> : null}
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
                <div
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
                  <TypeIdentity
                    name={item.name}
                    typeId={item.typeId}
                    variation={
                      item.category === "blueprint"
                        ? "bp"
                        : item.category === "reaction"
                          ? "bpc"
                          : "icon"
                    }
                  />
                </div>
              ))
            : !isLoading && (
                <div className={styles.noSearchResults}>No matching published items.</div>
              )}
        </div>
      )}
    </div>
  );
}

function PlanList({
  activeTab,
  plan,
  resultsHeaderRef,
}: {
  activeTab: PlannerTab;
  plan: PlanResult;
  resultsHeaderRef: RefObject<HTMLElement | null>;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const planListHeaderRef = useRef<HTMLDivElement>(null);
  const list =
    activeTab === "Plan"
      ? plan.lists.planItems
      : activeTab === "Buy"
        ? [
            ...plan.lists.materialsToBuy.filter((entry) => entry.buyQuantity > 0),
            ...plan.lists.bpcsToBuy.filter((entry) => entry.buyQuantity > 0),
          ]
        : activeTab === "Copy"
          ? plan.lists.bpcsNeeded.filter((entry) => entry.buyQuantity > 0)
          : activeTab === "Invent"
            ? plan.lists.inventionJobs
            : activeTab === "React"
              ? plan.lists.reactionJobs
              : activeTab === "Manufacture"
                ? plan.lists.manufacturingJobs
                : plan.lists.haulingTasks;
  const planColumns = ["Required", "Available", "Buy/Build", "Surplus"] as const;

  function getPlanCells(
    entry: PlanResult["lists"]["planItems"][number],
  ): Partial<Record<(typeof planColumns)[number], string>> {
    if (entry.kind === "material") {
      return {
        Required: entry.requiredQuantity.toLocaleString(),
        Available: entry.availableStockQuantity.toLocaleString(),
        "Buy/Build": (entry.productionQuantity + entry.buyQuantity).toLocaleString(),
        Surplus: (
          entry.remainingStockQuantity + entry.remainingProductionQuantity
        ).toLocaleString(),
      };
    }
    if (entry.kind === "bpc") {
      return {
        Required: entry.neededQuantity.toLocaleString(),
        Available: entry.stockRuns.toLocaleString(),
        "Buy/Build": Math.max(0, entry.neededQuantity - entry.stockRuns).toLocaleString(),
        Surplus: "0",
      };
    }
    return {
      Required: `${entry.runsNeeded.toLocaleString()} runs`,
      Available: entry.availableQuantity.toLocaleString(),
      "Buy/Build": Math.max(0, entry.runsNeeded - entry.availableQuantity).toLocaleString(),
      Surplus: "0",
    };
  }

  async function copyList() {
    const lines =
      activeTab === "Plan"
        ? [
            ["Type", ...planColumns].join("\t"),
            ...plan.lists.planItems.map((entry) => {
              const cells = getPlanCells(entry);
              return [entry.name, ...planColumns.map((column) => cells[column] || "")].join("\t");
            }),
          ]
        : list.map((entry) => {
            const amount =
              activeTab === "Copy" && "neededQuantity" in entry
                ? Math.max(0, entry.neededQuantity - entry.stockRuns)
                : "runsNeeded" in entry
                  ? entry.runsNeeded
                  : "runs" in entry
                    ? entry.runs
                    : "buyQuantity" in entry
                      ? entry.buyQuantity
                      : entry.quantity;
            return `${entry.name}\t${amount}`;
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
        <strong>Nothing to {activeTab}</strong>
        <p>The current project has no work in this category.</p>
      </div>
    );
  return (
    <>
      <div className={styles.planActions}>
        <button type="button" className={styles.copyButton} onClick={copyList}>
          {copyStatus || (activeTab === "Plan" ? "Copy table" : "Copy list")}
        </button>
      </div>
      {activeTab === "Plan" && (
        <div className={styles.planTableHeader} ref={planListHeaderRef}>
          <ScrollTopButton targetRef={resultsHeaderRef} headerRef={planListHeaderRef} />
          {planColumns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
      )}
      <div className={activeTab === "Plan" ? styles.planTable : styles.planList}>
        {list.map((entry, index) => {
          const typeId = "itemTypeId" in entry ? entry.itemTypeId : entry.typeId;
          const name = entry.name;
          const isPlanBpc = "kind" in entry && entry.kind === "bpc";
          const isBpcPurchase = activeTab === "Buy" && "bpoCount" in entry;
          const isCopyOfBpo = activeTab === "Copy" && "bpoCount" in entry && entry.bpoCount > 0;
          const isBlueprintName = / blueprint$/i.test(name);
          const isReactionFormulaName = / formula$/i.test(name);
          const isPlanReaction = "kind" in entry && entry.kind === "reaction";
          const detail =
            "fromLocationId" in entry && activeTab !== "Buy"
              ? `From ${entry.fromLocationId} to ${entry.toLocationId}`
              : "locationId" in entry && activeTab !== "Buy"
                ? `Location ${entry.locationId}`
                : "";
          const totalTime =
            "totalTime" in entry && typeof entry.totalTime === "number" ? entry.totalTime : null;
          const materialEntry =
            (activeTab === "Buy" && !isBpcPurchase && "quantity" in entry) ||
            (activeTab === "Plan" && "kind" in entry && entry.kind === "material")
              ? (entry as PlanResult["lists"]["materialsToBuy"][number])
              : null;
          const amount =
            "volume" in entry
              ? `${entry.quantity.toLocaleString()} units | ${Math.ceil(entry.volume).toLocaleString()} m3`
              : isBpcPurchase
                ? `${entry.buyQuantity.toLocaleString()} runs`
                : isPlanBpc
                  ? `${entry.neededQuantity.toLocaleString()} needed`
                  : isPlanReaction
                    ? `${entry.runsNeeded.toLocaleString()} runs`
                    : materialEntry
                      ? `${(materialEntry.buildQuantity || materialEntry.buyQuantity).toLocaleString()} units`
                      : activeTab === "Copy" && "neededQuantity" in entry
                        ? `${Math.max(0, entry.neededQuantity - entry.stockRuns).toLocaleString()} runs`
                      : "quantity" in entry
                        ? `${entry.quantity.toLocaleString()} ${activeTab === "Copy" ? "runs" : "units"}`
                        : "runs" in entry
                          ? `${totalTime !== null ? `${formatDuration(totalTime)} | ` : ""}${entry.runs.toLocaleString()} ${activeTab === "Invent" ? "attempts" : "runs"}`
                          : "";
          const imageVariation =
            "imageVariation" in entry && entry.imageVariation
              ? entry.imageVariation === "icon" && isBlueprintName
                ? "bp"
                : entry.imageVariation === "icon" && isReactionFormulaName
                  ? "bpc"
                : entry.imageVariation
              : isCopyOfBpo || (isPlanBpc && entry.bpoCount > 0)
                ? "bp"
                : isBlueprintName
                  ? "bp"
                : isReactionFormulaName
                  ? "bpc"
                : activeTab === "Manufacture" ||
                    activeTab === "React" ||
                    isPlanBpc ||
                    isBpcPurchase ||
                    isPlanReaction ||
                    activeTab === "Copy" ||
                    activeTab === "Invent"
                  ? "bpc"
                  : "icon";
          const planCells =
            activeTab === "Plan"
              ? getPlanCells(entry as PlanResult["lists"]["planItems"][number])
              : null;
          return (
            <div
              className={activeTab === "Plan" ? styles.planTableRow : styles.planRow}
              key={`${activeTab}-${index}`}
            >
              <div className={styles.planTypeCell}>
                <TypeIdentity
                  name={name}
                  typeId={typeId}
                  imageSize={40}
                  variation={imageVariation}
                  className={styles.planTypeIdentity}
                />
              </div>
              {activeTab === "Plan" ? (
                planColumns.map((column) =>
                  planCells?.[column] ? (
                    <span className={styles.planTableCell} data-label={column} key={column}>
                      <span className={styles.planTableValue}>
                        {column === "Available" && (
                          <AvailableSourceIcons
                            icons={
                              "availableSourceIcons" in entry ? entry.availableSourceIcons : undefined
                            }
                            counts={
                              "availableSourceCounts" in entry ? entry.availableSourceCounts : undefined
                            }
                          />
                        )}
                        {planCells[column]}
                      </span>
                    </span>
                  ) : (
                    <span className={styles.planTableCellEmpty} key={column} />
                  ),
                )
              ) : (
                <span className={styles.planRowAmount}>
                  <strong>{amount}</strong>
                  {detail && <small>{detail}</small>}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
