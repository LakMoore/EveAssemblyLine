"use client";

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AlertTriangle,
  Atom,
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
import SimulationJobInputsResponsive from "@/components/SimulationJobInputsResponsive";
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
import { fetchTypeMetadata } from "@/lib/reference/types";
import {
  groupSimulationActivityJobs,
  type SimulationIndustryJobGroup,
} from "@/lib/planning/simulator/presentation";
import { AssemblyLineGroups } from "@/lib/reference/assemblyLineGroups";
import {
  convertSimulationTargetTime,
  getSimulationMinimumRunsPerInstall,
  getSimulationInstallableRuns,
  solveSimulationActivity,
  splitSimulationRuns,
  type ClientSimulationInstall,
  type ClientSimulationScheduleOptions,
  type ClientSimulationSolveMode,
  type ClientSimulationSlotGroup,
  type ClientSimulationSchedule,
} from "@/lib/planning/simulator/clientScheduler";
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
  SimulationResultV1,
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
function updateSimulationTabInUrl(tab: SimulationTab): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(simulationTabParam, tab);
  window.history.replaceState(null, "", url);
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
  imageVariation?: "icon" | "bp" | "bpc";
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
  result: SimulationResultV1 | null,
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

/** Calculates the total future material supply shown in a simulator balance row. */
function futureSupply(item: SimulationMaterialBalance): number {
  return (
    item.availableFromHauling
    + item.availableFromProduction
    + item.availableFromCopying
    + item.availableFromInvention
    + item.availableFromReprocessing
    + item.availableFromMarket
  );
}

type FutureSupplySource = {
  key: string;
  label: string;
  quantity: number;
  source: "haul" | "industry" | "copying" | "invention" | "reprocessing" | "market";
  Icon: LucideIcon;
};

/** Returns the non-empty source contributions shown beside a future supply total. */
function futureSupplySources(item: SimulationMaterialBalance): FutureSupplySource[] {
  const sources: FutureSupplySource[] = [
    {
      key: "hauling",
      label: "Haul",
      quantity: item.availableFromHauling,
      source: "haul",
      Icon: Truck,
    },
    {
      key: "production",
      label: "Produce",
      quantity: item.availableFromProduction,
      source: "industry",
      Icon: Factory,
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

/** Formats a covered-run ratio for the activity summary. */
function simulationCoverage(coveredRuns: number, totalRuns: number): string {
  return totalRuns > 0 ? `${((coveredRuns / totalRuns) * 100).toFixed(1)}%` : "0.0%";
}

type SimulationActivitySlotCharacter = {
  characterId: number;
  name: string;
  availableSlots: number;
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
        ? [{ characterId: character.characterId, name, availableSlots }]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

type SimulationBlueprintCounts = {
  owned: number;
  available: number;
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

/** Converts one server-planned install to the client dialog's display shape. */
function serverInstallDetail(
  install: SimulationIndustryJob["installs"][number],
): ClientSimulationInstall {
  return {
    installId: install.installId,
    runs: install.runs,
    durationSeconds: install.durationSeconds,
    characterId: install.characterId,
    slotIndex: install.slotIndex,
  };
}

/** Returns all install rows that should be visible for one grouped simulator job. */
function displayInstallsForEntry(
  entry: SimulationInstallPlanEntry,
  activityLabel: "reaction" | "manufacturing",
): Array<{ install: ClientSimulationInstall; trackCompletion: boolean }> {
  const clientInstalls = entry.schedule?.installs ?? [];
  if (clientInstalls.length > 0) {
    return clientInstalls.map((install) => ({ install, trackCompletion: true }));
  }
  if (activityLabel === "reaction") return [];
  if (entry.job.installs.length > 0) {
    return entry.job.installs.map((install) => ({
      install: serverInstallDetail(install),
      trackCompletion: false,
    }));
  }
  return [
    {
      install: {
        installId: `planned-install:${entry.job.jobId}`,
        runs: entry.job.requiredRuns,
        durationSeconds: entry.job.requiredRuns * entry.job.durationPerRunSeconds,
      },
      trackCompletion: false,
    },
  ];
}

/** Renders the install plan for one or more simulator activity rows. */
function SimulationInstallPlanDialog({
  entries,
  activityLabel,
  solveMode,
  scheduleOptions,
  characterNamesById,
  onOpenPlan,
  readOnly,
}: {
  entries: readonly SimulationInstallPlanEntry[];
  activityLabel: "reaction" | "manufacturing";
  solveMode: ClientSimulationSolveMode;
  scheduleOptions: ClientSimulationScheduleOptions;
  characterNamesById: ReadonlyMap<number, string>;
  onOpenPlan: () => void;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SimulationInstallPlanView>("compact");
  const installDetails = entries.flatMap((entry) => {
    const displayInstalls = displayInstallsForEntry(entry, activityLabel);
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
  const compactGroups = compactInstallGroups(
    installDetails,
    activityLabel === "reaction" && solveMode !== "available-slots",
    scheduleOptions,
  );
  const detailedInstallDetails = detailedInstallDetailsFromGroups(compactGroups);
  const installableRuns = entries.reduce((total, entry) => total + entry.job.readyNowRuns, 0);
  const totalRuns = entries.reduce((total, entry) => total + entry.job.requiredRuns, 0);
  const allocatedSlots = installDetails.filter(
    ({ install }) => install.characterId !== undefined && install.slotIndex !== undefined,
  ).length;
  const blueprintCounts = entries.reduce(
    (counts, entry) => ({
      owned: counts.owned + entry.blueprintCounts.owned,
      available: counts.available + entry.blueprintCounts.available,
    }),
    { owned: 0, available: 0 },
  );
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
              </small>
            </div>
            <div className="flex flex-col">
              <strong>{totalRuns.toLocaleString()}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">Total runs</small>
            </div>
            <div className="flex flex-col">
              <strong>{allocatedSlots.toLocaleString()}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">Slots allocated</small>
            </div>
            <div className="flex flex-col">
              <strong>
                {blueprintCounts.owned.toLocaleString()} /{" "}
                {blueprintCounts.available.toLocaleString()}
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
                    suffix={` run${install.runs === 1 ? "" : "s"}`}
                    copyLabel={`Install run${install.runs === 1 ? "" : "s"}`}
                  />
                </SwitchedResultRow>
              );
            })
          : compactGroups.map((group) => {
              const firstDetail = group.installs[0];
              const blueprintTypeIds = [
                ...new Set(
                  group.installs.map((detail) => detail.entry.job.blueprint.blueprintTypeId),
                ),
              ];
              const blueprintLabel =
                blueprintTypeIds.length === 1 ? `BP ${blueprintTypeIds[0]}` : "Multiple blueprints";
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
                  subline={`${blueprintLabel} · ${group.displayInstallCount} install${group.displayInstallCount === 1 ? "" : "s"} grouped by runs per install`}
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
                  <CopyableNumber
                    value={group.runs}
                    suffix={` run${group.runs === 1 ? "" : "s"} each`}
                    copyLabel="Runs per install"
                  />
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

/** Selects blueprint artwork for blueprint-named balances in the plan ledger. */
function materialImageVariation(typeName: string): "icon" | "bp" {
  return /\bblueprint$/i.test(typeName) ? "bp" : "icon";
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
              {groupHeader}
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

/** Renders the grouped material ledger for Plan or Surplus. */
function SimulationMaterialsTab({
  tab,
  buckets,
  reactionFormulaBuckets,
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
          item.availableNow.toLocaleString(),
          item.requiredNow.toLocaleString(),
          futureSupply(item).toLocaleString(),
          item.reserved.toLocaleString(),
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
        <SimulationLocationResultGroups
          tab={tab}
          items={filteredItems}
          locationNamesById={locationNamesById}
          openGroups={openGroups}
          onOpenGroupChange={onOpenGroupChange}
          getRowKey={(item) => `${tab}:${item.locationId}:${item.typeId}`}
          getAvatar={(item) => ({ typeId: item.typeId, name: item.typeName })}
          groupHeader={<MaterialBalanceHeader />}
          renderRow={(item) => {
            const rowKey = `${tab}:${item.locationId}:${item.typeId}`;
            return (
              <SimpleResultRow
                name={item.typeName}
                typeId={item.typeId}
                subline={demandStockpiles(item, stockpileNamesById)}
                linkPath="assets"
                selected={controls.selectedRowKey === rowKey}
                onClick={() => controls.onSelectRow(rowKey)}
                variation={materialImageVariation(item.typeName)}
                wideBreakpoint="md"
                contentClassName="self-end text-right font-mono text-xs md:w-full md:self-auto"
              >
                <div className="flex w-full min-w-0 items-center justify-end gap-1">
                  {tab === "plan" && item.demandSources.length > 0 ? (
                    <SimulationDemandSourcesDrawer
                      item={item}
                      demandTypeNamesById={demandTypeNamesById}
                      locationLabel={locationName(locationNamesById, item.locationId)}
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
            );
          }}
        />
      )}
      {filteredReactionFormulaItems.length > 0 && (
        <section className="mb-4 flex min-w-0 flex-col gap-2">
          <h2 className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Reaction formulas
          </h2>
          <SimulationLocationResultGroups
            tab={tab}
            items={filteredReactionFormulaItems}
            groupKeyPrefix="reaction-formula"
            locationNamesById={locationNamesById}
            openGroups={openGroups}
            onOpenGroupChange={onOpenGroupChange}
            getRowKey={(item) => `reaction-formula:${item.locationId}:${item.typeId}`}
            getAvatar={(item) => ({
              typeId: item.typeId,
              name: item.typeName,
              imageVariation: "bpc",
            })}
            groupHeader={<ReactionFormulaBalanceHeader />}
            renderRow={(item) => <SimulationReactionFormulaRow item={item} controls={controls} />}
          />
        </section>
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
      variation="bpc"
      wideBreakpoint="md"
      summary={
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(5rem,auto)] gap-x-3 gap-y-1 text-right md:grid-cols-4 md:gap-x-3">
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
function ReactionFormulaBalanceHeader() {
  return (
    <div className="sticky top-0 z-10 hidden min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-[13px] bg-card p-2 shadow-[0_1px_0_var(--border)] md:grid">
      <span aria-hidden="true" />
      <div className="grid min-w-0 grid-cols-4 gap-x-3 text-right font-mono text-[10px] text-muted-foreground uppercase">
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
  demandTypeNamesById,
  locationLabel,
  onSelectSimulationTab,
}: {
  item: SimulationMaterialBalance;
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
  const marketBuyOrderQuantity = marketBuyOrderQuantities?.[String(item.typeId)] ?? 0;
  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(5rem,auto)] gap-x-3 gap-y-1 text-right md:grid-cols-6 md:gap-x-3">
      <span className="text-muted-foreground md:hidden">Available</span>
      <span className="flex items-center justify-end gap-2">
        <MarketBuyOrderIndicator quantity={marketBuyOrderQuantity} />
        <CopyableNumber value={item.availableNow} copyLabel="Available quantity" />
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
          {supplySources.map(({ key, label, quantity, source, Icon }) => (
            <Tooltip key={key}>
              <TooltipTrigger
                render={
                  <span
                    aria-label={`${label}: ${quantity.toLocaleString()}`}
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
                {label}: {quantity.toLocaleString()}
              </TooltipContent>
            </Tooltip>
          ))}
        </span>
        <span className="shrink-0">
          <CopyableNumber value={futureSupply(item)} copyLabel="Future supply" />
        </span>
      </span>
      <span className="text-muted-foreground md:hidden">Future Demand</span>
      <span>
        <CopyableNumber value={item.reserved} copyLabel="Future demand" />
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
function MaterialBalanceHeader() {
  return (
    <div className="sticky top-0 z-10 hidden min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-[13px] bg-card p-2 shadow-[0_1px_0_var(--border)] md:grid">
      <span aria-hidden="true" />
      <div className="flex min-w-0 items-center justify-end gap-1">
        <span className="size-6 shrink-0" aria-hidden="true" />
        <div className="grid min-w-0 flex-1 grid-cols-6 gap-x-3 text-right font-mono text-[10px] text-muted-foreground uppercase">
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
  const blueprintNamesById = useSimulationTypeNames(jobs.map((job) => job.outputBlueprintTypeId));
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="invent"
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({
          typeId: job.outputBlueprintTypeId,
          name:
            blueprintNamesById.get(job.outputBlueprintTypeId)
            ?? `Blueprint ${job.outputBlueprintTypeId}`,
          imageVariation: "bpc",
        })}
        renderRow={(job) => (
          <SimulationSimpleJobRow
            rowKey={`invent:${job.jobId}`}
            typeId={job.outputBlueprintTypeId}
            name={
              blueprintNamesById.get(job.outputBlueprintTypeId)
              ?? `Blueprint ${job.outputBlueprintTypeId}`
            }
            subline={
              <CopyableNumber
                value={Math.round(job.successProbability * 100)}
                suffix="% success probability"
                copyLabel="Success probability"
              />
            }
            summary={
              <CopyableNumber value={job.attempts} suffix=" attempts" copyLabel="Attempts" />
            }
            variation="bpc"
            controls={controls}
          />
        )}
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
  showCheckbox = false,
  controls,
}: {
  rowKey: string;
  typeId: number;
  name: string;
  subline?: ReactNode;
  summary: ReactNode;
  variation?: "icon" | "bp" | "bpc";
  wideBreakpoint?: "sm" | "md";
  showCheckbox?: boolean;
  controls: SimulationRowControls;
}) {
  const rowProps = {
    name,
    typeId,
    subline,
    variation,
    linkPath: "planner" as const,
    linkIcon: ClipboardList,
    linkSearchParams: { simulationTab: "plan" },
    linkHash: "plan-breakdown",
    navigateInPlace: true,
    onNavigate: controls.onOpenPlan,
    wideBreakpoint,
    selected: controls.selectedRowKey === rowKey,
    onClick: () => controls.onSelectRow(rowKey),
    contentClassName: "self-end text-right font-mono text-xs sm:self-auto",
  };
  const checkboxChecked = showCheckbox && controls.isCompleted(rowKey);

  return showCheckbox ? (
    <SwitchedResultRow
      {...rowProps}
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

type SimulationBuyEntry = {
  purchase: SimulationPurchase;
  isMaterial: boolean;
};

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
  simulationInputRevision,
  stock,
  locationNamesById,
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
  simulationInputRevision: string;
  stock: readonly PlanStockItem[];
  locationNamesById: ReadonlyMap<number, string>;
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
  const [solveMode, setSolveMode] = useState<ClientSimulationSolveMode>("available-slots");
  const [targetTime, setTargetTime] = useState("24");
  const [protectReactionMaterialBonus, setProtectReactionMaterialBonus] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [groupCopyStatus, setGroupCopyStatus] = useState<SimulationGroupCopyStatus>(null);
  const slotCharacters = simulationSlotCharacters(
    characterStatuses,
    characterNamesById,
    slotUsage,
    tab,
  );
  const availableSlots = slotCharacters.reduce(
    (total, character) => total + character.availableSlots,
    0,
  );
  const effectiveSolveMode = tab === "react" ? solveMode : "available-slots";
  const baseScheduleRevision = [
    simulationInputRevision,
    effectiveSolveMode,
    targetTime,
    protectReactionMaterialBonus,
    availableSlots,
    ...slotCharacters.map(
      ({ characterId, availableSlots: characterSlots }) => `${characterId}:${characterSlots}`,
    ),
    ...jobs
      .filter((job) => controls.isIncluded(`${tab}:${job.jobId}`))
      .map((job) => job.jobId)
      .sort(),
    ...[...reactionMaterialBonusesByLocation.entries()]
      .sort(([left], [right]) => left - right)
      .map(([locationId, bonus]) => `${locationId}:${bonus}`),
  ].join("|");
  const activeJobs = jobs.filter(
    (job) => !controls.isCompleted(`${tab}:${job.jobId}`, baseScheduleRevision, true),
  );
  const scheduleRevision = [
    baseScheduleRevision,
    ...activeJobs.map((job) => job.jobId).sort(),
  ].join("|");
  const enabledJobIds = new Set(
    activeJobs.filter((job) => controls.isIncluded(`${tab}:${job.jobId}`)).map((job) => job.jobId),
  );
  const schedules = solveSimulationActivity(
    jobs,
    availableSlots,
    effectiveSolveMode,
    Number(targetTime),
    enabledJobIds,
    slotCharacters.map(
      ({ characterId, availableSlots }): ClientSimulationSlotGroup => ({
        characterId,
        availableSlots,
      }),
    ),
    {
      protectReactionMaterialBonus: tab === "react" && protectReactionMaterialBonus,
      reactionMaterialBonusesByLocation,
    },
  );
  const scheduledRuns = activeJobs.reduce(
    (total, job) => total + (schedules.get(job.jobId)?.runs ?? 0),
    0,
  );
  const installableRuns = activeJobs.reduce(
    (total, job) => total + getSimulationInstallableRuns(job),
    0,
  );
  const totalRuns = activeJobs.reduce((total, job) => total + job.requiredRuns, 0);
  const suggestedInstalls = activeJobs.reduce(
    (total, job) => total + (schedules.get(job.jobId)?.installs.length ?? 0),
    0,
  );
  const maxJobLength = Math.max(
    ...activeJobs.map((job) => schedules.get(job.jobId)?.timeSeconds ?? 0),
    0,
  );
  const presentationGroups: SimulationIndustryJobGroup[] = groupSimulationActivityJobs(jobs);
  const activeJobIds = new Set(activeJobs.map((job) => job.jobId));

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
      solveMode !== "available-slots"
      && nextMode !== "available-slots"
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
                      {solveMode === "available-slots"
                        ? "available slots"
                        : solveMode === "run-time-hours"
                          ? "run time (hours)"
                          : "run time (days)"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available-slots">available slots</SelectItem>
                    <SelectItem value="run-time-hours">run time (hours)</SelectItem>
                    <SelectItem value="run-time-days">run time (days)</SelectItem>
                  </SelectContent>
                </Select>
                {solveMode !== "available-slots" && (
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
              onClick={() => void copyEntries(activeJobs, "list")}
            >
              <CopyIcon aria-hidden="true" />
              {copyStatus || "Copy list"}
            </Button>
          </div>
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
                      aria-label={`View characters with available ${activityLabel} slots`}
                      title={`View characters with available ${activityLabel} slots`}
                    >
                      <UsersRound aria-hidden="true" />
                    </Button>
                  }
                  title={`${activityLabel[0].toUpperCase()}${activityLabel.slice(1)} slots by character`}
                  description={`Characters with available ${activityLabel} slots.`}
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
              <small className="text-[10px] text-muted-foreground uppercase">Available slots</small>
            </span>
            <span className="flex flex-col">
              <strong className="text-sm">{suggestedInstalls.toLocaleString()}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">
                Suggested installs
              </small>
            </span>
            <span className="flex flex-col">
              <strong className="text-sm">{simulationDuration(maxJobLength)}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">Max job length</small>
            </span>
            <span className="flex flex-col">
              <strong className="text-sm">
                {simulationCoverage(scheduledRuns, installableRuns)}
              </strong>
              <small className="text-[10px] text-muted-foreground uppercase">
                Installable coverage
              </small>
            </span>
            <span className="flex flex-col">
              <strong className="text-sm">{simulationCoverage(scheduledRuns, totalRuns)}</strong>
              <small className="text-[10px] text-muted-foreground uppercase">Total coverage</small>
            </span>
          </div>
        </div>
      }
    >
      <SimulationLocationResultGroups
        tab={tab}
        items={presentationGroups}
        locationNamesById={locationNamesById}
        reactionMaterialBonusesByLocation={
          tab === "react" ? reactionMaterialBonusesByLocation : undefined
        }
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(group) => group.groupKey}
        getGroupAction={(locationId, groupItems) => ({
          onCopyGroup: () =>
            void copyEntries(
              groupItems.flatMap((group) =>
                group.jobs.filter((job) => activeJobIds.has(job.jobId)),
              ),
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
            const active = activeJobIds.has(job.jobId);
            const generatedScheduleIdentity = simulationInstallScheduleIdentity(
              scheduleRevision,
              generatedSchedule?.installs ?? [],
            );
            const jobScheduleRevision = active ? scheduleRevision : baseScheduleRevision;
            const scheduleIdentity = active
              ? generatedScheduleIdentity
              : simulationInstallScheduleIdentity(
                  baseScheduleRevision,
                  generatedSchedule?.installs ?? [],
                );
            const completedSchedule = controls.getCompletedSchedule(
              rowKey,
              active ? generatedScheduleIdentity : baseScheduleRevision,
              !active,
            );
            const schedule =
              generatedSchedule && generatedSchedule.installs.length > 0
                ? generatedSchedule
                : completedSchedule;
            const included = controls.isIncluded(rowKey);
            const installableRuns = schedule?.runs ?? 0;
            const installedRuns = controls.getInstalledRuns(
              rowKey,
              active ? generatedScheduleIdentity : baseScheduleRevision,
              !active,
            );
            const completed = controls.isCompleted(
              rowKey,
              active ? generatedScheduleIdentity : baseScheduleRevision,
              !active,
            );
            const completedInstallIds = controls.getCompletedInstallIds(
              rowKey,
              active ? generatedScheduleIdentity : baseScheduleRevision,
              !active,
            );
            return {
              job,
              rowKey,
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
          const groupInstallableRuns = groupEntries.reduce(
            (total, entry) => total + entry.installableRuns,
            0,
          );
          const groupInstalledRuns = groupEntries.reduce(
            (total, entry) => total + entry.installedRuns,
            0,
          );
          const groupCompleted =
            groupEntries.length > 0 && groupEntries.every((entry) => entry.completed);
          const groupPartiallyInstalled = groupInstalledRuns > 0 && !groupCompleted;
          const groupIncluded = groupEntries.every((entry) => entry.included);
          const updateGroupCompletion = (checked: boolean) => {
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
              onNavigate={controls.onOpenPlan}
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
              contentClassName={cn(
                "grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3 self-end text-right font-mono text-xs",
                "lg:w-auto lg:grid-cols-[3rem_9rem_minmax(11rem,max-content)] lg:justify-end lg:gap-x-5 lg:self-auto",
              )}
            >
              <span className="flex items-center justify-self-start">
                <SimulationInstallPlanDialog
                  entries={installPlanEntries}
                  activityLabel={activityLabel}
                  solveMode={solveMode}
                  scheduleOptions={{
                    protectReactionMaterialBonus: tab === "react" && protectReactionMaterialBonus,
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
                  value={group.quantities.installableRuns}
                  suffix=" / "
                  copyLabel="Installable runs"
                />
                <CopyableNumber
                  value={group.quantities.totalRuns}
                  suffix=" runs"
                  copyLabel="Total runs"
                />
              </span>
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
                      const destinationIncluded =
                        includedTaskCount > sortedDestinationTasks.length / 2;
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
      onNavigate={controls.onOpenPlan}
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
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  result: SimulationResultV1;
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const entries: SimulationBuyEntry[] = [
    ...result.lists.materialsToBuy.map((purchase) => ({ purchase, isMaterial: true })),
    ...result.lists.bpoToBuy.map((purchase) => ({ purchase, isMaterial: false })),
  ];
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
          <div className="flex justify-end">
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
                imageVariation: entry.isMaterial ? "icon" : "bp",
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
                        variation={isMaterial ? "icon" : "bp"}
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
  controls,
}: {
  result: SimulationResultV1;
  controls: SimulationRowControls;
}) {
  return (
    <SimulationResultsTab hasResults={result.lists.skillsRequired.length > 0}>
      <div className="flex min-w-0 flex-col">
        {result.lists.skillsRequired.map((skill) => (
          <SimulationSimpleJobRow
            key={skill.skillId}
            rowKey={`skills:${skill.skillId}`}
            typeId={skill.skillId}
            name={skill.name}
            subline={<CopyableNumber value={skill.jobIds.length} suffix=" jobs" copyLabel="Jobs" />}
            summary={
              <CopyableNumber
                value={skill.requiredLevel}
                suffix=" required level"
                copyLabel="Required skill level"
              />
            }
            controls={controls}
          />
        ))}
      </div>
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
  result: SimulationResultV1;
  locationNamesById: ReadonlyMap<number, string>;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const warningsByLocation = new Map<number | undefined, SimulationResultV1["lists"]["warnings"]>();
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
  status,
  stock,
  marketBuyOrderQuantities,
  locationNamesById,
  stockpileLocations,
  reactionMaterialBonusesByLocation,
  characterNamesById,
  characterStatuses,
  slotUsage,
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
  result: SimulationResultV1 | null;
  status: string;
  stock: readonly PlanStockItem[];
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  locationNamesById: ReadonlyMap<number, string>;
  stockpileLocations: ReadonlySet<number>;
  reactionMaterialBonusesByLocation: ReadonlyMap<number, number>;
  characterNamesById: ReadonlyMap<number, string>;
  characterStatuses: readonly ClientCharacterStatus[];
  slotUsage: ClientJobsResponse["slotUsage"];
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
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [includedRows, setIncludedRows] = useState<Record<string, boolean>>({});
  const [localPreservedHaulTasks, setLocalPreservedHaulTasks] = useState<
    Record<string, SimulationHaulTask>
  >({});
  const [completionByRow, setCompletionByRow] = useState<
    Partial<Record<string, SimulationCompletionState>>
  >({});
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const isMobile = useIsMobileSimulationView();
  const statusIsError = status.startsWith("Error:");
  const hasSurplusTab = result?.lists.surplusItems !== undefined;
  const selectedTab = !hasSurplusTab && activeTab === "surplus" ? "warnings" : activeTab;
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
    onOpenBuy: () => selectTab("buy"),
  };
  const onOpenGroupChange = (groupKey: string, open: boolean) =>
    setOpenGroups((current) => ({ ...current, [groupKey]: open }));

  function selectTab(value: string) {
    if (!isSimulationTab(value) || (value === "surplus" && !hasSurplusTab)) return;
    setActiveTab(value);
    if (usePlannerUrlState) updateSimulationTabInUrl(value);
  }

  useEffect(() => {
    if (!usePlannerUrlState) return;
    const applyUrlState = () => {
      const requestedTab = readSimulationTabFromUrl();
      const nextTab = requestedTab === "surplus" && !hasSurplusTab ? "warnings" : requestedTab;
      setActiveTab(nextTab);
      if (new URLSearchParams(window.location.search).get(simulationTabParam) !== nextTab) {
        updateSimulationTabInUrl(nextTab);
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
      haulTasks={visibleHaulTasks}
      stock={stock}
      marketBuyOrderQuantities={marketBuyOrderQuantities}
      locationNamesById={locationNamesById}
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
  haulTasks,
  stock,
  marketBuyOrderQuantities,
  locationNamesById,
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
  result: SimulationResultV1;
  haulTasks: readonly SimulationHaulTask[];
  stock: readonly PlanStockItem[];
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  locationNamesById: ReadonlyMap<number, string>;
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
        simulationInputRevision={`${result.metadata.normalizedInputHash}|${result.metadata.sdeRevision}`}
        stock={stock}
        locationNamesById={locationNamesById}
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
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  return <SimulationSkillsTab result={result} controls={controls} />;
}
