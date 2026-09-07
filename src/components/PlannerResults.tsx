"use client";

import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ClientPlanStockpile,
  PlanResult,
  PlanSourceCounts,
  PlanSourceIcon,
  PlanStockItem,
} from "@/lib/planning/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import type { ClientCharacterStatus, ClientJobsResponse } from "@/lib/client/requestCache";
import { loadCompressSettings, saveCompressSettings } from "@/lib/planning/compressSettingsStore";
import {
  getNonProductionHaulingQuantity,
  groupBuyEntriesByMarketCategory,
  groupPlanItemEntriesByBuildLocation,
  mergeBuyEntries,
  mergePlanItemEntries,
  createHaulItemExclusionKey,
  parseHaulItemExclusionKey,
  splitReactionRunAllocations,
  splitReactionJobInputs,
  type HaulItemExclusion,
  type PlanBuyEntry,
  type PlanItemEntry,
} from "@/lib/planning/planView";
import { fetchTypeMetadata } from "@/lib/reference/types";
import CopyableText from "@/components/CopyableText";
import JobInputsResponsive, {
  getJobInputsCompletionPercent,
} from "@/components/JobInputsResponsive";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import styles from "@/app/page.module.css";
import {
  ArrowDown,
  ArrowUp,
  Atom,
  Brain,
  Bug,
  ChartLine,
  Check,
  ClipboardList,
  Copy as CopyIcon,
  Factory,
  Minimize2,
  Microscope,
  SquareX,
  TestTubes,
  ShoppingCart,
  Truck,
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

type ReactionScheduleMode = "simple" | "available-slots" | "max-job-length";
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
type ResultsLocations = {
  manufacturing: number;
  reactions: number;
  reprocessing?: number;
  copying?: number;
  invention?: number;
};

function isMultibuyMaterial(entry: PlanBuyEntry): boolean {
  return !("bpoCount" in entry) && !/ formula$/i.test(entry.name);
}

function reactionJobKey(job: { typeId: number; locationId?: number }) {
  return `${job.locationId ?? "unlocated"}:${job.typeId}`;
}

/** Counts unused reaction formulas available at the job's reaction location. */
function getReactionFormulaCount(
  entry: PlanResult["lists"]["reactionJobs"][number],
  stock: PlanStockItem[],
): number {
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

/** Calculates the readiness percentage used to sort a reaction job. */
function getReactionInputsCompletionPercent(
  entry: PlanResult["lists"]["reactionJobs"][number],
  stock: PlanStockItem[],
): number {
  return getJobInputsCompletionPercent(entry.inputs, getReactionFormulaCount(entry, stock));
}

function getStockLocationId(item: PlanStockItem) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

function haulTaskKey(task: PlanResult["lists"]["haulingTasks"][number]) {
  return createHaulItemExclusionKey(task.fromLocationId, task.itemTypeId);
}

type HaulStockItem = PlanStockItem & {
  assembledVolume?: number;
  packagedVolume?: number;
};

function getHaulTasksWithExclusions(
  tasks: PlanResult["lists"]["haulingTasks"],
  stock: HaulStockItem[],
  exclusions: HaulItemExclusion,
): PlanResult["lists"]["haulingTasks"] {
  const tasksByKey = new Map(tasks.map((task) => [haulTaskKey(task), task]));
  const displayedTasks = tasks.filter((task) => !exclusions.has(haulTaskKey(task)));
  for (const [key, destinationLocationId] of exclusions) {
    const parsedKey = parseHaulItemExclusionKey(key);
    if (!parsedKey) continue;
    const existingTask = tasksByKey.get(key);
    if (existingTask) {
      displayedTasks.push({ ...existingTask, toLocationId: destinationLocationId });
      continue;
    }
    const matchingStockItems = stock.filter(
      (item) =>
        item.rootLocationId === parsedKey.sourceRootLocationId
        && item.typeId === parsedKey.itemTypeId
        && item.category !== "blueprint"
        && item.category !== "reactionformula",
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
    displayedTasks.push({
      itemTypeId: parsedKey.itemTypeId,
      name: stockItem?.name ?? `Type ${parsedKey.itemTypeId}`,
      quantity,
      volume,
      fromLocationId: parsedKey.sourceRootLocationId,
      toLocationId: destinationLocationId,
    });
  }
  return displayedTasks;
}

function getBposInUseCount(typeId: number, stock: PlanStockItem[]) {
  return stock
    .filter((item) => item.typeId === typeId && item.category === "blueprint" && item.inUse)
    .reduce(
      (total, item) =>
        total
        + (
          item.blueprintPrints?.filter((print) => print.type === "bpo").length
          ?? (item.blueprintType === "bpo" ? item.quantity : 0)
        ),
      0,
    );
}

function formatBposInUse(count: number) {
  return `${count} BPO${count === 1 ? "" : "s"} In Use`;
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

function getReactionScheduleRuns(schedules: ReactionSchedule[] | undefined) {
  return Math.max(...(schedules ?? []).map((schedule) => schedule.runs), 0);
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
  jobs: PlanResult["lists"]["reactionJobs"],
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
    const runs = showTotalRunCounts ? job.runs : job.runsAvailable;
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
      const perRunTime = job.runs > 0 ? job.totalTime / job.runs : 0;
      const timeLimitedRuns =
        maxJobHours > 0 && perRunTime > 0 ? Math.floor((maxJobHours * 3600) / perRunTime) : runs;
      const simpleInstalls = runs > 0 ? Math.min(blueprintCount, Math.ceil(runs / 10)) : 0;
      const installCount =
        mode === "available-slots"
          ? (installs.get(reactionJobKey(job)) ?? 0)
          : mode === "max-job-length"
            ? timeLimitedRuns > 0
              ? Math.min(blueprintCount, Math.ceil(runs / timeLimitedRuns))
              : 0
            : simpleInstalls;
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

/** Renders the planner output header, bug-report dialog, and every output tab. */
export default function PlannerResults({
  language,
  plan,
  planStatus,
  characterStatuses,
  characterNamesById,
  jobs,
  stock,
  locations,
  stockpiles,
  locationOptions,
  onAddBuildItem,
  onExcludeHaulStockpile,
  haulItemExclusion,
  onToggleHaulItemExclusion,
}: {
  language: SdeLanguage;
  plan: PlanResult | null;
  planStatus: string;
  characterStatuses: ClientCharacterStatus[];
  characterNamesById: Map<number, string>;
  jobs: ClientJobsResponse | null;
  stock: PlanStockItem[];
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
}) {
  const [activeTab, setActiveTab] = useState<PlannerTab>("Plan");
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const resultsHeaderRef = useRef<HTMLDivElement>(null);

  const availableReactionSlots = Object
    .entries(jobs?.slotUsage ?? {})
    .reduce(
      (total, [characterId, usage]) =>
        characterNamesById.has(Number(characterId))
          ? total + Math.max(0, usage.availableSlots.Reactions - usage.slots.Reactions)
          : total,
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
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PlannerTab)}>
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
          <Select
            value={activeTab}
            onValueChange={(value) => value && setActiveTab(value as PlannerTab)}
          >
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
              stock={stock}
              activityLocationIds={activityLocationIds}
              availableReactionSlots={availableReactionSlots}
              locationNamesById={locationNamesById}
              onAddBuildItem={onAddBuildItem}
              onExcludeHaulStockpile={onExcludeHaulStockpile}
              haulItemExclusion={haulItemExclusion}
              onToggleHaulItemExclusion={onToggleHaulItemExclusion}
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
  stock,
  activityLocationIds,
  availableReactionSlots,
  locationNamesById,
  onAddBuildItem,
  onExcludeHaulStockpile,
  haulItemExclusion,
  onToggleHaulItemExclusion,
  resultsHeaderRef,
}: {
  activeTab: PlannerTab;
  language: SdeLanguage;
  plan: PlanResult;
  characterStatuses: ClientCharacterStatus[];
  characterNamesById: Map<number, string>;
  stock: PlanStockItem[];
  activityLocationIds: number[];
  availableReactionSlots: number;
  locationNamesById: Map<number, string>;
  onAddBuildItem: (item: { name: string; typeId: number; quantity: number }) => void;
  onExcludeHaulStockpile: (fromLocationId: number) => Promise<void>;
  haulItemExclusion: HaulItemExclusion;
  onToggleHaulItemExclusion: (
    key: string,
    destinationLocationId: number,
    excluded: boolean,
  ) => Promise<void>;
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
  const [showTotalRunCounts, setShowTotalRunCounts] = useState(false);
  const [showTotalManufacturingRunCounts, setShowTotalManufacturingRunCounts] = useState(false);
  const [planViewMode, setPlanViewMode] = useState<PlanViewMode>("all");
  const [reactionScheduleMode, setReactionScheduleMode] = useState<ReactionScheduleMode>("simple");
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
  const reprocessingJobs =
    (
      plan.lists as Omit<PlanResult["lists"], "reprocessingJobs"> & {
        reprocessingJobs?: PlanResult["lists"]["reprocessingJobs"];
      }
    ).reprocessingJobs ?? [];
  const haulingTasks = getHaulTasksWithExclusions(
    plan.lists.haulingTasks,
    stock,
    haulItemExclusion,
  );
  const rawList =
    activeTab === "Plan"
      ? plan.lists.planItems
      : activeTab === "Buy"
        ? [
            ...plan.lists.materialsToBuy.filter((entry) => entry.buyQuantity > 0),
            ...plan.lists.bpcsToBuy.filter((entry) => entry.buyQuantity > 0),
          ]
        : activeTab === "Copy"
          ? plan.lists.bpcsNeeded.filter((entry) => entry.buyQuantity > 0)
          : activeTab === "Reprocess"
            ? reprocessingJobs
            : activeTab === "Invent"
              ? plan.lists.inventionJobs
              : activeTab === "React"
                ? plan.lists.reactionJobs
                : activeTab === "Manufacture"
                  ? plan.lists.manufacturingJobs
                  : haulingTasks;
  const list =
    activeTab === "Buy"
      ? mergeBuyEntries(rawList as PlanBuyEntry[])
      : activeTab === "Plan" && planViewMode === "all"
        ? mergePlanItemEntries(
            rawList as PlanItemEntry[],
            undefined,
            plan.metadata.availableStockByTypeId,
          )
        : rawList;
  const materialBuyEntries =
    activeTab === "Buy" ? (list as PlanBuyEntry[]).filter(isMultibuyMaterial) : [];
  const buyTypeKey =
    activeTab === "Buy"
      ? [...new Set((list as PlanBuyEntry[]).map((entry) => entry.typeId))].join(",")
      : "";
  const [buyMarketCategories, setBuyMarketCategories] = useState<Map<number, string>>(
    () => new Map(),
  );
  useEffect(() => {
    if (activeTab !== "Buy" || buyTypeKey === "") return;
    let cancelled = false;
    const buyTypeIds = buyTypeKey.split(",").map(Number);
    void fetchTypeMetadata(buyTypeIds, language)
      .then((metadata) => {
        if (cancelled) return;
        setBuyMarketCategories(
          new Map(
            metadata.flatMap((item) =>
              item.marketCategory ? [[item.typeId, item.marketCategory] as const] : [],
            ),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setBuyMarketCategories(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, buyTypeKey, language]);
  const locationGroupedTab =
    activeTab === "Reprocess"
    || activeTab === "Invent"
    || activeTab === "React"
    || activeTab === "Manufacture"
    || (activeTab === "Plan" && planViewMode === "build-location");
  type PlanListEntry =
    | PlanResult["lists"]["planItems"][number]
    | PlanResult["lists"]["materialsToBuy"][number]
    | PlanResult["lists"]["bpcsNeeded"][number]
    | PlanResult["lists"]["inventionJobs"][number]
    | PlanResult["lists"]["reprocessingJobs"][number]
    | PlanResult["lists"]["reactionJobs"][number]
    | PlanResult["lists"]["manufacturingJobs"][number]
    | PlanResult["lists"]["haulingTasks"][number];
  type ReactionDisplayRow = {
    entry: PlanListEntry;
    reactionPlan: ReactionSchedule | null;
    reactionIndex: number;
  };
  const locationGroups = new Map<number | undefined, PlanListEntry[]>();
  if (locationGroupedTab) {
    if (activeTab === "Plan") {
      for (const [locationId, entries] of groupPlanItemEntriesByBuildLocation(
        rawList as PlanItemEntry[],
      )) {
        locationGroups.set(locationId, entries);
      }
    }
    else {
      for (const entry of list) {
        const locationId = "locationId" in entry ? entry.locationId : undefined;
        const group = locationGroups.get(locationId) ?? [];
        group.push(entry as PlanListEntry);
        locationGroups.set(locationId, group);
      }
    }
  }
  const sortedLocationGroups = [...locationGroups.entries()].sort(([left], [right]) => {
    const leftName = locationNamesById.get(left ?? 0) ?? String(left ?? "Location unavailable");
    const rightName = locationNamesById.get(right ?? 0) ?? String(right ?? "Location unavailable");
    return leftName.localeCompare(rightName);
  });
  const categoryGroupedTab = activeTab === "Buy";
  const categoryGroups = categoryGroupedTab
    ? groupBuyEntriesByMarketCategory(list as PlanBuyEntry[], buyMarketCategories)
    : undefined;
  const displayGroups = (
    categoryGroupedTab
      ? [...(categoryGroups ?? new Map())]
      : locationGroupedTab
        ? sortedLocationGroups
        : [[undefined, list as PlanListEntry[]]]
  ) as Array<[number | string | undefined, PlanListEntry[]]>;
  const reactionSchedule = buildReactionSchedule(
    plan.lists.reactionJobs,
    stock,
    showTotalRunCounts,
    reactionScheduleMode,
    availableReactionSlots,
    Number(maxJobHours),
  );
  const reactionSummary = plan.lists.reactionJobs.reduce(
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
  const reactionCoverage = plan.lists.reactionJobs
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
        let remainingRuns = job.runs;
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
  const totalInstallableReactionRuns = plan.lists.reactionJobs.reduce(
    (total, job) => total + job.runsAvailable,
    0,
  );
  const totalReactionRuns = plan.lists.reactionJobs.reduce((total, job) => total + job.runs, 0);
  const sortedDisplayGroups =
    activeTab === "React" || activeTab === "Manufacture"
      ? (displayGroups.map(([locationId, entries]) => [
          locationId,
          entries
            .slice()
            .sort((left, right) => {
              const leftTypeId = "itemTypeId" in left ? left.itemTypeId : left.typeId;
              const rightTypeId = "itemTypeId" in right ? right.itemTypeId : right.typeId;
              if (activeTab === "Manufacture") {
                const leftManufacturing = left as PlanResult["lists"]["manufacturingJobs"][number];
                const rightManufacturing =
                  right as PlanResult["lists"]["manufacturingJobs"][number];
                const leftValue =
                  manufacturingSort.key === "type"
                    ? leftManufacturing.name
                    : manufacturingSort.key === "inputs"
                      ? getJobInputsCompletionPercent(leftManufacturing.inputs)
                      : showTotalManufacturingRunCounts
                        ? leftManufacturing.runs
                        : leftManufacturing.runsAvailable;
                const rightValue =
                  manufacturingSort.key === "type"
                    ? rightManufacturing.name
                    : manufacturingSort.key === "inputs"
                      ? getJobInputsCompletionPercent(rightManufacturing.inputs)
                      : showTotalManufacturingRunCounts
                        ? rightManufacturing.runs
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
                reactionJobKey(left as PlanResult["lists"]["reactionJobs"][number]),
              );
              const rightSchedule = reactionSchedule.get(
                reactionJobKey(right as PlanResult["lists"]["reactionJobs"][number]),
              );
              const leftValue =
                reactionSort.key === "type"
                  ? left.name
                  : reactionSort.key === "inputs"
                    ? getReactionInputsCompletionPercent(
                        left as PlanResult["lists"]["reactionJobs"][number],
                        stock,
                      )
                    : reactionSort.key === "suggestedRuns"
                      ? getReactionScheduleRuns(leftSchedule)
                      : "runs" in left
                        ? showTotalRunCounts
                          ? left.runs
                          : "runsAvailable" in left
                            ? left.runsAvailable
                            : left.runs
                        : 0;
              const rightValue =
                reactionSort.key === "type"
                  ? right.name
                  : reactionSort.key === "inputs"
                    ? getReactionInputsCompletionPercent(
                        right as PlanResult["lists"]["reactionJobs"][number],
                        stock,
                      )
                    : reactionSort.key === "suggestedRuns"
                      ? getReactionScheduleRuns(rightSchedule)
                      : "runs" in right
                        ? showTotalRunCounts
                          ? right.runs
                          : "runsAvailable" in right
                            ? right.runsAvailable
                            : right.runs
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
      : displayGroups;
  const maxCopyBuildTime = Math.max(...plan.lists.bpcsNeeded.map((entry) => entry.buildTime), 0);
  const haulGroups = new Map<
    string,
    {
      fromLocationId: number;
      toLocationId: number;
      tasks: PlanResult["lists"]["haulingTasks"];
    }
  >();
  if (activeTab === "Haul") {
    for (const task of haulingTasks) {
      const key = `${task.fromLocationId}:${task.toLocationId}`;
      const group = haulGroups.get(key) ?? {
        fromLocationId: task.fromLocationId,
        toLocationId: task.toLocationId,
        tasks: [],
      };
      group.tasks.push(task);
      haulGroups.set(key, group);
    }
    for (const group of haulGroups.values()) {
      group.tasks.sort(
        (left, right) => left.name.localeCompare(right.name) || left.itemTypeId - right.itemTypeId,
      );
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
        "Buy/Build": (
          Math.max(0, entry.productionQuantity - (entry.reprocessingQuantity ?? 0))
          + entry.buyQuantity
        ).toLocaleString(),
        Surplus: Math
          .max(0, entry.availableStockQuantity - entry.requiredQuantity)
          .toLocaleString(),
      };
    }
    if (entry.kind === "bpc") {
      return {
        Required: `${entry.neededQuantity.toLocaleString()} runs`,
        Available: `${entry.stockRuns.toLocaleString()} runs`,
        "Buy/Build": `${Math.max(0, entry.neededQuantity - entry.stockRuns).toLocaleString()} runs`,
        Surplus: `${Math.max(0, entry.stockRuns - entry.neededQuantity).toLocaleString()} runs`,
      };
    }
    return {
      Required: `${entry.runsNeeded.toLocaleString()} runs`,
      Available: entry.availableQuantity.toLocaleString(),
      "Buy/Build": "-",
      Surplus: "-",
    };
  }

  function getPlanHaulingQuantity(entry: PlanResult["lists"]["planItems"][number]) {
    const stockpileId = "stockpileId" in entry ? entry.stockpileId : undefined;
    const buildLocationId = "buildLocationId" in entry ? entry.buildLocationId : undefined;
    const haulActivityLocationIds = new Set(activityLocationIds);
    if (buildLocationId !== undefined) haulActivityLocationIds.add(buildLocationId);
    if (haulActivityLocationIds.size === 0) return 0;
    return plan.lists.haulingTasks
      .filter(
        (task) =>
          task.itemTypeId === entry.typeId
          && haulActivityLocationIds.has(task.toLocationId)
          && (stockpileId === undefined || task.stockpileId === stockpileId),
      )
      .reduce(
        (total, task) =>
          total + getNonProductionHaulingQuantity(task.quantity, task.productionQuantity ?? 0),
        0,
      );
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
      items: materialBuyEntries.map((entry) => ({
        name: entry.name,
        typeId: entry.typeId,
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
            ...displayGroups
              .flatMap(([, entries]) => entries)
              .map((entry) => {
                const cells = getPlanCells(entry as PlanItemEntry);
                return [entry.name, ...planColumns.map((column) => cells[column] || "")].join("\t");
              }),
          ]
        : (activeTab === "Buy" ? materialBuyEntries : list).map((entry) => {
            return `${entry.name}\t${getListAmount(entry)}`;
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
          .map((entry) => `${entry.name}\t${getListAmount(entry)}`)
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
                      {reactionScheduleMode === "available-slots"
                        ? "Solve for available slots"
                        : reactionScheduleMode === "max-job-length"
                          ? "Max job length"
                          : "Simple"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="simple">Simple</SelectItem>
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
            <div className={styles.reactionResultsActions}>
              <div className={styles.reactionSummary}>
                <span>
                  <strong>{availableReactionSlots.toLocaleString()}</strong>
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
              <Button type="button" variant="outline" onClick={copyList}>
                <CopyIcon aria-hidden="true" />
                {copyStatus || "Copy list"}
              </Button>
            </div>
          )}
          {activeTab === "Manufacture" && (
            <div className={styles.reactionDisplayControls}>
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
          {activeTab === "Plan" && (
            <div className={styles.planViewControls}>
              <Label htmlFor="plan-view-mode">View</Label>
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
        <div className={styles.copySummary}>
          <strong>{formatDuration(maxCopyBuildTime)}</strong>
          <span>MAX BUILD TIME</span>
        </div>
      )}
      {activeTab === "Haul" ? (
        <div className={styles.haulGroups}>
          {[...haulGroups.values()].map((group) => (
            <section
              className={styles.haulGroup}
              key={`${group.fromLocationId}:${group.toLocationId}`}
            >
              <header className={styles.haulGroupHeader}>
                <span>From</span>
                <strong>
                  {locationNamesById.get(group.fromLocationId) ?? group.fromLocationId}
                </strong>
                <span>To</span>
                <strong>{locationNamesById.get(group.toLocationId) ?? group.toLocationId}</strong>
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
                        : "Exclude and Recalculate"}
                    </span>
                  </Button>
                </div>
              </header>
              <div className={styles.haulGroupRows}>
                {group.tasks.map((task) => {
                  const key = haulTaskKey(task);
                  const isExcluded = haulItemExclusion.has(key);
                  return (
                    <div
                      className={`${styles.haulRow} ${isExcluded ? styles.haulRowDisabled : ""}`}
                      key={key}
                    >
                      <span className={styles.haulRowSwitch}>
                        {togglingHaulItemKey === key ? (
                          <Spinner aria-hidden="true" />
                        ) : (
                          <Switch
                            aria-label={`Include ${task.name} haul`}
                            checked={!isExcluded}
                            disabled={togglingHaulItemKey !== null}
                            onCheckedChange={(checked) => {
                              setTogglingHaulItemKey(key);
                              void onToggleHaulItemExclusion(
                                key,
                                task.toLocationId,
                                !checked,
                              ).finally(() => setTogglingHaulItemKey(null));
                            }}
                          />
                        )}
                      </span>
                      <TypeIdentity
                        name={task.name}
                        typeId={task.itemTypeId}
                        imageSize={40}
                        className={styles.planTypeIdentity}
                      />
                      <span className={styles.haulRowAmount}>
                        <CopyableText
                          textToRender={`${task.quantity.toLocaleString()} units`}
                          textToCopy={String(task.quantity)}
                          copyLabel="Quantity"
                        />
                        <small>{Math.ceil(task.volume).toLocaleString()} m3</small>
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
          {sortedDisplayGroups.map(([locationId, entries]) => (
            <Fragment key={locationId ?? "unlocated"}>
              {(locationGroupedTab || categoryGroupedTab) && (
                <h3 className={styles.locationGroupHeader}>
                  <span>
                    {categoryGroupedTab
                      ? locationId
                      : (
                          locationNamesById.get(Number(locationId ?? 0))
                          ?? locationId
                          ?? "Location unavailable"
                        )}
                  </span>
                  {categoryGroupedTab && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void copyGroupMultibuy(String(locationId), entries as PlanBuyEntry[])
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
              {entries
                .flatMap<ReactionDisplayRow>((entry) => {
                  const schedules =
                    activeTab === "React" && "inputs" in entry
                      ? (
                          reactionSchedule.get(
                            reactionJobKey(entry as PlanResult["lists"]["reactionJobs"][number]),
                          ) ?? []
                        )
                      : [];
                  return schedules.length > 0
                    ? schedules.map((reactionPlan, reactionIndex) => ({
                        entry,
                        reactionPlan,
                        reactionIndex,
                      }))
                    : [{ entry, reactionPlan: null, reactionIndex: 0 }];
                })
                .map(({ entry, reactionPlan, reactionIndex }, index, rows) => {
                  const rowSchedules =
                    activeTab === "React" && "inputs" in entry
                      ? (
                          reactionSchedule.get(
                            reactionJobKey(entry as PlanResult["lists"]["reactionJobs"][number]),
                          ) ?? []
                        )
                      : [];
                  const typeId = "itemTypeId" in entry ? entry.itemTypeId : entry.typeId;
                  const name = entry.name;
                  const isPlanBpc = "kind" in entry && entry.kind === "bpc";
                  const isBpcPurchase = activeTab === "Buy" && "bpoCount" in entry;
                  const isCopyOfBpo =
                    activeTab === "Copy" && "bpoCount" in entry && entry.bpoCount > 0;
                  const bposInUse =
                    activeTab === "Buy" && "bpoCount" in entry
                      ? "bposInUse" in entry && typeof entry.bposInUse === "number"
                        ? entry.bposInUse
                        : getBposInUseCount(typeId, stock)
                      : 0;
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
                      ? getReactionFormulaCount(
                          entry as PlanResult["lists"]["reactionJobs"][number],
                          stock,
                        )
                      : 0;
                  const precedingRuns = rowSchedules
                    .slice(0, reactionIndex)
                    .reduce((total, schedule) => total + schedule.totalRuns, 0);
                  const reactionInputs =
                    activeTab === "React"
                    && reactionPlan !== null
                    && rowSchedules.length > 1
                    && "inputs" in entry
                    && "runs" in entry
                      ? splitReactionJobInputs(
                          entry.inputs,
                          entry.runs,
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
                    activeTab === "React" && "runs" in entry && "runsAvailable" in entry
                      ? (
                          reactionPlan?.totalRuns
                          ?? (showTotalRunCounts ? entry.runs : entry.runsAvailable)
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
                                      && suggestedInstallCount > 1
                                      && targetRuns !== null
                                      && installTime !== null
                                      ? `${suggestedInstallCount.toLocaleString()} x ${targetRuns.toLocaleString()} runs @ ${formatDuration(installTime)} | ${entry.runs.toLocaleString()} runs`
                                      : `${totalTime !== null ? `${formatDuration(totalTime)} | ` : ""}${entry.runs.toLocaleString()} ${activeTab === "Invent" ? "attempts" : "runs"}`
                                    : "";
                  const amountToCopy =
                    "volume" in entry
                      ? String(entry.quantity)
                      : isBpcPurchase
                        ? String(entry.buyQuantity)
                        : isPlanBpc
                          ? String(entry.neededQuantity)
                          : isPlanReaction
                            ? String(entry.runsNeeded)
                            : materialEntry
                              ? String(materialEntry.buildQuantity || materialEntry.buyQuantity)
                              : activeTab === "Copy" && "neededQuantity" in entry
                                ? String(Math.max(0, entry.neededQuantity - entry.stockRuns))
                                : "quantity" in entry
                                  ? String(entry.quantity)
                                  : "runs" in entry
                                    ? String(entry.runs)
                                    : null;
                  const amountCopyLabel =
                    activeTab === "Invent"
                      ? "Attempts"
                      : "volume" in entry || materialEntry
                        ? "Quantity"
                        : isBpcPurchase
                            || isPlanBpc
                            || isPlanReaction
                            || activeTab === "Copy"
                            || "runs" in entry
                          ? "Runs"
                          : "Quantity";
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
                  const planHaulingQuantity =
                    activeTab === "Plan"
                      ? getPlanHaulingQuantity(entry as PlanResult["lists"]["planItems"][number])
                      : 0;
                  const manufacturingEntry =
                    activeTab === "Manufacture"
                      ? (entry as PlanResult["lists"]["manufacturingJobs"][number])
                      : null;
                  const manufacturingDisplayedRuns = manufacturingEntry
                    ? showTotalManufacturingRunCounts
                      ? manufacturingEntry.runs
                      : manufacturingEntry.runsAvailable
                    : 0;
                  const manufacturingDisplayedTime =
                    manufacturingEntry && manufacturingEntry.runs > 0
                      ? (manufacturingEntry.totalTime * manufacturingDisplayedRuns)
                        / manufacturingEntry.runs
                      : 0;
                  return (
                    <Fragment key={`${activeTab}-${index}`}>
                      <div
                        className={`${activeTab === "Plan" ? styles.planTableRow : styles.planRow} ${activeTab === "React" ? styles.reactionRow : activeTab === "Manufacture" ? styles.manufacturingRow : ""}`}
                      >
                        <div className={styles.planTypeCell}>
                          <TypeIdentity
                            name={name}
                            typeId={typeId}
                            imageSize={40}
                            variation={imageVariation}
                            className={styles.planTypeIdentity}
                          />
                          {bposInUse > 0 && (
                            <Badge variant="outline">{formatBposInUse(bposInUse)}</Badge>
                          )}
                        </div>
                        {activeTab === "React" && "inputs" in entry && (
                          <span className={styles.jobInputsTrigger}>
                            <JobInputsResponsive
                              inputs={reactionInputs ?? entry.inputs}
                              reactionFormulaCount={
                                reactionPlan?.availableBlueprints ?? reactionFormulaCount
                              }
                            />
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
                                <span className={styles.reactionValue} data-label="Suggested runs">
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
                                    {totalNeeded !== null && totalTime !== null && "runs" in entry
                                      ? formatDuration(
                                          totalNeeded > 0
                                            ? (totalTime * totalNeeded) / entry.runs
                                            : 0,
                                        )
                                      : "-"}
                                  </small>
                                </span>
                              </span>
                            ) : (
                              <strong>
                                <CopyableText
                                  textToRender={amount}
                                  textToCopy={amountToCopy ?? amount}
                                  copyLabel={amountCopyLabel}
                                />
                              </strong>
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
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function AvailableSourceIcons({
  counts,
  haulingQuantity = 0,
}: {
  counts?: PlanSourceCounts;
  haulingQuantity?: number;
}) {
  const icons = (Object.keys(counts ?? {}) as PlanSourceIcon[]).filter(
    (icon) => (counts?.[icon] ?? 0) > 0,
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
        const quantity = counts?.[icon] ?? 0;
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
