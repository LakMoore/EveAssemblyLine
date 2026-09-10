"use client";

import Image from "next/image";
import { Fragment, Suspense, type RefObject, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  ClientPlanStockpile,
  ResponseLocationBucket,
  PlanResponse,
  PlanSourceCounts,
  PlanSourceCountsByLocation,
  PlanSourceIcon,
  PlanStockItem,
  HaulPatch,
  ResponsePlanItem,
  ResponseHaulTask,
  ResponseMaterialBuy,
  ResponseBlueprintBuy,
} from "@/lib/planning/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import type { ClientCharacterStatus, ClientJobsResponse } from "@/lib/client/requestCache";
import { loadCompressSettings, saveCompressSettings } from "@/lib/planning/compressSettingsStore";
import {
  createHaulItemExclusionKey,
  parseHaulItemExclusionKey,
  splitReactionRunAllocations,
  splitReactionJobInputs,
  type HaulItemExclusion,
} from "@/lib/planning/planView";
import { isHaulTaskPatched } from "@/lib/planning/haulPatches";
import CopyableText from "@/components/CopyableText";
import JobInputsResponsive, {
  getJobInputsCompletionPercent,
} from "@/components/JobInputsResponsive";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  eveCharacterPortraitUrl,
  eveCorporationLogoUrl,
  eveTypeImageUrl,
} from "@/lib/eve/imageServer";
import styles from "@/app/page.module.css";
import {
  ArrowDown,
  ArrowUp,
  Atom,
  Brain,
  Bug,
  ChartLine,
  Check,
  ChevronDown,
  ClipboardList,
  Copy as CopyIcon,
  ChevronsDownUp,
  ChevronsUpDown,
  Factory,
  Minimize2,
  Microscope,
  SquareX,
  TestTubes,
  ShoppingCart,
  Truck,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";

export type PlannerTab =
  | "Plan"
  | "Haul"
  | "Buy"
  | "Reprocess"
  | "Copy"
  | "Invent"
  | "React"
  | "Manufacture"
  | "Skills";

const tabs: { value: PlannerTab; icon: LucideIcon }[] = [
  { value: "Plan", icon: ClipboardList },
  { value: "Haul", icon: Truck },
  { value: "Buy", icon: ShoppingCart },
  { value: "Reprocess", icon: Minimize2 },
  { value: "Copy", icon: TestTubes },
  { value: "Invent", icon: Microscope },
  { value: "React", icon: Atom },
  { value: "Manufacture", icon: Factory },
  { value: "Skills", icon: Brain },
];

const plannerTabParam = "tab";
const plannerTypeIdParam = "typeId";

function isPlannerTab(value: string | null): value is PlannerTab {
  return tabs.some((tab) => tab.value === value);
}

function parsePlannerTypeId(value: string | null) {
  const typeId = Number(value);
  return Number.isSafeInteger(typeId) && typeId > 0 ? typeId : null;
}

type ReactionScheduleMode = "available-slots" | "max-job-length";
type ReactionSchedule = {
  installs: number;
  runs: number;
  totalRuns: number;
  time: number;
  availableBlueprints: number;
};
type ReactionCoverage = { installable: number; total: number };
type ReactionSortKey = "type" | "inputs" | "suggestedRuns" | "totalNeeded";
type ReactionSort = { key: ReactionSortKey; direction: "asc" | "desc" };
type ManufacturingSort = { key: "type" | "inputs" | "runs"; direction: "asc" | "desc" };
type PlanViewMode = "all" | "build-location";
type ResponseReactionJob = PlanResponse["lists"]["reactionJobs"][number]["items"][number] & {
  locationId?: number;
};
type ResponseManufacturingJob =
  PlanResponse["lists"]["manufacturingJobs"][number]["items"][number] & { locationId?: number };
type ResponseReprocessingJob =
  PlanResponse["lists"]["reprocessingJobs"][number]["items"][number] & { locationId?: number };
type ResultsLocations = {
  manufacturing: number;
  reactions: number;
  reprocessing?: number;
  copying?: number;
  invention?: number;
};

type PlanBuyEntry = ResponseMaterialBuy | ResponseBlueprintBuy;

function isMultibuyMaterial(entry: PlanBuyEntry): boolean {
  return "typeName" in entry && !("bpoCount" in entry);
}

function getEntryName(entry: { name?: string; typeName?: string }) {
  return entry.typeName ?? entry.name ?? "";
}

function reactionJobKey(job: { typeId: number; locationId?: number }) {
  return `${job.locationId ?? "unlocated"}:${job.typeId}`;
}

/** Counts unused reaction formulas available at the job's reaction location. */
function getReactionFormulaCount(entry: ResponseReactionJob, stock: PlanStockItem[]): number {
  if (entry.locationId === undefined) {
    return 0;
  }
  return stock
    .filter(
      (stockItem) =>
        stockItem.category === "reactionformula"
        && stockItem.typeId === entry.typeId
        && !stockItem.inUse
        && getStockLocationId(stockItem) === entry.locationId,
    )
    .reduce((total, stockItem) => total + stockItem.quantity, 0);
}

/** Summarizes owned and currently used reaction formulas for a type. */
function getReactionFormulaSummary(typeId: number, stock: PlanStockItem[]) {
  const formulaStock = stock.filter(
    (stockItem) => stockItem.category === "reactionformula" && stockItem.typeId === typeId,
  );
  return {
    owned: formulaStock.reduce((total, stockItem) => total + stockItem.quantity, 0),
    inUse: formulaStock
      .filter((stockItem) => stockItem.inUse)
      .reduce((total, stockItem) => total + stockItem.quantity, 0),
  };
}

/** Calculates the readiness percentage used to sort a reaction job. */
function getReactionInputsCompletionPercent(entry: ResponseReactionJob): number {
  return getJobInputsCompletionPercent(entry.inputs);
}

function getStockLocationId(item: PlanStockItem) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

type PublicHaulTask = ResponseHaulTask;

function haulTaskKey(task: PublicHaulTask) {
  if ("exclusionKey" in task && typeof task.exclusionKey === "string") {
    return task.exclusionKey;
  }
  return createHaulItemExclusionKey(task.fromLocationId, task.typeId, task.ownerType, task.ownerId);
}
function flattenHaulBuckets(buckets: PlanResponse["lists"]["haulingTasks"]): PublicHaulTask[] {
  return buckets.flatMap((bucket) =>
    bucket.items.map((item) => ({
      ...item,
      fromLocationId: bucket.fromLocationId,
      toLocationId: bucket.toLocationId,
      ...(bucket.ownerType ? { ownerType: bucket.ownerType } : {}),
      ...(bucket.ownerId !== undefined ? { ownerId: bucket.ownerId } : {}),
    })),
  );
}

function flattenLocationBuckets<T>(
  buckets: ResponseLocationBucket<T>[],
  field: "activityLocationId" | "locationId",
): Array<T & { activityLocationId?: number; locationId?: number }> {
  return buckets.flatMap((bucket) =>
    bucket.items.map((item) => ({
      ...item,
      ...(bucket.locationId !== undefined ? { [field]: bucket.locationId } : {}),
    })),
  ) as Array<T & { activityLocationId?: number; locationId?: number }>;
}

type HaulStockItem = PlanStockItem & {
  assembledVolume?: number;
  packagedVolume?: number;
};

type DisplayHaulTask = PublicHaulTask & {
  completed?: boolean;
  exclusionKey?: string;
};

function haulTaskRenderKey(task: DisplayHaulTask) {
  return `${task.fromLocationId}:${task.toLocationId}:${task.typeId}:${task.ownerType ?? "unassigned"}:${task.ownerId ?? 0}:${task.completed ? "completed" : "pending"}`;
}

function getHaulGroupVolume(tasks: DisplayHaulTask[]) {
  return Math.ceil(tasks.reduce((total, task) => total + task.neededQuantity * task.unitVolume, 0));
}

function getHaulTasksWithExclusions(
  tasks: PublicHaulTask[],
  stock: HaulStockItem[],
  exclusions: HaulItemExclusion,
): DisplayHaulTask[] {
  const tasksByKey = new Map(tasks.map((task) => [haulTaskKey(task), task]));
  const displayedTasks: DisplayHaulTask[] = tasks.filter(
    (task) => !exclusions.has(haulTaskKey(task)),
  );
  for (const [key, destinationLocationId] of exclusions) {
    const parsedKey = parseHaulItemExclusionKey(key);
    if (!parsedKey) continue;
    const exclusion = destinationLocationId;
    const existingTask = tasksByKey.get(key);
    if (existingTask) {
      displayedTasks.push({
        ...existingTask,
        toLocationId: exclusion.destinationLocationId,
        neededQuantity: exclusion.neededQuantity,
        exclusionKey: key,
        ...(exclusion.ownerType ? { ownerType: exclusion.ownerType } : {}),
        ...(exclusion.ownerId !== undefined ? { ownerId: exclusion.ownerId } : {}),
      });
      continue;
    }
    const matchingStockItems = stock.filter(
      (item) =>
        item.rootLocationId === parsedKey.sourceRootLocationId
        && item.typeId === parsedKey.itemTypeId
        && item.category !== "blueprint"
        && item.category !== "reactionformula"
        && (
          parsedKey.ownerType === undefined
          || (item.ownerType === parsedKey.ownerType && item.ownerId === parsedKey.ownerId)
        ),
    );
    const stockItem = matchingStockItems.at(0);
    const quantity = matchingStockItems.reduce((total, item) => total + item.quantity, 0);
    const volume = matchingStockItems.reduce(
      (total, item) => {
        const unitVolume = item.isPackaged
          ? (item.packagedVolume ?? item.assembledVolume ?? 0)
          : (item.assembledVolume ?? 0);
        return total + item.quantity * unitVolume;
      },
      0,
    );
    const owner =
      exclusion.ownerType && exclusion.ownerId !== undefined
        ? { ownerType: exclusion.ownerType, ownerId: exclusion.ownerId }
        : {};
    displayedTasks.push({
      typeId: parsedKey.itemTypeId,
      typeName: stockItem?.name ?? `Type ${parsedKey.itemTypeId}`,
      unitVolume: quantity > 0 ? volume / quantity : 0,
      neededQuantity: exclusion.neededQuantity,
      fromLocationId: parsedKey.sourceRootLocationId,
      toLocationId: exclusion.destinationLocationId,
      exclusionKey: key,
      ...owner,
    });
  }
  return displayedTasks;
}

/** Restores completed haul rows from persisted patches when recalculation removes them. */
function getHaulTasksWithPatches(
  tasks: PublicHaulTask[],
  patches: ReadonlyMap<string, HaulPatch>,
): DisplayHaulTask[] {
  const displayedTasks: DisplayHaulTask[] = [...tasks];
  const liveTaskKeys = new Set(
    tasks.map(
      (task) =>
        `${task.fromLocationId}:${task.toLocationId}:${task.typeId}:${task.ownerType ?? "unassigned"}:${task.ownerId ?? 0}`,
    ),
  );
  const patchGroups = new Map<
    string,
    {
      fromLocationId: number;
      toLocationId: number;
      typeId: number;
      typeName: string;
      unitVolume: number;
      neededQuantity: number;
      ownerType?: "character" | "corporation";
      ownerId?: number;
    }
  >();

  for (const patch of patches.values()) {
    const routeKey = `${patch.fromLocationId}:${patch.toLocationId}:${patch.typeId}:${patch.ownerType}:${patch.ownerId}`;
    const group = patchGroups.get(routeKey) ?? {
      fromLocationId: patch.fromLocationId,
      toLocationId: patch.toLocationId,
      typeId: patch.typeId,
      typeName: patch.typeName,
      unitVolume: patch.unitVolume,
      neededQuantity: 0,
      ownerType: patch.ownerType,
      ownerId: patch.ownerId,
    };
    const totalVolume =
      group.neededQuantity * group.unitVolume + patch.neededQuantity * patch.unitVolume;
    group.neededQuantity += patch.neededQuantity;
    group.unitVolume = totalVolume / group.neededQuantity;
    patchGroups.set(routeKey, group);
  }

  for (const [routeKey, group] of patchGroups) {
    if (liveTaskKeys.has(routeKey)) continue;
    displayedTasks.push({
      ...group,
      completed: true,
    });
  }
  return displayedTasks;
}

function formatCoverage(coveredRuns: number, totalRuns: number) {
  return totalRuns > 0 ? `${((coveredRuns / totalRuns) * 100).toFixed(1)}%` : "0.0%";
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

function formatOptionalCount(count: number | undefined) {
  return count?.toLocaleString() ?? "0";
}

function getReactionScheduleRuns(schedules: ReactionSchedule[] | undefined) {
  return Math.max(...(schedules ?? []).map((schedule) => schedule.runs), 0);
}

type ActivitySlot = "Manufacturing" | "Reactions";
type ActivitySlotCharacter = {
  characterId: number;
  name: string;
  availableSlots: number;
};

function getActivitySlotCharacters(
  jobs: ClientJobsResponse | null,
  characterNamesById: Map<number, string>,
  activity: ActivitySlot,
): ActivitySlotCharacter[] {
  return Object
    .entries(jobs?.slotUsage ?? {})
    .flatMap(([characterId, usage]) => {
      const id = Number(characterId);
      const name = characterNamesById.get(id);
      const availableSlots = Math.max(0, usage.availableSlots[activity] - usage.slots[activity]);
      return name && availableSlots > 0 ? [{ characterId: id, name, availableSlots }] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function ActivitySlotCharacters({ characters }: { characters: ActivitySlotCharacter[] }) {
  return (
    <div className="flex flex-col gap-2">
      {characters.length > 0 ? (
        characters.map((character) => (
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
        <p className="py-4 text-muted-foreground">No characters have available reaction slots.</p>
      )}
    </div>
  );
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

function buildReactionSchedule(
  jobs: ResponseReactionJob[],
  stock: PlanStockItem[],
  showTotalRunCounts: boolean,
  mode: ReactionScheduleMode,
  availableReactionSlots: number,
  maxJobHours: number,
): Map<string, ReactionSchedule[]> {
  const rows = jobs.map((job) => {
    const blueprintCount = stock
      .filter(
        (item) =>
          item.category === "reactionformula"
          && item.typeId === job.typeId
          && !item.inUse
          && getStockLocationId(item) === job.locationId,
      )
      .reduce((total, item) => total + item.quantity, 0);
    const runs = showTotalRunCounts ? job.countNeeded : job.runsAvailable;
    return { job, blueprintCount, runs, maxInstalls: Math.min(blueprintCount, Math.max(0, runs)) };
  });
  const installs = new Map<string, number>();
  if (mode === "available-slots") {
    let remainingSlots = Math.max(0, availableReactionSlots);
    for (const row of rows.slice().sort((left, right) => right.runs - left.runs)) {
      if (remainingSlots <= 0) break;
      const count = Math.min(1, row.maxInstalls);
      installs.set(reactionJobKey(row.job), count);
      remainingSlots -= count;
    }
    while (remainingSlots > 0) {
      const candidates = rows
        .filter((row) => (installs.get(reactionJobKey(row.job)) ?? 0) < row.maxInstalls)
        .sort((left, right) => {
          const leftRuns = Math.ceil(
            left.runs / Math.max(1, installs.get(reactionJobKey(left.job)) ?? 0),
          );
          const rightRuns = Math.ceil(
            right.runs / Math.max(1, installs.get(reactionJobKey(right.job)) ?? 0),
          );
          return rightRuns - leftRuns || right.runs - left.runs;
        });
      if (candidates.length === 0) break;
      const candidate = candidates[0];
      const key = reactionJobKey(candidate.job);
      installs.set(key, (installs.get(key) ?? 0) + 1);
      remainingSlots -= 1;
    }
  }
  return new Map(
    rows.map(({ job, blueprintCount, runs, maxInstalls }) => {
      const perRunTime = job.countNeeded > 0 ? job.totalTime / job.countNeeded : 0;
      const timeLimitedRuns =
        maxJobHours > 0 && perRunTime > 0 ? Math.floor((maxJobHours * 3600) / perRunTime) : runs;
      const installCount =
        mode === "available-slots"
          ? (installs.get(reactionJobKey(job)) ?? 0)
          : timeLimitedRuns > 0
            ? Math.min(blueprintCount, Math.ceil(runs / timeLimitedRuns))
            : 0;
      const allocations = splitReactionRunAllocations(
        runs,
        Math.min(installCount, maxInstalls),
        blueprintCount,
      );
      return [
        reactionJobKey(job),
        allocations.map((allocation) => ({
          ...allocation,
          time: perRunTime * allocation.runs,
        })),
      ];
    }),
  );
}

function getManufacturingSummary(
  jobs: ResponseManufacturingJob[],
  availableSlots: number,
  showTotalRunCounts: boolean,
) {
  const rows = jobs.map((job) => {
    const runs = showTotalRunCounts ? job.countNeeded : job.runsAvailable;
    return {
      runs,
      time: job.countNeeded > 0 ? (job.totalTime * runs) / job.countNeeded : 0,
    };
  });
  const totalRuns = jobs.reduce((total, job) => total + job.countNeeded, 0);
  const installableRuns = jobs.reduce((total, job) => total + job.runsAvailable, 0);
  const selectedRows = rows
    .filter((row) => row.runs > 0)
    .sort((left, right) => right.runs - left.runs)
    .slice(0, Math.max(0, availableSlots));

  return {
    installs: selectedRows.length,
    maxTime: Math.max(...selectedRows.map((row) => row.time), 0),
    installableCoverage: formatCoverage(installableRuns, totalRuns),
    totalCoverage: formatCoverage(
      selectedRows.reduce((total, row) => total + row.runs, 0),
      totalRuns,
    ),
  };
}

/** Renders the planner output header, bug-report dialog, and every output tab. */
export default function PlannerResults(props: React.ComponentProps<typeof PlannerResultsContent>) {
  return (
    <Suspense fallback={null}>
      <PlannerResultsContent {...props} />
    </Suspense>
  );
}

function PlannerResultsContent({
  language,
  plan,
  planStatus,
  characterStatuses,
  characterNamesById,
  corporationNamesById,
  jobs,
  stock,
  marketBuyOrderQuantities,
  locations,
  stockpiles,
  locationOptions,
  onAddBuildItem,
  onExcludeHaulStockpile,
  haulItemExclusion,
  onToggleHaulItemExclusion,
  haulPatches,
  onToggleHaulPatches,
}: {
  language: SdeLanguage;
  plan: PlanResponse | null;
  planStatus: string;
  characterStatuses: ClientCharacterStatus[];
  characterNamesById: Map<number, string>;
  corporationNamesById: Map<number, string>;
  jobs: ClientJobsResponse | null;
  stock: PlanStockItem[];
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  locations: ResultsLocations;
  stockpiles: ClientPlanStockpile[];
  locationOptions: Array<{ locationId: number; name: string }>;
  onAddBuildItem: (item: { name: string; typeId: number; quantity: number }) => void;
  onExcludeHaulStockpile: (fromLocationId: number) => Promise<void>;
  haulItemExclusion: HaulItemExclusion;
  onToggleHaulItemExclusion: (
    key: string,
    destinationLocationId: number,
    excluded: boolean,
  ) => Promise<void>;
  haulPatches: ReadonlyMap<string, HaulPatch>;
  onToggleHaulPatches: (tasks: ResponseHaulTask[], patched: boolean) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<PlannerTab>("Plan");
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const resultsHeaderRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const applyUrlState = () => {
      const currentSearchParams = new URLSearchParams(window.location.search);
      const tab = currentSearchParams.get(plannerTabParam);
      const nextTab = isPlannerTab(tab) ? tab : "Plan";
      const nextTypeId = parsePlannerTypeId(currentSearchParams.get(plannerTypeIdParam));
      setActiveTab(nextTab);
      setSelectedTypeId(nextTypeId);
      const url = new URL(window.location.href);
      url.searchParams.set(plannerTabParam, nextTab);
      if (nextTypeId === null) url.searchParams.delete(plannerTypeIdParam);
      else url.searchParams.set(plannerTypeIdParam, String(nextTypeId));
      if (url.pathname === pathname && url.search !== window.location.search) {
        window.history.replaceState(null, "", url);
      }
    };
    applyUrlState();
    window.addEventListener("popstate", applyUrlState);
    return () => window.removeEventListener("popstate", applyUrlState);
  }, [pathname, searchParams]);

  function updatePlannerUrl(tab: PlannerTab, typeId: number | null) {
    const url = new URL(window.location.href);
    url.searchParams.set(plannerTabParam, tab);
    if (typeId === null) url.searchParams.delete(plannerTypeIdParam);
    else url.searchParams.set(plannerTypeIdParam, String(typeId));
    window.history.replaceState(null, "", url);
  }

  function selectTab(value: string) {
    if (!isPlannerTab(value)) return;
    setActiveTab(value);
    updatePlannerUrl(value, selectedTypeId);
  }

  function selectTypeId(typeId: number | null) {
    setSelectedTypeId(typeId);
    updatePlannerUrl(activeTab, typeId);
  }

  const reactionSlotCharacters = getActivitySlotCharacters(jobs, characterNamesById, "Reactions");
  const manufacturingSlotCharacters = getActivitySlotCharacters(
    jobs,
    characterNamesById,
    "Manufacturing",
  );
  const availableReactionSlots = reactionSlotCharacters.reduce(
    (total, character) => total + character.availableSlots,
    0,
  );
  const availableManufacturingSlots = manufacturingSlotCharacters.reduce(
    (total, character) => total + character.availableSlots,
    0,
  );
  const activityLocationIds = [
    ...new Set(
      [
        locations.manufacturing,
        locations.reactions,
        locations.reprocessing,
        locations.copying,
        locations.invention,
        ...stockpiles.flatMap((stockpile) => [
          stockpile.locations.manufacturing,
          stockpile.locations.reactions,
          stockpile.locations.reprocessing,
          stockpile.locations.copying,
          stockpile.locations.invention,
        ]),
      ].filter((locationId): locationId is number => locationId !== undefined),
    ),
  ];
  const locationNamesById = new Map([
    ...locationOptions.map((option) => [option.locationId, option.name] as const),
    ...stock.flatMap((item) =>
      item.rootLocationId !== undefined && item.sourceLocationName
        ? [[item.rootLocationId, item.sourceLocationName] as const]
        : [],
    ),
  ]);

  async function copyPlanId() {
    const planId = plan?.metadata.planId;
    if (!planId) return;
    try {
      await navigator.clipboard.writeText(planId);
      toast.add({ description: "Plan ID copied" });
    }
    catch {
      toast.add({ description: "Could not copy the plan ID", type: "error" });
    }
  }

  const ActiveTabIcon = tabs.find((tab) => tab.value === activeTab)?.icon ?? ClipboardList;
  return (
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
          {plan?.metadata.planId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsBugReportOpen(true)}
            >
              <Bug aria-hidden="true" />
              Found a bug in this plan?
            </Button>
          )}
          <span className={styles.planStatus}>
            <i /> {planStatus}
          </span>
        </div>
      </div>
      <Dialog open={isBugReportOpen} onOpenChange={setIsBugReportOpen}>
        <DialogContent>
          <DialogTitle>Report a plan problem</DialogTitle>
          <div className="flex flex-col gap-4 text-sm">
            <p>
              Go to our Discord and post details of the problem along with this plan ID so we can
              reproduce the calculation.
            </p>
            <div className="flex items-center gap-2 border p-3 font-mono text-xs">
              <span className="min-w-0 flex-1 break-all">{plan?.metadata.planId}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyPlanId()}>
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
      <Tabs value={activeTab} onValueChange={selectTab}>
        <TabsList
          variant="line"
          className={`${styles.desktopTabList} w-full max-w-full justify-start overflow-x-auto overflow-y-hidden`}
        >
          {tabs.map(({ value, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon data-icon="inline-start" />
              {value}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className={styles.mobileTabSelect}>
          <span className={styles.mobileTabLabel}>OUTPUT VIEW</span>
          <Select value={activeTab} onValueChange={(value) => value && selectTab(value)}>
            <SelectTrigger className="w-full" aria-label="Plan output view">
              <SelectValue>
                <ActiveTabIcon data-icon="inline-start" />
                {activeTab}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {tabs.map(({ value, icon: Icon }) => (
                  <SelectItem key={value} value={value}>
                    <Icon data-icon="inline-start" />
                    {value}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <TabsContent value={activeTab}>
          {plan ? (
            <PlanList
              activeTab={activeTab}
              language={language}
              plan={plan}
              characterStatuses={characterStatuses}
              characterNamesById={characterNamesById}
              corporationNamesById={corporationNamesById}
              stock={stock}
              marketBuyOrderQuantities={marketBuyOrderQuantities}
              activityLocationIds={activityLocationIds}
              availableReactionSlots={availableReactionSlots}
              availableManufacturingSlots={availableManufacturingSlots}
              reactionSlotCharacters={reactionSlotCharacters}
              manufacturingSlotCharacters={manufacturingSlotCharacters}
              locationNamesById={locationNamesById}
              onAddBuildItem={onAddBuildItem}
              onExcludeHaulStockpile={onExcludeHaulStockpile}
              haulItemExclusion={haulItemExclusion}
              onToggleHaulItemExclusion={onToggleHaulItemExclusion}
              haulPatches={haulPatches}
              onToggleHaulPatches={onToggleHaulPatches}
              selectedTypeId={selectedTypeId}
              onSelectedTypeIdChange={selectTypeId}
              resultsHeaderRef={resultsHeaderRef}
            />
          ) : (
            <Empty className={styles.emptyResult}>
              <div className={styles.resultGlyph}>↗</div>
              <strong>Your {activeTab.toLowerCase()} list will appear here</strong>
              <EmptyDescription>
                Calculate a plan to see the work required for this project.
              </EmptyDescription>
            </Empty>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlanList({
  activeTab,
  language,
  plan,
  characterStatuses,
  characterNamesById,
  corporationNamesById,
  stock,
  marketBuyOrderQuantities,
  activityLocationIds,
  availableReactionSlots,
  availableManufacturingSlots,
  reactionSlotCharacters,
  manufacturingSlotCharacters,
  locationNamesById,
  onAddBuildItem,
  onExcludeHaulStockpile,
  haulItemExclusion,
  onToggleHaulItemExclusion,
  haulPatches,
  onToggleHaulPatches,
  selectedTypeId,
  onSelectedTypeIdChange,
  resultsHeaderRef,
}: {
  activeTab: PlannerTab;
  language: SdeLanguage;
  plan: PlanResponse;
  characterStatuses: ClientCharacterStatus[];
  characterNamesById: Map<number, string>;
  corporationNamesById: Map<number, string>;
  stock: PlanStockItem[];
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
  activityLocationIds: number[];
  availableReactionSlots: number;
  availableManufacturingSlots: number;
  reactionSlotCharacters: ActivitySlotCharacter[];
  manufacturingSlotCharacters: ActivitySlotCharacter[];
  locationNamesById: Map<number, string>;
  onAddBuildItem: (item: { name: string; typeId: number; quantity: number }) => void;
  onExcludeHaulStockpile: (fromLocationId: number) => Promise<void>;
  haulItemExclusion: HaulItemExclusion;
  onToggleHaulItemExclusion: (
    key: string,
    destinationLocationId: number,
    excluded: boolean,
  ) => Promise<void>;
  haulPatches: ReadonlyMap<string, HaulPatch>;
  onToggleHaulPatches: (tasks: ResponseHaulTask[], patched: boolean) => Promise<void>;
  selectedTypeId: number | null;
  onSelectedTypeIdChange: (typeId: number | null) => void;
  resultsHeaderRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [copyStatus, setCopyStatus] = useState("");
  const [groupCopyStatus, setGroupCopyStatus] = useState<{
    category: string;
    label: string;
  } | null>(null);
  const [excludingHaulFromLocationId, setExcludingHaulFromLocationId] = useState<number | null>(
    null,
  );
  const [togglingHaulItemKey, setTogglingHaulItemKey] = useState<string | null>(null);
  const [togglingHaulPatchKey, setTogglingHaulPatchKey] = useState<string | null>(null);
  const [togglingHaulPatchGroupKey, setTogglingHaulPatchGroupKey] = useState<string | null>(null);
  const [showTotalRunCounts, setShowTotalRunCounts] = useState(false);
  const [showTotalManufacturingRunCounts, setShowTotalManufacturingRunCounts] = useState(false);
  const [planViewMode, setPlanViewMode] = useState<PlanViewMode>("build-location");
  const [reactionScheduleMode, setReactionScheduleMode] =
    useState<ReactionScheduleMode>("available-slots");
  const [maxJobHours, setMaxJobHours] = useState("24");
  const [reactionSort, setReactionSort] = useState<ReactionSort>({
    key: "type",
    direction: "asc",
  });
  const [manufacturingSort, setManufacturingSort] = useState<ManufacturingSort>({
    key: "type",
    direction: "asc",
  });
  const [addedReactionBuildItems, setAddedReactionBuildItems] = useState<Set<number>>(
    () => new Set(),
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
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
  const planItems = plan.lists.planItems.all;
  const planTypeOptions = [
    ...new Map(
      planItems.map((entry) => [entry.typeId, { id: entry.typeId, name: getEntryName(entry) }]),
    ).values(),
  ].sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  const selectedType = planTypeOptions.find((option) => option.id === selectedTypeId);
  const filteredPlanItems =
    selectedTypeId === null
      ? planItems
      : planItems.filter((entry) => entry.typeId === selectedTypeId);
  const planItemsByActivityLocation = flattenLocationBuckets(
    plan.lists.planItems.byActivityLocation,
    "activityLocationId",
  );
  const filteredPlanItemsByActivityLocation =
    selectedTypeId === null
      ? planItemsByActivityLocation
      : planItemsByActivityLocation.filter((entry) => entry.typeId === selectedTypeId);
  const inventionJobs = flattenLocationBuckets(plan.lists.inventionJobs, "locationId");
  const reactionJobs = flattenLocationBuckets(plan.lists.reactionJobs, "locationId");
  const manufacturingJobs = flattenLocationBuckets(plan.lists.manufacturingJobs, "locationId");
  const reprocessingJobs = flattenLocationBuckets(plan.lists.reprocessingJobs, "locationId");
  const haulingTasks = getHaulTasksWithPatches(
    getHaulTasksWithExclusions(
      flattenHaulBuckets(plan.lists.haulingTasks),
      stock,
      haulItemExclusion,
    ),
    haulPatches,
  );
  const copyPlanItems = planItemsByActivityLocation.filter(
    (entry): entry is Extract<ResponsePlanItem, { kind: "bpc" }> =>
      entry.kind === "bpc" && entry.bpoCount > 0 && entry.neededQuantity > 0,
  );
  const buyBuckets =
    activeTab === "Buy"
      ? [...plan.lists.materialsToBuy, ...plan.lists.bpoToBuy]
          .map((bucket) => ({
            ...bucket,
            items: bucket.items.filter((entry) => entry.neededQuantity > 0),
          }))
          .filter((bucket) => bucket.items.length > 0)
      : [];
  const buyEntries = buyBuckets.flatMap((bucket) => bucket.items);
  const rawList =
    activeTab === "Plan"
      ? planViewMode === "all"
        ? filteredPlanItems
        : filteredPlanItemsByActivityLocation
      : activeTab === "Buy"
        ? buyEntries
        : activeTab === "Copy"
          ? copyPlanItems
          : activeTab === "Reprocess"
            ? reprocessingJobs
            : activeTab === "Invent"
              ? inventionJobs
              : activeTab === "React"
                ? reactionJobs
                : activeTab === "Manufacture"
                  ? manufacturingJobs
                  : haulingTasks;
  const list = rawList;
  const materialBuyEntries =
    activeTab === "Buy" ? (list as PlanBuyEntry[]).filter(isMultibuyMaterial) : [];
  const locationGroupedTab =
    activeTab === "Reprocess"
    || activeTab === "Copy"
    || activeTab === "Invent"
    || activeTab === "React"
    || activeTab === "Manufacture"
    || (activeTab === "Plan" && planViewMode === "build-location");
  type PlanListEntry =
    | ResponsePlanItem
    | PlanBuyEntry
    | (typeof inventionJobs)[number]
    | (typeof reprocessingJobs)[number]
    | (typeof reactionJobs)[number]
    | (typeof manufacturingJobs)[number]
    | DisplayHaulTask;
  type ReactionDisplayRow = {
    entry: PlanListEntry;
    reactionPlan: ReactionSchedule | null;
    reactionIndex: number;
  };
  const locationGroups = new Map<number | undefined, PlanListEntry[]>();
  if (locationGroupedTab) {
    for (const entry of list) {
      const locationId =
        "locationId" in entry && typeof entry.locationId === "number"
          ? entry.locationId
          : "activityLocationId" in entry && typeof entry.activityLocationId === "number"
            ? entry.activityLocationId
            : undefined;
      const group = locationGroups.get(locationId) ?? [];
      group.push(entry as PlanListEntry);
      locationGroups.set(locationId, group);
    }
  }
  const sortedLocationGroups = [...locationGroups.entries()].sort(([left], [right]) => {
    const leftName = locationNamesById.get(left ?? 0) ?? String(left ?? "Location unavailable");
    const rightName = locationNamesById.get(right ?? 0) ?? String(right ?? "Location unavailable");
    return leftName.localeCompare(rightName);
  });
  const categoryGroupedTab = activeTab === "Buy";
  const categoryGroups = categoryGroupedTab
    ? buyBuckets.map(
        (bucket) => [bucket.assemblyLineGroup, bucket.items as unknown as PlanListEntry[]] as const,
      )
    : undefined;
  const displayGroups = (
    categoryGroupedTab
      ? [...(categoryGroups ?? new Map())]
      : locationGroupedTab
        ? sortedLocationGroups
        : [[undefined, list as PlanListEntry[]]]
  ) as Array<[number | string | undefined, PlanListEntry[]]>;
  const sortEntriesByTypeName = (entries: PlanListEntry[]) =>
    entries
      .slice()
      .sort(
        (left, right) =>
          getEntryName(left).localeCompare(getEntryName(right)) || left.typeId - right.typeId,
      );
  const reactionSchedule = buildReactionSchedule(
    reactionJobs,
    stock,
    showTotalRunCounts,
    reactionScheduleMode,
    availableReactionSlots,
    Number(maxJobHours),
  );
  const reactionSummary = reactionJobs.reduce(
    (summary, job) => {
      const schedules = reactionSchedule.get(reactionJobKey(job)) ?? [];
      return {
        installs:
          summary.installs + schedules.reduce((total, schedule) => total + schedule.installs, 0),
        maxTime: Math.max(summary.maxTime, ...schedules.map((schedule) => schedule.time)),
      };
    },
    { installs: 0, maxTime: 0 },
  );
  const manufacturingSummary = getManufacturingSummary(
    manufacturingJobs,
    availableManufacturingSlots,
    showTotalManufacturingRunCounts,
  );
  const reactionCoverage = reactionJobs
    .map((job) => ({
      job,
      schedules: reactionSchedule.get(reactionJobKey(job)) ?? [],
    }))
    .sort(
      (left, right) =>
        getReactionScheduleRuns(right.schedules) - getReactionScheduleRuns(left.schedules),
    )
    .reduce<{ coverage: ReactionCoverage; remainingSlots: number }>(
      (result, { job, schedules }) => {
        let remainingRuns = job.countNeeded;
        let coveredRuns = 0;
        let remainingSlots = result.remainingSlots;
        for (const schedule of schedules) {
          if (remainingSlots <= 0 || remainingRuns <= 0) break;
          const installCount = Math.min(schedule.installs, remainingSlots);
          const scheduleRuns = Math.min(remainingRuns, installCount * schedule.runs);
          coveredRuns += scheduleRuns;
          remainingRuns -= scheduleRuns;
          remainingSlots -= installCount;
        }
        return {
          coverage: {
            installable: result.coverage.installable + Math.min(job.runsAvailable, coveredRuns),
            total: result.coverage.total + coveredRuns,
          },
          remainingSlots,
        };
      },
      {
        coverage: { installable: 0, total: 0 },
        remainingSlots: Math.max(0, availableReactionSlots),
      },
    ).coverage;
  const totalInstallableReactionRuns = reactionJobs.reduce(
    (total, job) => total + job.runsAvailable,
    0,
  );
  const totalReactionRuns = reactionJobs.reduce((total, job) => total + job.countNeeded, 0);
  const sortedDisplayGroups =
    activeTab === "React" || activeTab === "Manufacture"
      ? (displayGroups.map(([locationId, entries]) => [
          locationId,
          entries
            .slice()
            .sort((left, right) => {
              const leftTypeId = left.typeId;
              const rightTypeId = right.typeId;
              if (activeTab === "Manufacture") {
                const leftManufacturing = left as ResponseManufacturingJob;
                const rightManufacturing = right as ResponseManufacturingJob;
                const leftValue =
                  manufacturingSort.key === "type"
                    ? leftManufacturing.name
                    : manufacturingSort.key === "inputs"
                      ? getJobInputsCompletionPercent(leftManufacturing.inputs)
                      : showTotalManufacturingRunCounts
                        ? leftManufacturing.countNeeded
                        : leftManufacturing.runsAvailable;
                const rightValue =
                  manufacturingSort.key === "type"
                    ? rightManufacturing.name
                    : manufacturingSort.key === "inputs"
                      ? getJobInputsCompletionPercent(rightManufacturing.inputs)
                      : showTotalManufacturingRunCounts
                        ? rightManufacturing.countNeeded
                        : rightManufacturing.runsAvailable;
                const comparison =
                  typeof leftValue === "string" && typeof rightValue === "string"
                    ? leftValue.localeCompare(rightValue)
                    : Number(leftValue) - Number(rightValue);
                return (
                  (manufacturingSort.direction === "asc" ? comparison : -comparison)
                  || leftTypeId - rightTypeId
                );
              }
              const leftSchedule = reactionSchedule.get(
                reactionJobKey(left as ResponseReactionJob),
              );
              const rightSchedule = reactionSchedule.get(
                reactionJobKey(right as ResponseReactionJob),
              );
              const leftValue =
                reactionSort.key === "type"
                  ? "typeName" in left
                    ? left.typeName
                    : left.name
                  : reactionSort.key === "inputs"
                    ? getReactionInputsCompletionPercent(left as ResponseReactionJob)
                    : reactionSort.key === "suggestedRuns"
                      ? getReactionScheduleRuns(leftSchedule)
                      : "countNeeded" in left
                        ? showTotalRunCounts
                          ? left.countNeeded
                          : "runsAvailable" in left
                            ? left.runsAvailable
                            : left.countNeeded
                        : 0;
              const rightValue =
                reactionSort.key === "type"
                  ? "typeName" in right
                    ? right.typeName
                    : right.name
                  : reactionSort.key === "inputs"
                    ? getReactionInputsCompletionPercent(right as ResponseReactionJob)
                    : reactionSort.key === "suggestedRuns"
                      ? getReactionScheduleRuns(rightSchedule)
                      : "countNeeded" in right
                        ? showTotalRunCounts
                          ? right.countNeeded
                          : "runsAvailable" in right
                            ? right.runsAvailable
                            : right.countNeeded
                        : 0;
              const comparison =
                typeof leftValue === "string" && typeof rightValue === "string"
                  ? leftValue.localeCompare(rightValue)
                  : Number(leftValue) - Number(rightValue);
              return (
                (reactionSort.direction === "asc" ? comparison : -comparison)
                || leftTypeId - rightTypeId
              );
            }),
        ]) as Array<[number | undefined, PlanListEntry[]]>)
      : displayGroups.map(([group, entries]) => [group, sortEntriesByTypeName(entries)] as const);
  const maxCopyBuildTime = Math.max(...copyPlanItems.map((entry) => entry.buildTime), 0);
  const haulGroups = new Map<
    string,
    {
      fromLocationId: number;
      toLocationId: number;
      ownerType?: "character" | "corporation";
      ownerId?: number;
      tasks: DisplayHaulTask[];
    }
  >();
  if (activeTab === "Haul") {
    for (const task of haulingTasks) {
      const key = `${task.fromLocationId}:${task.toLocationId}:${task.ownerType ?? "unassigned"}:${task.ownerId ?? 0}`;
      const group = haulGroups.get(key) ?? {
        fromLocationId: task.fromLocationId,
        toLocationId: task.toLocationId,
        ownerType: task.ownerType,
        ownerId: task.ownerId,
        tasks: [],
      };
      group.tasks.push(task);
      haulGroups.set(key, group);
    }
    for (const group of haulGroups.values()) {
      group.tasks.sort(
        (left, right) => left.typeName.localeCompare(right.typeName) || left.typeId - right.typeId,
      );
    }
  }
  const sortedHaulGroups = [...haulGroups.values()].sort((left, right) => {
    const leftSourceName =
      locationNamesById.get(left.fromLocationId) ?? String(left.fromLocationId);
    const rightSourceName =
      locationNamesById.get(right.fromLocationId) ?? String(right.fromLocationId);
    return (
      leftSourceName.localeCompare(rightSourceName)
      || left.fromLocationId - right.fromLocationId
      || left.toLocationId - right.toLocationId
      || (left.ownerType ?? "").localeCompare(right.ownerType ?? "")
      || (left.ownerId ?? 0) - (right.ownerId ?? 0)
    );
  });
  const planColumns = ["Available", "Required", "Buy/Build", "Surplus"] as const;

  function getPlanCells(
    entry: ResponsePlanItem,
  ): Partial<Record<(typeof planColumns)[number], string>> {
    if (entry.kind === "material" || entry.kind === "bpc") {
      return {
        Required: entry.requiredQuantity.toLocaleString(),
        Available: entry.availableQuantity.toLocaleString(),
        "Buy/Build": entry.neededQuantity.toLocaleString(),
        Surplus: entry.surplusQuantity.toLocaleString(),
      };
    }
    return {
      Required: `${entry.requiredQuantity.toLocaleString()} runs`,
      Available: `${entry.availableQuantity.toLocaleString()} BPs`,
      "Buy/Build": "-",
      Surplus: "-",
    };
  }

  function getListAmount(entry: PlanBuyEntry | (typeof list)[number]): number {
    return activeTab === "Copy"
      && "kind" in entry
      && entry.kind === "bpc"
      && "neededQuantity" in entry
      && typeof entry.neededQuantity === "number"
      ? entry.neededQuantity
      : "runsNeeded" in entry && typeof entry.runsNeeded === "number"
        ? entry.runsNeeded
        : "countNeeded" in entry
          ? entry.countNeeded
          : "buyQuantity" in entry && typeof entry.buyQuantity === "number"
            ? entry.buyQuantity
            : "neededQuantity" in entry && typeof entry.neededQuantity === "number"
              ? entry.neededQuantity
              : 0;
  }

  async function sendToCompress() {
    const settings = await loadCompressSettings();
    await saveCompressSettings({
      ...settings,
      items: materialBuyEntries.map((entry) => ({
        name: getEntryName(entry),
        typeId: entry.typeId,
        quantity: getListAmount(entry),
        category: "item" as const,
        imageVariation:
          "bpoCount" in entry
            ? ("bpc" as const)
            : / blueprint$/i.test(getEntryName(entry))
              ? ("bp" as const)
              : / formula$/i.test(getEntryName(entry))
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
            ...displayGroups
              .flatMap(([, entries]) => entries)
              .map((entry) => {
                const cells = getPlanCells(entry as ResponsePlanItem);
                return [
                  getEntryName(entry),
                  ...planColumns.map((column) => cells[column] || ""),
                ].join("\t");
              }),
          ]
        : (activeTab === "Buy" ? materialBuyEntries : list).map((entry) => {
            return `${getEntryName(entry)}\t${getListAmount(entry)}`;
          });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("Copied");
      toast.add({ description: "All materials copied to clipboard" });
      window.setTimeout(() => setCopyStatus(""), 1600);
    }
    catch {
      setCopyStatus("Copy failed");
      toast.add({ description: "Could not copy to clipboard", type: "error" });
    }
  }

  async function copyGroupMultibuy(category: string, entries: PlanBuyEntry[]) {
    try {
      await navigator.clipboard.writeText(
        entries
          .filter(isMultibuyMaterial)
          .map((entry) => `${getEntryName(entry)}\t${getListAmount(entry)}`)
          .join("\n"),
      );
      setGroupCopyStatus({ category, label: "Copied" });
      toast.add({ description: `All ${category} copied to clipboard` });
      window.setTimeout(
        () => {
          setGroupCopyStatus((current) => (current?.category === category ? null : current));
        },
        1600,
      );
    }
    catch {
      setGroupCopyStatus({ category, label: "Copy failed" });
      toast.add({ description: "Could not copy multibuy group", type: "error" });
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
          <Empty className={styles.emptyResult}>
            <div className={styles.resultGlyph}>?</div>
            <strong>Character skills are unavailable</strong>
            <EmptyDescription>
              Connect a character and refresh status to compare trained skills.
            </EmptyDescription>
          </Empty>
        ) : skillsByCharacter.every((character) => character.skills.length === 0) ? (
          <Empty className={styles.emptyResult}>
            <div className={styles.resultGlyph}>✓</div>
            <strong>All characters meet the requirements</strong>
            <EmptyDescription>
              No insufficient skills were found in the cached character status.
            </EmptyDescription>
          </Empty>
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
                        {character.skills.some((skill) => skill.currentLevel > 0)
                          ? ` (${character.skills.filter((skill) => skill.currentLevel > 0).length} PARTIAL)`
                          : ""}
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
      <Empty className={styles.emptyResult}>
        <div className={styles.resultGlyph}>✓</div>
        <strong>Nothing to {activeTab}</strong>
        <EmptyDescription>The current project has no work in this category.</EmptyDescription>
      </Empty>
    );
  }
  return (
    <>
      {activeTab !== "Haul" && (
        <div
          className={`${styles.planActions} ${activeTab === "React" ? styles.reactionPlanActions : ""}`}
        >
          {activeTab === "Buy" && (
            <Button
              variant="outline"
              onClick={() => void sendToCompress()}
              disabled={materialBuyEntries.length === 0}
            >
              <Minimize2 aria-hidden="true" />
              <span>Send to Compress</span>
            </Button>
          )}
          {activeTab === "React" && (
            <>
              <div className={styles.reactionPlanControls}>
                <Label htmlFor="reaction-schedule-mode">Plan Type:</Label>
                <Select
                  value={reactionScheduleMode}
                  onValueChange={(value) => setReactionScheduleMode(value as ReactionScheduleMode)}
                >
                  <SelectTrigger
                    id="reaction-schedule-mode"
                    aria-label="Reaction scheduling mode"
                    className={styles.modeSelect}
                  >
                    <SelectValue>
                      {reactionScheduleMode === "max-job-length"
                        ? "Max job length"
                        : "Solve for available slots"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available-slots">Solve for available slots</SelectItem>
                    <SelectItem value="max-job-length">Max job length</SelectItem>
                  </SelectContent>
                </Select>
                {reactionScheduleMode === "max-job-length" && (
                  <div className={styles.hoursControl}>
                    <Input
                      id="max-reaction-job-hours"
                      type="number"
                      min="1"
                      step="1"
                      value={maxJobHours}
                      onChange={(event) => setMaxJobHours(event.target.value)}
                      aria-label="Maximum reaction job length in hours"
                      className={styles.maxJobHours}
                    />
                    <Label htmlFor="max-reaction-job-hours">Hours</Label>
                  </div>
                )}
              </div>
              <div className={styles.reactionDisplayControls}>
                <Label htmlFor="reaction-run-count-mode">Show</Label>
                <Select
                  value={showTotalRunCounts ? "total" : "installable"}
                  onValueChange={(value) => setShowTotalRunCounts(value === "total")}
                >
                  <SelectTrigger
                    id="reaction-run-count-mode"
                    aria-label="Reaction run count display"
                    className={styles.runCountSelect}
                  >
                    <SelectValue>{showTotalRunCounts ? "Total" : "Installable"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="installable">Installable</SelectItem>
                    <SelectItem value="total">Total</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {activeTab === "React" && (
            <>
              <div className={styles.reactionSummary}>
                <span>
                  <strong className="flex items-center gap-1">
                    {availableReactionSlots.toLocaleString()}
                    <ResponsiveDialogDrawer
                      trigger={
                        <button
                          type="button"
                          className="inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                          aria-label="View characters with available reaction slots"
                          title="View characters with available reaction slots"
                        >
                          <UsersRound className="size-4" aria-hidden="true" />
                        </button>
                      }
                      title="Reaction slots by character"
                      description="Characters with available reaction slots."
                    >
                      <ActivitySlotCharacters characters={reactionSlotCharacters} />
                    </ResponsiveDialogDrawer>
                  </strong>
                  <small>AVAILABLE SLOTS</small>
                </span>
                <span>
                  <strong>{reactionSummary.installs.toLocaleString()}</strong>
                  <small>SUGGESTED INSTALLS</small>
                </span>
                <span>
                  <strong>{formatDuration(reactionSummary.maxTime)}</strong>
                  <small>MAX JOB LENGTH</small>
                </span>
                <span>
                  <strong>
                    {formatCoverage(reactionCoverage.installable, totalInstallableReactionRuns)}
                  </strong>
                  <small>INSTALLABLE COVERAGE</small>
                </span>
                <span>
                  <strong>{formatCoverage(reactionCoverage.total, totalReactionRuns)}</strong>
                  <small>TOTAL COVERAGE</small>
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                className={styles.reactionCopyButton}
                onClick={copyList}
              >
                <CopyIcon aria-hidden="true" />
                {copyStatus || "Copy list"}
              </Button>
            </>
          )}
          {activeTab === "Manufacture" && (
            <div className={`${styles.reactionDisplayControls} mr-auto`}>
              <Label htmlFor="manufacturing-run-count-mode">Show</Label>
              <Select
                value={showTotalManufacturingRunCounts ? "total" : "installable"}
                onValueChange={(value) => setShowTotalManufacturingRunCounts(value === "total")}
              >
                <SelectTrigger
                  id="manufacturing-run-count-mode"
                  aria-label="Manufacturing run count display"
                  className={styles.runCountSelect}
                >
                  <SelectValue>
                    {showTotalManufacturingRunCounts ? "Total" : "Installable"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="installable">Installable</SelectItem>
                  <SelectItem value="total">Total</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {activeTab === "Manufacture" && (
            <div className={styles.reactionSummary}>
              <span>
                <strong className="flex items-center gap-1">
                  {availableManufacturingSlots.toLocaleString()}
                  <ResponsiveDialogDrawer
                    trigger={
                      <button
                        type="button"
                        className="inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="View characters with available manufacturing slots"
                        title="View characters with available manufacturing slots"
                      >
                        <UsersRound className="size-4" aria-hidden="true" />
                      </button>
                    }
                    title="Manufacturing slots by character"
                    description="Characters with available manufacturing slots."
                  >
                    <ActivitySlotCharacters characters={manufacturingSlotCharacters} />
                  </ResponsiveDialogDrawer>
                </strong>
                <small>AVAILABLE SLOTS</small>
              </span>
              <span>
                <strong>{manufacturingSummary.installs.toLocaleString()}</strong>
                <small>SUGGESTED INSTALLS</small>
              </span>
              <span>
                <strong>{formatDuration(manufacturingSummary.maxTime)}</strong>
                <small>MAX JOB LENGTH</small>
              </span>
              <span>
                <strong>{manufacturingSummary.installableCoverage}</strong>
                <small>INSTALLABLE COVERAGE</small>
              </span>
              <span>
                <strong>{manufacturingSummary.totalCoverage}</strong>
                <small>TOTAL COVERAGE</small>
              </span>
            </div>
          )}
          {activeTab === "Plan" && (
            <div className={styles.planViewControls}>
              <Label htmlFor="plan-type">TYPE</Label>
              <Combobox
                items={planTypeOptions.map((option) => option.name)}
                value={selectedType?.name ?? null}
                onValueChange={(value) => {
                  const nextTypeId =
                    planTypeOptions.find((option) => option.name === value)?.id ?? null;
                  onSelectedTypeIdChange(nextTypeId);
                }}
              >
                <ComboboxInput
                  id="plan-type"
                  placeholder="Filter by type"
                  aria-label="Filter plan by asset type"
                  showClear
                />
                <ComboboxContent>
                  <ComboboxEmpty>No matching asset types.</ComboboxEmpty>
                  <ComboboxList>
                    <ComboboxCollection>
                      {(option) => (
                        <ComboboxItem key={option} value={option}>
                          {option}
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <Label htmlFor="plan-view-mode">VIEW</Label>
              <Select
                value={planViewMode}
                onValueChange={(value) => setPlanViewMode(value as PlanViewMode)}
              >
                <SelectTrigger
                  id="plan-view-mode"
                  aria-label="Plan view mode"
                  className={styles.modeSelect}
                >
                  <SelectValue>
                    {planViewMode === "build-location" ? "By Build Location" : "All Items"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Items</SelectItem>
                  <SelectItem value="build-location">By Build Location</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {activeTab !== "React" && (
            <Button
              type="button"
              variant="outline"
              onClick={copyList}
              disabled={activeTab === "Buy" && materialBuyEntries.length === 0}
            >
              <CopyIcon aria-hidden="true" />
              {copyStatus
                || (activeTab === "Plan"
                  ? "Copy table"
                  : activeTab === "Buy"
                    ? "Multibuy Materials"
                    : "Copy list")}
            </Button>
          )}
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
      {activeTab === "React" && (
        <div className={styles.reactionTableHeader}>
          <button
            type="button"
            className={styles.reactionSortButton}
            aria-label={`Sort reactions by Type${reactionSort.key === "type" ? `, currently ${reactionSort.direction}ending` : ""}`}
            onClick={() =>
              setReactionSort((current) => ({
                key: "type",
                direction: current.key === "type" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            Type
            {reactionSort.key === "type"
              && (reactionSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
          <button
            type="button"
            className={`${styles.reactionSortButton} ${styles.inputsSortHeader}`}
            aria-label={`Sort reactions by Inputs${reactionSort.key === "inputs" ? `, currently ${reactionSort.direction}ending` : ""}`}
            onClick={() =>
              setReactionSort((current) => ({
                key: "inputs",
                direction: current.key === "inputs" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            % inputs
            {reactionSort.key === "inputs"
              && (reactionSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
          <span>BPs available</span>
          <span>Suggested installs</span>
          <button
            type="button"
            className={styles.reactionSortButton}
            aria-label={`Sort reactions by Suggested runs${reactionSort.key === "suggestedRuns" ? `, currently ${reactionSort.direction}ending` : ""}`}
            onClick={() =>
              setReactionSort((current) => ({
                key: "suggestedRuns",
                direction:
                  current.key === "suggestedRuns" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            Suggested runs
            {reactionSort.key === "suggestedRuns"
              && (reactionSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
          <button
            type="button"
            className={styles.reactionSortButton}
            aria-label={`Sort reactions by Total needed${reactionSort.key === "totalNeeded" ? `, currently ${reactionSort.direction}ending` : ""}`}
            onClick={() =>
              setReactionSort((current) => ({
                key: "totalNeeded",
                direction:
                  current.key === "totalNeeded" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            Total needed
            {reactionSort.key === "totalNeeded"
              && (reactionSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
        </div>
      )}
      {activeTab === "Manufacture" && (
        <div className={styles.manufacturingTableHeader}>
          <button
            type="button"
            className={styles.reactionSortButton}
            aria-label={`Sort manufacturing jobs by Type${manufacturingSort.key === "type" ? `, currently ${manufacturingSort.direction}ending` : ""}`}
            onClick={() =>
              setManufacturingSort((current) => ({
                key: "type",
                direction: current.key === "type" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            Type
            {manufacturingSort.key === "type"
              && (manufacturingSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
          <button
            type="button"
            className={`${styles.reactionSortButton} ${styles.inputsSortHeader}`}
            aria-label={`Sort manufacturing jobs by % inputs${manufacturingSort.key === "inputs" ? `, currently ${manufacturingSort.direction}ending` : ""}`}
            onClick={() =>
              setManufacturingSort((current) => ({
                key: "inputs",
                direction: current.key === "inputs" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            % inputs
            {manufacturingSort.key === "inputs"
              && (manufacturingSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
          <span>BPO count</span>
          <span>BPC runs</span>
          <button
            type="button"
            className={styles.reactionSortButton}
            aria-label={`Sort manufacturing jobs by Run count${manufacturingSort.key === "runs" ? `, currently ${manufacturingSort.direction}ending` : ""}`}
            onClick={() =>
              setManufacturingSort((current) => ({
                key: "runs",
                direction: current.key === "runs" && current.direction === "asc" ? "desc" : "asc",
              }))
            }
          >
            Run count
            {manufacturingSort.key === "runs"
              && (manufacturingSort.direction === "asc" ? (
                <ArrowUp aria-hidden="true" />
              ) : (
                <ArrowDown aria-hidden="true" />
              ))}
          </button>
        </div>
      )}
      {activeTab === "Copy" && (
        <>
          <div className={styles.copySummary}>
            <strong>{formatDuration(maxCopyBuildTime)}</strong>
            <span>MAX BUILD TIME</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(74px,auto)_minmax(74px,auto)_minmax(90px,auto)] items-center gap-[13px] py-2.5 pb-1.5 text-right font-mono text-[9px] leading-normal tracking-[0.3px] text-muted-foreground uppercase max-[640px]:hidden [&>span:first-child]:text-left">
            <span>Type</span>
            <span>BPOs in use</span>
            <span>BPOs owned</span>
            <span>BPC runs</span>
          </div>
        </>
      )}
      {activeTab === "Haul" ? (
        <div className={styles.haulGroups}>
          {sortedHaulGroups.map((group) => (
            <section
              className={styles.haulGroup}
              key={`${group.fromLocationId}:${group.toLocationId}:${group.ownerType ?? "unassigned"}:${group.ownerId ?? 0}`}
            >
              <header className={styles.haulGroupHeader}>
                <strong className={styles.haulGroupVolume}>
                  {getHaulGroupVolume(group.tasks).toLocaleString()} m<sup>3</sup>
                </strong>
                <span className={styles.haulFromLabel}>From</span>
                <strong className={styles.haulFromName}>
                  {locationNamesById.get(group.fromLocationId) ?? group.fromLocationId}
                </strong>
                <span className={styles.haulToLabel}>To</span>
                <strong className={styles.haulToName}>
                  {locationNamesById.get(group.toLocationId) ?? group.toLocationId}
                </strong>
                {group.ownerType !== undefined && group.ownerId !== undefined && (
                  <strong className={styles.haulOwner}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          group.ownerType === "corporation" ? (
                            <Image
                              src={eveCorporationLogoUrl(group.ownerId, 64)}
                              alt={`${corporationNamesById.get(group.ownerId) ?? `Corporation ${group.ownerId}`} logo`}
                              width={24}
                              height={24}
                              className="size-6 rounded-none"
                            />
                          ) : (
                            <Image
                              src={eveCharacterPortraitUrl(group.ownerId, 64)}
                              alt={`${characterNamesById.get(group.ownerId) ?? `Character ${group.ownerId}`} portrait`}
                              width={24}
                              height={24}
                              className="size-6 rounded-none"
                            />
                          )
                        }
                      />
                      <TooltipContent>
                        {group.ownerType === "corporation"
                          ? (
                              corporationNamesById.get(group.ownerId)
                              ?? `Corporation ${group.ownerId}`
                            )
                          : (characterNamesById.get(group.ownerId) ?? `Character ${group.ownerId}`)}
                      </TooltipContent>
                    </Tooltip>
                    <span className={styles.haulOwnerName}>
                      {group.ownerType === "corporation"
                        ? (
                            corporationNamesById.get(group.ownerId)
                            ?? `Corporation ${group.ownerId}`
                          )
                        : (characterNamesById.get(group.ownerId) ?? `Character ${group.ownerId}`)}
                    </span>
                  </strong>
                )}
                <div className={styles.haulHeaderActions}>
                  <Button
                    variant="outline"
                    disabled={excludingHaulFromLocationId !== null}
                    onClick={() => {
                      setExcludingHaulFromLocationId(group.fromLocationId);
                      void onExcludeHaulStockpile(group.fromLocationId).finally(() => {
                        setExcludingHaulFromLocationId(null);
                      });
                    }}
                  >
                    {excludingHaulFromLocationId === group.fromLocationId ? (
                      <Spinner aria-hidden="true" />
                    ) : (
                      <SquareX aria-hidden="true" />
                    )}
                    <span>
                      {excludingHaulFromLocationId === group.fromLocationId
                        ? "Recalculating..."
                        : "Exclude Location"}
                    </span>
                  </Button>
                  {(() => {
                    const eligibleTasks = group.tasks.filter(
                      (task) => !haulItemExclusion.has(haulTaskKey(task)),
                    );
                    const patchedCount = eligibleTasks.filter((task) =>
                      isHaulTaskPatched(task, haulPatches),
                    ).length;
                    const groupChecked =
                      eligibleTasks.length > 0 && patchedCount === eligibleTasks.length;
                    const groupIndeterminate = patchedCount > 0 && !groupChecked;
                    const groupKey = `${group.fromLocationId}:${group.toLocationId}:${group.ownerType ?? "unassigned"}:${group.ownerId ?? 0}`;
                    return (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Checkbox
                              aria-label="Mark all eligible items as moved"
                              checked={groupChecked}
                              indeterminate={groupIndeterminate}
                              disabled={
                                eligibleTasks.length === 0
                                || togglingHaulPatchGroupKey !== null
                                || togglingHaulPatchKey !== null
                              }
                              onCheckedChange={(checked) => {
                                setTogglingHaulPatchGroupKey(groupKey);
                                void onToggleHaulPatches(eligibleTasks, checked).finally(() => {
                                  setTogglingHaulPatchGroupKey(null);
                                });
                              }}
                            />
                          }
                        />
                        <TooltipContent>Haul completed?</TooltipContent>
                      </Tooltip>
                    );
                  })()}
                </div>
              </header>
              <div className={styles.haulGroupRows}>
                {group.tasks.map((task) => {
                  const key = haulTaskKey(task);
                  const isExcluded = haulItemExclusion.has(key);
                  const isPatched = isHaulTaskPatched(task, haulPatches);
                  return (
                    <div
                      className={`${styles.haulRow} ${isExcluded ? styles.haulRowDisabled : ""} ${isPatched ? styles.haulRowCompleted : ""}`}
                      key={haulTaskRenderKey(task)}
                    >
                      <span className={styles.haulRowSwitch}>
                        {togglingHaulItemKey === key ? (
                          <Spinner aria-hidden="true" />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Switch
                                  aria-label="Include in haul plan?"
                                  checked={!isExcluded}
                                  disabled={isPatched || togglingHaulItemKey !== null}
                                  onCheckedChange={(checked) => {
                                    setTogglingHaulItemKey(key);
                                    void onToggleHaulItemExclusion(
                                      key,
                                      task.toLocationId,
                                      !checked,
                                    ).finally(() => setTogglingHaulItemKey(null));
                                  }}
                                />
                              }
                            />
                            <TooltipContent>Include in haul plan?</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                      <TypeIdentity
                        name={task.typeName}
                        typeId={task.typeId}
                        imageSize={40}
                        linkPath="planner"
                        linkIcon={ClipboardList}
                        linkSearchParams={{ tab: "Plan" }}
                        navigateInPlace
                        className={styles.planTypeIdentity}
                      />
                      <span className={styles.haulRowAmount}>
                        <CopyableText
                          textToRender={`${task.neededQuantity.toLocaleString()} units`}
                          textToCopy={String(task.neededQuantity)}
                          copyLabel="Quantity"
                        />
                        <small>
                          {Math.ceil(task.neededQuantity * task.unitVolume).toLocaleString()} m
                          <sup>3</sup>
                        </small>
                      </span>
                      <span className={styles.haulRowPatch}>
                        {togglingHaulPatchKey === key ? (
                          <Spinner aria-hidden="true" />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Checkbox
                                  aria-label={`Mark ${task.typeName} as moved`}
                                  checked={isPatched}
                                  disabled={
                                    isExcluded
                                    || togglingHaulPatchGroupKey !== null
                                    || togglingHaulPatchKey !== null
                                  }
                                  onCheckedChange={(checked) => {
                                    setTogglingHaulPatchKey(key);
                                    void onToggleHaulPatches([task], checked).finally(() => {
                                      setTogglingHaulPatchKey(null);
                                    });
                                  }}
                                />
                              }
                            />
                            <TooltipContent>Haul completed?</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className={activeTab === "Plan" ? styles.planTable : styles.planList}>
          {sortedDisplayGroups.map(([locationId, entries]) => {
            const groupKey = `${activeTab}:${locationId ?? "unlocated"}`;
            const isGroupOpen = openGroups[groupKey] ?? true;
            const displayRows = entries.flatMap<ReactionDisplayRow>((entry) => {
              const schedules =
                activeTab === "React" && "inputs" in entry
                  ? (reactionSchedule.get(reactionJobKey(entry as ResponseReactionJob)) ?? [])
                  : [];
              return schedules.length > 0
                ? schedules.map((reactionPlan, reactionIndex) => ({
                    entry,
                    reactionPlan,
                    reactionIndex,
                  }))
                : [{ entry, reactionPlan: null, reactionIndex: 0 }];
            });
            const groupAvatarRows = displayRows
              .filter(
                ({ entry }, index, rows) =>
                  rows.findIndex((row) => row.entry.typeId === entry.typeId) === index,
              )
              .sort(({ entry: a }, { entry: b }) =>
                getEntryName(b).includes("Reaction Formula")
                || getEntryName(b).includes("Blueprint")
                  ? -1
                  : 1,
              )
              .slice(0, 5);
            return (
              <Collapsible
                className="group/plan-group"
                key={groupKey}
                open={isGroupOpen}
                onOpenChange={(open) =>
                  setOpenGroups((current) => ({ ...current, [groupKey]: open }))
                }
              >
                {(locationGroupedTab || categoryGroupedTab) && (
                  <h3 className={styles.locationGroupHeader}>
                    <CollapsibleTrigger
                      type="button"
                      className="flex min-w-0 min-h-10 flex-1 items-center justify-between gap-3 border-0 bg-transparent p-0 text-left font-inherit uppercase text-inherit"
                      aria-label="Toggle group"
                    >
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                        {categoryGroupedTab
                          ? locationId
                          : (
                              locationNamesById.get(Number(locationId ?? 0))
                              ?? locationId
                              ?? "Location unavailable"
                            )}
                      </span>
                      <AvatarGroup className="ml-auto hidden group-data-closed/plan-group:flex">
                        {groupAvatarRows.map(({ entry }, index) => (
                          <Avatar key={`${entry.typeId}-${index}`} size="lg">
                            <AvatarImage
                              className="bg-muted"
                              src={eveTypeImageUrl(
                                entry.typeId,
                                "kind" in entry
                                  ? entry.kind === "bpc"
                                    ? "bpc"
                                    : entry.kind === "reaction"
                                      ? "bp"
                                      : "icon"
                                  : "icon",
                                64,
                              )}
                              alt={`${getEntryName(entry)} icon`}
                            />
                            <AvatarFallback>{getEntryName(entry).slice(0, 2)}</AvatarFallback>
                          </Avatar>
                        ))}
                        {displayRows.length - groupAvatarRows.length > 0 && (
                          <AvatarGroupCount>
                            +{displayRows.length - groupAvatarRows.length}
                          </AvatarGroupCount>
                        )}
                      </AvatarGroup>
                      {isGroupOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
                    </CollapsibleTrigger>
                    {categoryGroupedTab && (
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 normal-case"
                        onClick={() =>
                          void copyGroupMultibuy(
                            String(locationId),
                            entries as unknown as PlanBuyEntry[],
                          )
                        }
                      >
                        <CopyIcon aria-hidden="true" />
                        {groupCopyStatus?.category === String(locationId)
                          ? groupCopyStatus.label
                          : "Copy Group Multibuy"}
                      </Button>
                    )}
                  </h3>
                )}
                <CollapsibleContent>
                  {displayRows.map(({ entry, reactionPlan, reactionIndex }, index, rows) => {
                    const rowSchedules =
                      activeTab === "React" && "inputs" in entry
                        ? (reactionSchedule.get(reactionJobKey(entry as ResponseReactionJob)) ?? [])
                        : [];
                    const typeId = entry.typeId;
                    const name = getEntryName(entry);
                    const marketBuyOrderQuantity =
                      activeTab === "Buy" ? (marketBuyOrderQuantities?.[String(typeId)] ?? 0) : 0;
                    const isPlanBpc = "kind" in entry && entry.kind === "bpc";
                    const isBpcPurchase = activeTab === "Buy" && "bpoCount" in entry;
                    const buyBpoEntry = isBpcPurchase && "bpoCount" in entry ? entry : null;
                    const isCopyOfBpo =
                      activeTab === "Copy" && "bpoCount" in entry && entry.bpoCount > 0;
                    const copyBpoEntry = activeTab === "Copy" && "bpoCount" in entry ? entry : null;
                    const isBlueprintName = / blueprint$/i.test(name);
                    const isReactionFormulaName = / formula$/i.test(name);
                    const isReactionFormulaBuy = activeTab === "Buy" && isReactionFormulaName;
                    const reactionFormulaSummary = isReactionFormulaBuy
                      ? getReactionFormulaSummary(typeId, stock)
                      : null;
                    const isPlanReaction = "kind" in entry && entry.kind === "reaction";
                    const planBlueprintVariation =
                      activeTab === "Plan" && (isPlanBpc || isBlueprintName)
                        ? isPlanBpc && entry.bpoCount > 0
                          ? "bp"
                          : "bpc"
                        : null;
                    const detail =
                      activeTab === "Reprocess" && "efficiency" in entry
                        ? `${entry.efficiency.toFixed(1)}% yield`
                        : "fromLocationId" in entry && activeTab !== "Buy"
                          ? `From ${locationNamesById.get(entry.fromLocationId) ?? entry.fromLocationId} to ${locationNamesById.get(entry.toLocationId) ?? entry.toLocationId}`
                          : "";
                    const totalTime =
                      "totalTime" in entry && typeof entry.totalTime === "number"
                        ? entry.totalTime
                        : null;
                    const reactionFormulaCount =
                      activeTab === "React" && "inputs" in entry && "locationId" in entry
                        ? getReactionFormulaCount(entry as ResponseReactionJob, stock)
                        : 0;
                    const precedingRuns = rowSchedules
                      .slice(0, reactionIndex)
                      .reduce((total, schedule) => total + schedule.totalRuns, 0);
                    const reactionInputs =
                      activeTab === "React"
                      && reactionPlan !== null
                      && rowSchedules.length > 1
                      && "inputs" in entry
                      && "countNeeded" in entry
                        ? splitReactionJobInputs(
                            entry.inputs,
                            entry.countNeeded,
                            reactionPlan.totalRuns,
                            precedingRuns,
                          )
                        : "inputs" in entry
                          ? entry.inputs
                          : null;
                    const targetRuns = reactionPlan?.runs ?? null;
                    const suggestedInstallCount = reactionPlan?.installs ?? 0;
                    const installTime = reactionPlan?.time ?? totalTime;
                    const totalNeeded =
                      activeTab === "React" && "countNeeded" in entry && "runsAvailable" in entry
                        ? (
                            reactionPlan?.totalRuns
                            ?? (showTotalRunCounts ? entry.countNeeded : entry.runsAvailable)
                          )
                        : null;
                    const scheduledRuns = rowSchedules.reduce(
                      (total, schedule) => total + schedule.totalRuns,
                      0,
                    );
                    const scheduleRuns = getReactionScheduleRuns(rowSchedules);
                    const additionalInstallCount =
                      totalNeeded !== null && scheduleRuns > 0
                        ? Math.max(
                            0,
                            Math.ceil(Math.max(0, totalNeeded - scheduledRuns) / scheduleRuns),
                          )
                        : 0;
                    const materialEntry =
                      activeTab === "Buy" && !isBpcPurchase
                        ? (entry as ResponseMaterialBuy)
                        : activeTab === "Plan" && "kind" in entry && entry.kind === "material"
                          ? (entry as Extract<ResponsePlanItem, { kind: "material" }>)
                          : null;
                    const materialAmount = materialEntry?.neededQuantity ?? null;
                    const amount =
                      "fromLocationId" in entry
                        ? `${entry.neededQuantity.toLocaleString()} units | ${Math.ceil(entry.neededQuantity * entry.unitVolume).toLocaleString()} m<sup>3</sup>`
                        : isBpcPurchase
                          ? `${entry.neededQuantity.toLocaleString()} runs`
                          : isPlanBpc
                            ? `${entry.neededQuantity.toLocaleString()} needed`
                            : isPlanReaction
                              ? `${entry.requiredQuantity.toLocaleString()} runs`
                              : materialAmount !== null
                                ? `${materialAmount.toLocaleString()} units`
                                : activeTab === "Copy" && "kind" in entry && entry.kind === "bpc"
                                  ? `${entry.neededQuantity.toLocaleString()} runs`
                                  : "quantity" in entry && typeof entry.quantity === "number"
                                    ? `${entry.quantity.toLocaleString()} ${activeTab === "Copy" ? "runs" : "units"}`
                                    : "countNeeded" in entry
                                      ? entry.countNeeded >= 10
                                        && suggestedInstallCount > 1
                                        && targetRuns !== null
                                        && installTime !== null
                                        ? `${suggestedInstallCount.toLocaleString()} x ${targetRuns.toLocaleString()} runs @ ${formatDuration(installTime)} | ${entry.countNeeded.toLocaleString()} runs`
                                        : `${totalTime !== null ? `${formatDuration(totalTime)} | ` : ""}${entry.countNeeded.toLocaleString()} ${activeTab === "Invent" ? "attempts" : "runs"}`
                                      : "";
                    const amountToCopy =
                      "fromLocationId" in entry
                        ? String(entry.neededQuantity)
                        : isBpcPurchase
                          ? String(entry.neededQuantity)
                          : isPlanBpc
                            ? String(entry.neededQuantity)
                            : isPlanReaction
                              ? String(entry.requiredQuantity)
                              : materialAmount !== null
                                ? String(materialAmount)
                                : activeTab === "Copy" && "kind" in entry && entry.kind === "bpc"
                                  ? String(entry.neededQuantity)
                                  : "quantity" in entry
                                    ? String(entry.quantity)
                                    : "countNeeded" in entry
                                      ? String(entry.countNeeded)
                                      : null;
                    const amountCopyLabel =
                      activeTab === "Invent"
                        ? "Attempts"
                        : "fromLocationId" in entry || materialAmount !== null
                          ? "Quantity"
                          : isBpcPurchase
                              || isPlanBpc
                              || isPlanReaction
                              || activeTab === "Copy"
                              || "countNeeded" in entry
                            ? "Runs"
                            : "Quantity";
                    const imageVariation =
                      planBlueprintVariation
                      ?? (isCopyOfBpo || (isPlanBpc && entry.bpoCount > 0)
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
                      activeTab === "Plan" ? getPlanCells(entry as ResponsePlanItem) : null;
                    const planHaulingQuantity =
                      activeTab === "Plan" && "kind" in entry
                        ? (entry as ResponsePlanItem).haulingQuantity
                        : 0;
                    const manufacturingEntry =
                      activeTab === "Manufacture" ? (entry as ResponseManufacturingJob) : null;
                    const manufacturingDisplayedRuns = manufacturingEntry
                      ? showTotalManufacturingRunCounts
                        ? manufacturingEntry.countNeeded
                        : manufacturingEntry.runsAvailable
                      : 0;
                    const manufacturingDisplayedTime =
                      manufacturingEntry && manufacturingEntry.countNeeded > 0
                        ? (manufacturingEntry.totalTime * manufacturingDisplayedRuns)
                          / manufacturingEntry.countNeeded
                        : 0;
                    return (
                      <Fragment key={`${activeTab}-${index}`}>
                        <div
                          className={`${activeTab === "Plan" ? styles.planTableRow : activeTab === "Copy" ? "grid grid-cols-[minmax(0,1fr)_minmax(74px,auto)_minmax(74px,auto)_minmax(90px,auto)] items-center gap-[13px] max-[640px]:grid-cols-3 max-[640px]:items-start max-[640px]:gap-y-2" : buyBpoEntry || isReactionFormulaBuy ? "grid grid-cols-[minmax(0,1fr)_minmax(150px,auto)_minmax(100px,auto)] items-center gap-[13px] max-[640px]:grid-cols-1 max-[640px]:items-start max-[640px]:gap-y-2" : styles.planRow} ${activeTab === "React" ? styles.reactionRow : activeTab === "Manufacture" ? styles.manufacturingRow : ""}`}
                        >
                          <div
                            className={`${styles.planTypeCell} ${activeTab === "Copy" ? "max-[640px]:col-span-full max-[640px]:w-full" : buyBpoEntry || isReactionFormulaBuy ? "max-[640px]:col-span-1 max-[640px]:w-full" : ""}`}
                          >
                            <TypeIdentity
                              name={name}
                              typeId={typeId}
                              imageSize={40}
                              variation={imageVariation}
                              linkPath={activeTab === "Plan" ? "assets" : "planner"}
                              linkIcon={activeTab === "Plan" ? undefined : ClipboardList}
                              linkSearchParams={activeTab === "Plan" ? undefined : { tab: "Plan" }}
                              navigateInPlace={activeTab !== "Plan"}
                              className={styles.planTypeIdentity}
                            />
                          </div>
                          {activeTab === "React" && "inputs" in entry && (
                            <span className={styles.jobInputsTrigger}>
                              <JobInputsResponsive inputs={reactionInputs ?? entry.inputs} />
                            </span>
                          )}
                          {activeTab === "Manufacture" && "inputs" in entry && (
                            <span className={styles.manufacturingInputsCell}>
                              <JobInputsResponsive inputs={entry.inputs} />
                            </span>
                          )}
                          {activeTab === "Plan" ? (
                            planColumns.map((column) =>
                              planCells?.[column] ? (
                                <span
                                  className={styles.planTableCell}
                                  data-label={column}
                                  key={column}
                                >
                                  <span className={styles.planTableValue}>
                                    {column === "Available" && (
                                      <AvailableSourceIcons
                                        counts={
                                          "availableSourceCounts" in entry
                                            ? entry.availableSourceCounts
                                            : undefined
                                        }
                                        haulingQuantity={planHaulingQuantity}
                                      />
                                    )}
                                    {planCells[column]}
                                  </span>
                                </span>
                              ) : (
                                <span className={styles.planTableCellEmpty} key={column} />
                              ),
                            )
                          ) : activeTab === "Manufacture" ? (
                            <>
                              <span className={styles.manufacturingBlueprintCell}>
                                {formatOptionalCount(manufacturingEntry?.inputs.bpoCount)}
                              </span>
                              <span className={styles.manufacturingBlueprintCell}>
                                {formatOptionalCount(manufacturingEntry?.inputs.bpcRuns)}
                              </span>
                              <span className={styles.manufacturingRunCell}>
                                <strong>
                                  <CopyableText
                                    textToRender={`${manufacturingDisplayedRuns.toLocaleString()} runs`}
                                    textToCopy={String(manufacturingDisplayedRuns)}
                                    copyLabel="Runs"
                                  />
                                </strong>
                                <small>{formatDuration(manufacturingDisplayedTime)}</small>
                              </span>
                            </>
                          ) : activeTab === "Buy" && buyBpoEntry ? (
                            <>
                              <span className="text-right font-mono text-[11px] leading-normal text-muted-foreground whitespace-nowrap max-[640px]:text-left max-[640px]:col-span-1 max-[640px]:w-full">
                                BPO: {buyBpoEntry.bpoCount.toLocaleString()} /{" "}
                                {buyBpoEntry.bposInUse.toLocaleString()} in use
                              </span>
                              <span
                                className={`${styles.planRowAmount} max-[640px]:col-span-1 max-[640px]:w-full`}
                              >
                                <strong>
                                  <CopyableText
                                    textToRender={`${buyBpoEntry.neededQuantity.toLocaleString()} runs needed`}
                                    textToCopy={String(buyBpoEntry.neededQuantity)}
                                    copyLabel="Runs needed"
                                  />
                                  <MarketBuyOrderIndicator quantity={marketBuyOrderQuantity} />
                                </strong>
                              </span>
                            </>
                          ) : activeTab === "Copy" && copyBpoEntry ? (
                            <>
                              <span
                                className="text-right font-mono text-[12px] leading-normal text-foreground max-[640px]:relative max-[640px]:w-auto max-[640px]:pt-3.5 max-[640px]:text-left max-[640px]:before:absolute max-[640px]:before:top-0 max-[640px]:before:left-0 max-[640px]:before:block max-[640px]:before:font-mono max-[640px]:before:text-[9px] max-[640px]:before:tracking-[0.3px] max-[640px]:before:text-muted-foreground max-[640px]:before:uppercase max-[640px]:before:content-[attr(data-label)]"
                                data-label="BPOs in use"
                              >
                                {formatOptionalCount(copyBpoEntry.bposInUse)}
                              </span>
                              <span
                                className="text-right font-mono text-[12px] leading-normal text-foreground max-[640px]:relative max-[640px]:w-auto max-[640px]:pt-3.5 max-[640px]:text-left max-[640px]:before:absolute max-[640px]:before:top-0 max-[640px]:before:left-0 max-[640px]:before:block max-[640px]:before:font-mono max-[640px]:before:text-[9px] max-[640px]:before:tracking-[0.3px] max-[640px]:before:text-muted-foreground max-[640px]:before:uppercase max-[640px]:before:content-[attr(data-label)]"
                                data-label="BPOs owned"
                              >
                                {formatOptionalCount(copyBpoEntry.bpoCount)}
                              </span>
                              <span
                                className={`${styles.planRowAmount} max-[640px]:relative max-[640px]:w-auto max-[640px]:pt-3.5 max-[640px]:text-left max-[640px]:before:absolute max-[640px]:before:top-0 max-[640px]:before:left-0 max-[640px]:before:block max-[640px]:before:font-mono max-[640px]:before:text-[9px] max-[640px]:before:tracking-[0.3px] max-[640px]:before:text-muted-foreground max-[640px]:before:uppercase max-[640px]:before:content-[attr(data-label)]`}
                                data-label="BPC runs"
                              >
                                <strong>
                                  <CopyableText
                                    textToRender={`${copyBpoEntry.neededQuantity.toLocaleString()} needed`}
                                    textToCopy={String(copyBpoEntry.neededQuantity)}
                                    copyLabel="BPC runs needed"
                                  />
                                </strong>
                              </span>
                            </>
                          ) : isReactionFormulaBuy && reactionFormulaSummary ? (
                            <>
                              <span className="text-right font-mono text-[11px] leading-normal text-muted-foreground whitespace-nowrap max-[640px]:text-left max-[640px]:col-span-1 max-[640px]:w-full">
                                Formulas: {reactionFormulaSummary.inUse.toLocaleString()} /{" "}
                                {reactionFormulaSummary.owned.toLocaleString()} in use
                              </span>
                              <span
                                className={`${styles.planRowAmount} max-[640px]:col-span-1 max-[640px]:w-full`}
                              >
                                <strong>
                                  <CopyableText
                                    textToRender={`${materialAmount?.toLocaleString() ?? "0"} units`}
                                    textToCopy={amountToCopy ?? "0"}
                                    copyLabel={amountCopyLabel}
                                  />
                                </strong>
                              </span>
                            </>
                          ) : (
                            <span className={styles.planRowAmount}>
                              {activeTab === "React" ? (
                                <span className={styles.reactionCells}>
                                  <span
                                    className={styles.reactionAvailableCell}
                                    data-label="BPs available"
                                  >
                                    {additionalInstallCount > 0
                                      && reactionIndex === 0
                                      && !addedReactionBuildItems.has(typeId) && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="xs"
                                          className={styles.buyReactionButton}
                                          onClick={() => {
                                            onAddBuildItem({
                                              name,
                                              typeId,
                                              quantity: additionalInstallCount,
                                            });
                                            setAddedReactionBuildItems((current) =>
                                              new Set(current).add(typeId),
                                            );
                                          }}
                                        >
                                          Buy +{additionalInstallCount.toLocaleString()}
                                        </Button>
                                      )}
                                    <strong>
                                      {(
                                        reactionPlan?.availableBlueprints ?? reactionFormulaCount
                                      ).toLocaleString()}
                                    </strong>
                                  </span>
                                  <span
                                    className={styles.reactionValue}
                                    data-label="Suggested installs"
                                  >
                                    <strong>{suggestedInstallCount.toLocaleString()}</strong>
                                  </span>
                                  <span
                                    className={styles.reactionValue}
                                    data-label="Suggested runs"
                                  >
                                    <strong>
                                      {targetRuns === null ? (
                                        "-"
                                      ) : targetRuns > 0 ? (
                                        <CopyableText
                                          textToRender={targetRuns.toLocaleString()}
                                          textToCopy={String(targetRuns)}
                                          copyLabel="Suggested runs"
                                        />
                                      ) : (
                                        targetRuns.toLocaleString()
                                      )}
                                    </strong>
                                    <small>
                                      {installTime !== null ? formatDuration(installTime) : "-"}
                                    </small>
                                  </span>
                                  <span className={styles.reactionValue} data-label="Total needed">
                                    <strong>
                                      {totalNeeded === null ? (
                                        "-"
                                      ) : totalNeeded > 0 ? (
                                        <CopyableText
                                          textToRender={totalNeeded.toLocaleString()}
                                          textToCopy={String(totalNeeded)}
                                          copyLabel="Total needed"
                                        />
                                      ) : (
                                        totalNeeded.toLocaleString()
                                      )}
                                    </strong>
                                    <small>
                                      {totalNeeded !== null
                                      && totalTime !== null
                                      && "countNeeded" in entry
                                        ? formatDuration(
                                            totalNeeded > 0
                                              ? (totalTime * totalNeeded) / entry.countNeeded
                                              : 0,
                                          )
                                        : "-"}
                                    </small>
                                  </span>
                                </span>
                              ) : (
                                <>
                                  <strong>
                                    <CopyableText
                                      textToRender={amount}
                                      textToCopy={amountToCopy ?? amount}
                                      copyLabel={amountCopyLabel}
                                    />
                                  </strong>
                                  <MarketBuyOrderIndicator quantity={marketBuyOrderQuantity} />
                                </>
                              )}
                              {detail && activeTab !== "React" && <small>{detail}</small>}
                            </span>
                          )}
                        </div>
                        {activeTab !== "Plan" && index < rows.length - 1 && (
                          <hr className={styles.planRowSeparator} />
                        )}
                      </Fragment>
                    );
                  })}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
    </>
  );
}

function AvailableSourceIcons({
  counts,
  haulingQuantity = 0,
}: {
  counts?: PlanSourceCountsByLocation;
  haulingQuantity?: number;
}) {
  const summedCounts = sumSourceCounts(counts);
  const icons = (Object.keys(summedCounts) as PlanSourceIcon[]).filter(
    (icon) => (summedCounts[icon] ?? 0) > 0,
  );
  if (!icons.length && haulingQuantity <= 0) return null;
  return (
    <span className={styles.availableSourceIcons} aria-label="Available sources">
      {icons.map((icon) => {
        const sourceIcons: Record<PlanSourceIcon, LucideIcon> = {
          market: ChartLine,
          industry: Factory,
          invention: Microscope,
          copying: TestTubes,
          reprocessing: Minimize2,
        };
        const Icon = sourceIcons[icon];
        const quantity = summedCounts[icon] ?? 0;
        const sourceDescriptions: Record<PlanSourceIcon, string> = {
          market: "in Sell Orders",
          industry: "in Production",
          invention: "being Invented",
          copying: "being Copied",
          reprocessing: "from Reprocessing",
        };
        const label = `${quantity.toLocaleString()} ${sourceDescriptions[icon]}`;
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
      {haulingQuantity > 0 && (
        <span
          className={styles.availableSourceIcon}
          data-source="haul"
          data-tooltip={`${haulingQuantity.toLocaleString()} to haul`}
          aria-label={`${haulingQuantity.toLocaleString()} to haul`}
          role="img"
          tabIndex={0}
        >
          <Truck size={14} strokeWidth={1.8} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

function sumSourceCounts(countsByLocation?: PlanSourceCountsByLocation): PlanSourceCounts {
  const counts: PlanSourceCounts = {};
  for (const sourceCounts of Object.values(countsByLocation ?? {})) {
    for (const [source, quantity] of Object.entries(sourceCounts ?? {})) {
      const sourceIcon = source as PlanSourceIcon;
      counts[sourceIcon] = (counts[sourceIcon] ?? 0) + quantity;
    }
  }
  return counts;
}

function MarketBuyOrderIndicator({ quantity }: { quantity: number }) {
  if (quantity <= 0) return null;
  const label = `${quantity.toLocaleString()} currently in market buy orders`;
  return (
    <span
      className={styles.availableSourceIcon}
      data-source="market"
      data-tooltip={label}
      aria-label={label}
      role="img"
      tabIndex={0}
    >
      <ChartLine size={14} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}
