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
import { Empty, EmptyDescription } from "@/components/ui/empty";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { isSdeLanguage, sdeLanguages, type SdeLanguage } from "@/lib/reference/languages";
import { loadStockSnapshotTime, replaceEsiStock } from "@/lib/planning/stockStore";
import {
  groupClientStockByLocation,
  loadClientJobs,
  loadClientCharacters,
  loadClientCorpStatus,
  loadClientSession,
  loadClientShips,
  loadClientStateStatus,
  loadClientStock,
  type ClientCharacterStatus,
} from "@/lib/client/requestCache";
import {
  endpointNeedsRefresh,
  loadLastRefreshAt,
  refreshDependentEndpoints,
  saveLastRefreshAt,
} from "@/lib/client/refreshCache";
import { fetchFacilityResponse } from "@/lib/planning/facilitiesStore";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";
import {
  ArrowUp,
  BadgeDollarSign,
  Boxes,
  ClipboardList,
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
import { FaDiscord, FaGithub } from "react-icons/fa6";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import styles from "./page.module.css";
import { PlanStockItem } from "@/lib/planning/types";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ThemeSelect } from "@/components/ThemeSelect";
import { toast } from "@/components/ui/toast";

const languageStorageKey = "assembly-line-language";
const sidebarStorageKey = "assembly-line-sidebar-collapsed";
type ActivePage =
  | "planner"
  | "welcome"
  | "compress"
  | "appraise"
  | "stock"
  | "jobs"
  | "ships"
  | "structures"
  | "settings"
  | "imagechecker"
  | "characters";
type LanguageContextValue = { language: SdeLanguage; setLanguage: (language: SdeLanguage) => void };
const LanguageContext = createContext<LanguageContextValue | null>(null);
const RefreshContext = createContext<boolean>(false);
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
    items: PlanStockItem[];
  }>;
};
type StateEndpoint = keyof Pick<ClientCharacterStatus, "assets" | "skills" | "jobs" | "orders">;
const stateEndpoints: StateEndpoint[] = ["assets", "skills", "jobs", "orders"];
const corporationStateEndpoints: Array<"assets" | "jobs" | "orders"> = ["assets", "jobs", "orders"];

function showRefreshError(details: string) {
  toast.add({
    description: details,
    type: "error",
    timeout: 0,
    actionProps: {
      children: "View details",
      onClick: () => window.location.assign("/characters"),
    },
  });
}

function showRefreshSuccess() {
  toast.add({
    description: "Refresh completed successfully.",
    type: "success",
  });
}

function hasExpiredEndpoint(statuses: ClientCharacterStatus[]) {
  return statuses.some((character) => {
    const endpoints = [
      ...stateEndpoints.map((endpoint) => character[endpoint]),
      ...(character.corporations ?? []).flatMap((corporation) =>
        corporationStateEndpoints.map((endpoint) => corporation[endpoint]),
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
        corporationStateEndpoints.map((endpoint) => corporation[endpoint]),
      ),
    ].some((endpoint) => endpoint?.status === "error"),
  );
}

function characterNeedsReauthorization(status: ClientCharacterStatus | undefined) {
  return [
    ...(status ? [status.assets, status.skills, status.jobs, status.orders] : []),
    ...(status?.corporations ?? []).flatMap((corporation) => [
      corporation.assets,
      corporation.jobs,
      corporation.orders,
    ]),
  ].some((endpoint) => endpoint?.reauthorizeRequired === true);
}

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
  const isRefreshingDataRef = useRef(false);
  const refreshAfterCharacterAdd = useRef(false);
  const mobileMetaCollapseTimer = useRef<number | null>(null);
  const mobileMetaCollapseAnimationTimer = useRef<number | null>(null);
  const pilotListSentinelRef = useRef<HTMLSpanElement | null>(null);
  const language = localLanguage;
  const activePage: ActivePage =
    pathname === "/" || pathname === "/welcome"
      ? "welcome"
      : pathname === "/planner"
        ? "planner"
        : pathname === "/compress"
          ? "compress"
          : pathname === "/appraise"
            ? "appraise"
            : pathname === "/stock"
              ? "stock"
              : pathname === "/jobs"
                ? "jobs"
                : pathname === "/ships"
                  ? "ships"
                  : pathname === "/structures"
                    ? "structures"
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
    const loadStatuses = (reload = false) => {
      void loadClientStateStatus(reload)
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
    const handleRefresh = () => {
      if (activePage !== "imagechecker") loadStatuses(true);
    };
    const statusTimer = window.setInterval(() => setStatusCheckAt(Date.now()), 5_000);
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(statusTimer);
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [activePage, authenticated, characters.length]);

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
    if (isRefreshingDataRef.current || !authenticated || characters.length === 0) return false;
    isRefreshingDataRef.current = true;
    setIsRefreshingData(true);
    window.dispatchEvent(new CustomEvent("assembly-line-esi-refresh-started"));
    let stockLocations: EsiStockResponse["locations"] | undefined;
    let refreshSucceeded = false;
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
        error?: string;
        errors?: string[];
      };
      if (!response.ok || data.success !== true) {
        const details =
          data.errors?.[0]
          ?? data.error
          ?? (data.rateLimitedUntil
            ? `Refresh is rate limited until ${new Date(data.rateLimitedUntil).toLocaleString()}.`
            : "Could not refresh ESI data.");
        showRefreshError(details);
        return false;
      }
      refreshSucceeded = true;
      const refreshedAt = data.refreshedAt ?? new Date().toISOString();
      await saveLastRefreshAt(refreshedAt);
      const requiredEndpoints = new Set<string>(refreshDependentEndpoints[activePage]);
      let shipsResponse;
      if (requiredEndpoints.has("state/ships")) {
        try {
          shipsResponse = await loadClientShips(true);
        }
        catch {}
      }
      let jobsResponse;
      if (requiredEndpoints.has("state/jobs")) {
        try {
          jobsResponse = await loadClientJobs(true);
        }
        catch {}
      }
      if (requiredEndpoints.has("state/stock")) {
        try {
          const stockData = await loadClientStock(language, true);
          stockLocations = groupClientStockByLocation(stockData);
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
        catch {}
      }
      if (requiredEndpoints.has("facilities")) {
        try {
          await fetchFacilityResponse(true);
        }
        catch {}
      }
      window.dispatchEvent(
        new CustomEvent(
          "assembly-line-esi-refreshed",
          {
            detail: {
              refreshedAt,
              rateLimitedUntil: data.rateLimitedUntil ?? null,
              stockLocations,
              ships: shipsResponse ?? null,
              jobs: jobsResponse ?? null,
            },
          },
        ),
      );
      showRefreshSuccess();
      return true;
    }
    catch (error) {
      showRefreshError(error instanceof Error ? error.message : "Could not refresh ESI data.");
      return false;
    }
    finally {
      isRefreshingDataRef.current = false;
      setIsRefreshingData(false);
      window.dispatchEvent(
        new CustomEvent(
          "assembly-line-esi-refresh-finished",
          {
            detail: { success: refreshSucceeded },
          },
        ),
      );
    }
  }, [activePage, authenticated, characters.length, language]);

  useEffect(() => {
    if (!authenticated || characters.length === 0 || activePage === "imagechecker") return;
    const page = activePage;
    const endpoints = refreshDependentEndpoints[page];
    if (endpoints.length === 0) return;
    let cancelled = false;
    void loadLastRefreshAt()
      .then(async (refreshAt) => {
        if (cancelled || !refreshAt) return;
        const stale = await Promise.all(
          endpoints.map(async (endpoint) => ({
            endpoint,
            stale: await endpointNeedsRefresh(endpoint, refreshAt),
          })),
        );
        const staleEndpoints = new Set(
          stale.filter((entry) => entry.stale).map((entry) => entry.endpoint),
        );
        if (staleEndpoints.has("state/stock")) await loadClientStock(language, true);
        if (staleEndpoints.has("state/jobs")) await loadClientJobs(true);
        if (staleEndpoints.has("state/ships")) await loadClientShips(true);
        if (staleEndpoints.has("state/status")) await loadClientStateStatus(true);
        if (staleEndpoints.has("characters")) await loadClientCharacters(true);
        if (staleEndpoints.has("auth/corp/status")) await loadClientCorpStatus(true);
        if (staleEndpoints.has("facilities")) await fetchFacilityResponse(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activePage, authenticated, characters.length, language]);

  useEffect(() => {
    if (!authenticated || characters.length === 0) return;
    let cancelled = false;
    void loadStockSnapshotTime()
      .then(async (snapshotTime) => {
        if (cancelled) return;
        const isRecent = snapshotTime !== null && Date.now() - snapshotTime < 5 * 60 * 1000;
        if (!isRecent) await refreshData();
      })
      .catch(() => {
        if (!cancelled) void refreshData();
      });
    return () => {
      cancelled = true;
    };
  }, [activePage, authenticated, characters.length, language, refreshData]);

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
  }, [authenticated, refreshData, scheduleMobileMetaCollapse]);

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
      <RefreshContext.Provider value={isRefreshingData}>
        <main className={styles.shell}>
          <header className={styles.topbar}>
            <Link className={styles.brand} href="/">
              <span className={styles.brandMark}>E</span>
              <span>
                Eve <span className={styles.brandAccent}>AssemblyLine</span>
              </span>
            </Link>
            <div className={styles.topbarActions}>
              <div
                className={`${styles.topMeta} ${isMobileMetaExpanded || isMobileMetaCollapsing ? styles.topMetaExpanded : ""} ${isMobileMetaCollapsing ? styles.topMetaCollapsing : ""}`}
              >
                <label className={styles.themeControl}>
                  <span>THEME</span>
                  <ThemeSelect className="w-36" />
                </label>
                <label className={styles.languageControl}>
                  <span>LANGUAGE</span>
                  <Select
                    aria-label="Language"
                    value={language}
                    onValueChange={(value) => {
                      if (value && isSdeLanguage(value)) changeLanguage(value);
                    }}
                    items={sdeLanguages.map(({ code, label }) => ({ value: code, label }))}
                  >
                    <SelectTrigger className={styles.languageSelectFull} size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {sdeLanguages.map(({ code, label }) => (
                          <SelectItem key={code} value={code}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Select
                    aria-label="Language"
                    value={language}
                    onValueChange={(value) => {
                      if (value && isSdeLanguage(value)) changeLanguage(value);
                    }}
                    items={sdeLanguages.map(({ code }) => ({
                      value: code,
                      label: code.toUpperCase(),
                    }))}
                  >
                    <SelectTrigger className={styles.languageSelectCompact} size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {sdeLanguages.map(({ code }) => (
                          <SelectItem key={code} value={code}>
                            {code.toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                {authenticated ? (
                  <span
                    className={styles.esiStatus}
                    aria-label="ESI connected"
                    title="ESI connected"
                  >
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
              <div className={`${styles.sectionLabel} ${styles.firstSectionLabel}`}>TOOLS</div>
              <Link
                className={`${styles.navItem} ${activePage === "planner" ? styles.navActive : ""}`}
                href="/planner"
                onClick={closeSidebarOnNavigation}
              >
                <span>
                  <ClipboardList size={17} strokeWidth={1.8} aria-hidden="true" />
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
                className={`${styles.navItem} ${activePage === "appraise" ? styles.navActive : ""}`}
                href="/appraise"
                onClick={closeSidebarOnNavigation}
              >
                <span>
                  <BadgeDollarSign size={17} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={styles.navText}>Appraise</span>
              </Link>
              <div className={styles.sectionLabel}>INFORMATION</div>
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
                className={`${styles.navItem} ${activePage === "jobs" ? styles.navActive : ""}`}
                href="/jobs"
                onClick={closeSidebarOnNavigation}
              >
                <span>
                  <Factory size={17} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={styles.navText}>Jobs</span>
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
                className={`${styles.navItem} ${activePage === "structures" ? styles.navActive : ""}`}
                href="/structures"
                onClick={closeSidebarOnNavigation}
              >
                <span>
                  <MapPinned size={17} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={styles.navText}>Structures</span>
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
              <div className={styles.sectionLabel}>UTILITY</div>
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
              <div className={styles.sidebarBottom}>
                <div className={styles.sectionLabel}>CONNECTED PILOTS</div>
                <div className={styles.pilotList}>
                  {characters.map((character) => {
                    const isNotAuthenticated = characterNeedsReauthorization(
                      stateStatuses.find((status) => status.characterId === character.characterId),
                    );
                    return (
                      <div className={styles.pilot} key={character.characterId}>
                        <Avatar>
                          <AvatarImage
                            src={eveCharacterPortraitUrl(character.characterId, 64)}
                            alt={character.characterName}
                          />
                          <AvatarFallback>
                            {character.characterName
                              .split(" ")
                              .filter((n) => n)
                              .map((n) => n[0])
                              .join("")
                              .toLocaleUpperCase()}
                          </AvatarFallback>
                          <AvatarBadge
                            className={`${isNotAuthenticated ? styles.pilotNotOk : styles.pilotOk}`}
                            aria-label={
                              isNotAuthenticated ? "Authorization required" : "Authorized"
                            }
                          />
                        </Avatar>
                        <span className={styles.navText}>
                          <strong>{character.characterName}</strong>
                          <small>
                            {character.hasDirectorRole ? "Director access" : "Character access"}
                          </small>
                        </span>
                      </div>
                    );
                  })}
                  {characters.length === 0 && (
                    <Empty className={styles.pilotEmpty}>
                      <EmptyDescription>No connected pilots</EmptyDescription>
                    </Empty>
                  )}
                  <span
                    className={styles.sidebarSentinel}
                    ref={pilotListSentinelRef}
                    aria-hidden="true"
                  />
                </div>
                <div className={styles.sidebarCommunity}>
                  <div className={styles.sectionLabel}>COMMUNITY</div>
                  <a
                    className={styles.navItem}
                    href="https://github.com/LakMoore/EveAssemblyLine"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>
                      <FaGithub size={17} aria-hidden="true" />
                    </span>
                    <span className={styles.navText}>GitHub</span>
                  </a>
                  <a
                    className={styles.navItem}
                    href="https://discord.gg/VdGZWzXahh"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>
                      <FaDiscord size={17} aria-hidden="true" />
                    </span>
                    <span className={styles.navText}>Discord</span>
                  </a>
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
      </RefreshContext.Provider>
    </LanguageContext.Provider>
  );
}

export { languageStorageKey };

export function useAppLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useAppLanguage must be used inside AppShell");
  return context;
}

export function useAppRefreshStatus() {
  return useContext(RefreshContext);
}
