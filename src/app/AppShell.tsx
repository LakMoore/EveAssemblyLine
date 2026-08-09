"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { replaceEsiStock, replaceMarketOrderStock, type StockItem } from "@/lib/planning/stockStore";
import { settingsStorageKey, type PlannerSettings } from "@/lib/planning/preferences";
import {
  loadClientSession,
  loadClientShips,
  loadClientStateStatus,
  loadClientStock,
  type ClientCharacterStatus,
} from "@/lib/client/requestCache";
import styles from "./page.module.css";

const languageStorageKey = "assembly-line-language";
type ActivePage = "planner" | "stock" | "ships" | "locations" | "settings" | "imagechecker" | "characters";
type CharacterSummary = {
  characterId: number;
  characterName: string;
  hasDirectorRole: boolean;
  corpAuthCompleted: boolean;
};

type EsiStockResponse = {
  locations?: Array<{
    locationId: number;
    name: string;
    systemId?: number;
    systemName?: string;
    items: StockItem[];
  }>;
};
type MarketOrderResponse = { marketOrderStock?: StockItem[] };
type StateEndpoint = keyof Pick<ClientCharacterStatus, "assets" | "jobs" | "orders">;
const stateEndpoints: StateEndpoint[] = ["assets", "jobs", "orders"];

function loadPlannerSettings(): PlannerSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    return stored ? { ...defaultPlannerSettings, ...JSON.parse(stored) } : defaultPlannerSettings;
  } catch {
    return defaultPlannerSettings;
  }
}

function hasExpiredEndpoint(statuses: ClientCharacterStatus[]) {
  return statuses.some((character) => {
    const endpoints = [
      ...stateEndpoints.map((endpoint) => character[endpoint]),
      ...(character.corporations ?? []).flatMap((corporation) => stateEndpoints.map((endpoint) => corporation[endpoint])),
    ];
    return endpoints.some((endpoint) => {
      if (!endpoint) return true;
      if (endpoint.status === "error") return false;
      const now = Date.now();
      if (
        endpoint.status === "rate_limited" &&
        endpoint.rateLimitedUntil &&
        Date.parse(endpoint.rateLimitedUntil) > now
      ) return false;
      const expiresAt = Date.parse(endpoint.expires ?? endpoint.nextRefreshAllowed ?? "");
      return endpoint.status === "stale" || !Number.isFinite(expiresAt) || expiresAt <= now;
    });
  });
}

const defaultPlannerSettings: PlannerSettings = {
  includeCorporationAssets: true,
  personalSellOrdersAsStock: true,
  allCorporationSellOrdersAsStock: true,
  myCorporationSellOrdersAsStock: true,
  respectActiveJobs: true,
  defaultMe: 10,
  defaultTe: 20,
};

export default function AppShell({
  children,
  activePage,
  language: controlledLanguage,
  onLanguageChange,
}: {
  children: ReactNode;
  activePage: ActivePage;
  language?: SdeLanguage;
  onLanguageChange?: (language: SdeLanguage) => void;
}) {
  const [localLanguage, setLocalLanguage] = useState<SdeLanguage>(() => {
    if (typeof window === "undefined") return "en";
    const savedLanguage = window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [isRefreshingData, setIsRefreshingData] = useState(false);
  const [stateStatuses, setStateStatuses] = useState<ClientCharacterStatus[]>([]);
  const [hasLoadedStateStatuses, setHasLoadedStateStatuses] = useState(false);
  const [statusCheckAt, setStatusCheckAt] = useState(() => Date.now());
  const refreshAfterCharacterAdd = useRef(false);
  const language = controlledLanguage ?? localLanguage;
  const hasExpiredState = authenticated && characters.length > 0 && hasLoadedStateStatuses && statusCheckAt > 0 && hasExpiredEndpoint(stateStatuses);

  useEffect(() => {
    loadClientSession()
      .then((data: { authenticated?: boolean; characters?: CharacterSummary[] }) => {
        setAuthenticated(Boolean(data.authenticated));
        setCharacters(data.characters ?? []);
      })
      .catch(() => {
        setAuthenticated(false);
        setCharacters([]);
      });
  }, []);

  useEffect(() => {
    if (!authenticated || characters.length === 0) {
      return;
    }
    let cancelled = false;
    const loadStatuses = (force = false) => {
      void loadClientStateStatus(force)
        .then((data) => {
          if (cancelled) return;
          setStateStatuses(data.characters ?? []);
          setHasLoadedStateStatuses(true);
          setStatusCheckAt(Date.now());
        })
        .catch(() => {
          if (!cancelled) setHasLoadedStateStatuses(false);
        });
    };
    loadStatuses();
    const handleRefresh = () => loadStatuses(true);
    const statusTimer = window.setInterval(() => setStatusCheckAt(Date.now()), 5_000);
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(statusTimer);
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [authenticated, characters.length]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleViewportChange = () => setIsSidebarCollapsed(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleViewportChange);
    return () => mediaQuery.removeEventListener("change", handleViewportChange);
  }, []);

  function changeLanguage(nextLanguage: string) {
    if (!isSdeLanguage(nextLanguage)) return;
    setLocalLanguage(nextLanguage);
    window.localStorage.setItem(languageStorageKey, nextLanguage);
    onLanguageChange?.(nextLanguage);
  }

  const refreshData = useCallback(async () => {
    if (isRefreshingData || !authenticated || characters.length === 0) return;
    setIsRefreshingData(true);
    let stockLocations: EsiStockResponse["locations"] | undefined;
    try {
      const response = await fetch("/api/state/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as {
        success?: boolean;
        refreshedAt?: string;
        rateLimitedUntil?: string | null;
      };
      if (!response.ok || data.success !== true) return;
      let shipsResponse;
      try {
        shipsResponse = await loadClientShips(true);
      } catch {
      }
      try {
        const stockData = await loadClientStock(language, true);
        stockLocations = stockData.locations ?? [];
        {
          await replaceEsiStock(
            stockLocations.map((location) => ({
              systemId: location.systemId ?? 0,
              systemName: location.systemName ?? "Unknown system",
              structureId: String(location.locationId),
              structureName: location.name,
              source: "esi" as const,
              items: location.items,
            })),
          );
        }
      } catch {
      }
      try {
        const settings = loadPlannerSettings();
        const marketOrderResponse = await fetch(
          `/api/state/marketOrders?${new URLSearchParams({
            personalSellOrdersAsStock: String(settings.personalSellOrdersAsStock),
            allCorporationSellOrdersAsStock: String(settings.allCorporationSellOrdersAsStock),
            myCorporationSellOrdersAsStock: String(settings.myCorporationSellOrdersAsStock),
          }).toString()}`,
          { cache: "no-store" },
        );
        if (marketOrderResponse.ok) {
          const marketOrders = (await marketOrderResponse.json()) as MarketOrderResponse;
          await replaceMarketOrderStock(marketOrders.marketOrderStock ?? []);
        }
      } catch {
      }
      window.dispatchEvent(
        new CustomEvent("assembly-line-esi-refreshed", {
          detail: {
            refreshedAt: data.refreshedAt ?? null,
            rateLimitedUntil: data.rateLimitedUntil ?? null,
            stockLocations,
            ships: shipsResponse ?? null,
          },
        }),
      );
    } catch {
    } finally {
      setIsRefreshingData(false);
    }
  }, [authenticated, characters.length, isRefreshingData, language]);

  useEffect(() => {
    if (!authenticated || characters.length === 0 || refreshAfterCharacterAdd.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("refresh") !== "1") return;
    refreshAfterCharacterAdd.current = true;
    url.searchParams.delete("refresh");
    window.history.replaceState({}, "", url);
    window.setTimeout(() => void refreshData(), 0);
  }, [authenticated, characters.length, refreshData]);

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>E</span>
          <span>
            Eve <span className={styles.brandAccent}>AssemblyLine</span>
          </span>
        </Link>
        <div className={styles.topMeta}>
          <label className={styles.languageControl}>
            <span>LANGUAGE</span>
            <select
              aria-label="Language"
              value={language}
              onChange={(event) => changeLanguage(event.target.value)}
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="ru">Русский</option>
              <option value="zh">中文</option>
            </select>
          </label>
          <span className={`${styles.onlineDot} ${authenticated ? "" : styles.offlineDot}`} />{" "}
          {authenticated ? "ESI CONNECTED" : "NOT CONNECTED"}
          {authenticated && (
            <button
              type="button"
              className={styles.refresh}
              onClick={() => void refreshData()}
              disabled={isRefreshingData}
              aria-label={hasExpiredState ? "Refresh data" : "Up to date"}
            >
              {hasExpiredState ? (
                <span className={styles.refreshIconWarning} aria-hidden="true">↻</span>
              ) : (
                <span className={styles.refreshStatusDot} aria-hidden="true" />
              )}
              <span>{isRefreshingData ? "Refreshing..." : hasExpiredState ? "Refresh Data" : "Up To Date"}</span>
            </button>
          )}
        </div>
      </header>
      <div className={`${styles.layout} ${isSidebarCollapsed ? styles.layoutCollapsed : ""}`}>
        <aside className={styles.sidebar}>
          <button
            type="button"
            className={styles.sidebarToggle}
            aria-label={isSidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
          >
            {isSidebarCollapsed ? "→" : "←"}
          </button>
          <div className={styles.sectionLabel}>WORKSPACE</div>
          <Link
            className={`${styles.navItem} ${activePage === "planner" ? styles.navActive : ""}`}
            href="/"
          >
            <span>▦</span>
            <span className={styles.navText}>Production planner</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "stock" ? styles.navActive : ""}`}
            href="/stock"
          >
            <span>▤</span>
            <span className={styles.navText}>Stock</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "ships" ? styles.navActive : ""}`}
            href="/ships"
          >
            <span>◇</span>
            <span className={styles.navText}>Ships</span>
          </Link>
          <div className={styles.sectionLabel}>CONFIGURATION</div>
          <Link
            className={`${styles.navItem} ${activePage === "locations" ? styles.navActive : ""}`}
            href="/locations"
          >
            <span>⌖</span>
            <span className={styles.navText}>Locations</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "settings" ? styles.navActive : ""}`}
            href="/settings"
          >
            <span>⚙</span>
            <span className={styles.navText}>Settings</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "imagechecker" ? styles.navActive : ""}`}
            href="/imagechecker"
          >
            <span>▧</span>
            <span className={styles.navText}>Image checker</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "characters" ? styles.navActive : ""}`}
            href="/characters"
          >
            <span className={styles.characterGlyph} aria-hidden="true" />
            <span className={styles.navText}>Characters</span>
            <b>{characters.length}</b>
          </Link>
          <button type="button" className={styles.navItem}>
            <span>⌁</span>
            <span className={styles.navText}>Data status</span>
          </button>
          <div className={styles.sidebarBottom}>
            <div className={styles.sectionLabel}>CONNECTED PILOTS</div>
            <div className={styles.pilotList}>
              {characters.map((character, index) => (
                <div className={styles.pilot} key={character.characterId}>
                  <span className={`${styles.pilotDot} ${index > 0 ? styles.pilotAlt : ""}`}>
                    {character.characterName.slice(0, 2).toUpperCase()}
                  </span>
                  <span className={styles.navText}>
                    <strong>{character.characterName}</strong>
                    <small>
                      {character.corpAuthCompleted && character.hasDirectorRole
                        ? "Director access"
                        : "Character access"}
                    </small>
                  </span>
                  <i />
                </div>
              ))}
            </div>
            <div className={styles.sidebarFooter}>
              <span
                className={`${styles.sidebarCount} ${styles.navText}`}
                aria-label={`${characters.length} connected characters`}
                data-tooltip={`${characters.length} connected character${characters.length === 1 ? "" : "s"}`}
                tabIndex={0}
              >
                {characters.length}
              </span>
              <a className={`${styles.addButton} ${styles.navText}`} href="/api/auth/eve/start">
                + Add character
              </a>
            </div>
          </div>
        </aside>
        <section className={styles.content}>{children}</section>
      </div>
    </main>
  );
}

export { languageStorageKey };
