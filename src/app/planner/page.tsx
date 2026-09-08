"use client";

import { type ChangeEvent, FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  ClientBuildItem,
  ClientPlanStockpile,
  PlanStockpileLocations,
  PlanResult,
  PlanStockItem,
} from "@/lib/planning/types";
import { loadBuildList } from "@/lib/planning/buildListStore";
import EveAuthorizationWarning from "@/components/EveAuthorizationWarning";
import {
  loadPlannerStockpiles,
  savePlannerStockpiles,
} from "@/lib/planning/plannerStockpilesStore";
import { loadStructures } from "@/lib/planning/structureStore";
import {
  loadBuildBlacklist,
  loadExcludedLocationIds,
  loadPlannerLocations,
  saveExcludedLocationIds,
  savePlannerLocations,
} from "@/lib/planning/plannerPreferencesStore";
import {
  loadClientCharacterState,
  loadClientSession,
  loadClientAssets,
  loadClientJobs,
  groupClientAssetsByLocation,
  type ClientRefreshEventDetail,
  filterClientAssetsForPlanning,
  type ClientAssetsResponse,
  type ClientCharacterStatus,
  type ClientCorporationSource,
  type ClientJobsResponse,
} from "@/lib/client/requestCache";
import { loadPlanResult, savePlanResult } from "@/lib/planning/planResultStore";
import { createHaulItemExclusionKey, excludeHaulItemsFromStock } from "@/lib/planning/planView";
import { loadHaulPatches, saveHaulPatches } from "@/lib/planning/haulPatchStore";
import {
  applyHaulPatches,
  createHaulPatchesForTask,
  invalidateHaulPatches,
  isHaulPatchForTask,
} from "@/lib/planning/haulPatches";
import type { HaulPatch } from "@/lib/planning/types";
import { refreshPlannerStockpileEfficiencies } from "@/lib/planning/reprocessingClient";
import {
  defaultLocations,
  defaultSettings,
  parsePlannerSettings,
  settingsStorageKey,
  type PlannerLocations,
  type PlannerSettings,
} from "@/lib/planning/preferences";
import type { SdeLanguage } from "@/lib/reference/languages";
import { formatLocationName } from "@/lib/reference/locationName";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { useAppLanguage } from "../AppShell";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import PlannerResults from "@/components/PlannerResults";
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
import { Switch } from "@/components/ui/switch";
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
  Clipboard,
  Copy as CopyIcon,
  Info,
  ClipboardList,
  Minimize2,
  Settings2,
  Trash2,
  X,
  Download,
  Pencil,
  Plus,
  Upload,
} from "lucide-react";
import PasteListDialog from "@/components/PasteListDialog";
import {
  PlannerStockpileDetailsDialog,
  PlannerStockpileItemsDialog,
  type ActivityLocationOption,
  type ProductionGroupOption,
  type StockLocationOption,
} from "@/components/PlannerStockpileEditor";
import type { FacilityGroupBonus } from "@/lib/planning/facilityBonuses";
import type { ProductionGroupKey, ProductionGroupReference } from "@/lib/planning/productionGroups";

type StockpileEditorMode = "details" | "items";
type PlanLocationOption = {
  id: string;
  locationId: number;
  name: string;
  locationType: "station" | "structure";
  baseYield: number;
  baseManufacturingMe: number;
  baseReactionMe: number;
  manufacturingTimeMultiplier: number;
  reactionTimeMultiplier: number;
  sizeId: number;
  activities: {
    manufacturing: boolean;
    reactions: boolean;
  };
  buildTypeGroups: Partial<Record<ProductionGroupKey, FacilityGroupBonus>>;
};

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

function getStockLocationId(item: PlanStockItem) {
  return item.rootLocationId ?? item.sourceLocationId ?? item.locationId;
}

function getPlannerStock(
  assets: ClientAssetsResponse | null,
  includeStock: boolean,
  excludedLocationIds: ReadonlySet<number>,
): PlanStockItem[] {
  if (!includeStock || !assets) return [];
  return (filterClientAssetsForPlanning(assets).assets ?? []).filter((item) => {
    const locationId = getStockLocationId(item);
    return locationId === undefined || !excludedLocationIds.has(locationId);
  });
}

function retainCurrentHaulItemExclusions(
  assets: ClientAssetsResponse,
  exclusions: ReadonlyMap<string, number>,
): Map<string, number> {
  const receivedAssets = assets.assets ?? [];
  if (receivedAssets.length === 0 || exclusions.size === 0) {
    return new Map(exclusions);
  }
  const assetKeys = new Set(
    receivedAssets.flatMap((item) =>
      item.rootLocationId === undefined
        ? []
        : [createHaulItemExclusionKey(item.rootLocationId, item.typeId)],
    ),
  );
  return new Map([...exclusions].filter(([key]) => assetKeys.has(key)));
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

function stockpileLocationsFromPlannerLocations(
  locations: PlannerLocations,
): PlanStockpileLocations {
  return {
    stock: locations.manufacturing,
    manufacturing: locations.manufacturing,
    reactions: locations.reactions,
    reprocessing: locations.reprocessing ?? locations.manufacturing,
    copying: locations.copying ?? locations.manufacturing,
    invention: locations.invention ?? locations.manufacturing,
  };
}

function createPlannerStockpile(
  locations: PlannerLocations,
  items: ClientBuildItem[] = [],
  name = "New stock destination",
): ClientPlanStockpile {
  return {
    id: `stockpile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    locations: stockpileLocationsFromPlannerLocations(locations),
    items,
  };
}

function isImportedPlan(value: unknown): value is {
  stockpiles?: ClientPlanStockpile[];
  buckets?: ClientPlanStockpile[];
  settings?: unknown;
  includeAssets?: unknown;
  excludedLocationIds?: unknown;
} {
  if (!value || typeof value !== "object") return false;
  const importedValue = value as { stockpiles?: unknown; buckets?: unknown };
  const stockpiles = importedValue.stockpiles ?? importedValue.buckets;
  if (!Array.isArray(stockpiles) || stockpiles.length === 0) return false;
  return stockpiles.every((stockpile) => {
    if (!stockpile || typeof stockpile !== "object") return false;
    const candidate = stockpile as Partial<ClientPlanStockpile>;
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
  const { language } = useAppLanguage();
  const [isBuildListLoaded, setIsBuildListLoaded] = useState(false);
  const [planStatus, setPlanStatus] = useState("Ready to calculate");
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [isExcludedLocationsModalOpen, setIsExcludedLocationsModalOpen] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = useState(false);
  const [isClearExcludedLocationsDialogOpen, setIsClearExcludedLocationsDialogOpen] =
    useState(false);
  const [stockpilePendingRemoval, setStockpilePendingRemoval] =
    useState<ClientPlanStockpile | null>(null);
  const [characterStatuses, setCharacterStatuses] = useState<ClientCharacterStatus[]>([]);
  const [jobs, setJobs] = useState<ClientJobsResponse | null>(null);
  const [clientAssets, setClientAssets] = useState<ClientAssetsResponse | null>(null);
  const [characterNamesById, setCharacterNamesById] = useState<Map<number, string>>(new Map());
  const [planningCharacterId, setPlanningCharacterId] = useState<number | undefined>();
  const [stockpiles, setStockpiles] = useState<ClientPlanStockpile[]>([]);
  const [areStockpilesLoaded, setAreStockpilesLoaded] = useState(false);
  const [editingStockpile, setEditingStockpile] = useState<ClientPlanStockpile | null>(null);
  const [stockpileEditorMode, setStockpileEditorMode] = useState<StockpileEditorMode | null>(null);
  const [knownStructures, setKnownStructures] = useState<
    Awaited<ReturnType<typeof loadStructures>>
  >([]);
  const [planImportInputKey, setPlanImportInputKey] = useState(0);
  const [excludedLocationIds, setExcludedLocationIds] = useState<number[]>([]);
  const [locationOptions, setLocationOptions] = useState<PlanLocationOption[]>([]);
  const [cachedAssetLocations, setCachedAssetLocations] = useState<StockLocationOption[]>([]);
  const [productionGroupReferences, setProductionGroupReferences] = useState<
    ProductionGroupReference[]
  >([]);
  const [includeStock, setIncludeStock] = useState(true);
  const [haulItemExclusion, setHaulItemExclusion] = useState<Map<string, number>>(() => new Map());
  const [haulPatches, setHaulPatches] = useState<Map<string, HaulPatch>>(() => new Map());
  const [haulPatchesLoaded, setHaulPatchesLoaded] = useState(false);
  const [corporationSources, setCorporationSources] = useState<ClientCorporationSource[]>([]);
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
    void loadPlanResult().then((savedPlan) => {
      if (savedPlan) {
        setPlan(savedPlan);
        setPlanStatus("Plan loaded from this browser");
      }
    });
  }, []);

  useEffect(() => {
    void loadHaulPatches().then((patches) => {
      setHaulPatches(new Map(patches.map((patch) => [patch.key, patch])));
      setHaulPatchesLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!haulPatchesLoaded || characterStatuses.length === 0) return;
    const retainedPatches = invalidateHaulPatches([...haulPatches.values()], characterStatuses);
    if (retainedPatches.length === haulPatches.size) return;
    void saveHaulPatches(retainedPatches);
  }, [characterStatuses, haulPatches, haulPatchesLoaded]);

  useEffect(() => {
    let cancelled = false;
    let activeCharacterIds = new Set<number>();
    void loadClientSession()
      .then(async (session) => {
        if (cancelled) return;
        setIsAuthenticated(Boolean(session.authenticated));
        if (!session.authenticated) return;
        const [assets, loadedJobs] = await Promise.all([
          loadClientAssets(language),
          loadClientJobs(),
        ]);
        setClientAssets(assets);
        setHaulItemExclusion((current) => retainCurrentHaulItemExclusions(assets, current));
        setJobs(loadedJobs);
        setCorporationSources(assets.corporationSources ?? []);
        const activeCharacters = (session.characters ?? []).filter(
          (character) => !character.onDeployment,
        );
        activeCharacterIds = new Set(activeCharacters.map((character) => character.characterId));
        setCharacterNamesById(
          new Map(
            activeCharacters.map((character) => [character.characterId, character.characterName]),
          ),
        );
        const state = await loadClientCharacterState();
        const activeStatuses = (state.characters ?? []).filter((character) =>
          activeCharacterIds.has(character.characterId),
        );
        setCharacterStatuses(activeStatuses);
        setPlanningCharacterId((current) => current ?? activeStatuses[0]?.characterId);
      })
      .catch(() => setIsAuthenticated(false));
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<ClientRefreshEventDetail>).detail;
      void Promise
        .all([
          detail.state ? Promise.resolve(detail.state) : loadClientCharacterState(),
          detail.assets ? Promise.resolve(detail.assets) : loadClientAssets(language),
          detail.jobs ? Promise.resolve(detail.jobs) : loadClientJobs(),
        ])
        .then(([state, assets, loadedJobs]) => {
          if (cancelled) return;
          setClientAssets(assets);
          setHaulItemExclusion((current) => retainCurrentHaulItemExclusions(assets, current));
          setJobs(loadedJobs);
          setCorporationSources(assets.corporationSources ?? []);
          setCharacterStatuses(
            (state.characters ?? []).filter((character) =>
              activeCharacterIds.has(character.characterId),
            ),
          );
        })
        .catch(() => undefined);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [language]);

  const stock = getPlannerStock(clientAssets, includeStock, new Set(excludedLocationIds));
  const activeHaulPatches =
    haulPatchesLoaded && characterStatuses.length > 0
      ? new Map(
          invalidateHaulPatches([...haulPatches.values()], characterStatuses).map((patch) => [
            patch.key,
            patch,
          ]),
        )
      : haulPatches;

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
    loadPlannerStockpiles()
      .then(async (savedStockpiles) => {
        if (savedStockpiles !== null) {
          const localizedStockpiles = await Promise.all(
            savedStockpiles.map(async (stockpile) => ({
              ...stockpile,
              items: await localizeItems(stockpile.items, language),
            })),
          );
          const enrichedStockpiles = await refreshPlannerStockpileEfficiencies(
            language,
            localizedStockpiles,
          );
          setStockpiles(enrichedStockpiles);
          setItems(enrichedStockpiles[0]?.items ?? []);
          return;
        }
        const savedItems = await loadBuildList();
        const localizedItems = await localizeItems(savedItems, language);
        const initialStockpiles = [
          createPlannerStockpile(defaultLocations, localizedItems, "Primary destination"),
        ];
        const enrichedStockpiles = await refreshPlannerStockpileEfficiencies(
          language,
          initialStockpiles,
        );
        setItems(localizedItems);
        setStockpiles(enrichedStockpiles);
      })
      .catch(() => {
        setItems([]);
        setStockpiles([]);
      })
      .finally(() => setAreStockpilesLoaded(true));
  }, [language]);

  useEffect(() => {
    void loadStructures().then(setKnownStructures);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadLocationOptions(reload = false) {
      const [data, storedLocations] = await Promise.all([
        loadClientAssets(language, reload).catch(() => null),
        loadPlannerLocations(),
      ]);
      if (cancelled) return;
      if (data) {
        setHaulItemExclusion((current) => retainCurrentHaulItemExclusions(data, current));
        const assetLocations = groupClientAssetsByLocation(data);
        setCachedAssetLocations(
          assetLocations
            .filter((location) => location.locationType !== "anchored")
            .map((location) => ({
              locationId: location.locationId,
              name: location.name,
              kind: location.locationType,
              baseYield: 0,
              baseManufacturingMe: 0,
              baseReactionMe: 0,
            })),
        );
      }
      const options = (data?.facilities ?? [])
        .filter(
          (facility): facility is typeof facility & { id: number } =>
            typeof facility.id === "number",
        )
        .map((facility) => ({
          id: String(facility.id),
          locationId: facility.id,
          name: facility.name,
          locationType: facility.locationType,
          baseYield: (facility.activities.reprocessing.baseYield ?? 0) * 100,
          baseManufacturingMe: facility.activities.manufacturing.materialConsumption ?? 0,
          baseReactionMe: facility.activities.reactions.materialConsumption ?? 0,
          manufacturingTimeMultiplier:
            facility.activities.manufacturing.rawJobDurationMultiplier ?? 1,
          reactionTimeMultiplier: facility.activities.reactions.rawJobDurationMultiplier ?? 1,
          sizeId: facility.sizeId,
          activities: {
            manufacturing: facility.activities.manufacturing.available,
            reactions: facility.activities.reactions.available,
          },
          buildTypeGroups: facility.buildTypeGroups,
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
      setProductionGroupReferences(data?.productionGroups ?? []);
      setLocations(nextLocations);
      void savePlannerLocations(nextLocations);
    }

    void loadLocationOptions().catch(() => {
      if (!cancelled) setLocationOptions([]);
    });
    function handleFacilitiesRefresh() {
      void loadLocationOptions(false).catch(() => {
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
    if (areStockpilesLoaded) void savePlannerStockpiles(stockpiles);
  }, [areStockpilesLoaded, stockpiles]);

  async function submitPlan(
    exclusions: Set<number>,
    itemExclusions: ReadonlyMap<string, number> = haulItemExclusion,
    patches: ReadonlyMap<string, HaulPatch> = activeHaulPatches,
  ): Promise<boolean> {
    const plannerItems = stockpiles.flatMap((stockpile) => stockpile.items);
    if (plannerItems.length === 0 || isPlanLoading) return false;
    setIsPlanLoading(true);
    setPlanStatus("Calculating...");
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    try {
      const populatedStockpiles = stockpiles.filter((stockpile) => stockpile.items.length > 0);
      const missingEfficiencies = populatedStockpiles.some(
        (stockpile) => Object.keys(stockpile.reprocessingEfficiencies ?? {}).length === 0,
      );
      if (missingEfficiencies) {
        setPlanStatus("Compression efficiencies are still loading");
        return false;
      }
      let workingAssets: PlanStockItem[] = [];
      if (includeStock && isAuthenticated && !clientAssets) {
        setPlanStatus("Account assets are still loading");
        return false;
      }
      workingAssets = getPlannerStock(clientAssets, includeStock, exclusions);
      const primaryStockpileLocations = populatedStockpiles[0].locations;
      const selectedManufacturingFacility = locationOptions.find(
        (location) => location.locationId === primaryStockpileLocations.manufacturing,
      );
      const selectedReactionFacility = locationOptions.find(
        (location) => location.locationId === primaryStockpileLocations.reactions,
      );
      const requestStock = applyHaulPatches(
        excludeHaulItemsFromStock(workingAssets, itemExclusions),
        [...patches.values()],
      );
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
            stockpiles:
              populatedStockpiles.length > 0
                ? populatedStockpiles.map((stockpile) => ({
                    ...stockpile,
                    items: stockpile.items.map(({ typeId, quantity, me, te, fromCompression }) => ({
                      typeId,
                      quantity,
                      me,
                      te,
                      fromCompression,
                    })),
                  }))
                : undefined,
            facilityProfiles: locationOptions.map((location) => ({
              locationId: location.locationId,
              sizeId: location.sizeId,
              buildTypeGroups: location.buildTypeGroups,
            })),
            assets: requestStock.map(
              ({ sourceLocationName: _sourceLocationName, ...item }) => item,
            ),
            facilityTimeMultipliers: {
              manufacturing: selectedManufacturingFacility?.manufacturingTimeMultiplier ?? 1,
              reactions: selectedReactionFacility?.reactionTimeMultiplier ?? 1,
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
        return false;
      }
      const calculatedPlan = data as PlanResult;
      await savePlanResult(calculatedPlan);
      setPlan(calculatedPlan);
      await savePlannerLocations(locations);
      setPlanStatus("Plan updated just now");
      return true;
    }
    catch {
      setPlanStatus("Could not reach the planning service");
      return false;
    }
    finally {
      setIsPlanLoading(false);
    }
  }

  async function calculatePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitPlan(new Set(excludedLocationIds));
  }

  async function excludeHaulStockpile(fromLocationId: number) {
    const nextExcludedLocationIds = new Set(excludedLocationIds);
    nextExcludedLocationIds.add(fromLocationId);
    const nextIds = [...nextExcludedLocationIds];
    setExcludedLocationIds(nextIds);
    const savePromise = saveExcludedLocationIds(nextIds);
    await submitPlan(nextExcludedLocationIds);
    await savePromise;
  }

  async function removeExcludedLocation(locationId: number) {
    const nextExcludedLocationIds = excludedLocationIds.filter((id) => id !== locationId);
    setExcludedLocationIds(nextExcludedLocationIds);
    const savePromise = saveExcludedLocationIds(nextExcludedLocationIds);
    await submitPlan(new Set(nextExcludedLocationIds));
    await savePromise;
  }

  async function clearExcludedLocations() {
    setExcludedLocationIds([]);
    setIsExcludedLocationsModalOpen(false);
    const savePromise = saveExcludedLocationIds([]);
    await submitPlan(new Set());
    await savePromise;
  }

  async function toggleHaulItemExclusion(
    key: string,
    destinationLocationId: number,
    excluded: boolean,
  ) {
    const nextExclusions = new Map(haulItemExclusion);
    if (excluded) nextExclusions.set(key, destinationLocationId);
    else nextExclusions.delete(key);
    if (await submitPlan(new Set(excludedLocationIds), nextExclusions)) {
      setHaulItemExclusion(nextExclusions);
    }
  }

  async function toggleHaulPatches(tasks: PlanResult["lists"]["haulingTasks"], patched: boolean) {
    const nextPatches = new Map(activeHaulPatches);
    const currentStock = getPlannerStock(clientAssets, includeStock, new Set(excludedLocationIds));
    for (const task of tasks) {
      if (haulItemExclusion.has(createHaulItemExclusionKey(task.fromLocationId, task.itemTypeId))) {
        continue;
      }
      const taskPatches = createHaulPatchesForTask(task, currentStock, characterStatuses);
      if (patched) {
        for (const patch of taskPatches) nextPatches.set(patch.key, patch);
      }
      else {
        for (const [key, patch] of nextPatches) {
          if (isHaulPatchForTask(task, patch)) nextPatches.delete(key);
        }
      }
    }
    if (await submitPlan(new Set(excludedLocationIds), haulItemExclusion, nextPatches)) {
      setHaulPatches(nextPatches);
      await saveHaulPatches([...nextPatches.values()]);
    }
  }

  function saveStockpile(stockpile: ClientPlanStockpile): boolean {
    const duplicate = stockpiles.some(
      (existing) =>
        existing.id !== stockpile.id
        && existing.locations.stock === stockpile.locations.stock
        && existing.locations.manufacturing === stockpile.locations.manufacturing,
    );
    if (duplicate) {
      toast.add({
        description: "A stockpile already uses this stock destination and build location.",
        type: "error",
      });
      return false;
    }
    setStockpiles((current) => {
      const existingIndex = current.findIndex((existing) => existing.id === stockpile.id);
      if (existingIndex < 0) return [...current, stockpile];
      return current.map((existing, index) => (index === existingIndex ? stockpile : existing));
    });
    void refreshPlannerStockpileEfficiencies(language, [stockpile], true).then(([updated]) => {
      if (!updated.reprocessingEfficiencies) return;
      setStockpiles((current) =>
        current.map((existing) => (existing.id === updated.id ? updated : existing)),
      );
    });
    setEditingStockpile(null);
    setStockpileEditorMode(null);
    return true;
  }

  function openNewStockpile() {
    setEditingStockpile(
      createPlannerStockpile(
        {
          ...locations,
          manufacturing: stockpiles[0]?.locations.manufacturing ?? locations.manufacturing,
          reactions: stockpiles[0]?.locations.reactions ?? locations.reactions,
        },
        [],
        `Stock destination ${stockpiles.length + 1}`,
      ),
    );
    setStockpileEditorMode("details");
  }

  function openStockpileDetails(stockpile: ClientPlanStockpile) {
    setEditingStockpile(stockpile);
    setStockpileEditorMode("details");
  }

  function openStockpileItems(stockpile: ClientPlanStockpile) {
    setEditingStockpile(stockpile);
    setStockpileEditorMode("items");
  }

  function closeStockpileEditor() {
    setEditingStockpile(null);
    setStockpileEditorMode(null);
  }

  function removeStockpile(stockpileId: string) {
    if (stockpiles.length <= 1) {
      toast.add({ description: "Keep at least one stockpile.", type: "error" });
      return;
    }
    setStockpiles((current) => current.filter((stockpile) => stockpile.id !== stockpileId));
    setPlan(null);
  }

  function requestStockpileRemoval(stockpile: ClientPlanStockpile) {
    if (stockpiles.length <= 1) {
      removeStockpile(stockpile.id);
      return;
    }
    setStockpilePendingRemoval(stockpile);
  }

  function confirmStockpileRemoval() {
    if (!stockpilePendingRemoval) return;
    removeStockpile(stockpilePendingRemoval.id);
    setStockpilePendingRemoval(null);
  }

  function exportPlan() {
    const payload = {
      format: "assembly-line-plan",
      version: 1,
      exportedAt: new Date().toISOString(),
      stockpiles,
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
      const importedStockpiles = parsed.stockpiles ?? parsed.buckets;
      if (!importedStockpiles) throw new Error("The file does not contain valid plan stockpiles.");
      const localizedStockpiles = await Promise.all(
        importedStockpiles.map(async (stockpile) => ({
          ...stockpile,
          items: await localizeItems(stockpile.items, language),
        })),
      );
      const enrichedStockpiles = await refreshPlannerStockpileEfficiencies(
        language,
        localizedStockpiles,
        true,
      );
      setStockpiles(enrichedStockpiles);
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

  const sharedLocationOptions: ActivityLocationOption[] = [
    ...locationOptions.map((location) => ({
      locationId: location.locationId,
      name: location.name,
      kind: location.locationType,
      baseYield: location.baseYield,
      baseManufacturingMe: location.baseManufacturingMe,
      baseReactionMe: location.baseReactionMe,
    })),
    ...cachedAssetLocations,
    ...knownStructures.flatMap((structure) =>
      structure.esiStructureId === undefined
        ? []
        : [
            {
              locationId: structure.esiStructureId,
              name: structure.name,
              kind: "structure" as const,
              baseYield: 0,
              baseManufacturingMe: 0,
              baseReactionMe: 0,
            },
          ],
    ),
  ].filter(
    (location, index, allLocations) =>
      allLocations.findIndex((candidate) => candidate.locationId === location.locationId) === index,
  );
  const selectedManufacturingLocation = sharedLocationOptions.find(
    (location) => location.locationId === locations.manufacturing,
  );
  const selectedReactionLocation = sharedLocationOptions.find(
    (location) => location.locationId === locations.reactions,
  );
  const activityLocationOptions = sharedLocationOptions;
  const stockLocationOptions: StockLocationOption[] = sharedLocationOptions;
  const plannerLocationNames = new Map<number, string>([
    ...stockpiles.flatMap((stockpile) =>
      stockpile.stockLocationName
        ? [[stockpile.locations.stock, stockpile.stockLocationName] as const]
        : [],
    ),
    ...sharedLocationOptions.map((location) => [location.locationId, location.name] as const),
  ]);
  const productionGroupOptions: ProductionGroupOption[] = productionGroupReferences.map((group) => {
    const facilities = locationOptions
      .filter(
        (location) =>
          location.activities[group.activity === "reaction" ? "reactions" : "manufacturing"]
          && location.buildTypeGroups[group.key] !== undefined,
      )
      .map((location) => {
        const bonus = location.buildTypeGroups[group.key]!;
        return {
          locationId: location.locationId,
          name: location.name,
          kind: location.locationType,
          baseYield: location.baseYield,
          baseManufacturingMe: location.baseManufacturingMe,
          baseReactionMe: location.baseReactionMe,
          sizeId: location.sizeId,
          materialPercentage:
            group.activity === "manufacturing"
              ? bonus.manufacturingMaterialPercentage
              : bonus.reactionMaterialPercentage,
          timePercentage:
            group.activity === "manufacturing"
              ? bonus.manufacturingTimePercentage
              : bonus.reactionTimePercentage,
        };
      })
      .sort(
        (left, right) =>
          left.materialPercentage - right.materialPercentage
          || left.sizeId - right.sizeId
          || left.name.localeCompare(right.name),
      );
    return { key: group.key, label: group.label, activity: group.activity, facilities };
  });

  function autoAssignGroupFacilities(stockpile: ClientPlanStockpile) {
    const popularity = new Map<number, number>();
    for (const existingStockpile of stockpiles) {
      for (const locationId of Object.values(existingStockpile.groupAssignments ?? {})) {
        popularity.set(locationId, (popularity.get(locationId) ?? 0) + 1);
      }
    }
    return Object.fromEntries(
      productionGroupOptions
        .filter((group) => group.facilities.length > 0)
        .map((group) => {
          const bestFacility = group.facilities
            .slice()
            .sort(
              (left, right) =>
                left.materialPercentage - right.materialPercentage
                || left.sizeId - right.sizeId
                || (popularity.get(right.locationId) ?? 0) - (popularity.get(left.locationId) ?? 0)
                || left.name.localeCompare(right.name),
            )[0];
          const defaultLocationId =
            group.activity === "manufacturing"
              ? stockpile.locations.manufacturing
              : stockpile.locations.reactions;
          const defaultFacility = group.facilities.find(
            (facility) => facility.locationId === defaultLocationId,
          );
          const selected =
            bestFacility.materialPercentage === 0 && defaultFacility !== undefined
              ? defaultFacility
              : bestFacility;
          return [group.key, selected.locationId] as const;
        }),
    );
  }

  const selectedDirectSourceCount = corporationSources.filter((source) => source.selected).length;
  const selectedContainerCount = corporationSources.reduce(
    (total, source) => total + source.containers.filter((container) => container.selected).length,
    0,
  );
  const selectedSourceCount = selectedDirectSourceCount + selectedContainerCount;
  const selectedSourceLabel =
    selectedSourceCount === 0
      ? "No corporation sources selected"
      : `${selectedSourceCount} corporation source${selectedSourceCount === 1 ? "" : "s"} selected`;

  return (
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">PRODUCTION CONTROL</p>
          <h1>Build plan</h1>
          <p className="mb-4 text-sm text-muted-foreground">
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
            <div className="flex flex-wrap gap-2 mb-2 justify-end">
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
                disabled={stockpiles.length === 0}
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
              <Button type="button" onClick={openNewStockpile}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add new Stock location
              </Button>
            </div>
          </div>
          <div className="grid min-w-0 gap-3">
            {stockpiles.length === 0 ? (
              <Empty>
                <EmptyDescription>Add a stock location to begin your plan.</EmptyDescription>
              </Empty>
            ) : (
              stockpiles.map((stockpile) => (
                <PlannerStockpileSummary
                  key={stockpile.id}
                  stockpile={stockpile}
                  locationNamesById={plannerLocationNames}
                  onEditDetails={() => openStockpileDetails(stockpile)}
                  onEditItems={() => openStockpileItems(stockpile)}
                  onRemove={() => requestStockpileRemoval(stockpile)}
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
              Include selected assets
            </label>
            <span className="text-sm text-muted-foreground">{selectedSourceLabel}</span>
            <Button
              type="button"
              variant="outline"
              nativeButton={false}
              render={<Link href="/corp-hangars" />}
            >
              <Settings2 data-icon="inline-start" aria-hidden="true" />
              Edit sources
            </Button>
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
              disabled={
                isPlanLoading || stockpiles.every((stockpile) => stockpile.items.length === 0)
              }
              icon={ClipboardList}
              isLoading={isPlanLoading}
              label="Calculate production plan"
              loadingLabel="Calculating..."
              onClick={() => void submitPlan(new Set(excludedLocationIds))}
            />
          </div>
        </div>
      </section>
      <PlannerStockpileDetailsDialog
        key={`details-${editingStockpile?.id ?? "new-stockpile"}`}
        stockpile={editingStockpile}
        open={stockpileEditorMode === "details"}
        activityLocations={activityLocationOptions}
        stockLocations={stockLocationOptions}
        excludedStockLocationIds={stockpiles.map((stockpile) => stockpile.locations.stock)}
        productionGroups={productionGroupOptions}
        onAutoAssign={autoAssignGroupFacilities}
        onOpenChange={(open) => !open && closeStockpileEditor()}
        onSave={saveStockpile}
      />
      <PlannerStockpileItemsDialog
        key={`items-${editingStockpile?.id ?? "new-stockpile"}`}
        stockpile={editingStockpile}
        open={stockpileEditorMode === "items"}
        language={language}
        onOpenChange={(open) => !open && closeStockpileEditor()}
        onSave={saveStockpile}
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
                <span>Remove All</span>
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
              {sharedLocationOptions.length > 0 ? (
                <>
                  <label>
                    <div className={`${styles.planOptionHeader} text-xs`}>
                      <span>MANUFACTURING LOCATION</span>
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
                      items={sharedLocationOptions.map((location) => ({
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
                          {sharedLocationOptions
                            .slice()
                            .sort(
                              (left, right) =>
                                left.baseManufacturingMe - right.baseManufacturingMe
                                || left.name.localeCompare(right.name),
                            )
                            .map((location) => (
                              <SelectItem
                                value={String(location.locationId)}
                                key={`manufacturing-${location.locationId}`}
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
                      items={sharedLocationOptions.map((location) => ({
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
                          {sharedLocationOptions
                            .slice()
                            .sort(
                              (left, right) =>
                                left.baseReactionMe - right.baseReactionMe
                                || left.name.localeCompare(right.name),
                            )
                            .map((location) => (
                              <SelectItem
                                value={String(location.locationId)}
                                key={`reaction-${location.locationId}`}
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
                      page or{" "}
                      <EveAuthorizationWarning href="/api/auth/eve/start">
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          className="inline h-auto p-0 align-baseline font-normal"
                        >
                          add character(s) via ESI
                        </Button>
                      </EveAuthorizationWarning>{" "}
                      to improve plan results.
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
                  <span>INCLUDE SELECTED ASSETS</span>
                </div>
                <Switch
                  aria-label="Include assets"
                  checked={includeStock}
                  onCheckedChange={setIncludeStock}
                />
              </label>
              <div className={styles.checkboxOption}>
                <div className={`${styles.planOptionHeader} text-xs`}>
                  <span>PLANNING SOURCES</span>
                  <Link href="/assets" className="text-primary">
                    Edit
                  </Link>
                </div>
                <span className="text-sm text-muted-foreground">{selectedSourceLabel}</span>
              </div>
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
          onClearAll={() => setIsClearExcludedLocationsDialogOpen(true)}
          onSave={() => setIsExcludedLocationsModalOpen(false)}
          onCancel={() => setIsExcludedLocationsModalOpen(false)}
        />
      )}
      <AlertDialog open={isDeleteAllDialogOpen} onOpenChange={setIsDeleteAllDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all build-list items?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove every item from the current build list. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDeleteAllItems}>
              Remove All
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
              variant="destructive"
              disabled={isPlanLoading}
              onClick={() => {
                setIsClearExcludedLocationsDialogOpen(false);
                void clearExcludedLocations();
              }}
            >
              Remove All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={stockpilePendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setStockpilePendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove stockpile?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove {stockpilePendingRemoval?.name ?? "this stockpile"} and its item
              list. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmStockpileRemoval}>
              Remove stockpile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PlannerResults
        language={language}
        plan={plan}
        planStatus={planStatus}
        characterStatuses={characterStatuses}
        characterNamesById={characterNamesById}
        jobs={jobs}
        stock={stock}
        locations={locations}
        stockpiles={stockpiles}
        locationOptions={locationOptions}
        onAddBuildItem={(item) =>
          importItems([
            {
              ...item,
              categoryName: "Reaction Formula",
              iconCategory: "reactionformula",
            },
          ])
        }
        onExcludeHaulStockpile={excludeHaulStockpile}
        haulItemExclusion={haulItemExclusion}
        onToggleHaulItemExclusion={toggleHaulItemExclusion}
        haulPatches={activeHaulPatches}
        onToggleHaulPatches={toggleHaulPatches}
      />
    </>
  );
}

export default Planner;

function PlannerStockpileSummary({
  stockpile,
  locationNamesById,
  onEditDetails,
  onEditItems,
  onRemove,
}: {
  stockpile: ClientPlanStockpile;
  locationNamesById: Map<number, string>;
  onEditDetails: () => void;
  onEditItems: () => void;
  onRemove: () => void;
}) {
  const locationName = (locationId: number) =>
    locationNamesById.get(locationId) ?? String(locationId);

  return (
    <article className="grid min-w-0 gap-3 border p-4">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-medium">{stockpile.name}</h3>
            {stockpile.kind === "special" && <Badge variant="outline">Special</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {stockpile.items.length.toLocaleString()} item types,{" "}
            {stockpile.items.reduce((total, item) => total + item.quantity, 0).toLocaleString()}{" "}
            units
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" onClick={onEditDetails}>
            <Pencil data-icon="inline-start" aria-hidden="true" />
            Edit details
          </Button>
          <Button type="button" variant="outline" onClick={onEditItems}>
            <ClipboardList data-icon="inline-start" aria-hidden="true" />
            Edit items
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove ${stockpile.name}`}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="grid min-w-0 gap-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <span className="block text-xs uppercase text-muted-foreground">Stock destination</span>
          <span className="block truncate">
            {locationNamesById.get(stockpile.locations.stock)
              ?? stockpile.stockLocationName
              ?? String(stockpile.locations.stock)}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-xs uppercase text-muted-foreground">Build location</span>
          <span className="block truncate">{locationName(stockpile.locations.manufacturing)}</span>
        </div>
        <div className="min-w-0">
          <span className="block text-xs uppercase text-muted-foreground">Reaction location</span>
          <span className="block truncate">{locationName(stockpile.locations.reactions)}</span>
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
  const sortedLocationIds = [...locationIds].sort((leftLocationId, rightLocationId) => {
    const leftName = locationNamesById.get(leftLocationId) ?? String(leftLocationId);
    const rightName = locationNamesById.get(rightLocationId) ?? String(rightLocationId);
    return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
  });

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
            {sortedLocationIds.map((locationId) => (
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
          <Button
            type="button"
            variant="destructive"
            disabled={isLoading || locationIds.length === 0}
            onClick={onClearAll}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Remove All
          </Button>
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
