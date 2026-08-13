"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isSdeLanguage, sdeLanguages, type SdeLanguage } from "@/lib/reference/languages";
import {
  replaceEsiStock,
  replaceMarketOrderStock,
  type StockItem,
} from "@/lib/planning/stockStore";
import { settingsStorageKey, type PlannerSettings } from "@/lib/planning/preferences";
import {
  loadClientSession,
  loadClientShips,
  loadClientStateStatus,
  loadClientStock,
  loadClientMarketOrders,
  type ClientCharacterStatus,
} from "@/lib/client/requestCache";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";
import {
  Activity,
  ArrowUp,
  Boxes,
  Factory,
  Image as ImageIcon,
  MapPinned,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
  Settings2,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import styles from "./page.module.css";

const languageStorageKey = "assembly-line-language";
const sidebarStorageKey = "assembly-line-sidebar-collapsed";
type ActivePage =
  | "planner"
  | "compress"
  | "stock"
  | "ships"
  | "locations"
  | "settings"
  | "imagechecker"
  | "characters";
type LanguageContextValue = { language: SdeLanguage; setLanguage: (language: SdeLanguage) => void };
const LanguageContext = createContext<LanguageContextValue | null>(null);
type CharacterSummary = {
  characterId: number;
  characterName: string;
  hasDirectorRole: boolean;
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
type StateEndpoint = keyof Pick<ClientCharacterStatus, "assets" | "jobs" | "orders">;
const stateEndpoints: StateEndpoint[] = ["assets", "jobs", "orders"];

function loadPlannerSettings(): PlannerSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    return stored ? { ...defaultPlannerSettings, ...JSON.parse(stored) } : defaultPlannerSettings;
  }
  catch {
    return defaultPlannerSettings;
  }
}

function hasExpiredEndpoint(statuses: ClientCharacterStatus[]) {
  return statuses.some((character) => {
    const endpoints = [
      ...stateEndpoints.map((endpoint) => character[endpoint]),
      ...(character.corporations ?? []).flatMap((corporation) =>
        stateEndpoints.map((endpoint) => corporation[endpoint]),
      ),
    ];
    return endpoints.some((endpoint) => {
      if (!endpoint) return true;
      if (endpoint.status === "error") return true;
      const now = Date.now();
      if (
        endpoint.status === "rate_limited"
        && endpoint.rateLimitedUntil
        && Date.parse(endpoint.rateLimitedUntil) > now
      ) return false;
      const expiresAt = Date.parse(endpoint.expires ?? endpoint.nextRefreshAllowed ?? "");
      return endpoint.status === "stale" || !Number.isFinite(expiresAt) || expiresAt <= now;
    });
  });
}

function hasEndpointErrors(statuses: ClientCharacterStatus[]) {
  return statuses.some((character) =>
    [
      ...stateEndpoints.map((endpoint) => character[endpoint]),
      ...(character.corporations ?? []).flatMap((corporation) =>
        stateEndpoints.map((endpoint) => corporation[endpoint]),
      ),
    ].some((endpoint) => endpoint?.status === "error"),
  );
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

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [localLanguage, setLocalLanguage] = useState<SdeLanguage>(() => {
    if (typeof window === "undefined") return "en";
    const savedLanguage = window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [isSidebarReady, setIsSidebarReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [isRefreshingData, setIsRefreshingData] = useState(false);
  const [isMobileMetaExpanded, setIsMobileMetaExpanded] = useState(false);
  const [isMobileMetaCollapsing, setIsMobileMetaCollapsing] = useState(false);
  const [stateStatuses, setStateStatuses] = useState<ClientCharacterStatus[]>([]);
  const [hasLoadedStateStatuses, setHasLoadedStateStatuses] = useState(false);
  const [showSidebarScrollTop, setShowSidebarScrollTop] = useState(false);
  const [statusCheckAt, setStatusCheckAt] = useState(() => Date.now());
  const refreshAfterCharacterAdd = useRef(false);
  const mobileMetaCollapseTimer = useRef<number | null>(null);
  const mobileMetaCollapseAnimationTimer = useRef<number | null>(null);
  const pilotListSentinelRef = useRef<HTMLSpanElement | null>(null);
  const language = localLanguage;
  const activePage: ActivePage =
    pathname === "/compress"
      ? "compress"
      : pathname === "/stock"
        ? "stock"
        : pathname === "/ships"
          ? "ships"
          : pathname === "/locations"
            ? "locations"
            : pathname === "/settings"
              ? "settings"
              : pathname === "/imagechecker"
                ? "imagechecker"
                : pathname === "/characters"
                  ? "characters"
                  : "planner";
  const hasExpiredState =
    authenticated
    && characters.length > 0
    && hasLoadedStateStatuses
    && statusCheckAt > 0
    && hasExpiredEndpoint(stateStatuses);
  const hasStateErrors =
    authenticated
    && characters.length > 0
    && hasLoadedStateStatuses
    && hasEndpointErrors(stateStatuses);

  useEffect(() => {
    const pilotListSentinel = pilotListSentinelRef.current;
    if (!pilotListSentinel) return;
    const observer = new IntersectionObserver(([entry]) => {
      const sentinelIsAboveViewport = entry.rootBounds
        ? entry.boundingClientRect.bottom < entry.rootBounds.top
        : false;
      setShowSidebarScrollTop(sentinelIsAboveViewport);
    });
    const handleScroll = () => {
      if (window.scrollY === 0) setShowSidebarScrollTop(false);
    };
    observer.observe(pilotListSentinel);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", handleScroll);
    };
  }, [characters.length]);

  function scrollSidebarToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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
    let readyFrame = 0;
    const handleViewportChange = () => {
      if (mediaQuery.matches) {
        setIsSidebarCollapsed(true);
      }
      else {
        const savedState = window.localStorage.getItem(sidebarStorageKey);
        setIsSidebarCollapsed(savedState === "true");
      }
      setIsSidebarReady(false);
      window.cancelAnimationFrame(readyFrame);
      readyFrame = window.requestAnimationFrame(() => {
        setIsSidebarReady(true);
      });
    };
    mediaQuery.addEventListener("change", handleViewportChange);
    handleViewportChange();
    return () => {
      mediaQuery.removeEventListener("change", handleViewportChange);
      window.cancelAnimationFrame(readyFrame);
    };
  }, []);

  function changeLanguage(nextLanguage: string) {
    if (!isSdeLanguage(nextLanguage)) return;
    setLocalLanguage(nextLanguage);
    window.localStorage.setItem(languageStorageKey, nextLanguage);
  }

  function closeSidebarOnNavigation() {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setIsSidebarCollapsed(true);
    }
  }

  const refreshData = useCallback(async () => {
    if (isRefreshingData || !authenticated || characters.length === 0) return false;
    setIsRefreshingData(true);
    let stockLocations: EsiStockResponse["locations"] | undefined;
    try {
      const response = await fetch(
        "/api/state/refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = (await response.json()) as {
        success?: boolean;
        refreshedAt?: string;
        rateLimitedUntil?: string | null;
      };
      if (!response.ok || data.success !== true) return false;
      let shipsResponse;
      try {
        shipsResponse = await loadClientShips(true);
      }
      catch {}
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
      }
      catch {}
      try {
        const settings = loadPlannerSettings();
        const marketOrders = await loadClientMarketOrders(settings);
        if (marketOrders) {
          await replaceMarketOrderStock(marketOrders.marketOrderStock ?? []);
        }
      }
      catch {}
      window.dispatchEvent(
        new CustomEvent(
          "assembly-line-esi-refreshed",
          {
            detail: {
              refreshedAt: data.refreshedAt ?? null,
              rateLimitedUntil: data.rateLimitedUntil ?? null,
              stockLocations,
              ships: shipsResponse ?? null,
            },
          },
        ),
      );
      return true;
    }
    catch {
      return false;
    }
    finally {
      setIsRefreshingData(false);
    }
  }, [authenticated, characters.length, isRefreshingData, language]);

  const scheduleMobileMetaCollapse = useCallback(() => {
    if (mobileMetaCollapseTimer.current !== null) {
      window.clearTimeout(mobileMetaCollapseTimer.current);
    }
    if (mobileMetaCollapseAnimationTimer.current !== null) {
      window.clearTimeout(mobileMetaCollapseAnimationTimer.current);
    }
    mobileMetaCollapseTimer.current = window.setTimeout(
      () => {
        setIsMobileMetaCollapsing(true);
        mobileMetaCollapseTimer.current = null;
        mobileMetaCollapseAnimationTimer.current = window.setTimeout(
          () => {
            setIsMobileMetaExpanded(false);
            setIsMobileMetaCollapsing(false);
            mobileMetaCollapseAnimationTimer.current = null;
          },
          220,
        );
      },
      900,
    );
  }, []);

  const handleMobileMetaAction = useCallback(async () => {
    setIsMobileMetaExpanded(true);
    setIsMobileMetaCollapsing(false);
    if (authenticated) {
      await refreshData();
    }
    scheduleMobileMetaCollapse();
  }, [authenticated, hasExpiredState, refreshData, scheduleMobileMetaCollapse]);

  useEffect(
    () => () => {
      if (mobileMetaCollapseTimer.current !== null) {
        window.clearTimeout(mobileMetaCollapseTimer.current);
      }
      if (mobileMetaCollapseAnimationTimer.current !== null) {
        window.clearTimeout(mobileMetaCollapseAnimationTimer.current);
      }
    },
    [],
  );

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
    <LanguageContext.Provider
      value={{ language, setLanguage: (nextLanguage) => changeLanguage(nextLanguage) }}
    >
      <main className={styles.shell}>
        <header className={styles.topbar}>
          <Link className={styles.brand} href="/">
            <span className={styles.brandMark}>E</span>
            <span>
              Eve <span className={styles.brandAccent}>AssemblyLine</span>
            </span>
          </Link>
          <div
            className={`${styles.topMeta} ${isMobileMetaExpanded || isMobileMetaCollapsing ? styles.topMetaExpanded : ""} ${isMobileMetaCollapsing ? styles.topMetaCollapsing : ""}`}
          >
            <label className={styles.languageControl}>
              <span>LANGUAGE</span>
              <select
                className={styles.languageSelectFull}
                aria-label="Language"
                value={language}
                onChange={(event) => changeLanguage(event.target.value)}
              >
                {sdeLanguages.map(({ code, label }) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className={styles.languageSelectCompact}
                aria-label="Language"
                value={language}
                onChange={(event) => changeLanguage(event.target.value)}
              >
                {sdeLanguages.map(({ code }) => (
                  <option key={code} value={code}>
                    {code.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            {authenticated ? (
              <span className={styles.esiStatus} aria-label="ESI connected" title="ESI connected">
                <span className={`${styles.onlineDot} ${styles.onlineDotCompact}`} />
                <span className={styles.esiStatusLabel}>ESI CONNECTED</span>
              </span>
            ) : (
              <button
                type="button"
                className={styles.esiStatus}
                onClick={() => void handleMobileMetaAction()}
                aria-label="ESI not connected"
                title="ESI not connected"
              >
                <span className={`${styles.onlineDot} ${styles.offlineDot}`} />
                <span className={styles.esiStatusLabel}>NOT CONNECTED</span>
              </button>
            )}
            {authenticated && (
              <button
                type="button"
                className={`${styles.refresh} ${!hasExpiredState ? styles.refreshCurrent : ""}`}
                onClick={() => void handleMobileMetaAction()}
                disabled={isRefreshingData}
                aria-label={hasExpiredState ? "Refresh data" : "Up to date"}
                title={
                  hasStateErrors
                    ? "Refresh data; one or more endpoints failed"
                    : hasExpiredState
                      ? "Refresh data"
                      : "Up to date"
                }
              >
                {hasStateErrors ? (
                  <span className={styles.refreshIconError} aria-hidden="true">
                    !
                  </span>
                ) : hasExpiredState ? (
                  <span className={styles.refreshIconWarning} aria-hidden="true">
                    ↻
                  </span>
                ) : (
                  <span className={styles.refreshStatusDot} aria-hidden="true" />
                )}
                <span>
                  {isRefreshingData
                    ? "Refreshing..."
                    : hasExpiredState
                      ? "Refresh Data"
                      : "Up To Date"}
                </span>
              </button>
            )}
          </div>
        </header>
        <div
          className={`${styles.layout} ${isSidebarCollapsed ? styles.layoutCollapsed : ""} ${!isSidebarReady ? styles.sidebarInitialising : ""}`}
        >
          <aside className={styles.sidebar}>
            <button
              type="button"
              className={styles.sidebarToggle}
              aria-label={isSidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
              onClick={() =>
                setIsSidebarCollapsed((collapsed) => {
                  const nextState = !collapsed;
                  if (window.matchMedia("(min-width: 901px)").matches) {
                    window.localStorage.setItem(sidebarStorageKey, String(nextState));
                  }
                  return nextState;
                })
              }
            >
              {isSidebarCollapsed ? (
                <PanelLeftOpen size={16} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <PanelLeftClose size={16} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            {showSidebarScrollTop && (
              <button
                type="button"
                className={styles.sidebarScrollTop}
                aria-label="Scroll to top"
                title="Scroll to top"
                onClick={scrollSidebarToTop}
              >
                <ArrowUp size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <div className={styles.sectionLabel}>WORKSPACE</div>
            <Link
              className={`${styles.navItem} ${activePage === "planner" ? styles.navActive : ""}`}
              href="/"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <Factory size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Production planner</span>
            </Link>
            <Link
              className={`${styles.navItem} ${activePage === "compress" ? styles.navActive : ""}`}
              href="/compress"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <Minimize2 size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Compress</span>
            </Link>
            <Link
              className={`${styles.navItem} ${activePage === "stock" ? styles.navActive : ""}`}
              href="/stock"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <Boxes size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Stock</span>
            </Link>
            <Link
              className={`${styles.navItem} ${activePage === "ships" ? styles.navActive : ""}`}
              href="/ships"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <Rocket size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Ships</span>
            </Link>
            <div className={styles.sectionLabel}>CONFIGURATION</div>
            <Link
              className={`${styles.navItem} ${activePage === "locations" ? styles.navActive : ""}`}
              href="/locations"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <MapPinned size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Locations</span>
            </Link>
            <Link
              className={`${styles.navItem} ${activePage === "settings" ? styles.navActive : ""}`}
              href="/settings"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <Settings2 size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Settings</span>
            </Link>
            <Link
              className={`${styles.navItem} ${activePage === "imagechecker" ? styles.navActive : ""}`}
              href="/imagechecker"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <ImageIcon size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Image checker</span>
            </Link>
            <Link
              className={`${styles.navItem} ${activePage === "characters" ? styles.navActive : ""}`}
              href="/characters"
              onClick={closeSidebarOnNavigation}
            >
              <span>
                <UsersRound size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Characters</span>
              <b>{characters.length}</b>
            </Link>
            <button type="button" className={styles.navItem}>
              <span>
                <Activity size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={styles.navText}>Data status</span>
            </button>
            <div className={styles.sidebarBottom}>
              <div className={styles.sectionLabel}>CONNECTED PILOTS</div>
              <div className={styles.pilotList}>
                {characters.map((character, index) => (
                  <div className={styles.pilot} key={character.characterId}>
                    <span className={`${styles.pilotDot} ${index > 0 ? styles.pilotAlt : ""}`}>
                      <img src={eveCharacterPortraitUrl(character.characterId, 64)} alt="" />
                    </span>
                    <span className={styles.navText}>
                      <strong>{character.characterName}</strong>
                      <small>
                        {character.hasDirectorRole ? "Director access" : "Character access"}
                      </small>
                    </span>
                    <i />
                  </div>
                ))}
                <span
                  className={styles.sidebarSentinel}
                  ref={pilotListSentinelRef}
                  aria-hidden="true"
                />
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
                <a
                  className={`${styles.addButton} ${styles.navText} ${!authenticated ? styles.addButtonDisconnected : ""}`}
                  href="/api/auth/eve/start"
                >
                  <UserRoundPlus size={16} strokeWidth={1.8} aria-hidden="true" />
                  <span>Add character</span>
                </a>
              </div>
            </div>
          </aside>
          <section className={styles.content}>{children}</section>
        </div>
      </main>
    </LanguageContext.Provider>
  );
}

export { languageStorageKey };

export function useAppLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useAppLanguage must be used inside AppShell");
  return context;
}
