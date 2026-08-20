"use client";

import { FormEvent, KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type {
  ClientBuildItem,
  PlanResult,
  PlanSourceCounts,
  PlanSourceIcon,
  PlanStockItem,
} from "@/lib/planning/types";
import { loadBuildList, saveBuildList } from "@/lib/planning/buildListStore";
import { loadCompressSettings, saveCompressSettings } from "@/lib/planning/compressSettingsStore";
import { loadPlannerLocations, savePlannerLocations } from "@/lib/planning/plannerPreferencesStore";
import {
  loadClientSession,
  loadClientStateStatus,
  loadClientStock,
  type ClientCharacterStatus,
} from "@/lib/client/requestCache";
import { fetchFacilityResponse } from "@/lib/planning/facilitiesStore";
import {
  defaultLocations,
  defaultSettings,
  settingsStorageKey,
  type PlannerLocations,
  type PlannerSettings,
} from "@/lib/planning/preferences";
import type { SdeLanguage } from "@/lib/reference/languages";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { useAppLanguage } from "./AppShell";
import TypeIdentity from "./components/TypeIdentity";
import { useToast } from "./components/ToastProvider";
import { Badge } from "./components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import styles from "./page.module.css";
import {
  ChartLine,
  Check,
  Clipboard,
  ClipboardList,
  Copy as CopyIcon,
  Factory,
  Info,
  Minimize2,
  Microscope,
  Repeat,
  SquareX,
  TestTubes,
  X,
} from "lucide-react";

type PlannerTab = "Plan" | "Haul" | "Buy" | "Copy" | "Invent" | "React" | "Manufacture" | "Skills";
const tabs: PlannerTab[] = [
  "Plan",
  "Haul",
  "Buy",
  "Copy",
  "Invent",
  "React",
  "Manufacture",
  "Skills",
];
type TypeResult = {
  name: string;
  typeId: number;
  category?: string;
  marketCategory?: string;
};
type PasteResult = {
  name: string;
  quantity?: number;
  typeId?: number;
  iconCategory?: ClientBuildItem["iconCategory"];
  error?: string;
};
type PlanLocationOption = {
  id: string;
  locationId: number;
  name: string;
  baseYield: number;
  baseManufacturingMe: number;
  baseReactionMe: number;
};

function getStockLocationId(item: PlanStockItem) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

function selectSavedLocation(
  options: PlanLocationOption[],
  savedLocationId: number | undefined,
  defaultLocationId: number,
) {
  return options.some((location) => location.locationId === savedLocationId)
    ? savedLocationId!
    : (options[0]?.locationId ?? defaultLocationId);
}

function AvailableSourceIcons({ counts }: { counts?: PlanSourceCounts }) {
  const icons = (Object.keys(counts ?? {}) as PlanSourceIcon[]).filter(
    (icon) => (counts?.[icon] ?? 0) > 0,
  );
  if (!icons.length) return null;
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
      // Must match the breakpoint where the table headers become sticky.
      const isSticky = window.matchMedia("(min-width: 641px)").matches;
      const headerTop = headerRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      setIsFloating(isSticky && headerTop <= 0);
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

async function localizeItems(
  buildItems: ClientBuildItem[],
  targetLanguage: SdeLanguage,
): Promise<ClientBuildItem[]> {
  try {
    const metadata = await fetchTypeMetadata(
      buildItems.map((item) => item.typeId),
      targetLanguage,
    );
    const metadataByTypeId = new Map(metadata.map((item) => [item.typeId, item]));
    return buildItems.map((item) => {
      const localizedItem = metadataByTypeId.get(item.typeId);
      return localizedItem
        ? {
            ...item,
            name: localizedItem.name,
            categoryName: localizedItem.marketCategory ?? "Unknown",
          }
        : item;
    });
  }
  catch {
    return buildItems;
  }
}

function WelcomePage() {
  return (
    <div className={styles.welcomePage}>
      <div className={styles.pageIntro}>
        <span className={styles.eyebrow}>EVE INDUSTRY CONTROL</span>
        <h1>Welcome to Eve AssemblyLine</h1>
        <p>Plan production, inspect your stock, and keep every industrial decision in one place.</p>
        <Link className={styles.addButton} href="/planner">
          Open production planner
        </Link>
      </div>
      <div className={styles.welcomeGrid}>
        <section className={styles.welcomePanel}>
          <span className={styles.eyebrow}>TOOLS</span>
          <h2>Build and evaluate</h2>
          <p>
            Use the planner for manufacturing plans, Compress for reprocessing decisions, and
            Appraise to turn a pasted item list into priced ISK and volume totals.
          </p>
        </section>
        <section className={styles.welcomePanel}>
          <span className={styles.eyebrow}>INFORMATION</span>
          <h2>See the operation</h2>
          <p>
            Stock, Locations, and Jobs show what you have, where it lives, and what is already
            moving through your facilities.
          </p>
        </section>
        <section className={styles.welcomePanel}>
          <span className={styles.eyebrow}>CONFIGURATION</span>
          <h2>Shape your workspace</h2>
          <p>
            Connect Characters when you need live ESI-backed assets and jobs, then configure the
            locations and settings used by your plans.
          </p>
        </section>
        <section className={styles.welcomePanel}>
          <span className={styles.eyebrow}>UTILITY</span>
          <h2>Keep assets visible</h2>
          <p>
            Image checker is a small diagnostic tool for verifying the artwork and identifiers used
            throughout the application.
          </p>
        </section>
      </div>
      <p className={styles.welcomeNote}>
        Character authentication is optional. Without it, you can still work with local planner
        data; connecting a character enables authenticated ESI state and corporation access
        according to that character&apos;s roles.
      </p>
    </div>
  );
}

function Planner() {
  const [items, setItems] = useState<ClientBuildItem[]>([]);
  const requirementsHeaderRef = useRef<HTMLParagraphElement>(null);
  const buildListHeaderRef = useRef<HTMLDivElement>(null);
  const resultsHeaderRef = useRef<HTMLDivElement>(null);
  const { language } = useAppLanguage();
  const { showToast } = useToast();
  const [isBuildListLoaded, setIsBuildListLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<PlannerTab>("Plan");
  const [planStatus, setPlanStatus] = useState("Ready to calculate");
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [isExcludedLocationsModalOpen, setIsExcludedLocationsModalOpen] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [characterStatuses, setCharacterStatuses] = useState<ClientCharacterStatus[]>([]);
  const [characterNamesById, setCharacterNamesById] = useState<Map<number, string>>(new Map());
  const [stock, setStock] = useState<PlanStockItem[]>([]);
  const [excludedLocationIds, setExcludedLocationIds] = useState<number[]>([]);
  const [locationOptions, setLocationOptions] = useState<PlanLocationOption[]>([]);
  const [includeStock, setIncludeStock] = useState(true);
  const [locations, setLocations] = useState<PlannerLocations>(defaultLocations);
  const [settings] = useState<PlannerSettings>(() => {
    if (typeof window === "undefined") return defaultSettings;
    try {
      const stored = window.localStorage.getItem(settingsStorageKey);
      return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
    }
    catch {
      return defaultSettings;
    }
  });

  function updateLocations(next: Partial<Pick<PlannerLocations, "manufacturing" | "reactions">>) {
    setLocations((current) => ({ ...current, ...next }));
  }

  useEffect(() => {
    loadBuildList()
      .then((savedItems) => localizeItems(savedItems, language).then(setItems))
      .catch(() => setItems([]))
      .finally(() => setIsBuildListLoaded(true));
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    Promise
      .all([fetchFacilityResponse(), loadPlannerLocations()])
      .then(([data, storedLocations]) => {
        const options = (data?.facilities ?? [])
          .filter(
            (facility): facility is typeof facility & { id: number } =>
              typeof facility.id === "number",
          )
          .map((facility) => ({
            id: String(facility.id),
            locationId: facility.id,
            name: facility.name,
            baseYield: (facility.activities.reprocessing.baseYield ?? 0) * 100,
            baseManufacturingMe: facility.activities.manufacturing.materialConsumption ?? 0,
            baseReactionMe: facility.activities.reactions.materialConsumption ?? 0,
          }));
        const manufacturingOptions = options
          .slice()
          .sort(
            (left, right) =>
              left.baseManufacturingMe - right.baseManufacturingMe
              || left.name.localeCompare(right.name),
          );
        const reactionOptions = options
          .slice()
          .sort(
            (left, right) =>
              left.baseReactionMe - right.baseReactionMe || left.name.localeCompare(right.name),
          );
        const nextLocations = {
          ...defaultLocations,
          ...storedLocations,
          manufacturing: selectSavedLocation(
            manufacturingOptions,
            storedLocations?.manufacturing,
            defaultLocations.manufacturing,
          ),
          reactions: selectSavedLocation(
            reactionOptions,
            storedLocations?.reactions,
            defaultLocations.reactions,
          ),
        };
        if (!cancelled) {
          setLocationOptions(options);
          setLocations(nextLocations);
          void savePlannerLocations(nextLocations);
        }
      })
      .catch(() => {
        if (!cancelled) setLocationOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [language, locations.structures]);

  useEffect(() => {
    if (isBuildListLoaded) void saveBuildList(items);
  }, [isBuildListLoaded, items]);

  async function submitPlan(exclusions: Set<number>) {
    if (items.length === 0 || isPlanLoading) return;
    setIsPlanLoading(true);
    setPlanStatus("Calculating...");
    try {
      let workingStock: PlanStockItem[] = [];
      if (includeStock && (await loadClientSession()).authenticated) {
        const stockData = await loadClientStock(language);
        workingStock = stockData.workingStock ?? [];
      }
      const compressSettings = await loadCompressSettings();
      const compressLocationId = Number(compressSettings.locationId);
      const planningLocations = Number.isInteger(compressLocationId)
        ? { ...locations, reprocessing: compressLocationId }
        : locations;
      const requestStock = workingStock.filter((item) => {
        const locationId = getStockLocationId(item);
        return locationId === undefined || !exclusions.has(locationId);
      });
      setStock(requestStock);
      const response = await fetch(
        "/api/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            toBuild: items.map(
              ({ typeId, quantity, me, te, fromCompression, reprocessingEfficiency }) => ({
                typeId,
                quantity,
                me,
                te,
                fromCompression,
                reprocessingEfficiency,
              }),
            ),
            stock: requestStock.map(({ sourceLocationName: _sourceLocationName, ...item }) => item),
            locations: planningLocations,
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
        },
      );
      const data = (await response.json()) as PlanResult | { error?: string };
      if (!response.ok) {
        setPlanStatus("error" in data && data.error ? data.error : "Could not calculate plan");
        return;
      }
      setPlan(data as PlanResult);
      try {
        const session = await loadClientSession();
        const status = session.authenticated ? await loadClientStateStatus() : { characters: [] };
        setCharacterNamesById(
          new Map(
            (session.characters ?? []).map((character) => [
              character.characterId,
              character.characterName,
            ]),
          ),
        );
        setCharacterStatuses(status.characters ?? []);
      }
      catch {
        setCharacterNamesById(new Map());
        setCharacterStatuses([]);
      }
      await savePlannerLocations(locations);
      setPlanStatus("Plan updated just now");
    }
    catch {
      setPlanStatus("Could not reach the planning service");
    }
    finally {
      setIsPlanLoading(false);
    }
  }

  async function calculatePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitPlan(new Set(excludedLocationIds));
  }

  async function excludeHaulBucket(fromLocationId: number) {
    const nextExcludedLocationIds = new Set(excludedLocationIds);
    nextExcludedLocationIds.add(fromLocationId);
    setExcludedLocationIds([...nextExcludedLocationIds]);
    await submitPlan(nextExcludedLocationIds);
  }

  async function removeExcludedLocation(locationId: number) {
    const nextExcludedLocationIds = excludedLocationIds.filter((id) => id !== locationId);
    setExcludedLocationIds(nextExcludedLocationIds);
    await submitPlan(new Set(nextExcludedLocationIds));
  }

  async function clearExcludedLocations() {
    setExcludedLocationIds([]);
    setIsExcludedLocationsModalOpen(false);
    await submitPlan(new Set());
  }

  function importItems(
    importedItems: Array<{
      name: string;
      categoryName: string;
      typeId: number;
      quantity: number;
      iconCategory?: ClientBuildItem["iconCategory"];
    }>,
  ) {
    setItems((current) => {
      const next = [...current];
      for (const imported of importedItems) {
        const existing = next.find(
          (item) => item.typeId === imported.typeId && !item.fromCompression,
        );
        if (existing) existing.quantity += imported.quantity;
        else next.push({ ...imported, me: 0, te: 0, fromCompression: false });
      }
      return next;
    });
    setIsPasteModalOpen(false);
  }

  async function copyBuildList() {
    try {
      await navigator.clipboard.writeText(
        items.map((item) => `${item.name}\t${item.quantity}`).join("\n"),
      );
      showToast("Build list multibuy copied");
    }
    catch {
      showToast("Could not copy build list multibuy");
    }
  }

  function removeCompressionItems() {
    if (!items.some((item) => item.fromCompression)) return;
    if (!window.confirm("Remove all items added from Compression?")) return;
    setItems((current) => current.filter((item) => !item.fromCompression));
  }

  return (
    <>
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
                <p className={styles.panelKicker} ref={requirementsHeaderRef}>
                  01 / REQUIREMENTS
                </p>
                <h2>Build list</h2>
              </div>
              <div className={styles.panelHeaderActions}>
                <button
                  type="button"
                  className={`actionButton ${styles.importButton}`}
                  onClick={() => setIsPasteModalOpen(true)}
                >
                  <Clipboard aria-hidden="true" />
                  <span>Paste list</span>
                </button>
                <button
                  type="button"
                  className={`actionButton ${styles.importButton}`}
                  onClick={() => void copyBuildList()}
                  disabled={items.length === 0}
                >
                  <CopyIcon aria-hidden="true" />
                  <span>Copy list</span>
                </button>
                {items.some((item) => item.fromCompression) && (
                  <button
                    type="button"
                    className={`actionButton ${styles.importButton}`}
                    onClick={removeCompressionItems}
                  >
                    <X aria-hidden="true" />
                    <span>Remove Compression</span>
                  </button>
                )}
              </div>
            </div>
            <p className={styles.panelDescription}>What are you making?</p>
            <TypeSearch
              language={language}
              onSelect={(item) =>
                setItems((current) => {
                  const existingIndex = current.findIndex(
                    (entry) => entry.typeId === item.typeId && !entry.fromCompression,
                  );
                  const nextItem =
                    existingIndex >= 0
                      ? { ...current[existingIndex], quantity: current[existingIndex].quantity + 1 }
                      : {
                          ...item,
                          categoryName: "Unknown",
                          quantity: 1,
                          me: 0,
                          te: 0,
                          fromCompression: false,
                        };
                  return [nextItem, ...current.filter((_, index) => index !== existingIndex)];
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
                <div className={styles.itemRow} key={`${item.typeId}-${item.fromCompression}`}>
                  <div className={styles.buildItemIdentity}>
                    <TypeIdentity
                      name={item.name}
                      typeId={item.typeId}
                      variation={
                        item.iconCategory === "bpo"
                          ? "bp"
                          : item.iconCategory === "bpc" || item.iconCategory === "reactionformula"
                            ? "bpc"
                            : "icon"
                      }
                    />
                    {item.fromCompression && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Badge
                              variant="default"
                              aria-label={`Will be reprocessed at ${(item.reprocessingEfficiency ?? 50).toFixed(1)}%`}
                            >
                              <Minimize2 aria-hidden="true" />
                              <span>{Math.round(item.reprocessingEfficiency ?? 50)}%</span>
                            </Badge>
                          }
                        />
                        <TooltipContent className={styles.compressionTooltip}>
                          Will be reprocessed at {(item.reprocessingEfficiency ?? 50).toFixed(1)}%
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <label className={`${styles.itemField} ${styles.quantityField}`}>
                    <span>Quantity</span>
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
                  </label>
                  <label className={`${styles.itemField} ${styles.meField}`}>
                    <span>ME</span>
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
                  </label>
                  <label className={`${styles.itemField} ${styles.teField}`}>
                    <span>TE</span>
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
                  </label>
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
            <div className={styles.planOptions}>
              {locationOptions.length > 0 ? (
                <>
                  <label>
                    <span>BUILD LOCATION</span>
                    <select
                      value={locations.manufacturing}
                      onChange={(event) =>
                        updateLocations({ manufacturing: Number(event.target.value) })
                      }
                    >
                      {locationOptions
                        .slice()
                        .sort(
                          (left, right) =>
                            left.baseManufacturingMe - right.baseManufacturingMe
                            || left.name.localeCompare(right.name),
                        )
                        .map((location) => (
                          <option value={location.locationId} key={`manufacturing-${location.id}`}>
                            {location.name} ({location.baseManufacturingMe.toFixed(1)}% ME)
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <span>REACTION LOCATION</span>
                    <select
                      value={locations.reactions}
                      onChange={(event) =>
                        updateLocations({ reactions: Number(event.target.value) })
                      }
                    >
                      {locationOptions
                        .slice()
                        .sort(
                          (left, right) =>
                            left.baseReactionMe - right.baseReactionMe
                            || left.name.localeCompare(right.name),
                        )
                        .map((location) => (
                          <option value={location.locationId} key={`reaction-${location.id}`}>
                            {location.name} ({location.baseReactionMe.toFixed(1)}% ME)
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              ) : (
                <div className={styles.locationAlert} role="alert">
                  <Info className={styles.locationAlertIcon} aria-hidden="true" />
                  <div className={styles.locationAlertContent}>
                    <strong>No build or reaction locations available.</strong>
                    <span>
                      Optionally add structures on the <Link href="/locations">Locations</Link> page
                      or <Link href="/api/auth/eve/start">add character(s) via ESI</Link> to improve
                      plan results.
                    </span>
                  </div>
                </div>
              )}
              <label className={styles.checkboxOption}>
                <span>INCLUDE STOCK</span>
                <button
                  type="button"
                  className={styles.stockSwitch}
                  role="switch"
                  aria-checked={includeStock}
                  aria-label="Include stock"
                  onClick={() => setIncludeStock((current) => !current)}
                >
                  <span className={styles.stockSwitchThumb} />
                </button>
              </label>
              <div className={styles.excludedLocationsControl}>
                <span>EXCLUDED LOCATIONS</span>
                <div className={styles.excludedLocationsActions}>
                  <button
                    type="button"
                    className={styles.excludedLocationsCount}
                    disabled={excludedLocationIds.length === 0}
                    onClick={() => setIsExcludedLocationsModalOpen(true)}
                  >
                    {excludedLocationIds.length}
                  </button>
                  <button
                    type="button"
                    className={styles.clearExcludedButton}
                    disabled={excludedLocationIds.length === 0 || isPlanLoading}
                    onClick={() => void clearExcludedLocations()}
                  >
                    Clear all
                  </button>
                </div>
              </div>
            </div>
            <button
              className={styles.calculate}
              type="submit"
              disabled={isPlanLoading || items.length === 0}
            >
              <span className={styles.calculateLead}>
                <ClipboardList size={16} aria-hidden="true" />
                <span>{isPlanLoading ? "Calculating..." : "Calculate production plan"}</span>
              </span>
              <b aria-hidden="true">→</b>
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
      {isExcludedLocationsModalOpen && (
        <ExcludedLocationsModal
          locationIds={excludedLocationIds}
          locationNamesById={
            new Map([
              ...locationOptions.map((option) => [option.locationId, option.name] as const),
              ...stock.flatMap((item) => {
                const locationId = getStockLocationId(item);
                return locationId !== undefined && item.sourceLocationName
                  ? [[locationId, item.sourceLocationName] as const]
                  : [];
              }),
            ])
          }
          isLoading={isPlanLoading}
          onRemove={(locationId) => void removeExcludedLocation(locationId)}
          onClearAll={() => void clearExcludedLocations()}
          onCancel={() => setIsExcludedLocationsModalOpen(false)}
        />
      )}
      <div className={styles.results}>
        <div className={styles.resultsHeader} ref={resultsHeaderRef}>
          <div>
            <p className={styles.panelKicker}>03 / OUTPUT</p>
            <h2>Plan breakdown</h2>
          </div>
          <div className={styles.resultsHeaderMeta}>
            {plan && (
              <span className={styles.requiredSkillCount}>
                {plan.lists.skillsRequired.length.toLocaleString()} skills required
              </span>
            )}
            <span className={styles.planStatus}>
              <i /> {planStatus}
            </span>
          </div>
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
          <PlanList
            activeTab={activeTab}
            plan={plan}
            characterStatuses={characterStatuses}
            characterNamesById={characterNamesById}
            stock={stock}
            locationNamesById={
              new Map([
                ...locationOptions.map((option) => [option.locationId, option.name] as const),
                ...stock.flatMap((item) =>
                  item.rootLocationId !== undefined && item.sourceLocationName
                    ? [[item.rootLocationId, item.sourceLocationName] as const]
                    : [],
                ),
              ])
            }
            onPlanChange={setPlan}
            onExcludeHaulBucket={(fromLocationId) => void excludeHaulBucket(fromLocationId)}
            resultsHeaderRef={resultsHeaderRef}
          />
        ) : (
          <div className={styles.emptyResult}>
            <div className={styles.resultGlyph}>↗</div>
            <strong>Your {activeTab.toLowerCase()} list will appear here</strong>
            <p>Calculate a plan to see the work required for this project.</p>
          </div>
        )}
      </div>
    </>
  );
}

export default function Home() {
  const pathname = usePathname();
  return pathname === "/" ? <WelcomePage /> : <Planner />;
}

function ExcludedLocationsModal({
  locationIds,
  locationNamesById,
  isLoading,
  onRemove,
  onClearAll,
  onCancel,
}: {
  locationIds: number[];
  locationNamesById: Map<number, string>;
  isLoading: boolean;
  onRemove: (locationId: number) => void;
  onClearAll: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        className={styles.importModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="excluded-locations-title"
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STOCK FILTER</p>
            <h2 id="excluded-locations-title">Excluded locations</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close excluded locations dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <div className={styles.excludedLocationList}>
          {locationIds.map((locationId) => (
            <div className={styles.excludedLocationRow} key={locationId}>
              <span>{locationNamesById.get(locationId) ?? locationId}</span>
              <button
                type="button"
                className={styles.clearExcludedButton}
                disabled={isLoading}
                onClick={() => onRemove(locationId)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.refresh} onClick={onCancel}>
            Close
          </button>
          <button
            type="button"
            className={styles.calculate}
            disabled={isLoading}
            onClick={onClearAll}
          >
            <span>Clear all</span>
            <b>→</b>
          </button>
        </div>
      </div>
    </div>
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
      categoryName: string;
      typeId: number;
      quantity: number;
      iconCategory?: ClientBuildItem["iconCategory"];
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
      const response = await fetch(
        "/api/reference/types",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language, items: parsed }),
        },
      );
      const data = (await response.json()) as { items?: PasteResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not resolve the pasted list.");
      const resolvedItems = data.items ?? [];
      setResults(resolvedItems);
      if (resolvedItems.length > 0 && resolvedItems.every((item) => !item.error)) {
        onImport(
          resolvedItems.map((item) => ({
            name: item.name,
            categoryName: "Unknown",
            typeId: item.typeId!,
            quantity: item.quantity!,
            iconCategory: item.iconCategory,
          })),
        );
      }
    }
    catch (resolveError) {
      setResults([]);
      setError(
        resolveError instanceof Error ? resolveError.message : "Could not resolve the pasted list.",
      );
    }
    finally {
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
                      item.iconCategory === "bpo"
                        ? "bp"
                        : item.iconCategory === "bpc" || item.iconCategory === "reactionformula"
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
    const timeout = window.setTimeout(
      async () => {
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
        }
        catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setResults([]);
        }
        finally {
          if (currentRequestId === requestId.current) setIsLoading(false);
        }
      },
      180,
    );
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
    }
    else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    }
    else if (event.key === "Enter" && isOpen && results[highlightedIndex]) {
      event.preventDefault();
      selectItem(results[highlightedIndex]);
    }
    else if (event.key === "Escape") {
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
                        : item.category === "reactionformula"
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
  characterStatuses,
  characterNamesById,
  stock,
  locationNamesById,
  onPlanChange,
  onExcludeHaulBucket,
  resultsHeaderRef,
}: {
  activeTab: PlannerTab;
  plan: PlanResult;
  characterStatuses: ClientCharacterStatus[];
  characterNamesById: Map<number, string>;
  stock: PlanStockItem[];
  locationNamesById: Map<number, string>;
  onPlanChange: (plan: PlanResult) => void;
  onExcludeHaulBucket: (fromLocationId: number) => void;
  resultsHeaderRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [copyStatus, setCopyStatus] = useState("");
  const planListHeaderRef = useRef<HTMLDivElement>(null);
  const skillRequirements = plan.lists.skillsRequired;
  const skillsByCharacter = characterStatuses.map((character) => {
    const skillsAvailable =
      character.skills?.hasBody === true && Array.isArray(character.skills.body);
    const trainedSkills = new Map(
      (character.skills?.body ?? []).map((skill) => [skill.skillId, skill.activeSkillLevel]),
    );
    return {
      characterId: character.characterId,
      name: characterNamesById.get(character.characterId) ?? `Character ${character.characterId}`,
      skillsAvailable,
      skills: (skillsAvailable ? skillRequirements : [])
        .map((required) => ({
          ...required,
          currentLevel: trainedSkills.get(required.skillId) ?? 0,
        }))
        .filter((skill) => skill.currentLevel < skill.requiredLevel),
    };
  });
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
  const haulBuckets = new Map<
    string,
    {
      fromLocationId: number;
      toLocationId: number;
      tasks: PlanResult["lists"]["haulingTasks"];
    }
  >();
  if (activeTab === "Haul") {
    for (const task of plan.lists.haulingTasks) {
      const key = `${task.fromLocationId}:${task.toLocationId}`;
      const bucket = haulBuckets.get(key) ?? {
        fromLocationId: task.fromLocationId,
        toLocationId: task.toLocationId,
        tasks: [],
      };
      bucket.tasks.push(task);
      haulBuckets.set(key, bucket);
    }
  }
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

  function rebuyHaulBucket(fromLocationId: number, toLocationId: number) {
    const bucketTasks = plan.lists.haulingTasks.filter(
      (task) => task.fromLocationId === fromLocationId && task.toLocationId === toLocationId,
    );
    if (bucketTasks.length === 0) return;
    const rebuyQuantities = new Map<number, number>();
    for (const task of bucketTasks) {
      rebuyQuantities.set(
        task.itemTypeId,
        (rebuyQuantities.get(task.itemTypeId) ?? 0) + task.quantity,
      );
    }
    const materialsToBuy = plan.lists.materialsToBuy.map((material) => {
      const quantity = rebuyQuantities.get(material.typeId);
      if (quantity === undefined) return material;
      return {
        ...material,
        quantity: material.quantity + quantity,
        buyQuantity: material.buyQuantity + quantity,
      };
    });
    for (const [typeId, quantity] of rebuyQuantities) {
      if (materialsToBuy.some((material) => material.typeId === typeId)) continue;
      const task = bucketTasks.find((entry) => entry.itemTypeId === typeId);
      if (!task) continue;
      materialsToBuy.push({
        typeId,
        name: task.name,
        quantity,
        requiredQuantity: 0,
        stockQuantity: 0,
        availableStockQuantity: 0,
        productionQuantity: 0,
        buildQuantity: 0,
        buyQuantity: quantity,
        remainingStockQuantity: 0,
        remainingProductionQuantity: 0,
        imageVariation: "icon",
      });
    }
    const planItems = plan.lists.planItems.map((entry) => {
      if (entry.kind !== "material") return entry;
      const quantity = rebuyQuantities.get(entry.typeId);
      return quantity === undefined
        ? entry
        : {
            ...entry,
            quantity: entry.quantity + quantity,
            buyQuantity: entry.buyQuantity + quantity,
          };
    });
    onPlanChange({
      ...plan,
      lists: {
        ...plan.lists,
        planItems,
        materialsToBuy,
        haulingTasks: plan.lists.haulingTasks.filter(
          (task) => task.fromLocationId !== fromLocationId || task.toLocationId !== toLocationId,
        ),
      },
    });
  }

  function getListAmount(entry: (typeof list)[number]) {
    return activeTab === "Copy" && "neededQuantity" in entry
      ? Math.max(0, entry.neededQuantity - entry.stockRuns)
      : "runsNeeded" in entry
        ? entry.runsNeeded
        : "runs" in entry
          ? entry.runs
          : "buyQuantity" in entry
            ? entry.buyQuantity
            : entry.quantity;
  }

  async function sendToCompress() {
    const settings = await loadCompressSettings();
    await saveCompressSettings({
      ...settings,
      items: list.map((entry) => ({
        name: entry.name,
        typeId: "typeId" in entry ? entry.typeId : entry.itemTypeId,
        quantity: getListAmount(entry),
        category: "item" as const,
        imageVariation:
          "bpoCount" in entry
            ? ("bpc" as const)
            : / blueprint$/i.test(entry.name)
              ? ("bp" as const)
              : / formula$/i.test(entry.name)
                ? ("bpc" as const)
                : ("icon" as const),
      })),
    });
    router.push("/compress");
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
            return `${entry.name}\t${getListAmount(entry)}`;
          });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("Copied");
      window.setTimeout(() => setCopyStatus(""), 1600);
    }
    catch {
      setCopyStatus("Copy failed");
    }
  }

  if (activeTab === "Skills") {
    return (
      <div className={styles.skillsResult}>
        <div className={styles.skillsSummary}>
          <strong>{skillRequirements.length.toLocaleString()} required skills</strong>
          <span>Only insufficient skills are shown for each character.</span>
        </div>
        {skillsByCharacter.length === 0 ? (
          <div className={styles.emptyResult}>
            <div className={styles.resultGlyph}>?</div>
            <strong>Character skills are unavailable</strong>
            <p>Connect a character and refresh status to compare trained skills.</p>
          </div>
        ) : skillsByCharacter.every((character) => character.skills.length === 0) ? (
          <div className={styles.emptyResult}>
            <div className={styles.resultGlyph}>✓</div>
            <strong>All characters meet the requirements</strong>
            <p>No insufficient skills were found in the cached character status.</p>
          </div>
        ) : (
          <div className={styles.skillsCharacters}>
            {skillsByCharacter.map((character) => (
              <section className={styles.skillsCharacter} key={character.characterId}>
                <header className={styles.skillsCharacterHeader}>
                  <strong>{character.name}</strong>
                  {character.skillsAvailable ? (
                    character.skills.length === 0 ? (
                      <span className={styles.skillsComplete}>
                        All required skills trained
                        <Check aria-hidden="true" />
                      </span>
                    ) : (
                      <span className={styles.skillsInsufficient}>
                        {character.skills.length} MISSING SKILL
                        {character.skills.length === 1 ? "" : "S"}
                        <X aria-hidden="true" />
                      </span>
                    )
                  ) : (
                    <span className={styles.skillsUnavailable}>Status unavailable</span>
                  )}
                </header>
                {!character.skillsAvailable ? (
                  <p className={styles.skillsUnavailable}>
                    Refresh character status to compare skills.
                  </p>
                ) : character.skills.length > 0 ? (
                  <div className={styles.skillsRows}>
                    {character.skills.map((skill) => (
                      <div className={styles.skillRow} key={skill.skillId}>
                        <span>{skill.name}</span>
                        <strong>
                          {skill.currentLevel} / {skill.requiredLevel}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className={styles.emptyResult}>
        <div className={styles.resultGlyph}>✓</div>
        <strong>Nothing to {activeTab}</strong>
        <p>The current project has no work in this category.</p>
      </div>
    );
  }
  return (
    <>
      {activeTab !== "Haul" && (
        <div className={styles.planActions}>
          {activeTab === "Buy" && (
            <button
              type="button"
              className={`actionButton ${styles.copyButton}`}
              onClick={() => void sendToCompress()}
            >
              <Minimize2 aria-hidden="true" />
              <span>Send to Compress</span>
            </button>
          )}
          <button type="button" className={`actionButton ${styles.copyButton}`} onClick={copyList}>
            <CopyIcon aria-hidden="true" />
            {copyStatus || (activeTab === "Plan" ? "Copy table" : "Copy list")}
          </button>
        </div>
      )}
      {activeTab === "Plan" && (
        <div className={styles.planTableHeader} ref={planListHeaderRef}>
          <ScrollTopButton targetRef={resultsHeaderRef} headerRef={planListHeaderRef} />
          {planColumns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
      )}
      {activeTab === "Haul" ? (
        <div className={styles.haulGroups}>
          {[...haulBuckets.values()].map((bucket) => (
            <section
              className={styles.haulGroup}
              key={`${bucket.fromLocationId}:${bucket.toLocationId}`}
            >
              <header className={styles.haulGroupHeader}>
                <span>From</span>
                <strong>
                  {locationNamesById.get(bucket.fromLocationId) ?? bucket.fromLocationId}
                </strong>
                <span>To</span>
                <strong>{locationNamesById.get(bucket.toLocationId) ?? bucket.toLocationId}</strong>
                <div className={styles.haulHeaderActions}>
                  <button
                    type="button"
                    className={`actionButton ${styles.copyButton} ${styles.rebuyButton}`}
                    onClick={() => rebuyHaulBucket(bucket.fromLocationId, bucket.toLocationId)}
                  >
                    <Repeat aria-hidden="true" />
                    <span>Rebuy</span>
                  </button>
                  <button
                    type="button"
                    className={`actionButton ${styles.copyButton} ${styles.excludeButton}`}
                    onClick={() => onExcludeHaulBucket(bucket.fromLocationId)}
                  >
                    <SquareX aria-hidden="true" />
                    <span>Exclude and Recalculate</span>
                  </button>
                </div>
              </header>
              <div className={styles.haulGroupRows}>
                {bucket.tasks.map((task) => (
                  <div className={styles.haulRow} key={task.itemTypeId}>
                    <TypeIdentity
                      name={task.name}
                      typeId={task.itemTypeId}
                      imageSize={40}
                      className={styles.planTypeIdentity}
                    />
                    <span className={styles.haulRowAmount}>
                      {task.quantity.toLocaleString()} units
                      <small>{Math.ceil(task.volume).toLocaleString()} m3</small>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
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
            const planBlueprintVariation =
              activeTab === "Plan" && (isPlanBpc || isBlueprintName)
                ? isPlanBpc && entry.bpoCount > 0
                  ? "bp"
                  : "bpc"
                : null;
            const detail =
              "fromLocationId" in entry && activeTab !== "Buy"
                ? `From ${locationNamesById.get(entry.fromLocationId) ?? entry.fromLocationId} to ${locationNamesById.get(entry.toLocationId) ?? entry.toLocationId}`
                : "locationId" in entry && activeTab !== "Buy"
                  ? `Location ${entry.locationId}`
                  : "";
            const totalTime =
              "totalTime" in entry && typeof entry.totalTime === "number" ? entry.totalTime : null;
            const reactionFormulaCount =
              activeTab === "React"
                ? stock
                    .filter(
                      (stockItem) =>
                        stockItem.category === "reactionformula"
                        && stockItem.typeId === typeId
                        && !stockItem.inUse,
                    )
                    .reduce((total, stockItem) => total + stockItem.quantity, 0)
                : 0;
            const installCount =
              activeTab === "React"
              && "runs" in entry
              && entry.runs >= 10
              && reactionFormulaCount > 0
                ? entry.runs / reactionFormulaCount < 10
                  ? Math.ceil(entry.runs / 10)
                  : reactionFormulaCount
                : null;
            const runsPerInstall =
              installCount !== null && "runs" in entry
                ? Math.ceil(entry.runs / installCount)
                : null;
            const installTime =
              totalTime !== null && runsPerInstall !== null && "runs" in entry && entry.runs > 0
                ? (totalTime / entry.runs) * runsPerInstall
                : totalTime;
            const materialEntry =
              (activeTab === "Buy" && !isBpcPurchase && "quantity" in entry)
              || (activeTab === "Plan" && "kind" in entry && entry.kind === "material")
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
                              ? entry.runs >= 10
                                && installCount !== null
                                && installCount > 1
                                && runsPerInstall !== null
                                && installTime !== null
                                ? `${installCount.toLocaleString()} x ${runsPerInstall.toLocaleString()} runs @ ${formatDuration(installTime)} | ${entry.runs.toLocaleString()} runs`
                                : `${totalTime !== null ? `${formatDuration(totalTime)} | ` : ""}${entry.runs.toLocaleString()} ${activeTab === "Invent" ? "attempts" : "runs"}`
                              : "";
            const imageVariation =
              planBlueprintVariation
              ?? ("imageVariation" in entry && entry.imageVariation
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
                      : activeTab === "Manufacture"
                          || activeTab === "React"
                          || isPlanBpc
                          || isBpcPurchase
                          || isPlanReaction
                          || activeTab === "Copy"
                          || activeTab === "Invent"
                        ? "bpc"
                        : "icon");
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
                              counts={
                                "availableSourceCounts" in entry
                                  ? entry.availableSourceCounts
                                  : undefined
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
      )}
    </>
  );
}
