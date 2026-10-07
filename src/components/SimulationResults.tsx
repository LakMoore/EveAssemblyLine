"use client";

import Image from "next/image";
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  Atom,
  ChartLine,
  Boxes,
  Brain,
  Bug,
  Factory,
  FlaskConical,
  ListChecks,
  ListTree,
  ShoppingCart,
  SquareX,
  TriangleAlert,
  Truck,
  ClipboardList,
  Copy as CopyIcon,
  UserRound,
  UsersRound,
  type LucideIcon,
  Minimize2,
  TestTubes,
} from "lucide-react";
import SimpleResultRow from "@/components/SimpleResultRow";
import PlannerSkillsTab from "@/components/PlannerSkillsTab";
import SimulationJobInputsResponsive, {
  SimulationInventionInputsResponsive,
} from "@/components/SimulationJobInputsResponsive";
import SimulationTimeline from "@/components/SimulationTimeline";
import SimulationResultGroup from "@/components/SimulationResultGroup";
import SimulationResultsTab from "@/components/SimulatorResultsTab";
import SwitchedResultRow from "@/components/SwitchedResultRow";
import CopyableText from "@/components/CopyableText";
import MarketBuyOrderIndicator from "@/components/MarketBuyOrderIndicator";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import styles from "@/app/page.module.css";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import type { ClientCharacterStatus, ClientJobsResponse } from "@/lib/client/requestCache";
import { getAvailableSlotCount } from "@/lib/client/slotUsage";
import { eveCharacterPortraitUrl, eveCorporationLogoUrl } from "@/lib/eve/imageServer";
import { cn } from "@/lib/utils";
import { useAppLanguage } from "@/app/AppShell";
import { fulleriteGasSites } from "@/lib/reference/fulleriteGasSites";
import { fetchTypeMetadata, type TypeMetadata } from "@/lib/reference/types";
import {
  adjustSimulationPurchaseQuantity,
  groupSimulationActivityJobs,
  shouldAdjustSimulationPurchaseQuantity,
  simulationRunsStartingAtT0,
  type SimulationIndustryJobGroup,
} from "@/lib/planning/simulator/presentation";
import { AssemblyLineGroups } from "@/lib/reference/assemblyLineGroups";
import {
  convertSimulationTargetTime,
  getSimulationMinimumRunsPerInstall,
  getSimulationInstallableRuns,
  simulationReactionFormulaKey,
  summarizeClientSimulationInstalls,
  scheduledSimulationActivity,
  simulationManufacturingInstallPlan,
  solveSimulationActivity,
  splitSimulationRuns,
  isWormholeSystemId,
  type ClientSimulationInstall,
  type ClientSimulationInstallBatch,
  type ClientSimulationManufacturingDisplayMode,
  type ClientSimulationScheduleOptions,
  type ClientSimulationSolveMode,
  type ClientSimulationSlotGroup,
  type ClientSimulationSchedule,
} from "@/lib/planning/simulator/clientScheduler";
import { simulationReactionFormulaAvailability } from "@/lib/planning/simulator/reactionFormulaAvailability";
import type { SimulationReactionFormulaAvailability } from "@/lib/planning/simulator/reactionFormulaAvailability";
import type { PlanHaulExclusion, PlanStockItem } from "@/lib/planning/types";
import type {
  SimulationCopyJob,
  SimulationDemandSource,
  SimulationHaulTask,
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationMaterialBalance,
  SimulationMaterialLocationBucket,
  SimulationPurchase,
  SimulationReactionFormulaBalance,
  SimulationReactionFormulaLocationBucket,
  SimulationReprocessingJobGroup,
  SimulationResultV2,
} from "@/lib/planning/simulator/types";

type SimulationTab =
  | "warnings"
  | "plan"
  | "reprocess"
  | "copy"
  | "invent"
  | "react"
  | "manufacture"
  | "skills"
  | "haul"
  | "buy"
  | "surplus";

const tabs: Array<{ value: SimulationTab; label: string; icon: LucideIcon }> = [
  { value: "warnings", label: "Warnings", icon: AlertTriangle },
  { value: "plan", label: "Plan", icon: ClipboardList },
  { value: "haul", label: "Haul", icon: Truck },
  { value: "buy", label: "Buy", icon: ShoppingCart },
  { value: "reprocess", label: "Reprocess", icon: Minimize2 },
  { value: "copy", label: "Copy", icon: TestTubes },
  { value: "invent", label: "Invent", icon: FlaskConical },
  { value: "react", label: "React", icon: Atom },
  { value: "manufacture", label: "Manufacture", icon: Factory },
  { value: "skills", label: "Skills", icon: Brain },
  { value: "surplus", label: "Surplus", icon: Boxes },
];

const materialBalanceColumns = [
  "Available",
  "Immediate Demand",
  "Future Supply",
  "Future Demand",
  "Transferred Out",
  "Surplus",
] as const;
const reactionFormulaBalanceColumns = ["Available", "Owned", "In Use", "Runs to Install"] as const;
const typeIdChangedEvent = "assembly-line-planner-type-id-changed";
const simulationTabParam = "simulationTab";
const completedTypeDatesStoragePrefix = "assembly-line-simulation-completed-types:";
const simulationBuySettingsStorageKey = "assembly-line-simulation-buy-settings-v1";
const simulationBuySettingsChangedEvent = "assembly-line-simulation-buy-settings-changed";
type SimulationActivityTab = "react" | "manufacture";
type CompletedTypeDates = Record<SimulationActivityTab, Map<number, Date>>;
type SimulationBuySettings = {
  overOrderPercent: string;
  roundUpQuantities: boolean;
};

const defaultSimulationBuySettings: SimulationBuySettings = {
  overOrderPercent: "0",
  roundUpQuantities: false,
};
const defaultSimulationBuySettingsSnapshot = JSON.stringify(defaultSimulationBuySettings);
let simulationBuySettingsSnapshot = defaultSimulationBuySettingsSnapshot;

/** Subscribes to same-tab and cross-tab changes to persisted Buy settings. */
function subscribeToSimulationBuySettings(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== simulationBuySettingsStorageKey) return;
    simulationBuySettingsSnapshot = event.newValue ?? defaultSimulationBuySettingsSnapshot;
    onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(simulationBuySettingsChangedEvent, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(simulationBuySettingsChangedEvent, onStoreChange);
  };
}

/** Reads the serialized Buy settings, retaining an in-memory fallback if storage is unavailable. */
function getSimulationBuySettingsSnapshot(): string {
  try {
    const storedSettings = window.localStorage.getItem(simulationBuySettingsStorageKey);
    if (storedSettings !== null) simulationBuySettingsSnapshot = storedSettings;
  }
  catch {
    // Browser storage may be unavailable.
  }
  return simulationBuySettingsSnapshot;
}

/** Supplies stable default settings during server rendering and hydration. */
function getServerSimulationBuySettingsSnapshot(): string {
  return defaultSimulationBuySettingsSnapshot;
}

/** Parses the decimal percentage syntax accepted by the Buy numeric input. */
function parseSimulationOverOrderPercent(value: string): number | undefined {
  const normalized = value.trim();
  if (normalized === "") return 0;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return undefined;
  const percent = Number(normalized);
  return Number.isFinite(percent) && percent >= 0 ? percent : undefined;
}

/** Parses persisted Buy settings and falls back independently for invalid values. */
function parseSimulationBuySettings(snapshot: string): SimulationBuySettings {
  try {
    const parsed: unknown = JSON.parse(snapshot);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultSimulationBuySettings;
    }
    const settings = parsed as Record<string, unknown>;
    const storedPercent = settings.overOrderPercent;
    const parsedPercent =
      typeof storedPercent === "string"
        ? parseSimulationOverOrderPercent(storedPercent)
        : undefined;
    return {
      overOrderPercent:
        typeof storedPercent === "string" && parsedPercent !== undefined
          ? storedPercent
          : defaultSimulationBuySettings.overOrderPercent,
      roundUpQuantities:
        typeof settings.roundUpQuantities === "boolean"
          ? settings.roundUpQuantities
          : defaultSimulationBuySettings.roundUpQuantities,
    };
  }
  catch {
    return defaultSimulationBuySettings;
  }
}

/** Persists a partial Buy setting update and notifies subscribers in this tab. */
function updateSimulationBuySettings(update: Partial<SimulationBuySettings>): void {
  const settings = { ...parseSimulationBuySettings(getSimulationBuySettingsSnapshot()), ...update };
  simulationBuySettingsSnapshot = JSON.stringify(settings);
  try {
    window.localStorage.setItem(simulationBuySettingsStorageKey, simulationBuySettingsSnapshot);
  }
  catch {
    // Browser storage may be unavailable or full; settings remain usable in memory.
  }
  window.dispatchEvent(new Event(simulationBuySettingsChangedEvent));
}

/** Exposes persisted Buy preferences through React's external-store subscription API. */
function useSimulationBuySettings() {
  const snapshot = useSyncExternalStore(
    subscribeToSimulationBuySettings,
    getSimulationBuySettingsSnapshot,
    getServerSimulationBuySettingsSnapshot,
  );
  const settings = parseSimulationBuySettings(snapshot);
  return {
    ...settings,
    setOverOrderPercent: (value: string) =>
      updateSimulationBuySettings({ overOrderPercent: value }),
    setRoundUpQuantities: (value: boolean) =>
      updateSimulationBuySettings({ roundUpQuantities: value }),
  };
}

/** Creates an empty completion map for each activity type. */
function emptyCompletedTypeDates(): CompletedTypeDates {
  return { react: new Map(), manufacture: new Map() };
}

/** Returns the localStorage key for one simulation identity. */
function completedTypeDatesStorageKey(simulationRevision: string): string {
  return `${completedTypeDatesStoragePrefix}${encodeURIComponent(simulationRevision)}`;
}

/** Parses persisted type completion timestamps while rejecting malformed entries. */
function parseCompletedTypeDates(value: unknown): Map<number, Date> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
  const dates = new Map<number, Date>();
  for (const [typeIdText, timestamp] of Object.entries(value)) {
    const typeId = Number(typeIdText);
    const date = typeof timestamp === "string" ? new Date(timestamp) : undefined;
    if (Number.isSafeInteger(typeId) && typeId > 0 && date && Number.isFinite(date.getTime())) {
      dates.set(typeId, date);
    }
  }
  return dates;
}

/** Loads persisted completion timestamps for one simulation identity. */
function loadCompletedTypeDates(simulationRevision: string): CompletedTypeDates {
  const empty = emptyCompletedTypeDates();
  if (typeof window === "undefined") return empty;
  try {
    const stored = window.localStorage.getItem(completedTypeDatesStorageKey(simulationRevision));
    if (!stored) return empty;
    const parsed: unknown = JSON.parse(stored);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const persisted = parsed as Partial<Record<SimulationActivityTab, unknown>>;
    return {
      react: parseCompletedTypeDates(persisted.react),
      manufacture: parseCompletedTypeDates(persisted.manufacture),
    };
  }
  catch {
    return empty;
  }
}

/** Persists completion timestamps for one simulation identity. */
function saveCompletedTypeDates(
  simulationRevision: string,
  completedTypeDates: CompletedTypeDates,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = completedTypeDatesStorageKey(simulationRevision);
    if (completedTypeDates.react.size === 0 && completedTypeDates.manufacture.size === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const serialize = (dates: Map<number, Date>) =>
      Object.fromEntries([...dates].map(([typeId, date]) => [String(typeId), date.toISOString()]));
    window.localStorage.setItem(
      key,
      JSON.stringify({
        react: serialize(completedTypeDates.react),
        manufacture: serialize(completedTypeDates.manufacture),
      }),
    );
  }
  catch {
    // Browser storage may be unavailable or full; completion remains usable in memory.
  }
}

/** Removes completion timestamps that predate the latest jobs endpoint update. */
function pruneCompletedTypeDates(
  completedTypeDates: CompletedTypeDates,
  jobsLastUpdated?: string,
): CompletedTypeDates {
  const lastUpdated = Date.parse(jobsLastUpdated ?? "");
  if (!Number.isFinite(lastUpdated)) return completedTypeDates;
  let changed = false;
  const next = { ...completedTypeDates };
  for (const tab of ["react", "manufacture"] as const) {
    const retained = new Map(
      [...completedTypeDates[tab]].filter(
        ([, completedAt]) => completedAt.getTime() >= lastUpdated,
      ),
    );
    if (retained.size !== completedTypeDates[tab].size) {
      next[tab] = retained;
      changed = true;
    }
  }
  return changed ? next : completedTypeDates;
}

/** Returns whether a URL value identifies a simulator output tab. */
function isSimulationTab(value: string | null): value is SimulationTab {
  return tabs.some((tab) => tab.value === value);
}

/** Reads the selected simulator tab from the current URL. */
function readSimulationTabFromUrl(): SimulationTab {
  if (typeof window === "undefined") return "warnings";
  const value = new URLSearchParams(window.location.search).get(simulationTabParam);
  return isSimulationTab(value) ? value : "warnings";
}

/** Writes the selected simulator tab without navigating away from the planner. */
function updateSimulationTabInUrl(tab: SimulationTab, historyMode: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(simulationTabParam, tab);
  window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", url);
}

/** Tracks whether simulator output controls should use the compact mobile select. */
function useIsMobileSimulationView(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);
    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);
    return () => mediaQuery.removeEventListener("change", updateIsMobile);
  }, []);

  return isMobile;
}

/** Parses a positive type ID from the planner URL query string. */
function parseTypeId(value: string | null): number | null {
  const typeId = Number(value);
  return Number.isSafeInteger(typeId) && typeId > 0 ? typeId : null;
}

/** Reads the shared planner type filter from the current URL. */
function readTypeIdFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  return parseTypeId(new URLSearchParams(window.location.search).get("typeId"));
}

/** Subscribes a simulator filter to browser URL and history changes. */
function subscribeToTypeId(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener(typeIdChangedEvent, onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener(typeIdChangedEvent, onStoreChange);
  };
}
/** Provides the server snapshot for the browser-only planner type filter. */
function getServerTypeIdSnapshot(): number | null {
  return null;
}

/** Updates the shared planner type filter without navigating away from the result view. */
function updateTypeIdInUrl(typeId: number | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (typeId === null) url.searchParams.delete("typeId");
  else url.searchParams.set("typeId", String(typeId));
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(typeIdChangedEvent));
}

type SimulationRowControls = {
  selectedRowKey: string | null;
  onSelectRow: (rowKey: string) => void;
  isIncluded: (rowKey: string) => boolean;
  onIncludedChange: (rowKey: string, included: boolean) => void;
  onHaulIncludedChange: (rowKeys: readonly string[], included: boolean) => void;
  isTypeCompleted: (tab: "react" | "manufacture", typeId: number) => boolean;
  onTypeCompletedChange: (tab: "react" | "manufacture", typeId: number, completed: boolean) => void;
  isCompleted: (
    rowKey: string,
    scheduleIdentity?: string,
    matchScheduleRevision?: boolean,
  ) => boolean;
  onCompletedChange: (rowKey: string, completed: boolean) => void;
  getInstalledRuns: (
    rowKey: string,
    scheduleIdentity?: string,
    matchScheduleRevision?: boolean,
  ) => number;
  getCompletedInstallIds: (
    rowKey: string,
    scheduleIdentity?: string,
    matchScheduleRevision?: boolean,
  ) => Readonly<Record<string, boolean>>;
  getCompletedSchedule: (
    rowKey: string,
    scheduleIdentity?: string,
    matchScheduleRevision?: boolean,
  ) => ClientSimulationSchedule | undefined;
  onInstalledRunsChange: (
    rowKey: string,
    installedRuns: number,
    installableRuns: number,
    scheduleIdentity?: string,
    completedInstallIds?: Readonly<Record<string, boolean>>,
    schedule?: ClientSimulationSchedule,
  ) => void;
  onOpenPlan: () => void;
  onNavigateToPlan: () => void;
  onOpenBuy: () => void;
};

type SimulationCompletionState = {
  installedRuns: number;
  installableRuns?: number;
  scheduleIdentity?: string;
  completedInstallIds: Record<string, boolean>;
  schedule?: ClientSimulationSchedule;
};

type SimulationGroupAvatar = {
  typeId: number;
  name: string;
  imageVariation?: "icon" | "bp" | "bpc" | "relic";
};

/** Formats simulator quantities for compact operational rows. */
function quantity(value: number): string {
  return value.toLocaleString();
}

/** Returns the rounded total volume represented by a group of simulation haul tasks. */
function simulationHaulVolume(tasks: readonly SimulationHaulTask[]): number {
  return Math.ceil(tasks.reduce((total, task) => total + task.quantity * task.unitVolume, 0));
}

/** Sorts haul rows by AssemblyLine group, item name, and stable identity. */
function sortSimulationHaulTasks(
  tasks: readonly SimulationHaulTask[],
  groupsByTypeId: ReadonlyMap<number, string>,
): SimulationHaulTask[] {
  return [...tasks].sort((left, right) => {
    const groupOrder = (groupsByTypeId.get(left.typeId) ?? "Unknown").localeCompare(
      groupsByTypeId.get(right.typeId) ?? "Unknown",
    );
    if (groupOrder !== 0) return groupOrder;

    const nameOrder = left.typeName.localeCompare(right.typeName);
    if (nameOrder !== 0) return nameOrder;

    return left.typeId - right.typeId || left.transferId.localeCompare(right.transferId);
  });
}

/** Identifies one simulator haul route. */
function simulationHaulExclusionKey(
  value: Pick<PlanHaulExclusion, "typeId" | "fromLocationId" | "toLocationId">,
): string {
  return `${value.typeId}:${value.fromLocationId}:${value.toLocationId}`;
}

/** Builds route-scoped simulator exclusions from the haul rows currently switched off. */
function simulationHaulExclusions(
  result: SimulationResultV2 | null,
  includedRows: Readonly<Record<string, boolean>>,
  currentExclusions: readonly PlanHaulExclusion[],
  visibleHaulTasks: readonly SimulationHaulTask[] = result?.lists.haulingTasks ?? [],
): PlanHaulExclusion[] {
  const exclusions = new Map<string, PlanHaulExclusion>(
    currentExclusions.map((exclusion) => {
      const routeOnly = {
        typeId: exclusion.typeId,
        fromLocationId: exclusion.fromLocationId,
        toLocationId: exclusion.toLocationId,
      };
      return [simulationHaulExclusionKey(routeOnly), routeOnly];
    }),
  );
  if (!result) return [...exclusions.values()];
  for (const task of visibleHaulTasks) {
    const exclusion: PlanHaulExclusion = {
      typeId: task.typeId,
      fromLocationId: task.fromLocationId,
      toLocationId: task.toLocationId,
    };
    const key = simulationHaulExclusionKey(exclusion);
    const isIncluded = includedRows[`haul:${task.transferId}`] ?? !exclusions.has(key);
    if (isIncluded) exclusions.delete(key);
    else exclusions.set(key, exclusion);
  }
  return [...exclusions.values()];
}

/** Renders a simulator number with its raw value available for copying. */
function CopyableNumber({
  value,
  suffix = "",
  copyLabel = "Number",
}: {
  value: number;
  suffix?: string;
  copyLabel?: string;
}) {
  return (
    <CopyableText
      aria-label={`${copyLabel}: ${quantity(value)}${suffix}. Copy to clipboard.`}
      className="font-[inherit] text-inherit"
      textToRender={`${quantity(value)}${suffix}`}
      textToCopy={String(value)}
      copyLabel={copyLabel}
    />
  );
}

/** Resolves a readable location label from current planner reference data. */
function locationName(locationNamesById: ReadonlyMap<number, string>, locationId: number): string {
  return locationNamesById.get(locationId) ?? `Location ${locationId}`;
}

/** Returns named stockpiles that contributed demand to an aggregate ledger balance. */
function demandStockpiles(
  balance: SimulationMaterialBalance,
  stockpileNamesById: ReadonlyMap<string, string>,
): string {
  const stockpiles = [...new Set(balance.demandSources.map((source) => source.stockpileId))];
  return stockpiles.length > 0
    ? `From: ${stockpiles
        .map((stockpileId) => stockpileNamesById.get(stockpileId) ?? stockpileId)
        .join(", ")}`
    : "Ledger balance";
}

/** Creates a compact preview sequence for a collapsible simulation result group. */
function createGroupAvatars<T>(items: readonly T[], getAvatar: (item: T) => SimulationGroupAvatar) {
  return items
    .slice(0, 5)
    .map((item) => {
      const avatar = getAvatar(item);
      return { ...avatar, imageVariation: avatar.imageVariation ?? "icon" };
    });
}

/** Returns immediate supply sources that need a provenance icon beside availability. */
function immediateSupplySources(item: SimulationMaterialBalance) {
  return item.availableFromSellOrders > 0
    ? [
        {
          key: "sell-orders",
          label: "Sell orders",
          quantity: item.availableFromSellOrders,
          source: "market" as const,
          Icon: ChartLine,
        },
      ]
    : [];
}

type FutureSupplySource = {
  key: string;
  label: string;
  quantity: number;
  source:
    | "haul"
    | "industry"
    | "reaction"
    | "production"
    | "copying"
    | "invention"
    | "reprocessing"
    | "market";
  Icon: LucideIcon;
  colored?: boolean;
};

/** Returns the non-empty source contributions shown beside a future supply total. */
function futureSupplySources(item: SimulationMaterialBalance): FutureSupplySource[] {
  const productionIcon = item.activityType === "reaction" ? Atom : Factory;
  const inFlightSource =
    item.activityType === "reaction"
      ? "reaction"
      : item.activityType === "copying"
        ? "copying"
        : item.activityType === "invention"
          ? "invention"
          : "industry";
  const inFlightIcon =
    item.activityType === "reaction"
      ? Atom
      : item.activityType === "copying"
        ? TestTubes
        : item.activityType === "invention"
          ? FlaskConical
          : Factory;
  const sources: FutureSupplySource[] = [
    {
      key: "hauling",
      label: "Haul",
      quantity: item.availableFromHauling,
      source: "haul",
      Icon: Truck,
    },
    {
      key: "in-flight-production",
      label: "In Production",
      quantity: item.inFlightQuantity,
      source: inFlightSource,
      Icon: inFlightIcon,
      colored: true,
    },
    {
      key: "planned-production",
      label: item.activityType === "reaction" ? "React" : "Produce",
      quantity: item.availableFromProduction,
      source: "production",
      Icon: productionIcon,
    },
    {
      key: "copying",
      label: "Copy",
      quantity: item.availableFromCopying,
      source: "copying",
      Icon: TestTubes,
    },
    {
      key: "invention",
      label: "Invent",
      quantity: item.availableFromInvention,
      source: "invention",
      Icon: FlaskConical,
      colored: false,
    },
    {
      key: "reprocessing",
      label: "Reprocess",
      quantity: item.availableFromReprocessing,
      source: "reprocessing",
      Icon: Minimize2,
    },
    {
      key: "market",
      label: "Buy",
      quantity: item.availableFromMarket,
      source: "market",
      Icon: ShoppingCart,
    },
  ];
  return sources.filter((source) => source.quantity > 0);
}

/** Maps simulator blueprint kinds to the corresponding EVE image variation. */
function haulImageVariation(kind: SimulationHaulTask["blueprintKind"]): "icon" | "bp" | "bpc" {
  if (kind === "bpc") return "bpc";
  return kind === undefined ? "icon" : "bp";
}

/** Formats a solver duration for the compact activity summary. */
function simulationDuration(totalSeconds: number): string {
  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "0m";
}

/** Rounds a reaction row duration to its two largest useful time units. */
function simulationReactionRowDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const days = Math.floor(safeSeconds / 86_400);
  if (days > 0) {
    const roundedHours = Math.round((safeSeconds - days * 86_400) / 3_600);
    return roundedHours === 24
      ? `${days + 1}d`
      : `${days}d${roundedHours > 0 ? ` ${roundedHours}h` : ""}`;
  }

  const hours = Math.floor(safeSeconds / 3_600);
  if (hours > 0) {
    const roundedMinutes = Math.round((safeSeconds - hours * 3_600) / 60);
    return roundedMinutes === 60
      ? `${hours + 1}h`
      : `${hours}h${roundedMinutes > 0 ? ` ${roundedMinutes}m` : ""}`;
  }

  const roundedMinutes = Math.round(safeSeconds / 60);
  return roundedMinutes >= 60 ? "1h" : `${roundedMinutes}m`;
}

/** Formats a covered-run ratio for the activity summary. */
function simulationCoverage(coveredRuns: number, totalRuns: number): string {
  return totalRuns > 0 ? `${((coveredRuns / totalRuns) * 100).toFixed(1)}%` : "0.0%";
}

type SimulationActivitySlotCharacter = {
  characterId: number;
  name: string;
  availableSlots: number;
  systemId?: number;
};

type SimulationGroupCopyStatus = {
  locationId: number;
  label: "Copied" | "Copy failed";
} | null;

/** Returns characters with free slots for one simulator activity. */
function simulationSlotCharacters(
  characterStatuses: readonly ClientCharacterStatus[],
  characterNamesById: ReadonlyMap<number, string>,
  slotUsage: ClientJobsResponse["slotUsage"],
  activity: "react" | "manufacture",
): SimulationActivitySlotCharacter[] {
  const slotKey = activity === "react" ? "Reactions" : "Manufacturing";
  return characterStatuses
    .flatMap((character) => {
      const availableSlots = getAvailableSlotCount(
        slotUsage?.[String(character.characterId)],
        slotKey,
      );
      const name = characterNamesById.get(character.characterId);
      return name && availableSlots > 0
        ? [
            {
              characterId: character.characterId,
              name,
              availableSlots,
              systemId: character.location?.systemId,
            },
          ]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Renders activity metrics and the character list for a scoped slot pool. */
function SimulationActivitySummary({
  availableSlots,
  slotCharacters,
  activityLabel,
  suggestedInstalls,
  maxJobLength,
  scheduledRuns,
  installableRuns,
  totalRuns,
  poolLabel,
}: {
  availableSlots: number;
  slotCharacters: readonly SimulationActivitySlotCharacter[];
  activityLabel: string;
  suggestedInstalls: number;
  maxJobLength: number;
  scheduledRuns: number;
  installableRuns: number;
  totalRuns: number;
  poolLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3 font-mono">
      <span className="flex flex-col">
        <strong className="flex items-center gap-1 text-sm">
          {availableSlots.toLocaleString()}
          <ResponsiveDialogDrawer
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`View characters with available ${activityLabel} slots${poolLabel ? ` in ${poolLabel}` : ""}`}
                title={`View characters with available ${activityLabel} slots${poolLabel ? ` in ${poolLabel}` : ""}`}
              >
                <UsersRound aria-hidden="true" />
              </Button>
            }
            title={`${activityLabel[0].toUpperCase()}${activityLabel.slice(1)} slots by character${poolLabel ? ` in ${poolLabel}` : ""}`}
            description={`Characters with available ${activityLabel} slots${poolLabel ? ` in ${poolLabel}` : ""}.`}
          >
            <div className="flex flex-col gap-2">
              {slotCharacters.length > 0 ? (
                slotCharacters.map((character) => (
                  <div
                    className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 py-2 first:border-t-0"
                    key={character.characterId}
                  >
                    <Image
                      src={eveCharacterPortraitUrl(character.characterId, 64)}
                      alt={`${character.name} portrait`}
                      width={32}
                      height={32}
                      className="size-8 rounded-none"
                    />
                    <span className="min-w-0 truncate font-medium">{character.name}</span>
                    <Badge variant="outline">
                      {character.availableSlots.toLocaleString()} slot
                      {character.availableSlots === 1 ? "" : "s"}
                    </Badge>
                  </div>
                ))
              ) : (
                <p className="py-4 text-muted-foreground">
                  No characters have available {activityLabel} slots.
                </p>
              )}
            </div>
          </ResponsiveDialogDrawer>
        </strong>
        <small className="text-[10px] text-muted-foreground uppercase">
          {poolLabel ? `${poolLabel} ` : ""}Available slots
        </small>
      </span>
      <span className="flex flex-col">
        <strong className="text-sm">{suggestedInstalls.toLocaleString()}</strong>
        <small className="text-[10px] text-muted-foreground uppercase">Suggested installs</small>
      </span>
      <span className="flex flex-col">
        <strong className="text-sm">{scheduledRuns.toLocaleString()}</strong>
        <small className="text-[10px] text-muted-foreground uppercase">Suggested runs</small>
      </span>
      <span className="flex flex-col">
        <strong className="text-sm">{simulationDuration(maxJobLength)}</strong>
        <small className="text-[10px] text-muted-foreground uppercase">Max job length</small>
      </span>
      <span className="flex flex-col">
        <strong className="text-sm">{simulationCoverage(scheduledRuns, installableRuns)}</strong>
        <small className="text-[10px] text-muted-foreground uppercase">Installable coverage</small>
      </span>
      <span className="flex flex-col">
        <strong className="text-sm">{simulationCoverage(scheduledRuns, totalRuns)}</strong>
        <small className="text-[10px] text-muted-foreground uppercase">Total coverage</small>
      </span>
    </div>
  );
}

/** Renders reaction fact headers aligned to the wide activity-row columns. */
function SimulationActivityColumnsHeader() {
  return (
    <div className="sticky top-0 z-10 hidden items-center gap-x-[13px] bg-card px-2 pb-1 font-mono text-[10px] text-muted-foreground uppercase lg:grid lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto]">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <div className="grid grid-cols-[3rem_3rem_6rem_7rem_6rem_4rem] gap-x-3 text-right">
        <span aria-hidden="true" />
        <span className="text-center">Inputs</span>
        <span className="leading-tight">Reaction Formulas</span>
        <span>Installable / Total Runs</span>
        <span>Suggested Runs Per Install</span>
        <span className="leading-tight">Suggested Installs</span>
      </div>
      <span aria-hidden="true" className="w-4" />
    </div>
  );
}

/** Counts owned, visible, in-use, and available formulas for one reaction result row. */
function simulationReactionFormulaCountsForGroup(
  group: SimulationIndustryJobGroup,
  availability: SimulationReactionFormulaAvailability | undefined,
): {
  available: number | undefined;
  visible: number;
  owned: number;
  inUse: number | undefined;
} {
  if (!availability) return { available: undefined, visible: 0, owned: 0, inUse: undefined };

  return [...new Set(group.jobs.map((job) => job.blueprint.blueprintTypeId))].reduce(
    (counts, typeId) => {
      const key = simulationReactionFormulaKey(group.locationId, typeId);
      const inUse = availability.inUseByLocationAndType.get(key) ?? 0;
      if (counts.available !== undefined) {
        counts.available += availability.availableByLocationAndType.get(key) ?? 0;
      }
      if (counts.inUse !== undefined) {
        counts.inUse += inUse;
      }
      counts.visible += availability.visibleByLocationAndType.get(key) ?? 0;
      counts.owned += availability.ownedByLocationAndType.get(key) ?? 0;
      return counts;
    },
    {
      available: availability.availabilityKnown ? 0 : undefined,
      visible: 0,
      owned: 0,
      inUse: availability.availabilityKnown ? 0 : undefined,
    },
  );
}

/** Renders reaction facts as two label/value columns on narrow screens. */
function SimulationReactionRowFacts({
  installPlan,
  inputs,
  availableFormulas,
  visibleFormulas,
  ownedFormulas,
  inUseFormulas,
  installableRuns,
  totalRuns,
  installableRuntimeSeconds,
  totalRuntimeSeconds,
  suggestedInstallBatches,
}: {
  installPlan: ReactNode;
  inputs: ReactNode;
  availableFormulas: number | undefined;
  visibleFormulas: number;
  ownedFormulas: number;
  inUseFormulas: number | undefined;
  installableRuns: number;
  totalRuns: number;
  installableRuntimeSeconds: number;
  totalRuntimeSeconds: number;
  suggestedInstallBatches: readonly ClientSimulationInstallBatch[];
}) {
  const formulaTooltipLabel = [
    "Reaction Formulas",
    `Visible: ${quantity(visibleFormulas)}`,
    `Owned: ${quantity(ownedFormulas)}`,
    `In Use: ${inUseFormulas === undefined ? "Unknown" : quantity(inUseFormulas)}`,
    `Available: ${availableFormulas === undefined ? "Unknown" : quantity(availableFormulas)}`,
  ].join(". ");
  const displayInstallBatches =
    suggestedInstallBatches.length > 0
      ? suggestedInstallBatches
      : [{ runsPerInstall: 0, installCount: 0, estimatedDurationSecondsPerInstall: 0 }];

  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-right font-mono text-xs lg:grid-cols-[3rem_3rem_6rem_7rem_6rem_4rem] lg:gap-x-3">
      <span className="col-span-2 flex items-center justify-self-start lg:col-span-1 lg:col-start-1">
        {installPlan}
      </span>
      <span className="text-muted-foreground lg:hidden">Inputs</span>
      <span className="flex justify-self-center lg:col-start-2 lg:row-start-1">{inputs}</span>
      <span className="text-muted-foreground lg:hidden">Reaction Formulas</span>
      <span className="flex items-center justify-end lg:col-start-3 lg:row-start-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={formulaTooltipLabel}
                className="flex items-center justify-end"
                role="group"
                tabIndex={0}
              >
                {availableFormulas === undefined ? (
                  <span className="text-muted-foreground">?</span>
                ) : (
                  <CopyableNumber
                    value={availableFormulas}
                    copyLabel="Available reaction formulas"
                  />
                )}
                <span aria-hidden="true" className="whitespace-pre">
                  {" / "}
                </span>
                <CopyableNumber value={visibleFormulas} copyLabel="Visible reaction formulas" />
              </span>
            }
          />
          <TooltipContent>
            <div className="flex flex-col items-start gap-1">
              <strong>Reaction Formulas</strong>
              <span>Visible: {quantity(visibleFormulas)}</span>
              <span>Owned: {quantity(ownedFormulas)}</span>
              <span>
                In Use: {inUseFormulas === undefined ? "Unknown" : quantity(inUseFormulas)}
              </span>
              <span>
                Available:{" "}
                {availableFormulas === undefined ? "Unknown" : quantity(availableFormulas)}
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      </span>
      <span className="text-muted-foreground lg:hidden">Installable / Total Runs</span>
      <span className="flex min-w-0 flex-col items-end justify-self-end lg:col-start-4 lg:row-start-1">
        <span className="flex items-center justify-end">
          <CopyableNumber value={installableRuns} copyLabel="Installable runs" />
          <span aria-hidden="true" className="whitespace-pre">
            {" / "}
          </span>
          <CopyableNumber value={totalRuns} copyLabel="Total runs" />
        </span>
        <small className="text-muted-foreground">
          {simulationReactionRowDuration(installableRuntimeSeconds)} /{" "}
          {simulationReactionRowDuration(totalRuntimeSeconds)}
        </small>
      </span>
      <span className="text-muted-foreground lg:hidden">Suggested Runs Per Install</span>
      <span className="flex min-w-0 flex-col items-end gap-y-1 justify-self-end lg:col-start-5 lg:row-start-1">
        {displayInstallBatches.map((batch) => (
          <span
            key={`${batch.runsPerInstall}:${batch.installCount}`}
            className="flex flex-col items-end"
          >
            <CopyableNumber
              value={batch.runsPerInstall}
              copyLabel={`${batch.runsPerInstall} runs per install`}
            />
            <small className="text-muted-foreground">
              {simulationReactionRowDuration(batch.estimatedDurationSecondsPerInstall)}
            </small>
          </span>
        ))}
      </span>
      <span className="text-muted-foreground lg:hidden">Suggested Installs</span>
      <span className="flex flex-col items-end gap-y-1 justify-self-end lg:col-start-6 lg:row-start-1">
        {displayInstallBatches.map((batch) => (
          <span
            key={`${batch.runsPerInstall}:${batch.installCount}`}
            className="flex flex-col items-end"
          >
            <CopyableNumber
              value={batch.installCount}
              copyLabel={`${batch.installCount} installs at ${batch.runsPerInstall} runs each`}
            />
            <span aria-hidden="true" className="h-4" />
          </span>
        ))}
      </span>
    </div>
  );
}

type SimulationBlueprintCounts = {
  owned: number;
  available: number;
};

type SimulationBlueprintCountSummary = {
  owned: number;
  available: number | undefined;
};

/** Counts owned and currently available blueprint assets for one simulator job. */
function simulationBlueprintCounts(
  job: SimulationIndustryJob,
  stock: readonly PlanStockItem[],
): SimulationBlueprintCounts {
  const matchingBlueprints = stock.filter(
    (item) =>
      item.typeId === job.blueprint.blueprintTypeId
      && (item.category === "blueprint" || item.category === "reactionformula"),
  );
  const countPrints = (item: PlanStockItem) =>
    item.blueprintPrints && item.blueprintPrints.length > 0
      ? item.blueprintPrints.length
      : Math.max(0, item.quantity);
  return matchingBlueprints.reduce(
    (counts, item) => {
      const quantity = countPrints(item);
      counts.owned += quantity;
      if (!item.inUse && !item.inBuild) counts.available += quantity;
      return counts;
    },
    { owned: 0, available: 0 },
  );
}

type SimulationInstallPlanView = "compact" | "full";

type SimulationInstallPlanEntry = {
  job: SimulationIndustryJob;
  schedule: ClientSimulationSchedule | undefined;
  installedRuns: number;
  completedInstallIds: Readonly<Record<string, boolean>>;
  scheduleRevision: string;
  blueprintCounts: SimulationBlueprintCounts;
  onInstalledRunsChange: (
    installedRuns: number,
    scheduleIdentity: string,
    completedInstallIds: Readonly<Record<string, boolean>>,
    schedule: ClientSimulationSchedule | undefined,
  ) => void;
};

type SimulationInstallDetail = {
  install: ClientSimulationInstall;
  entry: SimulationInstallPlanEntry;
  scheduleIdentity: string;
  trackCompletion: boolean;
};

type CompactInstallGroup = {
  runs: number;
  durationSeconds: number;
  installs: SimulationInstallDetail[];
  displayInstallCount: number;
  completionDetails: SimulationInstallDetail[];
};

type DetailedInstallDisplay = {
  detail: SimulationInstallDetail;
  completionDetails: SimulationInstallDetail[];
};

/** Identifies one generated install plan for completion-state reconciliation. */
function simulationInstallScheduleIdentity(
  scheduleRevision: string,
  installs: readonly ClientSimulationInstall[],
): string {
  return `${scheduleRevision}|${installs
    .map(
      (install) =>
        `${install.installId}:${install.characterId ?? ""}:${install.slotIndex ?? ""}:${install.runs}`,
    )
    .join("|")}`;
}

/** Matches a full install identity against its solver-revision prefix. */
function simulationCompletionMatchesSchedule(
  completionIdentity: string | undefined,
  scheduleIdentity: string,
  matchScheduleRevision: boolean,
): boolean {
  return (
    completionIdentity === scheduleIdentity
    || (matchScheduleRevision && completionIdentity?.startsWith(`${scheduleIdentity}|`) === true)
  );
}

/** Groups installs by product type and runs per install for compact display. */
function compactInstallGroups(
  installs: readonly SimulationInstallDetail[],
  aggregateReactionRuntime: boolean,
  scheduleOptions: ClientSimulationScheduleOptions,
): CompactInstallGroup[] {
  if (aggregateReactionRuntime) {
    return compactReactionRuntimeGroups(installs, scheduleOptions);
  }
  const groups = new Map<string, SimulationInstallDetail[]>();
  for (const detail of installs) {
    const key = `${detail.entry.job.productTypeId}:${detail.install.runs}`;
    const group = groups.get(key) ?? [];
    group.push(detail);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(
      ([, leftInstalls], [, rightInstalls]) =>
        rightInstalls[0].install.runs - leftInstalls[0].install.runs,
    )
    .map(([, groupedInstalls]) => ({
      runs: groupedInstalls[0].install.runs,
      durationSeconds: Math.max(
        ...groupedInstalls.map((detail) => detail.install.durationSeconds),
        0,
      ),
      installs: groupedInstalls,
      displayInstallCount: groupedInstalls.length,
      completionDetails: groupedInstalls,
    }));
}

/** Groups runtime reaction installs by product type and exact floor/ceiling run count. */
function compactReactionRuntimeGroups(
  installs: readonly SimulationInstallDetail[],
  scheduleOptions: ClientSimulationScheduleOptions,
): CompactInstallGroup[] {
  const byProductType = new Map<number, SimulationInstallDetail[]>();
  for (const detail of installs) {
    const group = byProductType.get(detail.entry.job.productTypeId) ?? [];
    group.push(detail);
    byProductType.set(detail.entry.job.productTypeId, group);
  }

  return [...byProductType.values()].flatMap((productInstalls) => {
    const totalRuns = productInstalls.reduce((total, detail) => total + detail.install.runs, 0);
    const maximumRunsPerInstall = Math.max(
      ...productInstalls.map((detail) => detail.install.runs),
      0,
    );
    if (totalRuns <= 0 || maximumRunsPerInstall <= 0) return [];
    const minimumRuns = scheduleOptions.protectReactionMaterialBonus
      ? Math.max(
          ...productInstalls.map((detail) =>
            getSimulationMinimumRunsPerInstall(detail.entry.job, scheduleOptions),
          ),
          1,
        )
      : 1;
    const installCount =
      minimumRuns > 1
        ? Math.min(productInstalls.length, Math.max(1, Math.ceil(totalRuns / minimumRuns)))
        : Math.ceil(totalRuns / maximumRunsPerInstall);
    const allocations = splitSimulationRuns(totalRuns, installCount, minimumRuns);
    const groups: CompactInstallGroup[] = [];
    let detailOffset = 0;
    let completionOffset = 0;
    for (const runs of [...new Set(allocations)]) {
      const displayInstallCount = allocations.filter((allocation) => allocation === runs).length;
      const details = installDetailsWithRuns(
        productInstalls.slice(detailOffset, detailOffset + displayInstallCount),
        runs,
      );
      detailOffset += displayInstallCount;
      const remainingGroups = [...new Set(allocations)].length - groups.length;
      const remainingDetails = productInstalls.length - completionOffset;
      const completionCount =
        remainingGroups === 1
          ? remainingDetails
          : Math.max(1, Math.ceil(remainingDetails / remainingGroups));
      const completionDetails = productInstalls.slice(
        completionOffset,
        completionOffset + completionCount,
      );
      completionOffset += completionDetails.length;
      groups.push({
        runs,
        durationSeconds: Math.max(...details.map((detail) => detail.install.durationSeconds), 0),
        installs: details,
        displayInstallCount,
        completionDetails,
      });
    }
    return groups;
  });
}

/** Copies install details with the normalized run count shown by a compact group. */
function installDetailsWithRuns(
  details: readonly SimulationInstallDetail[],
  runs: number,
): SimulationInstallDetail[] {
  return details.map((detail) => ({
    ...detail,
    install: {
      ...detail.install,
      runs,
      durationSeconds: Math.ceil(runs * detail.entry.job.durationPerRunSeconds),
    },
  }));
}

/** Expands compact groups into one normalized detail per displayed install. */
function detailedInstallDetailsFromGroups(
  groups: readonly CompactInstallGroup[],
): DetailedInstallDisplay[] {
  return groups.flatMap((group) =>
    group.installs
      .slice(0, group.displayInstallCount)
      .map((detail) => ({
        detail,
        completionDetails: group.completionDetails,
      })),
  );
}

/** Returns all install rows that should be visible for one grouped simulator job. */
function displayInstallsForEntry(
  entry: SimulationInstallPlanEntry,
  activityLabel: "reaction" | "manufacturing",
  manufacturingDisplayMode: ClientSimulationManufacturingDisplayMode,
): Array<{ install: ClientSimulationInstall; trackCompletion: boolean }> {
  if (activityLabel === "manufacturing") {
    return simulationManufacturingInstallPlan(entry.job, entry.schedule, manufacturingDisplayMode);
  }

  const clientInstalls = entry.schedule?.installs ?? [];
  if (clientInstalls.length > 0) {
    return clientInstalls.map((install) => ({ install, trackCompletion: true }));
  }
  return [];
}

type SimulationInstallPlanDialogLayoutProps = {
  entries: readonly SimulationInstallPlanEntry[];
  installDetails: SimulationInstallDetail[];
  compactGroups: CompactInstallGroup[];
  activityLabel: "reaction" | "manufacturing";
  blueprintCounts?: SimulationBlueprintCountSummary;
  characterNamesById: ReadonlyMap<number, string>;
  onOpenPlan: () => void;
  readOnly: boolean;
};

type SimulationInstallPlanDialogModelProps = {
  entries: readonly SimulationInstallPlanEntry[];
  scheduleOptions: ClientSimulationScheduleOptions;
  blueprintCounts?: SimulationBlueprintCountSummary;
  characterNamesById: ReadonlyMap<number, string>;
  onOpenPlan: () => void;
  readOnly: boolean;
};

/** Creates install details using the activity-specific display and completion rules. */
function simulationInstallDetails(
  entries: readonly SimulationInstallPlanEntry[],
  activityLabel: "reaction" | "manufacturing",
  manufacturingDisplayMode: ClientSimulationManufacturingDisplayMode = "total",
): SimulationInstallDetail[] {
  return entries.flatMap((entry) => {
    const displayInstalls = displayInstallsForEntry(entry, activityLabel, manufacturingDisplayMode);
    const scheduleInstalls = entry.schedule?.installs ?? [];
    const scheduleIdentity = simulationInstallScheduleIdentity(
      entry.scheduleRevision,
      scheduleInstalls,
    );
    return displayInstalls.map(({ install, trackCompletion }) => ({
      install,
      entry,
      scheduleIdentity,
      trackCompletion,
    }));
  });
}

/** Renders the reaction-specific install plan and runtime grouping behavior. */
function SimulationReactionInstallPlanDialog({
  entries,
  solveMode,
  scheduleOptions,
  blueprintCounts,
  characterNamesById,
  onOpenPlan,
  readOnly,
}: SimulationInstallPlanDialogModelProps & { solveMode: ClientSimulationSolveMode }) {
  const installDetails = simulationInstallDetails(entries, "reaction");
  const compactGroups = compactInstallGroups(
    installDetails,
    solveMode === "run-time-hours" || solveMode === "run-time-days",
    scheduleOptions,
  );
  return (
    <SimulationInstallPlanDialogLayout
      entries={entries}
      installDetails={installDetails}
      compactGroups={compactGroups}
      activityLabel="reaction"
      blueprintCounts={blueprintCounts}
      characterNamesById={characterNamesById}
      onOpenPlan={onOpenPlan}
      readOnly={readOnly}
    />
  );
}

/** Renders the manufacturing-specific install plan and server-install fallback behavior. */
function SimulationManufacturingInstallPlanDialog({
  entries,
  displayMode,
  scheduleOptions,
  characterNamesById,
  onOpenPlan,
  readOnly,
}: SimulationInstallPlanDialogModelProps & {
  displayMode: ClientSimulationManufacturingDisplayMode;
}) {
  const installDetails = simulationInstallDetails(entries, "manufacturing", displayMode);
  const compactGroups = compactInstallGroups(installDetails, false, scheduleOptions);
  return (
    <SimulationInstallPlanDialogLayout
      entries={entries}
      installDetails={installDetails}
      compactGroups={compactGroups}
      activityLabel="manufacturing"
      characterNamesById={characterNamesById}
      onOpenPlan={onOpenPlan}
      readOnly={readOnly}
    />
  );
}

/** Renders the shared install-plan dialog presentation for an activity-specific model. */
function SimulationInstallPlanDialogLayout({
  entries,
  installDetails,
  compactGroups,
  activityLabel,
  blueprintCounts: blueprintCountsOverride,
  characterNamesById,
  onOpenPlan,
  readOnly,
}: SimulationInstallPlanDialogLayoutProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SimulationInstallPlanView>("compact");
  const detailedInstallDetails = detailedInstallDetailsFromGroups(compactGroups);
  const installableRuns = entries.reduce((total, entry) => total + entry.job.readyNowRuns, 0);
  const totalRuns = entries.reduce((total, entry) => total + entry.job.requiredRuns, 0);
  const installableRuntimeSeconds = entries.reduce(
    (total, entry) => total + entry.job.readyNowRuns * entry.job.durationPerRunSeconds,
    0,
  );
  const totalRuntimeSeconds = entries.reduce(
    (total, entry) => total + entry.job.requiredRuns * entry.job.durationPerRunSeconds,
    0,
  );
  const allocatedSlots = installDetails.filter(
    ({ install }) => install.characterId !== undefined && install.slotIndex !== undefined,
  ).length;
  const entryBlueprintCounts = entries.reduce(
    (counts, entry) => ({
      owned: counts.owned + entry.blueprintCounts.owned,
      available: counts.available + entry.blueprintCounts.available,
    }),
    { owned: 0, available: 0 },
  );
  const blueprintCounts = blueprintCountsOverride ?? entryBlueprintCounts;
  const hasInsufficientInputs = entries.some(
    (entry) =>
      entry.job.inputs.length > 0
      && Math.min(...entry.job.inputs.map((input) => input.availableNow)) === 0,
  );
  const productName = entries[0]?.job.productName ?? "Item";
  const completed = (detail: SimulationInstallDetail) => {
    if (!detail.trackCompletion) return false;
    const totalEntryRuns = detail.entry.schedule?.runs ?? 0;
    return (
      (totalEntryRuns > 0 && detail.entry.installedRuns >= totalEntryRuns)
      || detail.entry.completedInstallIds[detail.install.installId] === true
    );
  };
  const setInstallCompleted = (details: readonly SimulationInstallDetail[], checked: boolean) => {
    const detailsByEntry = new Map<SimulationInstallPlanEntry, SimulationInstallDetail[]>();
    for (const detail of details) {
      const entryDetails = detailsByEntry.get(detail.entry) ?? [];
      entryDetails.push(detail);
      detailsByEntry.set(detail.entry, entryDetails);
    }
    for (const [entry, allEntryDetails] of detailsByEntry) {
      const entryDetails = allEntryDetails.filter((detail) => detail.trackCompletion);
      if (entryDetails.length === 0) continue;
      const entryInstalls = entry.schedule?.installs ?? [];
      const allRunsInstalled =
        entryInstalls.length > 0
        && entry.installedRuns >= entryInstalls.reduce((total, install) => total + install.runs, 0);
      const next = allRunsInstalled
        ? Object.fromEntries(entryInstalls.map((install) => [install.installId, true]))
        : { ...entry.completedInstallIds };
      let installedRunsDelta = 0;
      for (const detail of entryDetails) {
        const wasCompleted = completed(detail);
        if (wasCompleted === checked) continue;
        installedRunsDelta += checked ? detail.install.runs : -detail.install.runs;
        next[detail.install.installId] = checked;
      }
      entry.onInstalledRunsChange(
        Math.max(0, entry.installedRuns + installedRunsDelta),
        entryDetails[0].scheduleIdentity,
        next,
        entry.schedule,
      );
    }
  };
  const someCompleted = (details: readonly SimulationInstallDetail[]) =>
    details.some((detail) => completed(detail));
  const allCompleted = (details: readonly SimulationInstallDetail[]) =>
    details.length > 0 && details.every((detail) => completed(detail));
  const navigateToPlan = () => {
    setOpen(false);
    onOpenPlan();
  };

  return (
    <ResponsiveDialogDrawer
      open={open}
      onOpenChange={setOpen}
      trigger={
        installableRuns > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label={`View ${productName} install plan`}
            className="size-6 text-muted-foreground transition-colors hover:text-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <ListChecks aria-hidden="true" />
          </Button>
        ) : undefined
      }
      triggerTooltip={`View ${productName} install plan`}
      title={`${productName} install plan`}
      description={`Planned ${activityLabel} installs for this item.`}
      headerContent={
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4">
            <div className="flex flex-col">
              <strong>{installableRuns.toLocaleString()}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">
                Installable runs
                {activityLabel === "reaction"
                  ? ` · ${simulationDuration(installableRuntimeSeconds)}`
                  : ""}
              </small>
            </div>
            <div className="flex flex-col">
              <strong>{totalRuns.toLocaleString()}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">
                Total runs
                {activityLabel === "reaction"
                  ? ` · ${simulationDuration(totalRuntimeSeconds)}`
                  : ""}
              </small>
            </div>
            <div className="flex flex-col">
              <strong>{allocatedSlots.toLocaleString()}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">Slots allocated</small>
            </div>
            <div className="flex flex-col">
              <strong>
                {blueprintCounts.owned.toLocaleString()} /{" "}
                {blueprintCounts.available?.toLocaleString() ?? "?"}
              </strong>
              <small className="text-[10px] text-muted-foreground uppercase">
                BPs owned / available
              </small>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <Label className="flex items-center gap-2 text-xs">
              <span>View: Compact</span>
              <Switch
                aria-label="Show full install plan"
                checked={view === "full"}
                onCheckedChange={(checked) => setView(checked ? "full" : "compact")}
              />
              <span>Detailed</span>
            </Label>
          </div>
        </div>
      }
    >
      <div className="flex flex-col">
        {view === "full"
          ? detailedInstallDetails.map(({ detail, completionDetails }, index) => {
              const install = detail.install;
              const characterName =
                install.characterId === undefined
                  ? undefined
                  : characterNamesById.get(install.characterId);
              return (
                <SwitchedResultRow
                  key={install.installId}
                  name={detail.entry.job.productName}
                  typeId={detail.entry.job.productTypeId}
                  linkPath="planner"
                  linkIcon={ClipboardList}
                  linkSearchParams={{ simulationTab: "plan" }}
                  linkHash="plan-breakdown"
                  navigateInPlace
                  onNavigate={navigateToPlan}
                  subline={
                    install.characterId === undefined
                      ? `BP ${detail.entry.job.blueprint.blueprintTypeId} · Install ${index + 1} · Character not assigned`
                      : `BP ${detail.entry.job.blueprint.blueprintTypeId} · Install ${index + 1} · ${characterName ?? `Character ${install.characterId}`}`
                  }
                  variation="icon"
                  showSwitch={false}
                  checkboxChecked={allCompleted(completionDetails)}
                  checkboxDisabled={
                    readOnly
                    || completionDetails.some(
                      (completionDetail) => !completionDetail.trackCompletion,
                    )
                  }
                  checkboxIndeterminate={
                    !allCompleted(completionDetails) && someCompleted(completionDetails)
                  }
                  installed={allCompleted(completionDetails)}
                  checkboxTooltip="Mark install complete"
                  onCheckboxChange={(checked) => setInstallCompleted(completionDetails, checked)}
                  contentClassName="w-full justify-between gap-3 self-end text-right font-mono text-xs sm:grid sm:min-w-[11rem] sm:grid-cols-[minmax(0,1fr)_max-content] sm:gap-x-4 sm:justify-normal sm:self-auto"
                >
                  {install.characterId !== undefined ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Image
                            src={eveCharacterPortraitUrl(install.characterId, 32)}
                            alt={`${characterName ?? `Character ${install.characterId}`} portrait`}
                            width={24}
                            height={24}
                            className="size-6 rounded-none"
                          />
                        }
                      />
                      <TooltipContent>
                        {characterName ?? `Character ${install.characterId}`}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <UserRound
                            aria-label="Not Assigned"
                            className="size-6 text-muted-foreground"
                          />
                        }
                      />
                      <TooltipContent>Not Assigned</TooltipContent>
                    </Tooltip>
                  )}
                  <CopyableNumber
                    value={install.runs}
                    suffix={` run${install.runs === 1 ? "" : "s"}${activityLabel === "reaction" ? ` · ${simulationDuration(install.durationSeconds)}` : ""}`}
                    copyLabel={`Install run${install.runs === 1 ? "" : "s"}`}
                  />
                </SwitchedResultRow>
              );
            })
          : compactGroups.map((group) => {
              const firstDetail = group.installs[0];
              return (
                <SwitchedResultRow
                  key={`${firstDetail.entry.job.productTypeId}:${group.runs}`}
                  name={firstDetail.entry.job.productName}
                  typeId={firstDetail.entry.job.productTypeId}
                  linkPath="planner"
                  linkIcon={ClipboardList}
                  linkSearchParams={{ simulationTab: "plan" }}
                  linkHash="plan-breakdown"
                  navigateInPlace
                  onNavigate={navigateToPlan}
                  variation="icon"
                  showSwitch={false}
                  checkboxChecked={allCompleted(group.completionDetails)}
                  checkboxDisabled={
                    readOnly || group.completionDetails.some((detail) => !detail.trackCompletion)
                  }
                  checkboxIndeterminate={
                    !allCompleted(group.completionDetails) && someCompleted(group.completionDetails)
                  }
                  installed={allCompleted(group.completionDetails)}
                  checkboxTooltip="Mark grouped installs complete"
                  onCheckboxChange={(checked) =>
                    setInstallCompleted(group.completionDetails, checked)
                  }
                  contentClassName="w-full justify-between gap-3 self-end text-right font-mono text-xs sm:grid sm:min-w-[11rem] sm:grid-cols-[minmax(0,1fr)_max-content] sm:gap-x-4 sm:justify-normal sm:self-auto"
                >
                  <span className="flex flex-col items-end">
                    <CopyableNumber
                      value={group.runs}
                      suffix={` run${group.runs === 1 ? "" : "s"} each`}
                      copyLabel="Runs per install"
                    />
                    <small className="text-muted-foreground">
                      {simulationDuration(group.durationSeconds)}
                    </small>
                  </span>
                  <span>
                    {quantity(group.displayInstallCount)} install
                    {group.displayInstallCount === 1 ? "" : "s"}
                  </span>
                </SwitchedResultRow>
              );
            })}
        {installDetails.length === 0 && (
          <p className="py-4 text-muted-foreground">
            No slots are allocated for this item.
            {blueprintCounts.available === 0
              ? " No available blueprints."
              : hasInsufficientInputs
                ? " Insufficient inputs."
                : null}
          </p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}

/** Counts owned BPO records for one blueprint type. */
function ownedBpoCount(typeId: number, stock: readonly PlanStockItem[]): number {
  return stock
    .filter((item) => item.typeId === typeId && item.category === "blueprint")
    .reduce(
      (total, item) => {
        if (item.blueprintType === "bpo") return total + Math.max(0, item.quantity);
        return total + (item.blueprintPrints?.filter((print) => print.type === "bpo").length ?? 0);
      },
      0,
    );
}

/** Selects blueprint artwork, preferring BPCs unless a BPO is owned. */
function materialImageVariation(
  item: Pick<SimulationMaterialBalance, "typeId" | "typeName">,
  stock: readonly PlanStockItem[],
  metadataByTypeId: ReadonlyMap<number, TypeMetadata>,
): "icon" | "bp" | "bpc" | "relic" {
  if (metadataByTypeId.get(item.typeId)?.isAncientRelic) return "relic";
  if (!/\bblueprint$/i.test(item.typeName)) return "icon";
  const techLevel = metadataByTypeId.get(item.typeId)?.techLevel;
  if (techLevel === undefined) return "bpc";
  if (techLevel === 2) return "bpc";
  return ownedBpoCount(item.typeId, stock) > 0 ? "bp" : "bpc";
}

/** Uses relic artwork when an invention source is categorized as an Ancient Relic. */
function simulationInventionSourceImageVariation(
  job: SimulationInventionJob,
  metadataByTypeId: ReadonlyMap<number, TypeMetadata>,
): "bpc" | "relic" {
  return metadataByTypeId.get(job.sourceBlueprintTypeId)?.isAncientRelic ? "relic" : "bpc";
}

/** Identifies material balances whose type names represent blueprint records. */
function isBlueprintBalance(item: Pick<SimulationMaterialBalance, "typeName">): boolean {
  return /\bblueprint$/i.test(item.typeName);
}

/** Loads localized type metadata needed for blueprint artwork decisions. */
function useSimulationTypeMetadata(typeIds: readonly number[]) {
  const { language } = useAppLanguage();
  const typeIdKey = [...new Set(typeIds)].sort((left, right) => left - right).join(",");
  const requestKey = `${language}:${typeIdKey}`;
  const [loadedMetadata, setLoadedMetadata] = useState<{
    requestKey: string;
    metadataByTypeId: ReadonlyMap<number, TypeMetadata>;
  }>({ requestKey: "", metadataByTypeId: new Map() });

  useEffect(() => {
    const requestedTypeIds = typeIdKey.split(",").filter(Boolean).map(Number);
    if (requestedTypeIds.length === 0) return;
    let cancelled = false;
    void fetchTypeMetadata(requestedTypeIds, language)
      .then((metadata) => {
        if (cancelled) return;
        setLoadedMetadata({
          requestKey,
          metadataByTypeId: new Map(metadata.map((item) => [item.typeId, item])),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadedMetadata({ requestKey, metadataByTypeId: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, [language, requestKey, typeIdKey]);

  return loadedMetadata.requestKey === requestKey
    ? loadedMetadata.metadataByTypeId
    : new Map<number, TypeMetadata>();
}

/** Loads localized names for simulator type IDs while retaining a stable ID fallback. */
function useSimulationTypeNames(typeIds: readonly number[]) {
  const { language } = useAppLanguage();
  const typeIdKey = [...new Set(typeIds)].sort((left, right) => left - right).join(",");
  const requestKey = `${language}:${typeIdKey}`;
  const [loadedNames, setLoadedNames] = useState<{
    requestKey: string;
    namesByTypeId: ReadonlyMap<number, string>;
  }>({ requestKey: "", namesByTypeId: new Map() });

  useEffect(() => {
    const requestedTypeIds = typeIdKey.split(",").filter(Boolean).map(Number);
    if (requestedTypeIds.length === 0) return;
    let cancelled = false;
    void fetchTypeMetadata(requestedTypeIds, language)
      .then((metadata) => {
        if (cancelled) return;
        setLoadedNames({
          requestKey,
          namesByTypeId: new Map(metadata.map((item) => [item.typeId, item.name])),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadedNames({ requestKey, namesByTypeId: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, [language, requestKey, typeIdKey]);

  return loadedNames.requestKey === requestKey ? loadedNames.namesByTypeId : new Map();
}

/** Loads localized SDE assembly groups for purchase rows without response metadata. */
function useSimulationAssemblyLineGroups(typeIds: readonly number[]) {
  const { language } = useAppLanguage();
  const typeIdKey = [...new Set(typeIds)].sort((left, right) => left - right).join(",");
  const requestKey = `${language}:${typeIdKey}`;
  const [loadedGroups, setLoadedGroups] = useState<{
    requestKey: string;
    groupsByTypeId: ReadonlyMap<number, string>;
    error: string | null;
  }>({ requestKey: "", groupsByTypeId: new Map(), error: null });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const requestedTypeIds = typeIdKey.split(",").filter(Boolean).map(Number);
    if (requestedTypeIds.length === 0) return;
    let cancelled = false;
    void fetchTypeMetadata(requestedTypeIds, language)
      .then((metadata) => {
        if (cancelled) return;
        setLoadedGroups({
          requestKey,
          groupsByTypeId: new Map(
            metadata.map((item) => [item.typeId, item.assemblyLineGroup ?? "Unknown"]),
          ),
          error: null,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedGroups({
            requestKey,
            groupsByTypeId: new Map(),
            error: "Type metadata could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [language, requestKey, retryCount, typeIdKey]);

  return {
    groupsByTypeId:
      loadedGroups.requestKey === requestKey ? loadedGroups.groupsByTypeId : new Map(),
    error: loadedGroups.requestKey === requestKey ? loadedGroups.error : null,
    isLoading: typeIdKey.length > 0 && loadedGroups.requestKey !== requestKey,
    retry: () => setRetryCount((current) => current + 1),
  };
}

/** Renders location-scoped rows inside collapsible result groups. */
function SimulationLocationResultGroups<T extends { locationId: number }>({
  tab,
  items,
  groupKeyPrefix,
  locationNamesById,
  reactionMaterialBonusesByLocation,
  openGroups,
  onOpenGroupChange,
  getRowKey,
  getAvatar,
  groupHeader,
  getGroupHeader,
  getGroupAction,
  renderRow,
}: {
  tab: SimulationTab;
  items: readonly T[];
  groupKeyPrefix?: string;
  locationNamesById: ReadonlyMap<number, string>;
  reactionMaterialBonusesByLocation?: ReadonlyMap<number, number>;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
  getRowKey: (item: T) => string;
  getAvatar: (item: T) => SimulationGroupAvatar;
  groupHeader?: ReactNode;
  getGroupHeader?: (locationId: number, items: readonly T[]) => ReactNode;
  getGroupAction?: (
    locationId: number,
    items: readonly T[],
  ) => { onCopyGroup: () => void; copyLabel: string } | undefined;
  renderRow: (item: T) => ReactNode;
}) {
  const itemsByLocation = new Map<number, T[]>();
  for (const item of items) {
    const groupItems = itemsByLocation.get(item.locationId) ?? [];
    groupItems.push(item);
    itemsByLocation.set(item.locationId, groupItems);
  }
  const sortedGroups = [...itemsByLocation.entries()].sort(([leftId], [rightId]) =>
    locationName(locationNamesById, leftId).localeCompare(locationName(locationNamesById, rightId)),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {sortedGroups.map(([locationId, groupItems]) => {
        const groupKey = `${groupKeyPrefix ?? tab}:${locationId}`;
        const avatars = createGroupAvatars(groupItems, getAvatar);
        const groupAction = getGroupAction?.(locationId, groupItems);
        const resolvedGroupHeader = getGroupHeader?.(locationId, groupItems) ?? groupHeader;
        const hasReactionMaterialBonus =
          reactionMaterialBonusesByLocation?.has(locationId) ?? false;
        const reactionMaterialBonus = -(reactionMaterialBonusesByLocation?.get(locationId) ?? 0);
        const groupLabel = locationName(locationNamesById, locationId);
        const reactionMaterialLabel = hasReactionMaterialBonus
          ? reactionMaterialBonus > 0
            ? `+${reactionMaterialBonus.toFixed(1)}% reaction ME`
            : "No bonus to ME"
          : undefined;
        return (
          <SimulationResultGroup
            groupKey={groupKey}
            key={groupKey}
            ariaLabel={[groupLabel, reactionMaterialLabel].filter(Boolean).join(" ")}
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{groupLabel}</span>
                {hasReactionMaterialBonus && (
                  <small className="shrink-0 text-xs font-normal text-muted-foreground normal-case">
                    {reactionMaterialLabel}
                  </small>
                )}
              </span>
            }
            isOpen={openGroups[groupKey] ?? true}
            onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
            avatarRows={avatars}
            remainingCount={groupItems.length - avatars.length}
            onCopyGroup={groupAction?.onCopyGroup}
            copyLabel={groupAction?.copyLabel}
            allowOverflow={groupHeader !== undefined}
          >
            <div className="flex min-w-0 flex-col">
              {resolvedGroupHeader}
              {groupItems.map((item) => (
                <div key={getRowKey(item)}>{renderRow(item)}</div>
              ))}
            </div>
          </SimulationResultGroup>
        );
      })}
    </div>
  );
}

/** Groups the Plan tab's item and reaction rows under one location container. */
function SimulationPlanLocationGroups({
  tab,
  items,
  reactionFormulaItems,
  stock,
  metadataByTypeId,
  locationNamesById,
  stockpileNamesById,
  marketBuyOrderQuantities,
  demandTypeNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
  onSelectSimulationTab,
}: {
  tab: "plan" | "surplus";
  items: readonly SimulationMaterialBalance[];
  reactionFormulaItems: readonly SimulationReactionFormulaBalance[];
  stock: readonly PlanStockItem[];
  metadataByTypeId: ReadonlyMap<number, TypeMetadata>;
  locationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  demandTypeNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
  onSelectSimulationTab: (tab: SimulationTab) => void;
}) {
  const itemsByLocation = groupRowsByLocation(items);
  const reactionFormulaItemsByLocation = groupRowsByLocation(reactionFormulaItems);
  const locationIds = [
    ...new Set([...itemsByLocation.keys(), ...reactionFormulaItemsByLocation.keys()]),
  ].sort((left, right) =>
    locationName(locationNamesById, left).localeCompare(locationName(locationNamesById, right)),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {locationIds.map((locationId) => {
        const locationItems = itemsByLocation.get(locationId) ?? [];
        const blueprintItems = locationItems.filter(isBlueprintBalance);
        const itemBalances = locationItems.filter((item) => !isBlueprintBalance(item));
        const locationReactionFormulaItems = reactionFormulaItemsByLocation.get(locationId) ?? [];
        const groupKey = `${tab}:${locationId}`;
        const avatars = [
          ...createGroupAvatars(
            locationItems,
            (item) => ({
              typeId: item.typeId,
              name: item.typeName,
              imageVariation: materialImageVariation(item, stock, metadataByTypeId),
            }),
          ),
          ...createGroupAvatars(
            locationReactionFormulaItems,
            (item) => ({
              typeId: item.typeId,
              name: item.typeName,
              imageVariation: "bpc" as const,
            }),
          ),
        ].slice(0, 5);
        const groupLabel = locationName(locationNamesById, locationId);

        return (
          <SimulationResultGroup
            groupKey={groupKey}
            key={groupKey}
            ariaLabel={groupLabel}
            label={groupLabel}
            isOpen={openGroups[groupKey] ?? true}
            onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
            avatarRows={avatars}
            remainingCount={
              locationItems.length + locationReactionFormulaItems.length - avatars.length
            }
            allowOverflow
          >
            <div className="flex min-w-0 flex-col">
              {itemBalances.length > 0 && (
                <section
                  aria-labelledby={`${groupKey}-items-label`}
                  className="flex min-w-0 flex-col"
                  data-result-section="items"
                >
                  <MaterialBalanceHeader label="Items" labelId={`${groupKey}-items-label`} />
                  {itemBalances.map((item) => {
                    const rowKey = `${tab}:${item.locationId}:${item.typeId}`;
                    return (
                      <div key={rowKey}>
                        <SimpleResultRow
                          name={item.typeName}
                          typeId={item.typeId}
                          subline={demandStockpiles(item, stockpileNamesById)}
                          linkPath="assets"
                          selected={controls.selectedRowKey === rowKey}
                          onClick={() => controls.onSelectRow(rowKey)}
                          variation={materialImageVariation(item, stock, metadataByTypeId)}
                          wideBreakpoint="md"
                          contentClassName="self-end text-right font-mono text-xs md:w-full md:self-auto"
                        >
                          <div className="flex w-full min-w-0 items-center justify-end gap-1">
                            {tab === "plan" && item.demandSources.length > 0 ? (
                              <SimulationDemandSourcesDrawer
                                item={item}
                                imageVariation={materialImageVariation(
                                  item,
                                  stock,
                                  metadataByTypeId,
                                )}
                                demandTypeNamesById={demandTypeNamesById}
                                locationLabel={groupLabel}
                                onSelectSimulationTab={onSelectSimulationTab}
                              />
                            ) : tab === "plan" ? (
                              <span aria-hidden="true" className="size-6 shrink-0" />
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <MaterialBalanceSummary
                                item={item}
                                marketBuyOrderQuantities={marketBuyOrderQuantities}
                              />
                            </div>
                          </div>
                        </SimpleResultRow>
                      </div>
                    );
                  })}
                </section>
              )}
              {blueprintItems.length > 0 && (
                <section
                  aria-labelledby={`${groupKey}-blueprints-label`}
                  className="flex min-w-0 flex-col"
                  data-result-section="blueprints"
                >
                  <MaterialBalanceHeader
                    label="Blueprints"
                    labelId={`${groupKey}-blueprints-label`}
                  />
                  {blueprintItems.map((item) => {
                    const rowKey = `${tab}:${item.locationId}:${item.typeId}`;
                    return (
                      <div key={rowKey}>
                        <SimpleResultRow
                          name={item.typeName}
                          typeId={item.typeId}
                          subline={demandStockpiles(item, stockpileNamesById)}
                          linkPath="assets"
                          selected={controls.selectedRowKey === rowKey}
                          onClick={() => controls.onSelectRow(rowKey)}
                          variation={materialImageVariation(item, stock, metadataByTypeId)}
                          wideBreakpoint="md"
                          contentClassName="self-end text-right font-mono text-xs md:w-full md:self-auto"
                        >
                          <div className="flex w-full min-w-0 items-center justify-end gap-1">
                            {tab === "plan" && item.demandSources.length > 0 ? (
                              <SimulationDemandSourcesDrawer
                                item={item}
                                imageVariation={materialImageVariation(
                                  item,
                                  stock,
                                  metadataByTypeId,
                                )}
                                demandTypeNamesById={demandTypeNamesById}
                                locationLabel={groupLabel}
                                onSelectSimulationTab={onSelectSimulationTab}
                              />
                            ) : tab === "plan" ? (
                              <span aria-hidden="true" className="size-6 shrink-0" />
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <MaterialBalanceSummary
                                item={item}
                                marketBuyOrderQuantities={marketBuyOrderQuantities}
                              />
                            </div>
                          </div>
                        </SimpleResultRow>
                      </div>
                    );
                  })}
                </section>
              )}
              {locationReactionFormulaItems.length > 0 && (
                <section
                  aria-labelledby={`${groupKey}-reaction-formulas-label`}
                  className="flex min-w-0 flex-col"
                  data-result-section="reaction-formulas"
                >
                  <ReactionFormulaBalanceHeader
                    label="Reaction Formulas"
                    labelId={`${groupKey}-reaction-formulas-label`}
                  />
                  {locationReactionFormulaItems.map((item) => (
                    <div key={`reaction-formula:${item.locationId}:${item.typeId}`}>
                      <SimulationReactionFormulaRow item={item} controls={controls} />
                    </div>
                  ))}
                </section>
              )}
            </div>
          </SimulationResultGroup>
        );
      })}
    </div>
  );
}

/** Groups rows by physical location while preserving their input order. */
function groupRowsByLocation<T extends { locationId: number }>(
  rows: readonly T[],
): Map<number, T[]> {
  const rowsByLocation = new Map<number, T[]>();
  for (const row of rows) {
    const locationRows = rowsByLocation.get(row.locationId) ?? [];
    locationRows.push(row);
    rowsByLocation.set(row.locationId, locationRows);
  }
  return rowsByLocation;
}

/** Renders the grouped material ledger for Plan or Surplus. */
function SimulationMaterialsTab({
  tab,
  buckets,
  reactionFormulaBuckets,
  stock,
  locationNamesById,
  stockpileNamesById,
  marketBuyOrderQuantities,
  controls,
  onSelectSimulationTab,
  openGroups,
  onOpenGroupChange,
  usePlannerUrlState,
  instanceId,
}: {
  tab: "plan" | "surplus";
  buckets: SimulationMaterialLocationBucket[];
  reactionFormulaBuckets?: SimulationReactionFormulaLocationBucket[];
  stock: readonly PlanStockItem[];
  locationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  controls: SimulationRowControls;
  onSelectSimulationTab: (tab: SimulationTab) => void;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
  usePlannerUrlState: boolean;
  instanceId: string;
}) {
  const items = buckets.flatMap((bucket) => bucket.items);
  const reactionFormulaItems = reactionFormulaBuckets?.flatMap((bucket) => bucket.items) ?? [];
  const metadataByTypeId = useSimulationTypeMetadata(items.map((item) => item.typeId));
  const urlSelectedTypeId = useSyncExternalStore(
    subscribeToTypeId,
    readTypeIdFromUrl,
    getServerTypeIdSnapshot,
  );
  const [localSelectedTypeId, setLocalSelectedTypeId] = useState<number | null>(null);
  const selectedTypeId = usePlannerUrlState ? urlSelectedTypeId : localSelectedTypeId;
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (!usePlannerUrlState) return;
    const rawTypeId = new URLSearchParams(window.location.search).get("typeId");
    if (rawTypeId !== null && selectedTypeId === null) updateTypeIdInUrl(null);
  }, [selectedTypeId, usePlannerUrlState]);
  const typeOptions = [
    ...new Map(
      [...items, ...reactionFormulaItems].map((item) => [item.typeId, item.typeName]),
    ).entries(),
  ]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  const demandTypeNamesById = useSimulationTypeNames(
    items.flatMap((item) => item.demandSources.map((source) => source.productTypeId)),
  );
  useEffect(() => {
    if (!usePlannerUrlState) return;
    if (selectedTypeId === null || typeOptions.some((option) => option.id === selectedTypeId)) {
      return;
    }
    if (readTypeIdFromUrl() === selectedTypeId) updateTypeIdInUrl(null);
  }, [selectedTypeId, typeOptions, usePlannerUrlState]);
  const effectiveSelectedTypeId = typeOptions.some((option) => option.id === selectedTypeId)
    ? selectedTypeId
    : null;
  const filteredItems =
    effectiveSelectedTypeId === null
      ? items
      : items.filter((item) => item.typeId === effectiveSelectedTypeId);
  const filteredReactionFormulaItems =
    effectiveSelectedTypeId === null
      ? reactionFormulaItems
      : reactionFormulaItems.filter((item) => item.typeId === effectiveSelectedTypeId);
  const selectedType = typeOptions.find((option) => option.id === effectiveSelectedTypeId) ?? null;

  async function copyTable() {
    const lines = [
      ["Type", ...materialBalanceColumns].join("\t"),
      ...filteredItems.map((item) =>
        [
          item.typeName,
          (item.availableNow + item.availableFromSellOrders).toLocaleString(),
          item.requiredNow.toLocaleString(),
          item.futureSupply.toLocaleString(),
          item.futureDemand.toLocaleString(),
          item.transferredOut.toLocaleString(),
          item.surplus.toLocaleString(),
        ].join("\t"),
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("Copied");
      toast.add({ description: "Material table copied to clipboard" });
      window.setTimeout(() => setCopyStatus(""), 1600);
    }
    catch {
      setCopyStatus("Copy failed");
      toast.add({ description: "Could not copy material table", type: "error" });
    }
  }

  return (
    <SimulationResultsTab
      hasResults={items.length > 0 || reactionFormulaItems.length > 0}
      settings={
        items.length > 0 || reactionFormulaItems.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2.5 py-3.5 pb-2.5 max-[640px]:flex-col max-[640px]:items-stretch">
            <div className="flex w-auto items-center gap-2.5 max-[640px]:w-full max-[640px]:flex-col max-[640px]:items-stretch">
              <Label
                className="max-[640px]:self-start"
                htmlFor={`${instanceId}-simulation-${tab}-type`}
              >
                TYPE
              </Label>
              <div className="w-full min-w-0 max-[640px]:overflow-hidden sm:w-72 lg:w-96">
                <Combobox
                  items={typeOptions}
                  itemToStringLabel={(option) => option.name}
                  value={selectedType}
                  onValueChange={(value) => {
                    const nextTypeId = value?.id ?? null;
                    if (usePlannerUrlState) updateTypeIdInUrl(nextTypeId);
                    else setLocalSelectedTypeId(nextTypeId);
                  }}
                >
                  <ComboboxInput
                    id={`${instanceId}-simulation-${tab}-type`}
                    placeholder="Filter by type"
                    aria-label="Filter simulation by type"
                    showClear
                    className="w-full [&>input]:text-xs!"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>No matching types.</ComboboxEmpty>
                    <ComboboxList>
                      <ComboboxCollection>
                        {(option) => (
                          <ComboboxItem key={option.id} value={option}>
                            {option.name}
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
            </div>
            {filteredItems.length > 0 && (
              <Button
                type="button"
                variant="outline"
                className="max-[640px]:w-full"
                onClick={() => void copyTable()}
                disabled={filteredItems.length === 0}
              >
                <CopyIcon aria-hidden="true" />
                {copyStatus || "Copy table"}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {filteredItems.length === 0 && filteredReactionFormulaItems.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {items.length > 0 || reactionFormulaItems.length > 0
                ? "No matching materials or reaction formulas"
                : "No materials or reaction formulas"}
            </EmptyTitle>
            <EmptyDescription>
              {items.length > 0 || reactionFormulaItems.length > 0
                ? "Clear the type filter to show all matching results."
                : "No result rows are available for this simulation."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SimulationPlanLocationGroups
          tab={tab}
          items={filteredItems}
          reactionFormulaItems={filteredReactionFormulaItems}
          stock={stock}
          metadataByTypeId={metadataByTypeId}
          locationNamesById={locationNamesById}
          stockpileNamesById={stockpileNamesById}
          marketBuyOrderQuantities={marketBuyOrderQuantities}
          demandTypeNamesById={demandTypeNamesById}
          controls={controls}
          openGroups={openGroups}
          onOpenGroupChange={onOpenGroupChange}
          onSelectSimulationTab={onSelectSimulationTab}
        />
      )}
    </SimulationResultsTab>
  );
}

/** Renders formula availability and reaction-run demand for one location. */
function SimulationReactionFormulaRow({
  item,
  controls,
}: {
  item: SimulationReactionFormulaBalance;
  controls: SimulationRowControls;
}) {
  return (
    <SimulationSimpleJobRow
      rowKey={`reaction-formula:${item.locationId}:${item.typeId}`}
      typeId={item.typeId}
      name={item.typeName}
      linkPath="assets"
      variation="bpc"
      wideBreakpoint="md"
      summary={
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(5rem,auto)] items-center gap-x-3 gap-y-1 text-right md:grid-cols-4 md:gap-x-3">
          <span className="text-muted-foreground md:hidden">Available</span>
          <span>
            <CopyableNumber value={item.availableQuantity} copyLabel="Available formula count" />
          </span>
          <span className="text-muted-foreground md:hidden">Owned</span>
          <span>
            <CopyableNumber value={item.ownedQuantity} copyLabel="Owned formula count" />
          </span>
          <span className="text-muted-foreground md:hidden">In Use</span>
          <span>
            <CopyableNumber value={item.inUseQuantity} copyLabel="In-use formula count" />
          </span>
          <span className="text-muted-foreground md:hidden">Runs to Install</span>
          <span>
            <CopyableNumber
              value={item.requiredRuns}
              copyLabel="Reaction formula runs to install"
            />
          </span>
        </div>
      }
      controls={controls}
    />
  );
}

/** Renders the desktop labels for reaction formula balance columns. */
function ReactionFormulaBalanceHeader({ label, labelId }: { label: string; labelId: string }) {
  return (
    <div className="sticky top-0 z-10 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-[13px] bg-card p-2 shadow-[0_1px_0_var(--border)]">
      <span
        id={labelId}
        className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </span>
      <div className="hidden min-w-0 grid-cols-4 items-center gap-x-3 text-right font-mono text-[10px] text-muted-foreground uppercase md:grid">
        {reactionFormulaBalanceColumns.map((column) => (
          <span key={column}>{column}</span>
        ))}
      </div>
    </div>
  );
}

type SimulationDemandSummary = {
  productTypeId: number;
  productName: string;
  productQuantity: number;
  immediateInputQuantity: number;
  futureInputQuantity: number;
  activities: SimulationDemandSource["activity"][];
};

type DemandActivityDetails = {
  label: string;
  source: "industry" | "reaction" | "invention" | "copying" | "reprocessing" | "stock";
  Icon: LucideIcon;
  tab: SimulationTab;
};

/** Returns the display icon and label for a simulator demand activity. */
function demandActivityDetails(
  activity: SimulationDemandSource["activity"],
): DemandActivityDetails {
  switch (activity) {
  case "manufacturing":
    return { label: "Manufacture", source: "industry", Icon: Factory, tab: "manufacture" };
  case "reaction":
    return { label: "React", source: "reaction", Icon: Atom, tab: "react" };
  case "invention":
    return { label: "Invention", source: "invention", Icon: FlaskConical, tab: "invent" };
  case "copying":
    return { label: "Copying", source: "copying", Icon: TestTubes, tab: "copy" };
  case "reprocessing":
    return { label: "Reprocessing", source: "reprocessing", Icon: Minimize2, tab: "reprocess" };
  case "stock":
    return { label: "Stock", source: "stock", Icon: Boxes, tab: "plan" };
  }
}

/** Sorts demand activities into the simulator's workflow order. */
function sortDemandActivities(
  activities: readonly SimulationDemandSource["activity"][],
): SimulationDemandSource["activity"][] {
  const order: SimulationDemandSource["activity"][] = [
    "manufacturing",
    "reaction",
    "invention",
    "copying",
    "reprocessing",
    "stock",
  ];
  return [...new Set(activities)].sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

/** Combines repeated demand sources for the same demanding type. */
function summarizeSimulationDemandSources(
  sources: readonly SimulationDemandSource[],
  namesByTypeId: ReadonlyMap<number, string>,
): SimulationDemandSummary[] {
  const summaries = new Map<number, SimulationDemandSummary>();
  for (const source of sources) {
    const existing = summaries.get(source.productTypeId);
    if (existing) {
      existing.productQuantity += source.productQuantity;
      existing.immediateInputQuantity += source.requiredNow;
      existing.futureInputQuantity += source.reserved;
      existing.activities = sortDemandActivities([...existing.activities, source.activity]);
      continue;
    }
    summaries.set(
      source.productTypeId,
      {
        productTypeId: source.productTypeId,
        productName: namesByTypeId.get(source.productTypeId) ?? `Type ${source.productTypeId}`,
        productQuantity: source.productQuantity,
        immediateInputQuantity: source.requiredNow,
        futureInputQuantity: source.reserved,
        activities: [source.activity],
      },
    );
  }
  return [...summaries.values()].sort(
    (left, right) =>
      left.productName.localeCompare(right.productName) || left.productTypeId - right.productTypeId,
  );
}

/** Shows the demand contributors for one material balance at its physical location. */
function SimulationDemandSourcesDrawer({
  item,
  imageVariation,
  demandTypeNamesById,
  locationLabel,
  onSelectSimulationTab,
}: {
  item: SimulationMaterialBalance;
  imageVariation: "icon" | "bp" | "bpc" | "relic";
  demandTypeNamesById: ReadonlyMap<number, string>;
  locationLabel: string;
  onSelectSimulationTab: (tab: SimulationTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const summaries = summarizeSimulationDemandSources(item.demandSources, demandTypeNamesById);
  const totalInputQuantity = item.requiredNow + item.reserved;
  const triggerLabel = `View demand sources for ${item.typeName}`;
  const demandNumberGridClass =
    "grid min-w-[15.5rem] grid-cols-[minmax(6rem,1fr)_repeat(2,minmax(4rem,1fr))] gap-x-3";

  return (
    <ResponsiveDialogDrawer
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={triggerLabel}
          title={triggerLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <ListTree aria-hidden="true" />
        </Button>
      }
      triggerTooltip={triggerLabel}
      title="Demand sources"
      description={`Items creating demand for ${item.typeName} at ${locationLabel}.`}
      headerContent={
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center justify-between gap-4">
            <TypeIdentity
              name={item.typeName}
              typeId={item.typeId}
              imageSize={40}
              variation={imageVariation}
              linkPath="planner"
              linkSearchParams={{ simulationTab: "plan" }}
              linkHash="plan-breakdown"
            />
            <strong className="shrink-0 text-right font-mono text-xs text-foreground">
              {quantity(totalInputQuantity)} required
            </strong>
          </div>
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(14rem,auto)] items-center gap-[13px] border-t border-border px-2 pt-3 pr-5 text-right text-xs text-muted-foreground md:grid">
            <span className="text-left">Type</span>
            <div className={`${demandNumberGridClass} leading-tight whitespace-normal`}>
              <span>Create</span>
              <span>Immediate input</span>
              <span>Future input</span>
            </div>
          </div>
        </div>
      }
    >
      <div className="w-full">
        {summaries.map((summary) => (
          <SimpleResultRow
            key={summary.productTypeId}
            name={summary.productName}
            typeId={summary.productTypeId}
            linkPath="planner"
            linkIcon={ClipboardList}
            linkSearchParams={{ simulationTab: "plan" }}
            linkHash="plan-breakdown"
            imageSize={32}
            wideBreakpoint="md"
            className="md:grid-cols-[minmax(0,1fr)_minmax(14rem,auto)]"
            contentClassName="self-end text-right font-mono text-xs md:w-full md:self-auto"
          >
            <div className={`${demandNumberGridClass} items-center text-foreground`}>
              <span
                className="flex items-center justify-end gap-1 whitespace-nowrap"
                aria-label={`Create quantity: ${quantity(summary.productQuantity)} from ${summary.activities.map((activity) => demandActivityDetails(activity).label).join(", ")}`}
              >
                {summary.activities.map((activity) => {
                  const { label, source, Icon, tab } = demandActivityDetails(activity);
                  return (
                    <Tooltip key={activity}>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`${label} demand`}
                            className={cn(styles.simulationSourceIcon, "size-5 shrink-0 p-0")}
                            data-source={source}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpen(false);
                              onSelectSimulationTab(tab);
                            }}
                          >
                            <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                          </Button>
                        }
                      />
                      <TooltipContent>{label} demand</TooltipContent>
                    </Tooltip>
                  );
                })}
                x {quantity(summary.productQuantity)} =
              </span>
              <span
                aria-label={`Immediate input quantity: ${quantity(summary.immediateInputQuantity)}`}
              >
                {quantity(summary.immediateInputQuantity)}
              </span>
              <span aria-label={`Future input quantity: ${quantity(summary.futureInputQuantity)}`}>
                {quantity(summary.futureInputQuantity)}
              </span>
            </div>
          </SimpleResultRow>
        ))}
      </div>
    </ResponsiveDialogDrawer>
  );
}

/** Renders the detail columns for a simulator material balance. */
function MaterialBalanceSummary({
  item,
  marketBuyOrderQuantities,
}: {
  item: SimulationMaterialBalance;
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
}) {
  const supplySources = futureSupplySources(item);
  const immediateSources = immediateSupplySources(item);
  const marketBuyOrderQuantity = marketBuyOrderQuantities?.[String(item.typeId)] ?? 0;
  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(5rem,auto)] items-center gap-x-3 gap-y-1 text-right md:grid-cols-6 md:gap-x-3">
      <span className="text-muted-foreground md:hidden">Available</span>
      <span className="flex items-center justify-end gap-2">
        {immediateSources.map(({ key, label, quantity: sourceQuantity, source, Icon }) => (
          <Tooltip key={key}>
            <TooltipTrigger
              render={
                <span
                  aria-label={`${label}: ${sourceQuantity.toLocaleString()}`}
                  className={cn(
                    styles.simulationSourceIcon,
                    "inline-flex size-5 items-center justify-center",
                  )}
                  data-source={source}
                  role="img"
                  tabIndex={0}
                >
                  <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                </span>
              }
            />
            <TooltipContent>
              {label}: {sourceQuantity.toLocaleString()}
            </TooltipContent>
          </Tooltip>
        ))}
        <CopyableNumber
          value={item.availableNow + item.availableFromSellOrders}
          copyLabel="Available quantity"
        />
      </span>
      <span className="text-muted-foreground md:hidden">Immediate Demand</span>
      <span>
        <CopyableNumber value={item.requiredNow} copyLabel="Immediate demand" />
      </span>
      <span className="text-muted-foreground md:hidden">Future Supply</span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span
          className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1"
          aria-label="Future supply sources"
        >
          <MarketBuyOrderIndicator quantity={marketBuyOrderQuantity} />
          {supplySources.map(({ key, label, quantity, source, Icon, colored }) => (
            <Tooltip key={key}>
              <TooltipTrigger
                render={
                  <span
                    aria-label={`${label}: ${quantity.toLocaleString()}`}
                    className={cn(
                      colored ? styles.simulationSourceIcon : "text-muted-foreground",
                      "inline-flex size-5 items-center justify-center",
                    )}
                    data-source={source}
                    role="img"
                    tabIndex={0}
                  >
                    <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                  </span>
                }
              />
              <TooltipContent>
                {label}: {quantity.toLocaleString()}
              </TooltipContent>
            </Tooltip>
          ))}
        </span>
        <span className="shrink-0">
          <CopyableNumber value={item.futureSupply} copyLabel="Future supply" />
        </span>
      </span>
      <span className="text-muted-foreground md:hidden">Future Demand</span>
      <span className="flex min-w-0 items-center justify-end gap-2">
        <CopyableNumber value={item.futureDemand} copyLabel="Future demand" />
      </span>
      <span className="text-muted-foreground md:hidden">Transferred Out</span>
      <span>
        <CopyableNumber value={item.transferredOut} copyLabel="Transferred quantity" />
      </span>
      <span className="text-muted-foreground md:hidden">Surplus</span>
      <span>
        <CopyableNumber value={item.surplus} copyLabel="Surplus quantity" />
      </span>
    </div>
  );
}

/** Renders the desktop labels for the Plan and Surplus material columns. */
function MaterialBalanceHeader({ label, labelId }: { label: string; labelId: string }) {
  return (
    <div className="sticky top-0 z-10 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-[13px] bg-card p-2 shadow-[0_1px_0_var(--border)]">
      <span
        id={labelId}
        className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </span>
      <div className="hidden min-w-0 items-center justify-end gap-1 md:flex">
        <span className="size-6 shrink-0" aria-hidden="true" />
        <div className="grid min-w-0 flex-1 grid-cols-6 items-center gap-x-3 text-right font-mono text-[10px] text-muted-foreground uppercase">
          {materialBalanceColumns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Renders simulator reprocessing jobs grouped by their working location. */
function SimulationReprocessingTab({
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  jobs: SimulationReprocessingJobGroup[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="reprocess"
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(group) => group.groupKey}
        getAvatar={(group) => ({ typeId: group.sourceTypeId, name: group.sourceTypeName })}
        renderRow={(group) => (
          <SimulationSimpleJobRow
            rowKey={group.groupKey}
            typeId={group.sourceTypeId}
            name={group.sourceTypeName}
            subline={<span>Immediate {quantity(group.quantities.immediateSourceQuantity)}</span>}
            summary={
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <SimulationReprocessingHorizons quantities={group.quantities} />
                <CopyableNumber
                  value={group.quantities.totalSourceQuantity}
                  copyLabel="Total source quantity"
                />
              </span>
            }
            controls={controls}
          />
        )}
      />
    </SimulationResultsTab>
  );
}

/** Shows non-immediate reprocessing source quantities with horizon icons. */
function SimulationReprocessingHorizons({
  quantities,
}: {
  quantities: SimulationReprocessingJobGroup["quantities"];
}) {
  const horizons = [
    {
      key: "after-hauling",
      label: "After hauling",
      quantity: quantities.afterHaulingSourceQuantity,
      source: "haul" as const,
      Icon: Truck,
    },
    {
      key: "after-purchase",
      label: "After purchase",
      quantity: quantities.afterPurchaseSourceQuantity,
      source: "market" as const,
      Icon: ShoppingCart,
    },
  ];
  return (
    <span className="flex max-w-full flex-wrap items-center justify-end gap-2">
      {horizons
        .filter((horizon) => horizon.quantity > 0)
        .map(({ key, label, quantity: horizonQuantity, source, Icon }) => (
          <Tooltip key={key}>
            <TooltipTrigger
              render={
                <span
                  aria-label={`${label}: ${horizonQuantity.toLocaleString()}`}
                  className={cn(
                    styles.simulationSourceIcon,
                    "inline-flex size-5 items-center justify-center",
                  )}
                  data-source={source}
                  role="img"
                  tabIndex={0}
                >
                  <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                </span>
              }
            />
            <TooltipContent>
              {label}: {horizonQuantity.toLocaleString()}
            </TooltipContent>
          </Tooltip>
        ))}
    </span>
  );
}

/** Renders simulator copy jobs grouped by their working location. */
function SimulationCopyTab({
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  jobs: SimulationCopyJob[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const blueprintNamesById = useSimulationTypeNames(jobs.map((job) => job.blueprintTypeId));
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="copy"
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({
          typeId: job.blueprintTypeId,
          name: blueprintNamesById.get(job.blueprintTypeId) ?? `Blueprint ${job.blueprintTypeId}`,
          imageVariation: "bp",
        })}
        renderRow={(job) => (
          <SimulationSimpleJobRow
            rowKey={`copy:${job.jobId}`}
            typeId={job.blueprintTypeId}
            name={blueprintNamesById.get(job.blueprintTypeId) ?? `Blueprint ${job.blueprintTypeId}`}
            subline={
              <CopyableNumber
                value={job.totalLicensedRuns}
                suffix=" licensed runs"
                copyLabel="Licensed runs"
              />
            }
            summary={<CopyableNumber value={job.copies} suffix=" copies" copyLabel="Copies" />}
            variation="bp"
            controls={controls}
          />
        )}
      />
    </SimulationResultsTab>
  );
}

/** Renders simulator invention jobs grouped by their working location. */
function SimulationInventionTab({
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  jobs: SimulationInventionJob[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const blueprintTypeIds = jobs.flatMap((job) => [
    job.sourceBlueprintTypeId,
    job.outputBlueprintTypeId,
  ]);
  const blueprintNamesById = useSimulationTypeNames(blueprintTypeIds);
  const blueprintMetadataById = useSimulationTypeMetadata(blueprintTypeIds);
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="invent"
        items={jobs}
        locationNamesById={locationNamesById}
        groupHeader={
          <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_minmax(24rem,1fr)_auto] items-center gap-x-[13px] bg-card px-2 pb-1 font-mono text-[10px] text-muted-foreground uppercase sm:grid md:grid-cols-[minmax(0,0.7fr)_minmax(24rem,1fr)_auto]">
            <span aria-hidden="true" />
            <div className="grid grid-cols-[minmax(0,1fr)_3rem_8rem] gap-x-4 text-right sm:min-w-96 sm:grid-cols-[1.5rem_minmax(0,1fr)_3rem_8rem] md:grid-cols-[1.5rem_minmax(0,1fr)_3rem_5rem]">
              <span aria-hidden="true" className="hidden sm:block" />
              <span aria-hidden="true" />
              <span className="text-center">Inputs</span>
              <span>Attempts</span>
            </div>
            <span aria-hidden="true" className="w-4" />
          </div>
        }
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({
          typeId: job.sourceBlueprintTypeId,
          name:
            blueprintNamesById.get(job.sourceBlueprintTypeId)
            ?? `Blueprint ${job.sourceBlueprintTypeId}`,
          imageVariation: simulationInventionSourceImageVariation(job, blueprintMetadataById),
        })}
        renderRow={(job) => {
          const rowKey = `invent:${job.jobId}`;
          const completed = controls.isCompleted(rowKey);
          const sourceBlueprintVariation = simulationInventionSourceImageVariation(
            job,
            blueprintMetadataById,
          );
          const sourceBlueprintName =
            blueprintNamesById.get(job.sourceBlueprintTypeId)
            ?? `Blueprint ${job.sourceBlueprintTypeId}`;
          const outputBlueprintName =
            blueprintNamesById.get(job.outputBlueprintTypeId)
            ?? `Blueprint ${job.outputBlueprintTypeId}`;
          return (
            <SwitchedResultRow
              typeId={job.sourceBlueprintTypeId}
              name={sourceBlueprintName}
              className="sm:grid-cols-[minmax(0,1fr)_minmax(24rem,1fr)_auto] md:grid-cols-[minmax(0,0.7fr)_minmax(24rem,1fr)_auto]"
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ simulationTab: "plan" }}
              linkHash="plan-breakdown"
              navigateInPlace
              onNavigate={controls.onNavigateToPlan}
              selected={controls.selectedRowKey === rowKey}
              onClick={() => controls.onSelectRow(rowKey)}
              showSwitch={false}
              showCheckbox
              checkboxChecked={completed}
              checkboxTooltip="Mark invention complete"
              checkboxClassName="row-start-4 self-center sm:row-auto"
              onCheckboxChange={(checked) => controls.onCompletedChange(rowKey, checked)}
              subline={`${Math.round(job.successProbability * 100)}% success probability`}
              variation={sourceBlueprintVariation}
              contentClassName="contents sm:col-span-1 sm:col-start-2 sm:row-auto sm:grid sm:w-full sm:min-w-96 sm:grid-cols-[1.5rem_minmax(0,1fr)_3rem_8rem] sm:items-center sm:gap-x-4 sm:self-auto sm:text-right sm:font-mono sm:text-xs md:grid-cols-[1.5rem_minmax(0,1fr)_3rem_5rem]"
            >
              <span
                aria-hidden="true"
                className="col-start-1 row-start-2 flex items-center justify-center sm:col-start-1 sm:row-start-1"
              >
                <ArrowRight className="size-4 rotate-90 text-muted-foreground sm:rotate-0" />
              </span>
              <TypeIdentity
                name={outputBlueprintName}
                typeId={job.outputBlueprintTypeId}
                variation="bpc"
                linkPath="planner"
                linkIcon={ClipboardList}
                linkSearchParams={{ simulationTab: "plan" }}
                linkHash="plan-breakdown"
                navigateInPlace
                onNavigate={controls.onNavigateToPlan}
                className="col-start-1 row-start-3 w-full min-w-0 sm:col-start-2 sm:row-start-1"
              />
              <span className="col-start-1 row-start-4 flex items-center justify-between gap-3 sm:contents">
                <span className="flex justify-center sm:col-start-3 sm:row-start-1">
                  <SimulationInventionInputsResponsive
                    job={job}
                    outputBlueprintName={outputBlueprintName}
                    sourceBlueprintVariation={sourceBlueprintVariation}
                    onOpenPlan={controls.onOpenPlan}
                    onOpenBuy={controls.onOpenBuy}
                  />
                </span>
                <span className="flex justify-end sm:col-start-4 sm:row-start-1">
                  <span className="sm:hidden">
                    <CopyableNumber value={job.attempts} suffix=" attempts" copyLabel="Attempts" />
                  </span>
                  <span className="hidden sm:inline">
                    <CopyableNumber value={job.attempts} copyLabel="Attempts" />
                  </span>
                </span>
              </span>
            </SwitchedResultRow>
          );
        }}
      />
    </SimulationResultsTab>
  );
}

/** Renders a simple selectable operational job row. */
function SimulationSimpleJobRow({
  rowKey,
  typeId,
  name,
  subline,
  summary,
  variation = "icon",
  wideBreakpoint = "sm",
  linkPath = "planner",
  showCheckbox = false,
  identityTrailingContent,
  controls,
}: {
  rowKey: string;
  typeId: number;
  name: string;
  subline?: ReactNode;
  summary: ReactNode;
  variation?: "icon" | "bp" | "bpc" | "relic";
  wideBreakpoint?: "sm" | "md";
  linkPath?: "planner" | "assets";
  showCheckbox?: boolean;
  identityTrailingContent?: ReactNode;
  controls: SimulationRowControls;
}) {
  const rowProps = {
    name,
    typeId,
    subline,
    variation,
    linkPath,
    ...(linkPath === "assets"
      ? {}
      : {
          linkIcon: ClipboardList,
          linkSearchParams: { simulationTab: "plan" },
          linkHash: "plan-breakdown",
          navigateInPlace: true,
          onNavigate: controls.onNavigateToPlan,
        }),
    wideBreakpoint,
    selected: controls.selectedRowKey === rowKey,
    onClick: () => controls.onSelectRow(rowKey),
    contentClassName: "self-end text-right font-mono text-xs sm:self-auto",
  };
  const checkboxChecked = showCheckbox && controls.isCompleted(rowKey);

  return showCheckbox ? (
    <SwitchedResultRow
      {...rowProps}
      identityTrailingContent={identityTrailingContent}
      showSwitch={false}
      checkboxChecked={checkboxChecked}
      installed={checkboxChecked}
      checkboxTooltip="Mark purchase complete"
      onCheckboxChange={(checked) => controls.onCompletedChange(rowKey, checked)}
    >
      {summary}
    </SwitchedResultRow>
  ) : (
    <SimpleResultRow {...rowProps}>{summary}</SimpleResultRow>
  );
}

/** Renders the Fullerite gas sites and wormhole classes associated with a gas type. */
function FulleriteGasSiteBadges({ typeId }: { typeId: number }) {
  const sites = fulleriteGasSites.filter((site) =>
    site.types.some((siteTypeId) => siteTypeId === typeId),
  );
  if (sites.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Gas sites">
      {sites.map((site) => (
        <Tooltip key={site.name}>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                className="shrink-0"
                role="img"
                tabIndex={0}
                aria-label={`${site.name}, ${site.wormholeClasses}`}
              >
                {site.name.split(" ", 1)[0]}
              </Badge>
            }
          />
          <TooltipContent>
            {site.name} ({site.wormholeClasses})
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

type SimulationBuyEntry = {
  purchase: SimulationPurchase;
  isMaterial: boolean;
};

/** Selects the correct artwork for a purchase row and its group avatar. */
function simulationPurchaseImageVariation(
  entry: SimulationBuyEntry,
  metadataByTypeId: ReadonlyMap<number, TypeMetadata>,
): "icon" | "bp" | "relic" {
  if (!entry.isMaterial) return "bp";
  return metadataByTypeId.get(entry.purchase.typeId)?.isAncientRelic ? "relic" : "icon";
}

/** Serializes material purchases in the format accepted by EVE Multibuy. */
function multibuyText(entries: readonly SimulationBuyEntry[]): string {
  return entries
    .filter((entry) => entry.isMaterial)
    .map(({ purchase }) => `${purchase.typeName}\t${purchase.quantity}`)
    .join("\n");
}

/** Serializes currently installable activity runs once per product type. */
function installableRunsText(entries: readonly SimulationIndustryJob[]): string {
  const runsByType = new Map<number, { name: string; runs: number }>();
  for (const job of entries) {
    const runs = getSimulationInstallableRuns(job);
    if (runs <= 0) continue;
    const existing = runsByType.get(job.productTypeId);
    if (existing) {
      existing.runs += runs;
    }
    else {
      runsByType.set(job.productTypeId, { name: job.productName, runs });
    }
  }
  return [...runsByType.values()].map(({ name, runs }) => `${name}\t${runs}`).join("\n");
}

/** Renders reaction or manufacturing jobs grouped by their working location. */
function SimulationActivityTab({
  tab,
  jobs,
  allJobs,
  includedRows,
  industryJobs,
  simulationInputRevision,
  stock,
  visibleReactionFormulaStock,
  locationNamesById,
  locationSystemIdsById,
  systemNamesById,
  reactionMaterialBonusesByLocation,
  characterNamesById,
  characterStatuses,
  slotUsage,
  controls,
  openGroups,
  onOpenGroupChange,
  instanceId,
  readOnly,
}: {
  tab: "react" | "manufacture";
  jobs: SimulationIndustryJob[];
  allJobs: readonly SimulationIndustryJob[];
  includedRows: Readonly<Record<string, boolean>>;
  industryJobs?: ClientJobsResponse["jobs"];
  simulationInputRevision: string;
  stock: readonly PlanStockItem[];
  visibleReactionFormulaStock: readonly PlanStockItem[];
  locationNamesById: ReadonlyMap<number, string>;
  locationSystemIdsById?: ReadonlyMap<number, number>;
  systemNamesById?: ReadonlyMap<number, string>;
  reactionMaterialBonusesByLocation: ReadonlyMap<number, number>;
  characterNamesById: ReadonlyMap<number, string>;
  characterStatuses: readonly ClientCharacterStatus[];
  slotUsage: ClientJobsResponse["slotUsage"];
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
  instanceId: string;
  readOnly: boolean;
}) {
  const activityLabel = tab === "react" ? "reaction" : "manufacturing";
  const [manufacturingRunDisplay, setManufacturingRunDisplay] = useState<
    "total" | "installable" | "schedule"
  >("total");
  const [solveMode, setSolveMode] = useState<ClientSimulationSolveMode>("schedule");
  const [targetTime, setTargetTime] = useState("24");
  const [protectReactionMaterialBonus, setProtectReactionMaterialBonus] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [groupCopyStatus, setGroupCopyStatus] = useState<SimulationGroupCopyStatus>(null);
  const allSlotCharacters = useMemo(
    () => simulationSlotCharacters(characterStatuses, characterNamesById, slotUsage, tab),
    [characterStatuses, characterNamesById, slotUsage, tab],
  );
  const slotGroups = useMemo(
    () =>
      allSlotCharacters.map(
        ({ characterId, availableSlots, systemId }): ClientSimulationSlotGroup => ({
          characterId,
          availableSlots,
          systemId,
        }),
      ),
    [allSlotCharacters],
  );
  const slotCharacters =
    tab === "react" && locationSystemIdsById
      ? allSlotCharacters.filter(
          (character) =>
            character.systemId !== undefined && !isWormholeSystemId(character.systemId),
        )
      : allSlotCharacters;
  const availableSlots = slotCharacters.reduce(
    (total, character) => total + character.availableSlots,
    0,
  );
  const reactionFormulaCounts = useMemo(
    () =>
      tab === "react"
        ? simulationReactionFormulaAvailability(stock, industryJobs, visibleReactionFormulaStock)
        : undefined,
    [industryJobs, stock, tab, visibleReactionFormulaStock],
  );
  const effectiveSolveMode = tab === "react" ? solveMode : "available-slots";
  const baseScheduleRevision = [
    simulationInputRevision,
    effectiveSolveMode,
    targetTime,
    protectReactionMaterialBonus,
    availableSlots,
    ...allSlotCharacters.map(
      ({ characterId, availableSlots: characterSlots, systemId }) =>
        `${characterId}:${systemId ?? "unknown"}:${characterSlots}`,
    ),
    ...(locationSystemIdsById
      ? [...locationSystemIdsById.entries()]
          .sort(([left], [right]) => left - right)
          .map(([locationId, systemId]) => `${locationId}:${systemId}`)
      : []),
    ...jobs
      .filter((job) => controls.isIncluded(`${tab}:${job.jobId}`))
      .map((job) => job.jobId)
      .sort(),
    ...[...reactionMaterialBonusesByLocation.entries()]
      .sort(([left], [right]) => left - right)
      .map(([locationId, bonus]) => `${locationId}:${bonus}`),
  ].join("|");
  const scheduleRevision = [baseScheduleRevision, ...jobs.map((job) => job.jobId).sort()].join("|");
  const enabledJobIds = useMemo(
    () =>
      new Set(
        jobs.filter((job) => includedRows[`${tab}:${job.jobId}`] ?? true).map((job) => job.jobId),
      ),
    [includedRows, jobs, tab],
  );
  const schedules = useMemo(
    () =>
      effectiveSolveMode === "schedule"
        ? scheduledSimulationActivity(jobs, enabledJobIds)
        : solveSimulationActivity(
            jobs,
            availableSlots,
            effectiveSolveMode,
            Number(targetTime),
            enabledJobIds,
            slotGroups,
            {
              ...(reactionFormulaCounts?.availabilityKnown
                ? {
                    availableReactionFormulaCountsByLocationAndType:
                      reactionFormulaCounts.availableByLocationAndType,
                  }
                : {}),
              protectReactionMaterialBonus: tab === "react" && protectReactionMaterialBonus,
              reactionMaterialBonusesByLocation,
              ...(tab === "react" && locationSystemIdsById ? { locationSystemIdsById } : {}),
            },
          ),
    [
      availableSlots,
      effectiveSolveMode,
      enabledJobIds,
      jobs,
      locationSystemIdsById,
      protectReactionMaterialBonus,
      reactionFormulaCounts,
      reactionMaterialBonusesByLocation,
      slotGroups,
      tab,
      targetTime,
    ],
  );
  const metricJobs =
    tab === "react" && locationSystemIdsById
      ? jobs.filter((job) => {
          const systemId = locationSystemIdsById.get(job.locationId);
          return systemId !== undefined && !isWormholeSystemId(systemId);
        })
      : jobs;
  const scheduledRuns = metricJobs.reduce(
    (total, job) => total + (schedules.get(job.jobId)?.runs ?? 0),
    0,
  );
  const installableRuns = metricJobs.reduce(
    (total, job) => total + getSimulationInstallableRuns(job),
    0,
  );
  const totalRuns = metricJobs.reduce((total, job) => total + job.requiredRuns, 0);
  const suggestedInstalls = metricJobs.reduce(
    (total, job) => total + (schedules.get(job.jobId)?.installs.length ?? 0),
    0,
  );
  const maxJobLength = Math.max(
    ...metricJobs.map((job) => schedules.get(job.jobId)?.timeSeconds ?? 0),
    0,
  );
  const presentationGroups: SimulationIndustryJobGroup[] = groupSimulationActivityJobs(jobs);
  const visiblePresentationGroups =
    tab !== "manufacture" || manufacturingRunDisplay === "total"
      ? presentationGroups
      : presentationGroups.filter((group) =>
          manufacturingRunDisplay === "installable"
            ? group.quantities.installableRuns > 0
            : simulationRunsStartingAtT0(group.jobs) > 0,
        );
  async function copyEntries(entries: readonly SimulationIndustryJob[], status: "list" | number) {
    const text = installableRunsText(entries);
    try {
      await navigator.clipboard.writeText(text);
      if (status === "list") {
        setCopyStatus("Copied");
      }
      else {
        setGroupCopyStatus({ locationId: status, label: "Copied" });
      }
      toast.add({
        description: `${activityLabel[0].toUpperCase()}${activityLabel.slice(1)} list copied to clipboard`,
      });
      window.setTimeout(
        () => {
          if (status === "list") setCopyStatus("");
          else {
            setGroupCopyStatus((current) => (current?.locationId === status ? null : current));
          }
        },
        1600,
      );
    }
    catch {
      if (status === "list") setCopyStatus("Copy failed");
      else setGroupCopyStatus({ locationId: status, label: "Copy failed" });
      toast.add({ description: "Could not copy to clipboard", type: "error" });
    }
  }

  function handleSolveModeChange(value: ClientSimulationSolveMode | null) {
    if (value === null) return;
    const nextMode = value;
    if (
      (solveMode === "run-time-hours" || solveMode === "run-time-days")
      && (nextMode === "run-time-hours" || nextMode === "run-time-days")
      && solveMode !== nextMode
    ) {
      setTargetTime(String(convertSimulationTargetTime(Number(targetTime), solveMode, nextMode)));
    }
    setSolveMode(nextMode);
  }

  return (
    <SimulationResultsTab
      hasResults={jobs.length > 0}
      settings={
        <div className="flex flex-col gap-2.5 py-3.5 pb-2.5">
          <div className="flex flex-wrap items-center gap-2.5 max-[640px]:items-stretch">
            {tab === "manufacture" && (
              <>
                <Label
                  className="shrink-0 whitespace-nowrap"
                  htmlFor={`${instanceId}-manufacture-run-display`}
                >
                  Show
                </Label>
                <Select
                  value={manufacturingRunDisplay}
                  onValueChange={(value) => {
                    if (value === "total" || value === "installable" || value === "schedule") {
                      setManufacturingRunDisplay(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id={`${instanceId}-manufacture-run-display`}
                    aria-label="Show manufacturing run display"
                    className="min-w-32"
                  >
                    <SelectValue>
                      {manufacturingRunDisplay === "total"
                        ? "total"
                        : manufacturingRunDisplay === "installable"
                          ? "installable"
                          : "schedule"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="total">total</SelectItem>
                    <SelectItem value="installable">installable</SelectItem>
                    <SelectItem value="schedule">schedule</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
            {tab === "react" && (
              <>
                <Label
                  className="shrink-0 whitespace-nowrap"
                  htmlFor={`${instanceId}-${tab}-solve-mode`}
                >
                  Solve for
                </Label>
                <Select value={solveMode} onValueChange={handleSolveModeChange}>
                  <SelectTrigger
                    id={`${instanceId}-${tab}-solve-mode`}
                    aria-label={`${activityLabel} solve mode`}
                    className="min-w-44"
                  >
                    <SelectValue>
                      {solveMode === "schedule"
                        ? "schedule"
                        : solveMode === "available-slots"
                          ? "available slots"
                          : solveMode === "run-time-hours"
                            ? "run time (hours)"
                            : "run time (days)"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="schedule">schedule</SelectItem>
                    <SelectItem value="available-slots">available slots</SelectItem>
                    <SelectItem value="run-time-hours">run time (hours)</SelectItem>
                    <SelectItem value="run-time-days">run time (days)</SelectItem>
                  </SelectContent>
                </Select>
                {(solveMode === "run-time-hours" || solveMode === "run-time-days") && (
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={targetTime}
                    onChange={(event) => setTargetTime(event.target.value)}
                    aria-label={`Target ${activityLabel} run time`}
                    className="w-28"
                  />
                )}
              </>
            )}
            {tab === "react" && (
              <Label
                className="flex shrink-0 items-center gap-2 whitespace-nowrap"
                htmlFor={`${instanceId}-react-protect-me-bonus`}
              >
                <Switch
                  id={`${instanceId}-react-protect-me-bonus`}
                  checked={protectReactionMaterialBonus}
                  onCheckedChange={setProtectReactionMaterialBonus}
                />
                Protect ME Bonus
              </Label>
            )}
            <Button
              type="button"
              variant="outline"
              className="ml-auto max-[640px]:ml-0 max-[640px]:w-full"
              onClick={() => void copyEntries(jobs, "list")}
            >
              <CopyIcon aria-hidden="true" />
              {copyStatus || "Copy list"}
            </Button>
          </div>
          <SimulationActivitySummary
            availableSlots={availableSlots}
            slotCharacters={slotCharacters}
            activityLabel={activityLabel}
            suggestedInstalls={suggestedInstalls}
            maxJobLength={maxJobLength}
            scheduledRuns={scheduledRuns}
            installableRuns={installableRuns}
            totalRuns={totalRuns}
            poolLabel={tab === "react" && locationSystemIdsById ? "K-Space" : undefined}
          />
        </div>
      }
    >
      <SimulationLocationResultGroups
        tab={tab}
        items={visiblePresentationGroups}
        locationNamesById={locationNamesById}
        groupHeader={tab === "react" ? <SimulationActivityColumnsHeader /> : undefined}
        getGroupHeader={(locationId, groupItems) => {
          const systemId = locationSystemIdsById?.get(locationId);
          if (tab !== "react" || !isWormholeSystemId(systemId)) return undefined;

          const groupJobIds = new Set(
            groupItems.flatMap((group) => group.jobs.map((job) => job.jobId)),
          );
          const scopedJobs = jobs.filter((job) => groupJobIds.has(job.jobId));
          const scopedScheduledRuns = scopedJobs.reduce(
            (total, job) => total + (schedules.get(job.jobId)?.runs ?? 0),
            0,
          );
          const scopedInstallableRuns = scopedJobs.reduce(
            (total, job) => total + getSimulationInstallableRuns(job),
            0,
          );
          const scopedTotalRuns = scopedJobs.reduce((total, job) => total + job.requiredRuns, 0);
          const scopedSuggestedInstalls = scopedJobs.reduce(
            (total, job) => total + (schedules.get(job.jobId)?.installs.length ?? 0),
            0,
          );
          const scopedMaxJobLength = Math.max(
            ...scopedJobs.map((job) => schedules.get(job.jobId)?.timeSeconds ?? 0),
            0,
          );
          const scopedCharacters = allSlotCharacters.filter(
            (character) => character.systemId === systemId,
          );
          const scopedSlots = scopedCharacters.reduce(
            (total, character) => total + character.availableSlots,
            0,
          );

          return (
            <>
              <div className="mb-2">
                <SimulationActivitySummary
                  availableSlots={scopedSlots}
                  slotCharacters={scopedCharacters}
                  activityLabel={activityLabel}
                  suggestedInstalls={scopedSuggestedInstalls}
                  maxJobLength={scopedMaxJobLength}
                  scheduledRuns={scopedScheduledRuns}
                  installableRuns={scopedInstallableRuns}
                  totalRuns={scopedTotalRuns}
                  poolLabel={
                    systemId === undefined
                      ? "Wormhole"
                      : (systemNamesById?.get(systemId) ?? "Wormhole")
                  }
                />
              </div>
              <SimulationActivityColumnsHeader />
            </>
          );
        }}
        reactionMaterialBonusesByLocation={
          tab === "react" ? reactionMaterialBonusesByLocation : undefined
        }
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(group) => group.groupKey}
        getGroupAction={(locationId, groupItems) => ({
          onCopyGroup: () =>
            void copyEntries(
              groupItems.flatMap((group) => group.jobs),
              locationId,
            ),
          copyLabel:
            groupCopyStatus?.locationId === locationId
              ? groupCopyStatus.label
              : "Copy location list",
        })}
        getAvatar={(group) => ({
          typeId: group.productTypeId,
          name: group.productName,
          imageVariation: "icon",
        })}
        renderRow={(group) => {
          const groupEntries = group.jobs.map((job) => {
            const rowKey = `${tab}:${job.jobId}`;
            const generatedSchedule = schedules.get(job.jobId);
            const generatedScheduleIdentity = simulationInstallScheduleIdentity(
              scheduleRevision,
              generatedSchedule?.installs ?? [],
            );
            const jobScheduleRevision = scheduleRevision;
            const scheduleIdentity = generatedScheduleIdentity;
            const completedSchedule = controls.getCompletedSchedule(
              rowKey,
              generatedScheduleIdentity,
            );
            const schedule =
              generatedSchedule && generatedSchedule.installs.length > 0
                ? generatedSchedule
                : completedSchedule;
            const included = controls.isIncluded(rowKey);
            const installableRuns =
              schedule && schedule.runs > 0 ? schedule.runs : getSimulationInstallableRuns(job);
            const installedRuns = controls.getInstalledRuns(rowKey, generatedScheduleIdentity);
            const completed = controls.isCompleted(rowKey, generatedScheduleIdentity);
            const completedInstallIds = controls.getCompletedInstallIds(
              rowKey,
              generatedScheduleIdentity,
            );
            return {
              job,
              rowKey,
              generatedSchedule,
              schedule,
              scheduleIdentity,
              scheduleRevision: jobScheduleRevision,
              included,
              installableRuns,
              installedRuns,
              completed,
              completedInstallIds,
              blueprintCounts: simulationBlueprintCounts(job, stock),
            };
          });
          const installableGroupEntries = groupEntries.filter((entry) => entry.installableRuns > 0);
          const groupInstallableRuns = installableGroupEntries.reduce(
            (total, entry) => total + entry.installableRuns,
            0,
          );
          const groupInstalledRuns = installableGroupEntries.reduce(
            (total, entry) => total + entry.installedRuns,
            0,
          );
          const groupCompleted =
            controls.isTypeCompleted(tab, group.productTypeId)
            || (groupInstallableRuns > 0 && groupInstalledRuns >= groupInstallableRuns);
          const groupPartiallyInstalled = groupInstalledRuns > 0 && !groupCompleted;
          const groupIncluded = groupEntries.every((entry) => entry.included);
          const suggestedInstallSummary = summarizeClientSimulationInstalls(
            groupEntries.flatMap((entry) => entry.generatedSchedule?.installs ?? []),
          );
          const installableRuntimeSeconds = group.jobs.reduce(
            (total, job) => total + getSimulationInstallableRuns(job) * job.durationPerRunSeconds,
            0,
          );
          const totalRuntimeSeconds = group.jobs.reduce(
            (total, job) => total + job.requiredRuns * job.durationPerRunSeconds,
            0,
          );
          const scheduledAtT0Runs = simulationRunsStartingAtT0(group.jobs);
          const formulaCounts = simulationReactionFormulaCountsForGroup(
            group,
            reactionFormulaCounts,
          );
          const updateGroupCompletion = (checked: boolean) => {
            controls.onTypeCompletedChange(tab, group.productTypeId, checked);
            for (const entry of groupEntries) {
              controls.onInstalledRunsChange(
                entry.rowKey,
                checked ? entry.installableRuns : 0,
                entry.installableRuns,
                entry.scheduleIdentity,
                checked
                  ? Object.fromEntries(
                      (entry.schedule?.installs ?? []).map((install) => [install.installId, true]),
                    )
                  : {},
                entry.schedule,
              );
            }
          };
          const installPlanEntries: SimulationInstallPlanEntry[] = groupEntries.map((entry) => ({
            job: entry.job,
            schedule: entry.schedule,
            installedRuns: entry.installedRuns,
            completedInstallIds: entry.completedInstallIds,
            scheduleRevision: entry.scheduleRevision,
            blueprintCounts: entry.blueprintCounts,
            onInstalledRunsChange: (runs, dialogScheduleIdentity, installIds, schedule) =>
              controls.onInstalledRunsChange(
                entry.rowKey,
                runs,
                entry.installableRuns,
                dialogScheduleIdentity,
                installIds,
                schedule,
              ),
          }));
          return (
            <SwitchedResultRow
              name={group.productName}
              typeId={group.productTypeId}
              subline={
                group.jobs.length === 1
                  ? ` | ${group.quantities.inputs.length} inputs`
                  : `${group.jobs.length} jobs grouped by type ID`
              }
              variation="icon"
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ simulationTab: "plan" }}
              linkHash="plan-breakdown"
              navigateInPlace
              onNavigate={controls.onNavigateToPlan}
              wideBreakpoint="lg"
              selected={!groupCompleted && controls.selectedRowKey === group.groupKey}
              installed={groupCompleted}
              onClick={groupCompleted ? undefined : () => controls.onSelectRow(group.groupKey)}
              switchChecked={groupIncluded}
              switchDisabled={readOnly}
              switchTooltip={`Include in ${activityLabel} schedule`}
              onSwitchChange={(checked) =>
                groupEntries.forEach((entry) => controls.onIncludedChange(entry.rowKey, checked))
              }
              checkboxChecked={groupCompleted}
              checkboxIndeterminate={groupPartiallyInstalled}
              checkboxDisabled={readOnly || (!groupIncluded && !groupCompleted)}
              checkboxTooltip={
                tab === "react" ? "Mark reaction installed" : "Mark manufacturing job installed"
              }
              onCheckboxChange={updateGroupCompletion}
              contentClassName={
                tab === "react"
                  ? "w-full self-end text-right font-mono text-xs lg:w-auto lg:self-auto"
                  : "grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3 self-end text-right font-mono text-xs lg:w-auto lg:grid-cols-[3rem_9rem_minmax(11rem,max-content)] lg:justify-end lg:gap-x-5 lg:self-auto"
              }
            >
              {tab === "react" ? (
                <SimulationReactionRowFacts
                  installPlan={
                    <SimulationReactionInstallPlanDialog
                      entries={installPlanEntries}
                      solveMode={solveMode}
                      blueprintCounts={{
                        owned: formulaCounts.owned,
                        available: formulaCounts.available,
                      }}
                      scheduleOptions={{
                        protectReactionMaterialBonus,
                        reactionMaterialBonusesByLocation,
                      }}
                      characterNamesById={characterNamesById}
                      onOpenPlan={controls.onOpenPlan}
                      readOnly={readOnly}
                    />
                  }
                  inputs={
                    <SimulationJobInputsResponsive
                      job={group.jobs[0]}
                      jobs={group.jobs}
                      allJobs={allJobs}
                      onOpenPlan={controls.onOpenPlan}
                      onOpenBuy={controls.onOpenBuy}
                      showLabel={false}
                    />
                  }
                  availableFormulas={formulaCounts.available}
                  visibleFormulas={formulaCounts.visible}
                  ownedFormulas={formulaCounts.owned}
                  inUseFormulas={formulaCounts.inUse}
                  installableRuns={group.quantities.installableRuns}
                  totalRuns={group.quantities.totalRuns}
                  installableRuntimeSeconds={installableRuntimeSeconds}
                  totalRuntimeSeconds={totalRuntimeSeconds}
                  suggestedInstallBatches={suggestedInstallSummary.batches}
                />
              ) : (
                <>
                  <span className="flex items-center justify-self-start">
                    <SimulationManufacturingInstallPlanDialog
                      entries={installPlanEntries}
                      displayMode={manufacturingRunDisplay}
                      scheduleOptions={{
                        protectReactionMaterialBonus: false,
                        reactionMaterialBonusesByLocation,
                      }}
                      characterNamesById={characterNamesById}
                      onOpenPlan={controls.onOpenPlan}
                      readOnly={readOnly}
                    />
                  </span>
                  <span className="flex items-center justify-self-center">
                    <SimulationJobInputsResponsive
                      job={group.jobs[0]}
                      jobs={group.jobs}
                      allJobs={allJobs}
                      onOpenPlan={controls.onOpenPlan}
                      onOpenBuy={controls.onOpenBuy}
                    />
                  </span>
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1 justify-self-end whitespace-normal",
                      "lg:whitespace-nowrap",
                    )}
                  >
                    <CopyableNumber
                      value={
                        manufacturingRunDisplay === "schedule"
                          ? scheduledAtT0Runs
                          : group.quantities.installableRuns
                      }
                      suffix=" / "
                      copyLabel={
                        manufacturingRunDisplay === "schedule"
                          ? "T+0 scheduled runs"
                          : "Installable runs"
                      }
                    />
                    <CopyableNumber
                      value={group.quantities.totalRuns}
                      suffix=" runs"
                      copyLabel="Total runs"
                    />
                  </span>
                </>
              )}
            </SwitchedResultRow>
          );
        }}
      />
    </SimulationResultsTab>
  );
}

/** Renders haul tasks grouped first by source and then by destination location. */
function SimulationHaulTab({
  tasks,
  locationNamesById,
  stockpileLocations,
  characterNamesById,
  corporationNamesById,
  controls,
  isLoading,
  haulExclusions,
  onClearHaulExclusions,
  onExcludeLocation,
  readOnly,
  openGroups,
  onOpenGroupChange,
}: {
  tasks: readonly SimulationHaulTask[];
  locationNamesById: ReadonlyMap<number, string>;
  stockpileLocations: ReadonlySet<number>;
  characterNamesById: ReadonlyMap<number, string>;
  corporationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  isLoading: boolean;
  haulExclusions: readonly PlanHaulExclusion[];
  onClearHaulExclusions: () => Promise<boolean>;
  onExcludeLocation?: (locationId: number) => Promise<void>;
  readOnly: boolean;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const [excludingLocationId, setExcludingLocationId] = useState<number | null>(null);
  const {
    groupsByTypeId: haulGroupsByTypeId,
    error: haulGroupError,
    isLoading: haulGroupsLoading,
    retry: retryHaulGroups,
  } = useSimulationAssemblyLineGroups(tasks.map((task) => task.typeId));
  const tasksBySource = new Map<number, Map<number, SimulationHaulTask[]>>();
  for (const task of tasks) {
    const destinations =
      tasksBySource.get(task.fromLocationId) ?? new Map<number, SimulationHaulTask[]>();
    const destinationTasks = destinations.get(task.toLocationId) ?? [];
    destinationTasks.push(task);
    destinations.set(task.toLocationId, destinationTasks);
    tasksBySource.set(task.fromLocationId, destinations);
  }
  const sourceGroups = [...tasksBySource.entries()].sort(([leftId], [rightId]) =>
    locationName(locationNamesById, leftId).localeCompare(locationName(locationNamesById, rightId)),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={readOnly || isLoading || haulExclusions.length === 0}
          onClick={onClearHaulExclusions}
        >
          {haulExclusions.length > 0
            ? `Clear ${haulExclusions.length} haul ${haulExclusions.length === 1 ? "exclusion" : "exclusions"}`
            : "Clear haul exclusions"}
        </Button>
      </div>
      {haulGroupsLoading && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 px-2 text-muted-foreground"
        >
          <Spinner aria-hidden="true" />
          Loading haul item groups...
        </div>
      )}
      {haulGroupError && (
        <Alert variant="destructive">
          <AlertTitle>Haul item groups unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{haulGroupError} Haul items are temporarily sorted alphabetically.</span>
            <Button type="button" variant="outline" size="sm" onClick={retryHaulGroups}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <SimulationResultsTab hasResults={tasks.length > 0}>
        <div className="flex min-w-0 flex-col gap-4">
          {sourceGroups.map(([fromLocationId, destinations]) => {
            const sourceTasks = [...destinations.values()].flat();
            const sourceKey = `haul:from:${fromLocationId}`;
            const sourceAvatars = createGroupAvatars(
              sourceTasks,
              (task) => ({
                typeId: task.typeId,
                name: task.typeName,
                imageVariation: haulImageVariation(task.blueprintKind),
              }),
            );
            return (
              <SimulationResultGroup
                groupKey={sourceKey}
                key={sourceKey}
                allowOverflow
                stickyHeader="viewport"
                label={
                  <>
                    <span className="text-(--theme-info)">From:&nbsp;</span>
                    {locationName(locationNamesById, fromLocationId)}
                  </>
                }
                ariaLabel={`From: ${locationName(locationNamesById, fromLocationId)}`}
                trailingContent={
                  !stockpileLocations.has(fromLocationId) && (onExcludeLocation || readOnly) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 normal-case"
                      disabled={
                        readOnly || isLoading || excludingLocationId !== null || !onExcludeLocation
                      }
                      onClick={() => {
                        if (!onExcludeLocation) return;
                        setExcludingLocationId(fromLocationId);
                        void onExcludeLocation(fromLocationId).finally(() => {
                          setExcludingLocationId(null);
                        });
                      }}
                    >
                      {excludingLocationId === fromLocationId ? (
                        <Spinner data-icon="inline-start" aria-hidden="true" />
                      ) : (
                        <SquareX data-icon="inline-start" aria-hidden="true" />
                      )}
                      {excludingLocationId === fromLocationId
                        ? "Recalculating..."
                        : "Exclude Location"}
                    </Button>
                  ) : undefined
                }
                isOpen={openGroups[sourceKey] ?? true}
                onOpenChange={(open) => onOpenGroupChange(sourceKey, open)}
                avatarRows={sourceAvatars}
                remainingCount={sourceTasks.length - sourceAvatars.length}
              >
                <div className="flex min-w-0 flex-col gap-3 pb-3">
                  {[...destinations.entries()]
                    .sort(([leftId], [rightId]) =>
                      locationName(locationNamesById, leftId).localeCompare(
                        locationName(locationNamesById, rightId),
                      ),
                    )
                    .map(([toLocationId, destinationTasks]) => {
                      const destinationKey = `${sourceKey}:to:${toLocationId}`;
                      const sortedDestinationTasks = sortSimulationHaulTasks(
                        destinationTasks,
                        haulGroupsByTypeId,
                      );
                      const includedDestinationTasks = sortedDestinationTasks.filter((task) =>
                        controls.isIncluded(`haul:${task.transferId}`),
                      );
                      const destinationVolume = simulationHaulVolume(includedDestinationTasks);
                      const destinationVolumeLabel = `${quantity(destinationVolume)} cubic meters`;
                      const includedTaskCount = includedDestinationTasks.length;
                      const destinationIncluded = includedTaskCount > 0;
                      const destinationRowKeys = sortedDestinationTasks.map(
                        (task) => `haul:${task.transferId}`,
                      );
                      const destinationAvatars = createGroupAvatars(
                        sortedDestinationTasks,
                        (task) => ({
                          typeId: task.typeId,
                          name: task.typeName,
                          imageVariation: haulImageVariation(task.blueprintKind),
                        }),
                      );
                      return (
                        <SimulationResultGroup
                          groupKey={destinationKey}
                          key={destinationKey}
                          label={
                            <>
                              <span className="text-(--theme-info)">To:&nbsp;</span>
                              {locationName(locationNamesById, toLocationId)}
                            </>
                          }
                          trailingContent={
                            <strong className="shrink-0 text-lg whitespace-nowrap text-(--theme-info) lowercase">
                              {quantity(destinationVolume)} m<sup>3</sup>
                            </strong>
                          }
                          ariaLabel={`To: ${locationName(locationNamesById, toLocationId)}, ${destinationVolumeLabel}`}
                          switchChecked={destinationIncluded}
                          switchLabel={`Include haul group from ${locationName(locationNamesById, fromLocationId)} to ${locationName(locationNamesById, toLocationId)}`}
                          switchPending={isLoading}
                          switchDisabled={readOnly || isLoading}
                          onSwitchChange={(checked) =>
                            controls.onHaulIncludedChange(destinationRowKeys, checked)
                          }
                          variant="nested"
                          stickyHeader="parent"
                          isOpen={openGroups[destinationKey] ?? true}
                          onOpenChange={(open) => onOpenGroupChange(destinationKey, open)}
                          avatarRows={destinationAvatars}
                          remainingCount={sortedDestinationTasks.length - destinationAvatars.length}
                        >
                          <div className="flex min-w-0 flex-col">
                            {sortedDestinationTasks.map((task) => (
                              <SimulationHaulRow
                                key={task.transferId}
                                task={task}
                                characterNamesById={characterNamesById}
                                corporationNamesById={corporationNamesById}
                                switchLabel={`Include ${task.typeName} from ${locationName(locationNamesById, task.fromLocationId)} to ${locationName(locationNamesById, task.toLocationId)} in haul plan, transfer ${task.transferId}`}
                                isLoading={isLoading}
                                readOnly={readOnly}
                                controls={controls}
                              />
                            ))}
                          </div>
                        </SimulationResultGroup>
                      );
                    })}
                </div>
              </SimulationResultGroup>
            );
          })}
        </div>
      </SimulationResultsTab>
    </div>
  );
}

/** Renders a selectable, completion-trackable haul task. */
function SimulationHaulRow({
  task,
  characterNamesById,
  corporationNamesById,
  switchLabel,
  isLoading,
  readOnly,
  controls,
}: {
  task: SimulationHaulTask;
  characterNamesById: ReadonlyMap<number, string>;
  corporationNamesById: ReadonlyMap<number, string>;
  switchLabel: string;
  isLoading: boolean;
  readOnly: boolean;
  controls: SimulationRowControls;
}) {
  const rowKey = `haul:${task.transferId}`;
  const included = controls.isIncluded(rowKey);
  const completed = controls.isCompleted(rowKey);
  const owner =
    task.ownerType !== undefined && task.ownerId !== undefined
      ? { type: task.ownerType, id: task.ownerId }
      : null;
  return (
    <SwitchedResultRow
      name={task.typeName}
      typeId={task.typeId}
      variation={haulImageVariation(task.blueprintKind)}
      subline={task.purpose}
      linkPath="planner"
      linkIcon={ClipboardList}
      linkSearchParams={{ simulationTab: "plan" }}
      linkHash="plan-breakdown"
      navigateInPlace
      onNavigate={controls.onNavigateToPlan}
      selected={!completed && controls.selectedRowKey === rowKey}
      installed={completed}
      onClick={completed || isLoading || readOnly ? undefined : () => controls.onSelectRow(rowKey)}
      switchChecked={included}
      switchTooltip={switchLabel}
      switchPending={isLoading}
      switchDisabled={readOnly || isLoading}
      onSwitchChange={(checked) => controls.onHaulIncludedChange([rowKey], checked)}
      checkboxChecked={completed}
      checkboxDisabled={!included || readOnly || isLoading}
      checkboxTooltip="Mark as moved"
      onCheckboxChange={(checked) => controls.onCompletedChange(rowKey, checked)}
      contentClassName="self-end text-right font-mono text-xs sm:self-auto"
    >
      <span
        className={
          owner !== null
            ? "flex w-full items-center justify-between gap-2 sm:grid sm:w-auto sm:grid-cols-[auto_128px] sm:justify-normal"
            : "flex items-center"
        }
      >
        {owner !== null && (
          <Tooltip>
            <TooltipTrigger
              render={
                owner.type === "corporation" ? (
                  <Image
                    src={eveCorporationLogoUrl(owner.id, 64)}
                    alt={`${corporationNamesById.get(owner.id) ?? `Corporation ${owner.id}`} logo`}
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded-none"
                  />
                ) : (
                  <Image
                    src={eveCharacterPortraitUrl(owner.id, 64)}
                    alt={`${characterNamesById.get(owner.id) ?? `Character ${owner.id}`} portrait`}
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded-none"
                  />
                )
              }
            />
            <TooltipContent>
              Owner:&nbsp;
              {owner.type === "corporation"
                ? (corporationNamesById.get(owner.id) ?? `Corporation ${owner.id}`)
                : (characterNamesById.get(owner.id) ?? `Character ${owner.id}`)}
            </TooltipContent>
          </Tooltip>
        )}
        <span
          className={
            owner !== null ? "flex flex-col items-end justify-self-end" : "flex flex-col items-end"
          }
        >
          <CopyableNumber value={task.quantity} suffix=" units" copyLabel="Haul quantity" />
          <span className="text-muted-foreground">
            <CopyableNumber
              value={Math.ceil(task.quantity * task.unitVolume)}
              suffix=" m3"
              copyLabel="Haul volume"
            />
          </span>
        </span>
      </span>
    </SwitchedResultRow>
  );
}

/** Renders simulator purchases grouped by AssemblyLineGroup with multibuy actions. */
function SimulationBuyTab({
  result,
  marketBuyOrderQuantities,
  directStockpileItemTypeIds,
  overOrderPercent,
  onOverOrderPercentChange,
  roundUpQuantities,
  onRoundUpQuantitiesChange,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  result: SimulationResultV2;
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  directStockpileItemTypeIds: ReadonlySet<number>;
  overOrderPercent: string;
  onOverOrderPercentChange: (value: string) => void;
  roundUpQuantities: boolean;
  onRoundUpQuantitiesChange: (checked: boolean) => void;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const parsedOverOrderPercent = parseSimulationOverOrderPercent(overOrderPercent);
  const validOverOrderPercent = parsedOverOrderPercent ?? 0;
  const reactionFormulaTypeIds = new Set(
    result.lists.reactionFormulas?.flatMap((bucket) => bucket.items.map((item) => item.typeId))
      ?? [],
  );
  const excludedTypeIds = new Set([...directStockpileItemTypeIds, ...reactionFormulaTypeIds]);
  const entries: SimulationBuyEntry[] = [
    ...result.lists.materialsToBuy.map((purchase) => ({ purchase, isMaterial: true })),
    ...result.lists.bpoToBuy.map((purchase) => ({ purchase, isMaterial: false })),
  ].map((entry) => ({
    ...entry,
    purchase: {
      ...entry.purchase,
      quantity: shouldAdjustSimulationPurchaseQuantity(
        entry.purchase.typeId,
        entry.isMaterial,
        excludedTypeIds,
      )
        ? adjustSimulationPurchaseQuantity(
            entry.purchase.quantity,
            validOverOrderPercent,
            roundUpQuantities,
          )
        : entry.purchase.quantity,
    },
  }));
  const metadataByTypeId = useSimulationTypeMetadata(entries.map((entry) => entry.purchase.typeId));
  const {
    groupsByTypeId,
    error: assemblyLineGroupError,
    retry: retryAssemblyLineGroups,
  } = useSimulationAssemblyLineGroups(entries.map((entry) => entry.purchase.typeId));
  const groups = AssemblyLineGroups
    .groupBy(entries, (entry) => groupsByTypeId.get(entry.purchase.typeId) ?? "Unknown")
    .sort((left, right) => left.assemblyLineGroup.localeCompare(right.assemblyLineGroup));
  const materialEntries = entries.filter((entry) => entry.isMaterial);
  const [copyStatus, setCopyStatus] = useState<{ scope: string; label: string } | null>(null);

  async function copyGroupMultibuy(scope: string, groupEntries: readonly SimulationBuyEntry[]) {
    try {
      await navigator.clipboard.writeText(multibuyText(groupEntries));
      setCopyStatus({ scope, label: "Copied" });
      toast.add({ description: `All ${scope} copied to clipboard` });
      window.setTimeout(
        () => {
          setCopyStatus((current) => (current?.scope === scope ? null : current));
        },
        1600,
      );
    }
    catch {
      setCopyStatus({ scope, label: "Copy failed" });
      toast.add({ description: "Could not copy multibuy group", type: "error" });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {assemblyLineGroupError && (
        <Alert variant="destructive">
          <AlertTitle>Purchase groups unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{assemblyLineGroupError} Purchases are temporarily grouped as Unknown.</span>
            <Button type="button" variant="outline" size="sm" onClick={retryAssemblyLineGroups}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <SimulationResultsTab
        hasResults={entries.length > 0}
        settings={
          <div className="flex flex-wrap items-center justify-between gap-3 max-[640px]:justify-end">
            <FieldSet className="min-w-0 border p-3">
              <FieldLegend className="mb-0 px-1">Raw Materials</FieldLegend>
              <div className="flex flex-wrap items-center gap-4">
                <Label className="flex items-center gap-2 whitespace-nowrap">
                  Over-order %
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={overOrderPercent}
                    onChange={(event) => onOverOrderPercentChange(event.target.value)}
                    aria-label="Over-order percentage"
                    aria-invalid={parsedOverOrderPercent === undefined}
                    className="w-24"
                  />
                </Label>
                <Label className="flex items-center gap-2 whitespace-nowrap">
                  Round-up
                  <Switch
                    checked={roundUpQuantities}
                    onCheckedChange={onRoundUpQuantitiesChange}
                    aria-label="Round buy quantities up by quantity tier"
                  />
                </Label>
              </div>
            </FieldSet>
            <Button
              type="button"
              variant="outline"
              disabled={materialEntries.length === 0}
              onClick={() => void copyGroupMultibuy("all materials", materialEntries)}
            >
              <CopyIcon aria-hidden="true" />
              {copyStatus?.scope === "all materials" ? copyStatus.label : "Multibuy Materials"}
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          {groups.map((group) => {
            const groupKey = `buy:${group.assemblyLineGroup}`;
            const materialGroupEntries = group.items.filter((entry) => entry.isMaterial);
            const groupAvatars = createGroupAvatars(
              group.items,
              (entry) => ({
                typeId: entry.purchase.typeId,
                name: entry.purchase.typeName,
                imageVariation: simulationPurchaseImageVariation(entry, metadataByTypeId),
              }),
            );
            return (
              <SimulationResultGroup
                key={groupKey}
                groupKey={groupKey}
                label={group.assemblyLineGroup}
                ariaLabel={group.assemblyLineGroup}
                isOpen={openGroups[groupKey] ?? true}
                onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
                avatarRows={groupAvatars}
                remainingCount={group.items.length - groupAvatars.length}
                onCopyGroup={
                  materialGroupEntries.length > 0
                    ? () => void copyGroupMultibuy(group.assemblyLineGroup, materialGroupEntries)
                    : undefined
                }
                copyLabel={
                  copyStatus?.scope === group.assemblyLineGroup
                    ? copyStatus.label
                    : "Copy Group Multibuy"
                }
              >
                <div className="flex min-w-0 flex-col">
                  {group.items.map(({ purchase, isMaterial }) => {
                    const rowKey = `buy:${isMaterial ? "material" : "blueprint"}:${purchase.typeId}:${purchase.destinations
                      .map((destination) => destination.locationId)
                      .join(":")}`;
                    return (
                      <SimulationSimpleJobRow
                        key={rowKey}
                        rowKey={rowKey}
                        typeId={purchase.typeId}
                        name={purchase.typeName}
                        subline={
                          <CopyableNumber
                            value={purchase.destinations.length}
                            suffix={` destination${purchase.destinations.length === 1 ? "" : "s"}`}
                            copyLabel="Destinations"
                          />
                        }
                        identityTrailingContent={
                          isMaterial ? (
                            <FulleriteGasSiteBadges typeId={purchase.typeId} />
                          ) : undefined
                        }
                        summary={
                          <span className="flex items-center justify-end gap-2">
                            <MarketBuyOrderIndicator
                              quantity={marketBuyOrderQuantities?.[String(purchase.typeId)] ?? 0}
                            />
                            <CopyableNumber
                              value={purchase.quantity}
                              copyLabel="Purchase quantity"
                            />
                          </span>
                        }
                        variation={simulationPurchaseImageVariation(
                          { purchase, isMaterial },
                          metadataByTypeId,
                        )}
                        showCheckbox
                        controls={controls}
                      />
                    );
                  })}
                </div>
              </SimulationResultGroup>
            );
          })}
        </div>
      </SimulationResultsTab>
    </div>
  );
}

/** Renders simulator skill requirements as a simple result list. */
function SimulationSkillsTab({
  result,
  characterNamesById,
  characterStatuses,
}: {
  result: SimulationResultV2;
  characterNamesById: ReadonlyMap<number, string>;
  characterStatuses: readonly ClientCharacterStatus[];
}) {
  return (
    <SimulationResultsTab
      hasResults={true}
      emptyTitle="No character skill data"
      emptyDescription="Connect a character and refresh status to compare trained skills."
    >
      <PlannerSkillsTab
        requirements={result.lists.skillsRequired}
        characters={characterStatuses}
        characterNamesById={characterNamesById}
      />
    </SimulationResultsTab>
  );
}

/** Renders simulator warnings as the first output tab. */
function SimulationWarningsTab({
  result,
  locationNamesById,
  openGroups,
  onOpenGroupChange,
}: {
  result: SimulationResultV2;
  locationNamesById: ReadonlyMap<number, string>;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const warningsByLocation = new Map<number | undefined, SimulationResultV2["lists"]["warnings"]>();
  for (const warning of result.lists.warnings) {
    const group = warningsByLocation.get(warning.locationId) ?? [];
    group.push(warning);
    warningsByLocation.set(warning.locationId, group);
  }
  const sortedGroups = [...warningsByLocation.entries()].sort(([leftId], [rightId]) =>
    (leftId === undefined ? "Unlocated" : locationName(locationNamesById, leftId)).localeCompare(
      rightId === undefined ? "Unlocated" : locationName(locationNamesById, rightId),
    ),
  );

  return (
    <SimulationResultsTab
      hasResults={result.lists.warnings.length > 0}
      emptyTitle="No warnings"
      emptyDescription="This simulation has no calculation warnings."
    >
      <div className="flex min-w-0 flex-col gap-4">
        {sortedGroups.map(([locationId, warnings]) => {
          const groupKey = `warnings:${locationId ?? "unlocated"}`;
          const label =
            locationId === undefined ? "Unlocated" : locationName(locationNamesById, locationId);
          return (
            <SimulationResultGroup
              key={groupKey}
              groupKey={groupKey}
              label={label}
              isOpen={openGroups[groupKey] ?? true}
              onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
              avatarRows={[]}
              remainingCount={0}
            >
              <div className="flex min-w-0 flex-col gap-2">
                {warnings.map((warning, index) => (
                  <Alert key={`${warning.code}:${warning.jobId ?? index}`}>
                    <TriangleAlert />
                    <AlertTitle>{warning.code}</AlertTitle>
                    <AlertDescription>{warning.message}</AlertDescription>
                  </Alert>
                ))}
              </div>
            </SimulationResultGroup>
          );
        })}
      </div>
    </SimulationResultsTab>
  );
}

/** Renders the native simulator response without converting it to legacy planner result shapes. */
export default function SimulationResults({
  result,
  directStockpileItemTypeIds,
  status,
  stock,
  visibleReactionFormulaStock = stock,
  industryJobs,
  marketBuyOrderQuantities,
  locationNamesById,
  locationSystemIdsById,
  systemNamesById,
  stockpileLocations,
  reactionMaterialBonusesByLocation,
  characterNamesById,
  characterStatuses,
  slotUsage,
  jobsLastUpdated,
  corporationNamesById,
  stockpileNamesById,
  haulExclusions,
  preservedHaulTasks,
  isLoading,
  onClearHaulExclusions,
  onExcludeLocation,
  onHaulExclusionsChange,
  usePlannerUrlState = true,
  instanceId = "planner",
  readOnly = false,
}: {
  result: SimulationResultV2 | null;
  directStockpileItemTypeIds: ReadonlySet<number>;
  status: string;
  stock: readonly PlanStockItem[];
  visibleReactionFormulaStock?: readonly PlanStockItem[];
  industryJobs?: ClientJobsResponse["jobs"];
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  locationNamesById: ReadonlyMap<number, string>;
  locationSystemIdsById?: ReadonlyMap<number, number>;
  systemNamesById?: ReadonlyMap<number, string>;
  stockpileLocations: ReadonlySet<number>;
  reactionMaterialBonusesByLocation: ReadonlyMap<number, number>;
  characterNamesById: ReadonlyMap<number, string>;
  characterStatuses: readonly ClientCharacterStatus[];
  slotUsage: ClientJobsResponse["slotUsage"];
  jobsLastUpdated?: string;
  corporationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  haulExclusions: readonly PlanHaulExclusion[];
  preservedHaulTasks: readonly SimulationHaulTask[];
  isLoading: boolean;
  onClearHaulExclusions: () => Promise<boolean>;
  onExcludeLocation?: (locationId: number) => Promise<void>;
  onHaulExclusionsChange: (
    exclusions: readonly PlanHaulExclusion[],
    preservedHaulTasks: readonly SimulationHaulTask[],
  ) => Promise<boolean>;
  usePlannerUrlState?: boolean;
  instanceId?: string;
  readOnly?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<SimulationTab>(() =>
    usePlannerUrlState ? readSimulationTabFromUrl() : "warnings",
  );
  const { overOrderPercent, roundUpQuantities, setOverOrderPercent, setRoundUpQuantities } =
    useSimulationBuySettings();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [includedRows, setIncludedRows] = useState<Record<string, boolean>>({});
  const [localPreservedHaulTasks, setLocalPreservedHaulTasks] = useState<
    Record<string, SimulationHaulTask>
  >({});
  const [completionByRow, setCompletionByRow] = useState<
    Partial<Record<string, SimulationCompletionState>>
  >({});
  const [completedTypeDates, setCompletedTypeDates] =
    useState<CompletedTypeDates>(emptyCompletedTypeDates);
  const [completedTypeDatesHydratedRevision, setCompletedTypeDatesHydratedRevision] =
    useState<string>();
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const isMobile = useIsMobileSimulationView();
  const statusIsError = status.startsWith("Error:");
  const hasSurplusTab = result?.lists.surplusItems !== undefined;
  const selectedTab = !hasSurplusTab && activeTab === "surplus" ? "warnings" : activeTab;
  const simulationInputRevision = result
    ? `${result.metadata.simulationId ?? ""}|${result.metadata.normalizedInputHash}|${result.metadata.sdeRevision}`
    : undefined;
  const jobsLastUpdatedRef = useRef(jobsLastUpdated);
  jobsLastUpdatedRef.current = jobsLastUpdated;
  useEffect(() => {
    startTransition(() => {
      setCompletionByRow({});
    });
  }, [simulationInputRevision]);
  useEffect(() => {
    if (!simulationInputRevision) return;
    startTransition(() => {
      setCompletedTypeDates(
        pruneCompletedTypeDates(
          loadCompletedTypeDates(simulationInputRevision),
          jobsLastUpdatedRef.current,
        ),
      );
      setCompletedTypeDatesHydratedRevision(simulationInputRevision);
    });
  }, [simulationInputRevision]);
  useEffect(() => {
    if (
      !simulationInputRevision
      || completedTypeDatesHydratedRevision !== simulationInputRevision
    ) {
      return;
    }
    saveCompletedTypeDates(simulationInputRevision, completedTypeDates);
  }, [completedTypeDates, completedTypeDatesHydratedRevision, simulationInputRevision]);
  useEffect(() => {
    if (!jobsLastUpdated) return;
    startTransition(() => {
      setCompletedTypeDates((current) => pruneCompletedTypeDates(current, jobsLastUpdated));
    });
  }, [jobsLastUpdated]);
  async function copySimulationId() {
    const simulationId = result?.metadata.simulationId;
    if (!simulationId) return;
    try {
      await navigator.clipboard.writeText(simulationId);
      toast.add({ description: "Simulation ID copied" });
    }
    catch {
      toast.add({ description: "Could not copy the simulation ID", type: "error" });
    }
  }
  async function clearHaulExclusions(): Promise<boolean> {
    const succeeded = await onClearHaulExclusions();
    if (succeeded) {
      setIncludedRows({});
      setLocalPreservedHaulTasks({});
    }
    return succeeded;
  }
  const currentHaulTasks = result?.lists.haulingTasks ?? [];
  const currentHaulExclusionKeys = new Set(
    currentHaulTasks.map((task) => simulationHaulExclusionKey(task)),
  );
  const allPreservedHaulTasks = new Map(
    preservedHaulTasks.map((task) => [simulationHaulExclusionKey(task), task]),
  );
  for (const [key, task] of Object.entries(localPreservedHaulTasks)) {
    allPreservedHaulTasks.set(key, task);
  }
  const visibleHaulTasks = [
    ...currentHaulTasks,
    ...Object
      .entries(Object.fromEntries(allPreservedHaulTasks))
      .filter(
        ([key]) =>
          !currentHaulExclusionKeys.has(key)
          && haulExclusions.some((exclusion) => simulationHaulExclusionKey(exclusion) === key),
      )
      .map(([, task]) => task),
  ].filter(
    (task, index, tasks) =>
      tasks.findIndex((candidate) => candidate.transferId === task.transferId) === index,
  );
  const excludedHaulRowKeys = new Set(
    visibleHaulTasks
      .filter((task) =>
        haulExclusions.some(
          (exclusion) => simulationHaulExclusionKey(exclusion) === simulationHaulExclusionKey(task),
        ),
      )
      .map((task) => `haul:${task.transferId}`),
  );
  const controls: SimulationRowControls = {
    selectedRowKey,
    onSelectRow: (rowKey) => setSelectedRowKey((current) => (current === rowKey ? null : rowKey)),
    isIncluded: (rowKey) => includedRows[rowKey] ?? !excludedHaulRowKeys.has(rowKey),
    onIncludedChange: (rowKey, included) =>
      setIncludedRows((current) => ({ ...current, [rowKey]: included })),
    onHaulIncludedChange: (rowKeys, included) => {
      const previousIncludedRows = includedRows;
      const previousLocalPreservedHaulTasks = localPreservedHaulTasks;
      const nextIncludedRows = { ...includedRows };
      const nextPreservedHaulTasks = Object.fromEntries(allPreservedHaulTasks);
      const tasksByRowKey = new Map(
        visibleHaulTasks.map((task) => [`haul:${task.transferId}`, task]),
      );
      for (const rowKey of rowKeys) nextIncludedRows[rowKey] = included;
      for (const rowKey of rowKeys) {
        const task = tasksByRowKey.get(rowKey);
        if (!task) continue;
        const key = simulationHaulExclusionKey(task);
        if (!included) nextPreservedHaulTasks[key] = task;
        else delete nextPreservedHaulTasks[key];
      }
      const nextExclusions = simulationHaulExclusions(
        result,
        nextIncludedRows,
        haulExclusions,
        visibleHaulTasks,
      );
      const nextPreservedTasks = Object
        .values(nextPreservedHaulTasks)
        .filter((task) =>
          nextExclusions.some(
            (exclusion) =>
              simulationHaulExclusionKey(exclusion) === simulationHaulExclusionKey(task),
          ),
        );
      setIncludedRows(nextIncludedRows);
      setLocalPreservedHaulTasks(nextPreservedHaulTasks);
      void onHaulExclusionsChange(nextExclusions, nextPreservedTasks).then((succeeded) => {
        if (succeeded) return;
        setIncludedRows(previousIncludedRows);
        setLocalPreservedHaulTasks(previousLocalPreservedHaulTasks);
      });
    },
    isTypeCompleted: (tab, typeId) => completedTypeDates[tab].has(typeId),
    onTypeCompletedChange: (tab, typeId, completed) =>
      setCompletedTypeDates((current) => {
        const next = new Map(current[tab]);
        if (completed) next.set(typeId, new Date());
        else next.delete(typeId);
        return { ...current, [tab]: next };
      }),
    isCompleted: (rowKey, scheduleIdentity, matchScheduleRevision = false) => {
      const completion = completionByRow[rowKey];
      if (!completion) return false;
      if (
        scheduleIdentity !== undefined
        && completion.scheduleIdentity !== undefined
        && !simulationCompletionMatchesSchedule(
          completion.scheduleIdentity,
          scheduleIdentity,
          matchScheduleRevision,
        )
      ) {
        return false;
      }
      return completion.installableRuns === undefined
        ? completion.installedRuns > 0
        : completion.installableRuns > 0 && completion.installedRuns >= completion.installableRuns;
    },
    onCompletedChange: (rowKey, completed) =>
      setCompletionByRow((current) => ({
        ...current,
        [rowKey]: { installedRuns: completed ? 1 : 0, completedInstallIds: {} },
      })),
    getInstalledRuns: (rowKey, scheduleIdentity, matchScheduleRevision = false) => {
      const completion = completionByRow[rowKey];
      return scheduleIdentity !== undefined
        && completion?.scheduleIdentity !== undefined
        && !simulationCompletionMatchesSchedule(
          completion.scheduleIdentity,
          scheduleIdentity,
          matchScheduleRevision,
        )
        ? 0
        : (completion?.installedRuns ?? 0);
    },
    getCompletedInstallIds: (rowKey, scheduleIdentity, matchScheduleRevision = false) => {
      const completion = completionByRow[rowKey];
      return scheduleIdentity !== undefined
        && completion?.scheduleIdentity !== undefined
        && !simulationCompletionMatchesSchedule(
          completion.scheduleIdentity,
          scheduleIdentity,
          matchScheduleRevision,
        )
        ? {}
        : (completion?.completedInstallIds ?? {});
    },
    getCompletedSchedule: (rowKey, scheduleIdentity, matchScheduleRevision = false) => {
      const completion = completionByRow[rowKey];
      return scheduleIdentity !== undefined
        && completion?.scheduleIdentity !== undefined
        && !simulationCompletionMatchesSchedule(
          completion.scheduleIdentity,
          scheduleIdentity,
          matchScheduleRevision,
        )
        ? undefined
        : completion?.schedule;
    },
    onInstalledRunsChange: (
      rowKey,
      installedRuns,
      installableRuns,
      scheduleIdentity,
      completedInstallIds = {},
      schedule,
    ) => {
      const normalizedRuns = Math.min(Math.max(0, installedRuns), installableRuns);
      setCompletionByRow((current) => ({
        ...current,
        [rowKey]: {
          installedRuns: normalizedRuns,
          installableRuns,
          scheduleIdentity,
          completedInstallIds: { ...completedInstallIds },
          schedule,
        },
      }));
    },
    onOpenPlan: () => selectTab("plan"),
    onNavigateToPlan: () => setActiveTab("plan"),
    onOpenBuy: () => selectTab("buy"),
  };
  const onOpenGroupChange = (groupKey: string, open: boolean) =>
    setOpenGroups((current) => ({ ...current, [groupKey]: open }));

  function selectTab(value: string) {
    if (!isSimulationTab(value) || (value === "surplus" && !hasSurplusTab)) return;
    setActiveTab(value);
    if (usePlannerUrlState) updateSimulationTabInUrl(value, "push");
  }

  useEffect(() => {
    if (!usePlannerUrlState) return;
    const applyUrlState = () => {
      const requestedTab = readSimulationTabFromUrl();
      const nextTab = requestedTab === "surplus" && !hasSurplusTab ? "warnings" : requestedTab;
      setActiveTab(nextTab);
      if (new URLSearchParams(window.location.search).get(simulationTabParam) !== nextTab) {
        updateSimulationTabInUrl(nextTab, "replace");
      }
    };
    applyUrlState();
    window.addEventListener("popstate", applyUrlState);
    return () => window.removeEventListener("popstate", applyUrlState);
  }, [hasSurplusTab, usePlannerUrlState]);

  if (!result) {
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <p aria-live="polite" className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
        {statusIsError ? (
          <Alert variant="destructive">
            <AlertTitle>Simulation failed</AlertTitle>
            <AlertDescription>{status.slice("Error: ".length)}</AlertDescription>
          </Alert>
        ) : isLoading ? (
          <Empty>
            <EmptyHeader>
              <Spinner />
              <EmptyTitle>Simulation in progress</EmptyTitle>
              <EmptyDescription>{status}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Simulation output is ready when you are</EmptyTitle>
              <EmptyDescription>
                Simulate the active stockpiles to calculate the required work.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    );
  }

  const availableTabs = tabs.filter(({ value }) => value !== "surplus" || hasSurplusTab);
  const simulationTabContent = (
    <SimulationTabContent
      activeTab={selectedTab}
      result={result}
      includedRows={includedRows}
      haulTasks={visibleHaulTasks}
      stock={stock}
      visibleReactionFormulaStock={visibleReactionFormulaStock}
      industryJobs={industryJobs}
      marketBuyOrderQuantities={marketBuyOrderQuantities}
      directStockpileItemTypeIds={directStockpileItemTypeIds}
      overOrderPercent={overOrderPercent}
      onOverOrderPercentChange={setOverOrderPercent}
      roundUpQuantities={roundUpQuantities}
      onRoundUpQuantitiesChange={setRoundUpQuantities}
      locationNamesById={locationNamesById}
      locationSystemIdsById={locationSystemIdsById}
      systemNamesById={systemNamesById}
      stockpileLocations={stockpileLocations}
      reactionMaterialBonusesByLocation={reactionMaterialBonusesByLocation}
      characterNamesById={characterNamesById}
      characterStatuses={characterStatuses}
      slotUsage={slotUsage}
      corporationNamesById={corporationNamesById}
      stockpileNamesById={stockpileNamesById}
      haulExclusions={haulExclusions}
      preservedHaulTasks={preservedHaulTasks}
      isLoading={isLoading}
      onClearHaulExclusions={clearHaulExclusions}
      onExcludeLocation={onExcludeLocation}
      readOnly={readOnly}
      controls={controls}
      onSelectSimulationTab={selectTab}
      openGroups={openGroups}
      onOpenGroupChange={onOpenGroupChange}
      usePlannerUrlState={usePlannerUrlState}
      instanceId={instanceId}
    />
  );

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">SIMULATOR OUTPUT</p>
          <h2 className="text-lg font-medium">Plan breakdown</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3 max-[640px]:w-full max-[640px]:flex-col max-[640px]:items-stretch">
          <SimulationTimeline
            result={result}
            industryJobs={industryJobs}
            characterNamesById={characterNamesById}
            locationNamesById={locationNamesById}
          />
          <Badge variant="outline">v{result.metadata.simulatorVersion}</Badge>
          {result.metadata.simulationId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-[640px]:w-full"
              onClick={() => setIsBugReportOpen(true)}
            >
              <Bug aria-hidden="true" />
              Found a bug in this simulation?
            </Button>
          )}
          <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
            {status}
          </span>
        </div>
      </div>
      <Dialog open={isBugReportOpen} onOpenChange={setIsBugReportOpen}>
        <DialogContent>
          <DialogTitle>Report a simulation problem</DialogTitle>
          <div className="flex flex-col gap-4 text-sm">
            <DialogDescription>
              Go to our Discord and post details of the problem along with this simulation ID so we
              can reproduce the calculation.
            </DialogDescription>
            <div className="flex items-center gap-2 border p-3 font-mono text-xs">
              <span className="min-w-0 flex-1 break-all">{result.metadata.simulationId}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copySimulationId()}
              >
                <CopyIcon aria-hidden="true" />
                Copy ID
              </Button>
            </div>
            <Button
              type="button"
              onClick={() => window.open("https://discord.gg/VdGZWzXahh", "_blank", "noopener")}
            >
              Open Discord
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {isMobile ? (
        <>
          <Select
            value={selectedTab}
            onValueChange={(value) => {
              if (value !== null) selectTab(value);
            }}
          >
            <SelectTrigger aria-label="Simulation output view" className="w-full">
              <SelectValue>{tabs.find(({ value }) => value === selectedTab)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {availableTabs.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {simulationTabContent}
        </>
      ) : (
        <Tabs value={selectedTab} onValueChange={selectTab}>
          <ScrollArea className="h-11 w-full max-w-full **:data-[slot=scroll-area-viewport]:overflow-y-hidden!">
            <TabsList className="w-full min-w-max justify-start" variant="line">
              {availableTabs.map(({ value, label, icon: Icon }) => (
                <TabsTrigger key={value} value={value}>
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
          <TabsContent value={selectedTab} className="pt-0">
            {simulationTabContent}
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}

/** Selects the focused presentation component for the active simulation output tab. */
function SimulationTabContent({
  activeTab,
  result,
  includedRows,
  directStockpileItemTypeIds,
  haulTasks,
  stock,
  visibleReactionFormulaStock,
  industryJobs,
  marketBuyOrderQuantities,
  overOrderPercent,
  onOverOrderPercentChange,
  roundUpQuantities,
  onRoundUpQuantitiesChange,
  locationNamesById,
  locationSystemIdsById,
  systemNamesById,
  stockpileLocations,
  reactionMaterialBonusesByLocation,
  characterNamesById,
  characterStatuses,
  slotUsage,
  corporationNamesById,
  stockpileNamesById,
  controls,
  haulExclusions,
  preservedHaulTasks,
  isLoading,
  onClearHaulExclusions,
  onExcludeLocation,
  openGroups,
  onSelectSimulationTab,
  onOpenGroupChange,
  usePlannerUrlState,
  instanceId,
  readOnly,
}: {
  activeTab: SimulationTab;
  result: SimulationResultV2;
  includedRows: Readonly<Record<string, boolean>>;
  directStockpileItemTypeIds: ReadonlySet<number>;
  haulTasks: readonly SimulationHaulTask[];
  stock: readonly PlanStockItem[];
  visibleReactionFormulaStock: readonly PlanStockItem[];
  industryJobs?: ClientJobsResponse["jobs"];
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  overOrderPercent: string;
  onOverOrderPercentChange: (value: string) => void;
  roundUpQuantities: boolean;
  onRoundUpQuantitiesChange: (checked: boolean) => void;
  locationNamesById: ReadonlyMap<number, string>;
  locationSystemIdsById?: ReadonlyMap<number, number>;
  systemNamesById?: ReadonlyMap<number, string>;
  stockpileLocations: ReadonlySet<number>;
  reactionMaterialBonusesByLocation: ReadonlyMap<number, number>;
  characterNamesById: ReadonlyMap<number, string>;
  characterStatuses: readonly ClientCharacterStatus[];
  slotUsage: ClientJobsResponse["slotUsage"];
  corporationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  controls: SimulationRowControls;
  haulExclusions: readonly PlanHaulExclusion[];
  preservedHaulTasks: readonly SimulationHaulTask[];
  isLoading: boolean;
  onClearHaulExclusions: () => Promise<boolean>;
  onExcludeLocation?: (locationId: number) => Promise<void>;
  readOnly: boolean;
  openGroups: Record<string, boolean>;
  onSelectSimulationTab: (tab: SimulationTab) => void;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
  usePlannerUrlState: boolean;
  instanceId: string;
}) {
  if (activeTab === "warnings") {
    return (
      <SimulationWarningsTab
        result={result}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "plan" || activeTab === "surplus") {
    return (
      <SimulationMaterialsTab
        tab={activeTab}
        buckets={activeTab === "plan" ? result.lists.planItems : (result.lists.surplusItems ?? [])}
        reactionFormulaBuckets={activeTab === "plan" ? result.lists.reactionFormulas : undefined}
        stock={stock}
        locationNamesById={locationNamesById}
        stockpileNamesById={stockpileNamesById}
        marketBuyOrderQuantities={marketBuyOrderQuantities}
        controls={controls}
        onSelectSimulationTab={onSelectSimulationTab}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        usePlannerUrlState={usePlannerUrlState}
        instanceId={instanceId}
      />
    );
  }
  if (activeTab === "reprocess") {
    return (
      <SimulationReprocessingTab
        jobs={result.lists.reprocessingJobs}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "copy") {
    return (
      <SimulationCopyTab
        jobs={result.lists.bpcToCopy}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "invent") {
    return (
      <SimulationInventionTab
        jobs={result.lists.inventionJobs}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "react" || activeTab === "manufacture") {
    return (
      <SimulationActivityTab
        tab={activeTab}
        jobs={activeTab === "react" ? result.lists.reactionJobs : result.lists.manufacturingJobs}
        allJobs={[...result.lists.manufacturingJobs, ...result.lists.reactionJobs]}
        includedRows={includedRows}
        industryJobs={industryJobs}
        simulationInputRevision={`${result.metadata.simulationId ?? ""}|${result.metadata.normalizedInputHash}|${result.metadata.sdeRevision}`}
        stock={stock}
        visibleReactionFormulaStock={visibleReactionFormulaStock}
        locationNamesById={locationNamesById}
        locationSystemIdsById={locationSystemIdsById}
        systemNamesById={systemNamesById}
        reactionMaterialBonusesByLocation={reactionMaterialBonusesByLocation}
        characterNamesById={characterNamesById}
        characterStatuses={characterStatuses}
        slotUsage={slotUsage}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        instanceId={instanceId}
        readOnly={readOnly}
      />
    );
  }
  if (activeTab === "haul") {
    return (
      <SimulationHaulTab
        tasks={haulTasks}
        locationNamesById={locationNamesById}
        stockpileLocations={stockpileLocations}
        characterNamesById={characterNamesById}
        corporationNamesById={corporationNamesById}
        isLoading={isLoading}
        haulExclusions={haulExclusions}
        onClearHaulExclusions={onClearHaulExclusions}
        onExcludeLocation={onExcludeLocation}
        readOnly={readOnly}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "buy") {
    return (
      <SimulationBuyTab
        result={result}
        marketBuyOrderQuantities={marketBuyOrderQuantities}
        directStockpileItemTypeIds={directStockpileItemTypeIds}
        overOrderPercent={overOrderPercent}
        onOverOrderPercentChange={onOverOrderPercentChange}
        roundUpQuantities={roundUpQuantities}
        onRoundUpQuantitiesChange={onRoundUpQuantitiesChange}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  return (
    <SimulationSkillsTab
      result={result}
      characterNamesById={characterNamesById}
      characterStatuses={characterStatuses}
    />
  );
}
