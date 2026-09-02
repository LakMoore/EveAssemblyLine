"use client";

import {
  type ChangeEvent,
  Fragment,
  FormEvent,
  KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  ClientBuildItem,
  ClientPlanBucket,
  PlanBucketLocations,
  PlanResult,
  PlanSourceCounts,
  PlanSourceIcon,
  PlanStockItem,
} from "@/lib/planning/types";
import { loadBuildList, saveBuildList } from "@/lib/planning/buildListStore";
import { loadPlannerBuckets, savePlannerBuckets } from "@/lib/planning/plannerBucketsStore";
import { loadStructures } from "@/lib/planning/structureStore";
import { loadCompressSettings, saveCompressSettings } from "@/lib/planning/compressSettingsStore";
import {
  loadBuildBlacklist,
  loadExcludedLocationIds,
  loadPlannerLocations,
  saveExcludedLocationIds,
  savePlannerLocations,
} from "@/lib/planning/plannerPreferencesStore";
import {
  loadClientSession,
  loadClientJobs,
  loadClientStateStatus,
  loadClientAssets,
  type ClientCharacterStatus,
  type ClientJobsResponse,
} from "@/lib/client/requestCache";
import { fetchFacilityResponse } from "@/lib/planning/facilitiesStore";
import { loadPlannerReprocessingEfficiencies } from "@/lib/planning/reprocessingClient";
import {
  getNonProductionHaulingQuantity,
  groupPlanItemEntriesByBuildLocation,
  mergeBuyEntries,
  mergePlanItemEntries,
  type PlanBuyEntry,
  type PlanItemEntry,
} from "@/lib/planning/planView";
import {
  defaultLocations,
  defaultSettings,
  parsePlannerSettings,
  settingsStorageKey,
  type PlannerLocations,
  type PlannerSettings,
} from "@/lib/planning/preferences";
import type { SdeLanguage } from "@/lib/reference/languages";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { useAppLanguage } from "../AppShell";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import CopyableText from "@/components/CopyableText";
import JobInputsResponsive from "@/components/JobInputsResponsive";
import CalculateButton from "@/components/CalculateButton";
import TypeSearch from "@/components/TypeSearch";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import styles from "../page.module.css";
import {
  ArrowDown,
  ArrowUp,
  Atom,
  Brain,
  ChartLine,
  Clipboard,
  Copy as CopyIcon,
  Check,
  Info,
  ClipboardList,
  Minimize2,
  Microscope,
  Repeat,
  ShoppingCart,
  SquareX,
  TestTubes,
  Trash2,
  Truck,
  Factory,
  X,
  Download,
  Pencil,
  Plus,
  Upload,
  type LucideIcon,
} from "lucide-react";
import PasteListDialog from "@/components/PasteListDialog";
import PlannerBucketEditor, {
  type ActivityLocationOption,
  type StockLocationOption,
} from "@/components/PlannerBucketEditor";

type PlannerTab =
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
type PlanLocationOption = {
  id: string;
  locationId: number;
  name: string;
  baseYield: number;
  baseManufacturingMe: number;
  baseReactionMe: number;
  manufacturingTimeMultiplier: number;
  reactionTimeMultiplier: number;
};

type ReactionScheduleMode = "simple" | "available-slots" | "max-job-length";
type ReactionSchedule = { installs: number; runs: number; time: number };
type ReactionCoverage = { installable: number; total: number };
type ReactionSortKey = "type" | "suggestedRuns" | "totalNeeded";
type ReactionSort = { key: ReactionSortKey; direction: "asc" | "desc" };
type ManufacturingSort = { key: "type" | "runs"; direction: "asc" | "desc" };
type PlanViewMode = "all" | "build-location";

function reactionJobKey(job: { typeId: number; locationId?: number }) {
  return `${job.locationId ?? "unlocated"}:${job.typeId}`;
}

const industrySkillIds = {
  industry: 3380,
  advancedIndustry: 3388,
  reactions: 45746,
} as const;

function skillTimeMultiplier(
  skills: Array<{ skillId: number; activeSkillLevel: number }> | undefined,
  skillBonuses: Array<{ skillId: number; bonusPerLevel: number }>,
) {
  const levels = new Map((skills ?? []).map((skill) => [skill.skillId, skill.activeSkillLevel]));
  return skillBonuses.reduce(
    (multiplier, bonus) =>
      multiplier * (1 - (levels.get(bonus.skillId) ?? 0) * bonus.bonusPerLevel),
    1,
  );
}

function buildReactionSchedule(
  jobs: PlanResult["lists"]["reactionJobs"],
  stock: PlanStockItem[],
  showTotalRunCounts: boolean,
  mode: ReactionScheduleMode,
  availableReactionSlots: number,
  maxJobHours: number,
): Map<string, ReactionSchedule> {
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
      const runsPerInstall =
        installCount > 0
          ? mode === "max-job-length"
            ? Math.min(timeLimitedRuns, Math.ceil(runs / installCount))
            : Math.ceil(runs / installCount)
          : 0;
      return [
        reactionJobKey(job),
        {
          installs: Math.min(installCount, maxInstalls),
          runs: runsPerInstall,
          time: perRunTime * runsPerInstall,
        },
      ];
    }),
  );
}

function getStockLocationId(item: PlanStockItem) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

function formatCoverage(coveredRuns: number, totalRuns: number) {
  return totalRuns > 0 ? `${((coveredRuns / totalRuns) * 100).toFixed(1)}%` : "0.0%";
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

function bucketLocationsFromPlannerLocations(locations: PlannerLocations): PlanBucketLocations {
  return {
    stock: locations.manufacturing,
    manufacturing: locations.manufacturing,
    reactions: locations.reactions,
    reprocessing: locations.reprocessing ?? locations.manufacturing,
    copying: locations.copying ?? locations.manufacturing,
    invention: locations.invention ?? locations.manufacturing,
  };
}

function createPlannerBucket(
  locations: PlannerLocations,
  items: ClientBuildItem[] = [],
  name = "New stock destination",
): ClientPlanBucket {
  return {
    id: `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    locations: bucketLocationsFromPlannerLocations(locations),
    items,
  };
}

function isImportedPlan(value: unknown): value is {
  buckets: ClientPlanBucket[];
  settings?: unknown;
  includeAssets?: unknown;
  excludedLocationIds?: unknown;
} {
  if (!value || typeof value !== "object") return false;
  const buckets = (value as { buckets?: unknown }).buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) return false;
  return buckets.every((bucket) => {
    if (!bucket || typeof bucket !== "object") return false;
    const candidate = bucket as Partial<ClientPlanBucket>;
    return (
      typeof candidate.id === "string"
      && typeof candidate.name === "string"
      && Array.isArray(candidate.items)
      && candidate.items.every(
        (item) =>
          Number.isInteger(item.typeId)
          && Number.isFinite(item.quantity)
          && item.quantity > 0
          && typeof item.name === "string",
      )
      && candidate.locations !== undefined
      && Object
        .values(candidate.locations)
        .every((locationId) => Number.isSafeInteger(locationId) && Number(locationId) > 0)
    );
  });
}

function Planner() {
  const [items, setItems] = useState<ClientBuildItem[]>([]);
  const requirementsHeaderRef = useRef<HTMLParagraphElement>(null);
  const buildListHeaderRef = useRef<HTMLDivElement>(null);
  const resultsHeaderRef = useRef<HTMLDivElement>(null);
  const { language } = useAppLanguage();
  const [isBuildListLoaded, setIsBuildListLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<PlannerTab>("Plan");
  const activeTabDefinition = tabs.find((tab) => tab.value === activeTab) ?? tabs[0];
  const ActiveTabIcon = activeTabDefinition.icon;
  const [planStatus, setPlanStatus] = useState("Ready to calculate");
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [isExcludedLocationsModalOpen, setIsExcludedLocationsModalOpen] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = useState(false);
  const [isClearExcludedLocationsDialogOpen, setIsClearExcludedLocationsDialogOpen] =
    useState(false);
  const [characterStatuses, setCharacterStatuses] = useState<ClientCharacterStatus[]>([]);
  const [jobs, setJobs] = useState<ClientJobsResponse | null>(null);
  const [characterNamesById, setCharacterNamesById] = useState<Map<number, string>>(new Map());
  const [planningCharacterId, setPlanningCharacterId] = useState<number | undefined>();
  const [stock, setStock] = useState<PlanStockItem[]>([]);
  const [buckets, setBuckets] = useState<ClientPlanBucket[]>([]);
  const [areBucketsLoaded, setAreBucketsLoaded] = useState(false);
  const [editingBucket, setEditingBucket] = useState<ClientPlanBucket | null>(null);
  const [isBucketEditorOpen, setIsBucketEditorOpen] = useState(false);
  const [knownStructures, setKnownStructures] = useState<
    Awaited<ReturnType<typeof loadStructures>>
  >([]);
  const [planImportInputKey, setPlanImportInputKey] = useState(0);
  const [excludedLocationIds, setExcludedLocationIds] = useState<number[]>([]);
  const [locationOptions, setLocationOptions] = useState<PlanLocationOption[]>([]);
  const [includeStock, setIncludeStock] = useState(true);
  const [locations, setLocations] = useState<PlannerLocations>(defaultLocations);
  const [settings, setSettings] = useState<PlannerSettings>(() => {
    if (typeof window === "undefined") return defaultSettings;
    try {
      const stored = window.localStorage.getItem(settingsStorageKey);
      return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
    }
    catch {
      return defaultSettings;
    }
  });

  useEffect(() => {
    let cancelled = false;
    void loadClientSession()
      .then(async (session) => {
        if (cancelled || !session.authenticated) return;
        const activeCharacters = (session.characters ?? []).filter(
          (character) => !character.onDeployment,
        );
        setCharacterNamesById(
          new Map(
            activeCharacters.map((character) => [character.characterId, character.characterName]),
          ),
        );
        const state = await loadClientStateStatus();
        const activeCharacterIds = new Set(
          activeCharacters.map((character) => character.characterId),
        );
        const activeStatuses = (state.characters ?? []).filter((character) =>
          activeCharacterIds.has(character.characterId),
        );
        setCharacterStatuses(activeStatuses);
        setPlanningCharacterId((current) => current ?? activeStatuses[0]?.characterId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function updateLocations(next: Partial<Pick<PlannerLocations, "manufacturing" | "reactions">>) {
    const updatedLocations = { ...locations, ...next };
    setLocations(updatedLocations);
    void savePlannerLocations(updatedLocations);
  }

  function reactionSkillBonus(characterId: number | undefined) {
    const character = characterStatuses.find((entry) => entry.characterId === characterId);
    const skill = character?.skills?.body?.find(
      (entry) => entry.skillId === industrySkillIds.reactions,
    );
    return (skill?.activeSkillLevel ?? 0) * 4;
  }

  useEffect(() => {
    void loadBuildBlacklist().then((buildBlacklist) => {
      if (buildBlacklist) setSettings((current) => ({ ...current, buildBlacklist }));
    });
    void loadExcludedLocationIds().then(setExcludedLocationIds);
    loadPlannerBuckets()
      .then(async (savedBuckets) => {
        if (savedBuckets !== null) {
          const localizedBuckets = await Promise.all(
            savedBuckets.map(async (bucket) => ({
              ...bucket,
              items: await localizeItems(bucket.items, language),
            })),
          );
          setBuckets(localizedBuckets);
          setItems(localizedBuckets[0]?.items ?? []);
          return;
        }
        const savedItems = await loadBuildList();
        const localizedItems = await localizeItems(savedItems, language);
        setItems(localizedItems);
        setBuckets([createPlannerBucket(defaultLocations, localizedItems, "Primary destination")]);
      })
      .catch(() => {
        setItems([]);
        setBuckets([]);
      })
      .finally(() => setAreBucketsLoaded(true));
  }, [language]);

  useEffect(() => {
    void loadStructures().then(setKnownStructures);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadLocationOptions(reload = false) {
      const [data, storedLocations] = await Promise.all([
        fetchFacilityResponse(reload),
        loadPlannerLocations(),
      ]);
      if (cancelled) return;
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
          manufacturingTimeMultiplier:
            facility.activities.manufacturing.rawJobDurationMultiplier ?? 1,
          reactionTimeMultiplier: facility.activities.reactions.rawJobDurationMultiplier ?? 1,
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
      setLocationOptions(options);
      setLocations(nextLocations);
      void savePlannerLocations(nextLocations);
    }

    void loadLocationOptions().catch(() => {
      if (!cancelled) setLocationOptions([]);
    });
    function handleFacilitiesRefresh() {
      void loadLocationOptions().catch(() => {
        if (!cancelled) setLocationOptions([]);
      });
    }
    window.addEventListener("assembly-line-esi-refreshed", handleFacilitiesRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleFacilitiesRefresh);
    };
  }, [language]);

  useEffect(() => {
    if (areBucketsLoaded) void savePlannerBuckets(buckets);
  }, [areBucketsLoaded, buckets]);

  async function submitPlan(exclusions: Set<number>) {
    const plannerItems = buckets.flatMap((bucket) => bucket.items);
    if (plannerItems.length === 0 || isPlanLoading) return;
    setIsPlanLoading(true);
    setPlanStatus("Calculating...");
    try {
      let workingAssets: PlanStockItem[] = [];
      if (includeStock && (await loadClientSession()).authenticated) {
        const assetsData = await loadClientAssets(language, true);
        workingAssets = assetsData.assets ?? [];
      }
      const compressSettings = await loadCompressSettings();
      const compressLocationId = Number(compressSettings.locationId);
      const populatedBuckets = buckets.filter((bucket) => bucket.items.length > 0);
      const primaryBucketLocations = populatedBuckets[0]?.locations;
      const planningLocations = Number.isInteger(compressLocationId)
        ? { ...locations, ...primaryBucketLocations, reprocessing: compressLocationId }
        : { ...locations, ...primaryBucketLocations };
      const freshFacilities = await fetchFacilityResponse(true);
      const freshFacilityById = new Map(
        (freshFacilities?.facilities ?? []).map((facility) => [facility.id, facility]),
      );
      const manufacturingFacility = freshFacilityById.get(planningLocations.manufacturing);
      const reactionFacility = freshFacilityById.get(planningLocations.reactions);
      const reprocessingEfficiencies = await loadPlannerReprocessingEfficiencies(
        language,
        planningLocations.reprocessing,
      );
      const requestStock = workingAssets.filter((item) => {
        const locationId = getStockLocationId(item);
        return locationId === undefined || !exclusions.has(locationId);
      });
      setStock(requestStock);
      const planningCharacter = characterStatuses.find(
        (character) => character.characterId === planningCharacterId,
      );
      const planningSkills = planningCharacter?.skills?.body ?? undefined;
      const response = await fetch(
        "/api/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            toBuild: plannerItems.map(({ typeId, quantity, me, te, fromCompression }) => ({
              typeId,
              quantity,
              me,
              te,
              fromCompression,
            })),
            buckets:
              populatedBuckets.length > 0
                ? populatedBuckets.map((bucket) => ({
                    ...bucket,
                    items: bucket.items.map(({ typeId, quantity, me, te, fromCompression }) => ({
                      typeId,
                      quantity,
                      me,
                      te,
                      fromCompression,
                    })),
                  }))
                : undefined,
            reprocessingEfficiencies,
            assets: requestStock.map(
              ({ sourceLocationName: _sourceLocationName, ...item }) => item,
            ),
            locations: planningLocations,
            facilityTimeMultipliers: {
              manufacturing:
                manufacturingFacility?.activities.manufacturing.rawJobDurationMultiplier
                ?? selectedManufacturingLocation?.manufacturingTimeMultiplier
                ?? 1,
              reactions:
                reactionFacility?.activities.reactions.rawJobDurationMultiplier
                ?? selectedReactionLocation?.reactionTimeMultiplier
                ?? 1,
            },
            skillTimeMultipliers: {
              manufacturing: skillTimeMultiplier(
                planningSkills,
                [
                  { skillId: industrySkillIds.industry, bonusPerLevel: 0.04 },
                  { skillId: industrySkillIds.advancedIndustry, bonusPerLevel: 0.03 },
                ],
              ),
              reactions: skillTimeMultiplier(
                planningSkills,
                [{ skillId: industrySkillIds.reactions, bonusPerLevel: 0.04 }],
              ),
            },
            settings: {
              includeCorporationAssets: settings.includeCorporationAssets,
              personalSellOrdersAsStock: settings.personalSellOrdersAsStock,
              allCorporationSellOrdersAsStock: settings.allCorporationSellOrdersAsStock,
              myCorporationSellOrdersAsStock: settings.myCorporationSellOrdersAsStock,
              buildBlacklist: settings.buildBlacklist.map((item) => item.typeId),
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
        const jobsData = session.authenticated ? await loadClientJobs() : null;
        setJobs(jobsData);
        const activeCharacters = (session.characters ?? []).filter(
          (character) => !character.onDeployment,
        );
        setCharacterNamesById(
          new Map(
            activeCharacters.map((character) => [character.characterId, character.characterName]),
          ),
        );
        const activeCharacterIds = new Set(
          activeCharacters.map((character) => character.characterId),
        );
        setCharacterStatuses(
          (status.characters ?? []).filter((character) =>
            activeCharacterIds.has(character.characterId),
          ),
        );
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
    const nextIds = [...nextExcludedLocationIds];
    setExcludedLocationIds(nextIds);
    await saveExcludedLocationIds(nextIds);
    await submitPlan(nextExcludedLocationIds);
  }

  async function removeExcludedLocation(locationId: number) {
    const nextExcludedLocationIds = excludedLocationIds.filter((id) => id !== locationId);
    setExcludedLocationIds(nextExcludedLocationIds);
    await saveExcludedLocationIds(nextExcludedLocationIds);
    await submitPlan(new Set(nextExcludedLocationIds));
  }

  async function clearExcludedLocations() {
    setExcludedLocationIds([]);
    setIsExcludedLocationsModalOpen(false);
    await saveExcludedLocationIds([]);
    await submitPlan(new Set());
  }

  function saveBucket(bucket: ClientPlanBucket): boolean {
    const duplicate = buckets.some(
      (existing) =>
        existing.id !== bucket.id
        && existing.locations.stock === bucket.locations.stock
        && existing.locations.manufacturing === bucket.locations.manufacturing,
    );
    if (duplicate) {
      toast.add({
        description: "A stockpile already uses this stock destination and build location.",
        type: "error",
      });
      return false;
    }
    setBuckets((current) => {
      const existingIndex = current.findIndex((existing) => existing.id === bucket.id);
      if (existingIndex < 0) return [...current, bucket];
      return current.map((existing, index) => (index === existingIndex ? bucket : existing));
    });
    setEditingBucket(null);
    return true;
  }

  function openNewBucket() {
    setEditingBucket(
      createPlannerBucket(
        {
          ...locations,
          manufacturing: buckets[0]?.locations.manufacturing ?? locations.manufacturing,
          reactions: buckets[0]?.locations.reactions ?? locations.reactions,
        },
        [],
        `Stock destination ${buckets.length + 1}`,
      ),
    );
    setIsBucketEditorOpen(true);
  }

  function openBucket(bucket: ClientPlanBucket) {
    setEditingBucket(bucket);
    setIsBucketEditorOpen(true);
  }

  function removeBucket(bucketId: string) {
    if (buckets.length <= 1) {
      toast.add({ description: "Keep at least one stockpile.", type: "error" });
      return;
    }
    setBuckets((current) => current.filter((bucket) => bucket.id !== bucketId));
    setPlan(null);
  }

  function exportPlan() {
    const payload = {
      format: "assembly-line-plan",
      version: 1,
      exportedAt: new Date().toISOString(),
      buckets,
      settings,
      includeAssets: includeStock,
      excludedLocationIds,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "assembly-line-plan.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importPlan(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isImportedPlan(parsed)) {
        throw new Error("The file does not contain valid plan stockpiles.");
      }
      const localizedBuckets = await Promise.all(
        parsed.buckets.map(async (bucket) => ({
          ...bucket,
          items: await localizeItems(bucket.items, language),
        })),
      );
      setBuckets(localizedBuckets);
      if (typeof parsed.settings === "object" && parsed.settings !== null) {
        setSettings(parsePlannerSettings(parsed.settings));
      }
      if (typeof parsed.includeAssets === "boolean") setIncludeStock(parsed.includeAssets);
      if (
        Array.isArray(parsed.excludedLocationIds)
        && parsed.excludedLocationIds.every(
          (locationId) => Number.isSafeInteger(locationId) && locationId > 0,
        )
      ) {
        const importedExcludedLocationIds = parsed.excludedLocationIds as number[];
        setExcludedLocationIds(importedExcludedLocationIds);
        await saveExcludedLocationIds(importedExcludedLocationIds);
      }
      setPlan(null);
      toast.add({ description: "Plan imported" });
    }
    catch (error) {
      toast.add({
        description: error instanceof Error ? error.message : "Could not import plan",
        type: "error",
      });
    }
    setPlanImportInputKey((key) => key + 1);
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
      toast.add({ description: "Build list multibuy copied" });
    }
    catch {
      toast.add({ description: "Could not copy build list multibuy", type: "error" });
    }
  }

  function removeCompressionItems() {
    if (!items.some((item) => item.fromCompression)) return;
    if (!window.confirm("Remove all items added from Compression?")) return;
    setItems((current) => current.filter((item) => !item.fromCompression));
  }

  function deleteAllItems() {
    if (items.length === 0) return;
    setIsDeleteAllDialogOpen(true);
  }

  function confirmDeleteAllItems() {
    setItems([]);
    setIsDeleteAllDialogOpen(false);
  }

  const selectedManufacturingLocation = locationOptions.find(
    (location) => location.locationId === locations.manufacturing,
  );
  const selectedReactionLocation = locationOptions.find(
    (location) => location.locationId === locations.reactions,
  );
  const activityLocationOptions: ActivityLocationOption[] = locationOptions.map((location) => ({
    locationId: location.locationId,
    name: location.name,
    baseManufacturingMe: location.baseManufacturingMe,
    baseReactionMe: location.baseReactionMe,
  }));
  const stockLocationOptions: StockLocationOption[] = [
    ...locationOptions.map((location) => ({
      locationId: location.locationId,
      name: location.name,
    })),
    ...knownStructures.flatMap((structure) =>
      structure.esiStructureId === undefined
        ? []
        : [{ locationId: structure.esiStructureId, name: structure.name }],
    ),
  ].filter(
    (location, index, allLocations) =>
      allLocations.findIndex((candidate) => candidate.locationId === location.locationId) === index,
  );
  const plannerLocationNames = new Map<number, string>([
    ...locationOptions.map((location) => [location.locationId, location.name] as const),
    ...knownStructures.flatMap((structure) =>
      structure.esiStructureId === undefined
        ? []
        : [[structure.esiStructureId, structure.name] as const],
    ),
    ...buckets.flatMap((bucket) =>
      bucket.stockLocationName ? [[bucket.locations.stock, bucket.stockLocationName] as const] : [],
    ),
  ]);

  return (
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">PRODUCTION CONTROL</p>
          <h1>Build plan</h1>
          <p className={styles.subtitle}>
            Turn your project requirements into a clean, actionable production plan.
          </p>
        </div>
      </div>
      <section className="flex min-w-0 flex-col gap-4">
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className="min-w-0">
              <p className={styles.panelKicker}>01 / DESTINATIONS</p>
              <h2>Stockpiles</h2>
              <p className={styles.panelDescription}>
                Define what you want to stock and where each independent build plan finishes.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                key={planImportInputKey}
                id="planner-plan-import"
                className="hidden"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importPlan(event)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={exportPlan}
                disabled={buckets.length === 0}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                Export plan
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => document.getElementById("planner-plan-import")?.click()}
              >
                <Upload data-icon="inline-start" aria-hidden="true" />
                Import plan
              </Button>
              <Button type="button" onClick={openNewBucket}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add new Stock location
              </Button>
            </div>
          </div>
          <div className="grid min-w-0 gap-3">
            {buckets.length === 0 ? (
              <Empty>
                <EmptyDescription>Add a stock location to begin your plan.</EmptyDescription>
              </Empty>
            ) : (
              buckets.map((bucket) => (
                <PlannerBucketSummary
                  key={bucket.id}
                  bucket={bucket}
                  locationNamesById={plannerLocationNames}
                  onEdit={() => openBucket(bucket)}
                  onRemove={() => removeBucket(bucket.id)}
                />
              ))
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 border-t pt-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                aria-label="Include assets"
                checked={includeStock}
                onCheckedChange={setIncludeStock}
              />
              Include shared assets
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={excludedLocationIds.length === 0}
              onClick={() => setIsExcludedLocationsModalOpen(true)}
            >
              Excluded asset locations ({excludedLocationIds.length})
            </Button>
            <CalculateButton
              type="button"
              className="ml-auto"
              disabled={isPlanLoading || buckets.every((bucket) => bucket.items.length === 0)}
              icon={ClipboardList}
              isLoading={isPlanLoading}
              label="Calculate production plan"
              loadingLabel="Calculating..."
              onClick={() => void submitPlan(new Set(excludedLocationIds))}
            />
          </div>
        </div>
      </section>
      <PlannerBucketEditor
        key={editingBucket?.id ?? "new-bucket"}
        bucket={editingBucket}
        open={isBucketEditorOpen}
        language={language}
        activityLocations={activityLocationOptions}
        stockLocations={stockLocationOptions}
        excludedStockLocationIds={buckets.map((bucket) => bucket.locations.stock)}
        onOpenChange={(open) => {
          setIsBucketEditorOpen(open);
          if (!open) setEditingBucket(null);
        }}
        onSave={saveBucket}
      />
      <form className="hidden" onSubmit={calculatePlan}>
        <div className={styles.workspaceGrid}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelKicker} ref={requirementsHeaderRef}>
                  01 / REQUIREMENTS
                </p>
                <h2>Build list</h2>
              </div>
              <Button variant="outline" onClick={() => setIsPasteModalOpen(true)}>
                <Clipboard data-icon="inline-start" aria-hidden="true" />
                <span>Paste list</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => void copyBuildList()}
                disabled={items.length === 0}
              >
                <CopyIcon data-icon="inline-start" aria-hidden="true" />
                <span>Copy list</span>
              </Button>
              {items.some((item) => item.fromCompression) && (
                <Button variant="outline" onClick={removeCompressionItems}>
                  <X data-icon="inline-start" aria-hidden="true" />
                  <span>Remove Compression</span>
                </Button>
              )}
              <Button variant="destructive" onClick={deleteAllItems} disabled={items.length === 0}>
                <Trash2 data-icon="inline-start" aria-hidden="true" />
                <span>Delete all</span>
              </Button>
            </div>
            <p className={styles.panelDescription}>What are you making?</p>
            <TypeSearch
              language={language}
              placeholder="Search items by name or type ID"
              ariaLabel="Search items by name or type ID"
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
              <Empty className={styles.emptyBuildList}>
                <EmptyDescription>
                  Search for an item above to start your build list.
                </EmptyDescription>
              </Empty>
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
                              aria-label="Will be reprocessed using the selected refinery settings"
                            >
                              <Minimize2 aria-hidden="true" />
                              <span>Reprocess</span>
                            </Badge>
                          }
                        />
                        <TooltipContent>
                          Will be reprocessed using the selected refinery settings
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <label className={`${styles.itemField} ${styles.quantityField}`}>
                    <span>Quantity</span>
                    <Input
                      className="text-right"
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
                    <Input
                      className="text-right"
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
                    <Input
                      className="text-right"
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
                  <Button
                    variant="destructive"
                    size="icon-sm"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))
            )}
            <div className={styles.planOptions}>
              {locationOptions.length > 0 ? (
                <>
                  <label>
                    <div className={`${styles.planOptionHeader} text-xs`}>
                      <span>BUILD LOCATION</span>
                      <span className={styles.planOptionBonus}>
                        MANUFACTURING ME{" "}
                        {selectedManufacturingLocation
                          ? `${selectedManufacturingLocation.baseManufacturingMe.toFixed(1)}%`
                          : "0.0%"}
                      </span>
                    </div>
                    <Select
                      value={String(locations.manufacturing)}
                      onValueChange={(value) =>
                        value && updateLocations({ manufacturing: Number(value) })
                      }
                      items={locationOptions.map((location) => ({
                        value: String(location.locationId),
                        label: `${location.name} (${location.baseManufacturingMe.toFixed(1)}%)`,
                      }))}
                    >
                      <SelectTrigger
                        className={styles.locationSelectTrigger}
                        aria-label="Build location"
                      >
                        <SelectValue className={styles.locationSelectValue}>
                          <span className={styles.locationSelectName}>
                            {selectedManufacturingLocation?.name ?? "Select build location"}
                          </span>
                          <span className={styles.locationSelectYield}>
                            {selectedManufacturingLocation
                              ? `${selectedManufacturingLocation.baseManufacturingMe.toFixed(1)}%`
                              : "0.0%"}
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {locationOptions
                            .slice()
                            .sort(
                              (left, right) =>
                                left.baseManufacturingMe - right.baseManufacturingMe
                                || left.name.localeCompare(right.name),
                            )
                            .map((location) => (
                              <SelectItem
                                value={String(location.locationId)}
                                key={`manufacturing-${location.id}`}
                                className={styles.locationSelectItem}
                              >
                                <span className={styles.locationOptionName}>{location.name}</span>
                                <span className={styles.locationOptionYield}>
                                  {location.baseManufacturingMe.toFixed(1)}%
                                </span>
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </label>
                  <label>
                    <div className={`${styles.planOptionHeader} text-xs`}>
                      <span>REACTION LOCATION</span>
                      <span className={styles.planOptionBonus}>
                        REACTION ME{" "}
                        {selectedReactionLocation
                          ? `${selectedReactionLocation.baseReactionMe.toFixed(1)}%`
                          : "0.0%"}
                      </span>
                    </div>
                    <Select
                      value={String(locations.reactions)}
                      onValueChange={(value) =>
                        value && updateLocations({ reactions: Number(value) })
                      }
                      items={locationOptions.map((location) => ({
                        value: String(location.locationId),
                        label: `${location.name} (${location.baseReactionMe.toFixed(1)}%)`,
                      }))}
                    >
                      <SelectTrigger
                        className={styles.locationSelectTrigger}
                        aria-label="Reaction location"
                      >
                        <SelectValue className={styles.locationSelectValue}>
                          <span className={styles.locationSelectName}>
                            {selectedReactionLocation?.name ?? "Select reaction location"}
                          </span>
                          <span className={styles.locationSelectYield}>
                            {selectedReactionLocation
                              ? `${selectedReactionLocation.baseReactionMe.toFixed(1)}%`
                              : "0.0%"}
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {locationOptions
                            .slice()
                            .sort(
                              (left, right) =>
                                left.baseReactionMe - right.baseReactionMe
                                || left.name.localeCompare(right.name),
                            )
                            .map((location) => (
                              <SelectItem
                                value={String(location.locationId)}
                                key={`reaction-${location.id}`}
                                className={styles.locationSelectItem}
                              >
                                <span className={styles.locationOptionName}>{location.name}</span>
                                <span className={styles.locationOptionYield}>
                                  {location.baseReactionMe.toFixed(1)}%
                                </span>
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </label>
                </>
              ) : (
                <Alert className={styles.locationAlert}>
                  <Info className={styles.locationAlertIcon} aria-hidden="true" />
                  <div className={styles.locationAlertContent}>
                    <AlertTitle>No build or reaction locations available.</AlertTitle>
                    <AlertDescription>
                      Optionally add structures on the <Link href="/structures">Structures</Link>{" "}
                      page or <Link href="/api/auth/eve/start">add character(s) via ESI</Link> to
                      improve plan results.
                    </AlertDescription>
                  </div>
                </Alert>
              )}
              {characterNamesById.size > 0 && (
                <label>
                  <div className={`${styles.planOptionHeader} text-xs`}>
                    <span>INDUSTRY SKILLS</span>
                    <span className={styles.planOptionBonus}>
                      REACTION TE -{reactionSkillBonus(planningCharacterId).toFixed(1)}%
                    </span>
                  </div>
                  <Select
                    value={planningCharacterId === undefined ? "" : String(planningCharacterId)}
                    onValueChange={(value) => value && setPlanningCharacterId(Number(value))}
                  >
                    <SelectTrigger
                      className={styles.locationSelectTrigger}
                      aria-label="Industry skills character"
                    >
                      <SelectValue>
                        <span className={styles.locationSelectName}>
                          {characterNamesById.get(planningCharacterId ?? -1) ?? "Select character"}
                        </span>
                        <span className={styles.locationSelectYield}>
                          -{reactionSkillBonus(planningCharacterId).toFixed(1)}%
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[...characterNamesById.entries()].map(([characterId, characterName]) => (
                          <SelectItem key={characterId} value={String(characterId)}>
                            <span className={styles.locationOptionName}>{characterName}</span>
                            <span className={styles.locationOptionYield}>
                              -{reactionSkillBonus(characterId).toFixed(1)}%
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
              )}
              <label className={styles.checkboxOption}>
                <div className={`${styles.planOptionHeader} text-xs`}>
                  <span>INCLUDE ASSETS</span>
                </div>
                <Switch
                  aria-label="Include assets"
                  checked={includeStock}
                  onCheckedChange={setIncludeStock}
                />
              </label>
              <div className={styles.excludedLocationsControl}>
                <div className={`${styles.planOptionHeader} text-xs`}>
                  <span>EXCLUDED LOCATIONS</span>
                </div>
                <div className={styles.excludedLocationsActions}>
                  <Button
                    disabled={excludedLocationIds.length === 0}
                    onClick={() => setIsExcludedLocationsModalOpen(true)}
                  >
                    {excludedLocationIds.length}
                  </Button>
                  <div className="ml-auto flex gap-2">
                    <Button
                      disabled={excludedLocationIds.length === 0}
                      onClick={() => setIsExcludedLocationsModalOpen(true)}
                    >
                      View
                    </Button>
                    <Button
                      disabled={excludedLocationIds.length === 0 || isPlanLoading}
                      onClick={() => setIsClearExcludedLocationsDialogOpen(true)}
                    >
                      Clear all
                    </Button>
                  </div>
                </div>
              </div>
            </div>
            <CalculateButton
              type="submit"
              disabled={isPlanLoading || items.length === 0}
              icon={ClipboardList}
              isLoading={isPlanLoading}
              label="Calculate production plan"
              loadingLabel="Calculating..."
            />
          </div>
        </div>
      </form>
      {isPasteModalOpen && (
        <PasteListDialog
          language={language}
          currentItems={items}
          onCancel={() => setIsPasteModalOpen(false)}
          onImport={(importedItems) =>
            importItems(
              importedItems.map((item) => ({
                ...item,
                categoryName: "Unknown",
                quantity: item.quantity ?? 1,
              })),
            )
          }
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
          onSave={() => setIsExcludedLocationsModalOpen(false)}
          onCancel={() => setIsExcludedLocationsModalOpen(false)}
        />
      )}
      <AlertDialog open={isDeleteAllDialogOpen} onOpenChange={setIsDeleteAllDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all build-list items?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove every item from the current build list. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDeleteAllItems}>
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={isClearExcludedLocationsDialogOpen}
        onOpenChange={setIsClearExcludedLocationsDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear excluded locations?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all excluded locations and recalculate the plan. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setIsClearExcludedLocationsDialogOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isPlanLoading}
              onClick={() => {
                setIsClearExcludedLocationsDialogOpen(false);
                void clearExcludedLocations();
              }}
            >
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
                plan={plan}
                characterStatuses={characterStatuses}
                characterNamesById={characterNamesById}
                availableReactionSlots={(jobs?.characters ?? []).reduce(
                  (total, character) =>
                    characterNamesById.has(character.characterId)
                      ? total
                        + Math.max(
                          0,
                          character.availableSlots.Reactions - character.slots.Reactions,
                        )
                      : total,
                  0,
                )}
                stock={stock}
                activityLocationIds={[
                  ...new Set(
                    [
                      locations.manufacturing,
                      locations.reactions,
                      locations.reprocessing,
                      locations.copying,
                      locations.invention,
                      ...buckets.flatMap((bucket) => [
                        bucket.locations.manufacturing,
                        bucket.locations.reactions,
                        bucket.locations.reprocessing,
                        bucket.locations.copying,
                        bucket.locations.invention,
                      ]),
                    ].filter((locationId): locationId is number => locationId !== undefined),
                  ),
                ]}
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
                onAddBuildItem={(item) =>
                  importItems([
                    {
                      ...item,
                      categoryName: "Reaction Formula",
                      iconCategory: "reactionformula",
                    },
                  ])
                }
                onExcludeHaulBucket={excludeHaulBucket}
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
    </>
  );
}

export default Planner;

function PlannerBucketSummary({
  bucket,
  locationNamesById,
  onEdit,
  onRemove,
}: {
  bucket: ClientPlanBucket;
  locationNamesById: Map<number, string>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const locationName = (locationId: number) =>
    locationNamesById.get(locationId) ?? String(locationId);

  return (
    <article className="grid min-w-0 gap-3 border p-4">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-medium">{bucket.name}</h3>
          <p className="text-sm text-muted-foreground">
            {bucket.items.length.toLocaleString()} item types,{" "}
            {bucket.items.reduce((total, item) => total + item.quantity, 0).toLocaleString()} units
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" onClick={onEdit}>
            <Pencil data-icon="inline-start" aria-hidden="true" />
            View / edit
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove ${bucket.name}`}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="grid min-w-0 gap-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <span className="block text-xs uppercase text-muted-foreground">Stock destination</span>
          <span className="block truncate">
            {bucket.stockLocationName ?? locationName(bucket.locations.stock)}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-xs uppercase text-muted-foreground">Build location</span>
          <span className="block truncate">{locationName(bucket.locations.manufacturing)}</span>
        </div>
        <div className="min-w-0">
          <span className="block text-xs uppercase text-muted-foreground">Reaction location</span>
          <span className="block truncate">{locationName(bucket.locations.reactions)}</span>
        </div>
      </div>
    </article>
  );
}

function ExcludedLocationsModal({
  locationIds,
  locationNamesById,
  isLoading,
  onRemove,
  onClearAll,
  onSave,
  onCancel,
}: {
  locationIds: number[];
  locationNamesById: Map<number, string>;
  isLoading: boolean;
  onRemove: (locationId: number) => void;
  onClearAll: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className={styles.importModal}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>ASSET FILTER</p>
            <DialogTitle>Excluded locations</DialogTitle>
          </div>
        </div>
        <div className="no-scrollbar max-h-[70vh] overflow-y-auto overscroll-contain">
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
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Close
          </Button>
          <Button type="button" className="min-w-32" disabled={isLoading} onClick={onSave}>
            <b>→</b>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanList({
  activeTab,
  plan,
  characterStatuses,
  characterNamesById,
  stock,
  activityLocationIds,
  availableReactionSlots,
  locationNamesById,
  onPlanChange,
  onAddBuildItem,
  onExcludeHaulBucket,
  resultsHeaderRef,
}: {
  activeTab: PlannerTab;
  plan: PlanResult;
  characterStatuses: ClientCharacterStatus[];
  characterNamesById: Map<number, string>;
  stock: PlanStockItem[];
  activityLocationIds: number[];
  availableReactionSlots: number;
  locationNamesById: Map<number, string>;
  onPlanChange: (plan: PlanResult) => void;
  onAddBuildItem: (item: { name: string; typeId: number; quantity: number }) => void;
  onExcludeHaulBucket: (fromLocationId: number) => Promise<void>;
  resultsHeaderRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [copyStatus, setCopyStatus] = useState("");
  const [excludingHaulFromLocationId, setExcludingHaulFromLocationId] = useState<number | null>(
    null,
  );
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
                  : plan.lists.haulingTasks;
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
  const locationGroupedTab =
    activeTab === "Reprocess"
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
  const locationBuckets = new Map<number | undefined, PlanListEntry[]>();
  if (locationGroupedTab) {
    if (activeTab === "Plan") {
      for (const [locationId, entries] of groupPlanItemEntriesByBuildLocation(
        rawList as PlanItemEntry[],
      )) {
        locationBuckets.set(locationId, entries);
      }
    }
    else {
      for (const entry of list) {
        const locationId = "locationId" in entry ? entry.locationId : undefined;
        const bucket = locationBuckets.get(locationId) ?? [];
        bucket.push(entry as PlanListEntry);
        locationBuckets.set(locationId, bucket);
      }
    }
  }
  const sortedLocationBuckets = [...locationBuckets.entries()].sort(([left], [right]) => {
    const leftName = locationNamesById.get(left ?? 0) ?? String(left ?? "Location unavailable");
    const rightName = locationNamesById.get(right ?? 0) ?? String(right ?? "Location unavailable");
    return leftName.localeCompare(rightName);
  });
  const displayBuckets = (
    locationGroupedTab ? sortedLocationBuckets : [[undefined, list as PlanListEntry[]]]
  ) as Array<[number | undefined, PlanListEntry[]]>;
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
      const schedule = reactionSchedule.get(reactionJobKey(job));
      return {
        installs: summary.installs + (schedule?.installs ?? 0),
        maxTime: Math.max(summary.maxTime, schedule?.time ?? 0),
      };
    },
    { installs: 0, maxTime: 0 },
  );
  const reactionCoverage = plan.lists.reactionJobs
    .map((job) => ({
      job,
      schedule: reactionSchedule.get(reactionJobKey(job)),
    }))
    .sort((left, right) => (right.schedule?.runs ?? 0) - (left.schedule?.runs ?? 0))
    .reduce<{ coverage: ReactionCoverage; remainingSlots: number }>(
      (result, { job, schedule }) => {
        const installCount = Math.min(schedule?.installs ?? 0, result.remainingSlots);
        const coveredRuns = Math.min(job.runs, installCount * (schedule?.runs ?? 0));
        const coveredInstallableRuns = Math.min(job.runsAvailable, coveredRuns);
        return {
          coverage: {
            installable: result.coverage.installable + coveredInstallableRuns,
            total: result.coverage.total + coveredRuns,
          },
          remainingSlots: result.remainingSlots - installCount,
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
  const sortedDisplayBuckets =
    activeTab === "React" || activeTab === "Manufacture"
      ? (displayBuckets.map(([locationId, entries]) => [
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
                    : showTotalManufacturingRunCounts
                      ? leftManufacturing.runs
                      : leftManufacturing.runsAvailable;
                const rightValue =
                  manufacturingSort.key === "type"
                    ? rightManufacturing.name
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
                  : reactionSort.key === "suggestedRuns"
                    ? (leftSchedule?.runs ?? 0)
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
                  : reactionSort.key === "suggestedRuns"
                    ? (rightSchedule?.runs ?? 0)
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
      : displayBuckets;
  const maxCopyBuildTime = Math.max(...plan.lists.bpcsNeeded.map((entry) => entry.buildTime), 0);
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
    const bucketId = "bucketId" in entry ? entry.bucketId : undefined;
    const buildLocationId = "buildLocationId" in entry ? entry.buildLocationId : undefined;
    const haulActivityLocationIds = new Set(activityLocationIds);
    if (buildLocationId !== undefined) haulActivityLocationIds.add(buildLocationId);
    if (haulActivityLocationIds.size === 0) return 0;
    return plan.lists.haulingTasks
      .filter(
        (task) =>
          task.itemTypeId === entry.typeId
          && haulActivityLocationIds.has(task.toLocationId)
          && (bucketId === undefined || task.bucketId === bucketId),
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
            ...displayBuckets
              .flatMap(([, entries]) => entries)
              .map((entry) => {
                const cells = getPlanCells(entry as PlanItemEntry);
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
            <Button variant="outline" onClick={() => void sendToCompress()}>
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
            <Button type="button" variant="outline" onClick={copyList}>
              <CopyIcon aria-hidden="true" />
              {copyStatus || (activeTab === "Plan" ? "Copy table" : "Copy list")}
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
                  <Button
                    variant="outline"
                    disabled={excludingHaulFromLocationId !== null}
                    onClick={() => {
                      setExcludingHaulFromLocationId(bucket.fromLocationId);
                      void onExcludeHaulBucket(bucket.fromLocationId).finally(() => {
                        setExcludingHaulFromLocationId(null);
                      });
                    }}
                  >
                    {excludingHaulFromLocationId === bucket.fromLocationId ? (
                      <Spinner aria-hidden="true" />
                    ) : (
                      <SquareX aria-hidden="true" />
                    )}
                    <span>
                      {excludingHaulFromLocationId === bucket.fromLocationId
                        ? "Recalculating..."
                        : "Exclude and Recalculate"}
                    </span>
                  </Button>
                </div>
              </header>
              <div className={styles.haulGroupRows}>
                {bucket.tasks.map((task) => (
                  <div
                    className={styles.haulRow}
                    key={`${task.itemTypeId}:${task.bucketId ?? "unbucketed"}`}
                  >
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
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className={activeTab === "Plan" ? styles.planTable : styles.planList}>
          {sortedDisplayBuckets.map(([locationId, entries]) => (
            <Fragment key={locationId ?? "unlocated"}>
              {locationGroupedTab && (
                <h3 className={styles.locationGroupHeader}>
                  {locationNamesById.get(locationId ?? 0) ?? locationId ?? "Location unavailable"}
                </h3>
              )}
              {entries.map((entry, index) => {
                const typeId = "itemTypeId" in entry ? entry.itemTypeId : entry.typeId;
                const name = entry.name;
                const isPlanBpc = "kind" in entry && entry.kind === "bpc";
                const isBpcPurchase = activeTab === "Buy" && "bpoCount" in entry;
                const isCopyOfBpo =
                  activeTab === "Copy" && "bpoCount" in entry && entry.bpoCount > 0;
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
                      : "locationId" in entry && activeTab !== "Buy" && activeTab !== "Manufacture"
                        ? `Location ${entry.locationId}`
                        : "";
                const totalTime =
                  "totalTime" in entry && typeof entry.totalTime === "number"
                    ? entry.totalTime
                    : null;
                const reactionFormulaCount =
                  activeTab === "React" && "inputs" in entry && "locationId" in entry
                    ? stock
                        .filter(
                          (stockItem) =>
                            stockItem.category === "reactionformula"
                            && stockItem.typeId === typeId
                            && !stockItem.inUse
                            && getStockLocationId(stockItem) === entry.locationId,
                        )
                        .reduce((total, stockItem) => total + stockItem.quantity, 0)
                    : 0;
                const reactionPlan =
                  activeTab === "React"
                    ? reactionSchedule.get(
                        reactionJobKey(entry as PlanResult["lists"]["reactionJobs"][number]),
                      )
                    : null;
                const targetRuns = reactionPlan?.runs ?? null;
                const suggestedInstallCount = reactionPlan?.installs ?? 0;
                const installTime = reactionPlan?.time ?? totalTime;
                const totalNeeded =
                  activeTab === "React" && "runs" in entry && "runsAvailable" in entry
                    ? showTotalRunCounts
                      ? entry.runs
                      : entry.runsAvailable
                    : null;
                const suggestedCapacity = suggestedInstallCount * (targetRuns ?? 0);
                const additionalInstallCount =
                  totalNeeded !== null && targetRuns !== null && targetRuns > 0
                    ? Math.max(0, Math.ceil((totalNeeded - suggestedCapacity) / targetRuns))
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
                        {(activeTab === "React" || activeTab === "Manufacture")
                          && "inputs" in entry && (
                            <span className={styles.jobInputsTrigger}>
                              <JobInputsResponsive
                                inputs={entry.inputs}
                                reactionFormulaCount={
                                  activeTab === "React" ? reactionFormulaCount : undefined
                                }
                              />
                            </span>
                          )}
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
                                <strong>{reactionFormulaCount.toLocaleString()}</strong>
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
                    {activeTab !== "Plan" && index < entries.length - 1 && (
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
