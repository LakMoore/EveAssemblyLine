"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { NoPrefetchLink } from "@/components/NoPrefetchLink";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAppLanguage } from "@/app/AppShell";
import {
  blueprintImageVariation,
  countBlueprints,
  countReactionFormulas,
  isCountableBlueprintStock,
} from "@/lib/client/blueprintCounts";
import {
  filterClientAssetsForPlanning,
  loadClientAssets,
  loadClientSession,
  type ClientRefreshEventDetail,
} from "@/lib/client/requestCache";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import type { StockItem } from "@/lib/planning/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import { cn } from "@/lib/utils";

type TechCategory = "tech1" | "tech2" | "tech3" | "faction" | "reaction";
type BlueprintGroup = {
  name: string;
  items: Array<{
    typeId: number;
    name: string;
    techCategory: TechCategory;
    imageVariation?: "relic";
  }>;
};
type CatalogResponse = { groups?: BlueprintGroup[]; error?: string };
type Mode = "visible" | "owned";
const emptyCounts = {
  bpoCount: 0,
  bpcCount: 0,
  bpcRuns: 0,
  availableBpoCount: 0,
  availableBpcRuns: 0,
};
const tileClassName = "flex min-w-0 flex-col items-center gap-2 border p-3 text-center";

/** Merges sibling market categories at their parent level in the compact view. */
function groupBlueprintCategories(
  groups: readonly BlueprintGroup[],
  detailed: boolean,
  language: SdeLanguage,
): BlueprintGroup[] {
  if (detailed) return [...groups];
  const merged = new Map<string, Map<string, BlueprintGroup["items"]>>();
  for (const group of groups) {
    const separator = group.name.lastIndexOf(" / ");
    const name = separator < 0 ? group.name : group.name.slice(0, separator);
    const leaf = separator < 0 ? group.name : group.name.slice(separator + 3);
    const leaves = merged.get(name) ?? new Map<string, BlueprintGroup["items"]>();
    leaves.set(leaf, [...(leaves.get(leaf) ?? []), ...group.items]);
    merged.set(name, leaves);
  }
  return [...merged]
    .map(([name, leaves]) => ({
      name,
      items: [...leaves]
        .sort((left, right) => left[0].localeCompare(right[0], language))
        .flatMap(([, items]) =>
          items.sort((left, right) => left.name.localeCompare(right.name, language)),
        ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, language));
}

/** Returns the resolved stockpile location rather than an inner container ID. */
function blueprintStockLocationId(item: StockItem): number | undefined {
  return item.rootLocationId;
}

/** Displays the SDE blueprint catalog alongside the selected collection's stock. */
export default function BlueprintsPage() {
  const { language } = useAppLanguage();
  const [mode, setMode] = useState<Mode>("visible");
  const [techCategory, setTechCategory] = useState<TechCategory>("tech1");
  const [detailedCategories, setDetailedCategories] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<{
    language: SdeLanguage;
    groups: BlueprintGroup[];
  } | null>(null);
  const [stock, setStock] = useState<{ language: SdeLanguage; items: StockItem[] } | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<{
    language: SdeLanguage;
    message: string;
  } | null>(null);
  const [stockFailure, setStockFailure] = useState<{
    language: SdeLanguage;
    message: string;
  } | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const groups = catalog?.language === language ? catalog.groups : null;
  const assets = stock?.language === language ? stock.items : [];
  const catalogError = catalogFailure?.language === language ? catalogFailure.message : null;
  const assetsError = stockFailure?.language === language ? stockFailure.message : null;

  useEffect(() => {
    let cancelled = false;

    /** Loads catalog and collection stock independently so public SDE data survives auth errors. */
    async function loadCatalog() {
      try {
        const response = await fetch(`/api/reference/blueprints?language=${language}`);
        const body = (await response.json()) as CatalogResponse;
        if (!response.ok || !body.groups) {
          throw new Error(body.error ?? "Could not load blueprints.");
        }
        if (!cancelled) {
          setCatalog({ language, groups: body.groups });
          setCatalogFailure(null);
        }
      }
      catch (error) {
        if (!cancelled) {
          setCatalog(null);
          setCatalogFailure({
            language,
            message: error instanceof Error ? error.message : "Could not load blueprints.",
          });
        }
      }
    }

    /** Reads only the current session's selected corporation sources and personal stock. */
    async function loadAssets() {
      try {
        const session = await loadClientSession();
        if (!cancelled) setConnected(session.authenticated === true);
        if (!session.authenticated) {
          if (!cancelled) {
            setStock({ language, items: [] });
            setSelectedLocationId(null);
          }
          return;
        }
        const response = await loadClientAssets(language);
        if (!cancelled) {
          setStock({ language, items: filterClientAssetsForPlanning(response).assets ?? [] });
          setSelectedLocationId(null);
          setStockFailure(null);
        }
      }
      catch {
        if (!cancelled) {
          setStockFailure({
            language,
            message: "Collection blueprints could not be loaded. Counts may be incomplete.",
          });
        }
      }
    }

    void loadCatalog();
    void loadAssets();
    const handleRefresh = (event: Event) => {
      const { assets: refreshedAssets, assetsLanguage } = (
        event as CustomEvent<ClientRefreshEventDetail>
      ).detail;
      if (assetsLanguage && assetsLanguage !== language) return;
      if (refreshedAssets && assetsLanguage === language) {
        setStock({ language, items: filterClientAssetsForPlanning(refreshedAssets).assets ?? [] });
        setSelectedLocationId(null);
        setStockFailure(null);
        return;
      }
      void loadClientAssets(language, true)
        .then((response) => {
          if (!cancelled) {
            setStock({ language, items: filterClientAssetsForPlanning(response).assets ?? [] });
            setSelectedLocationId(null);
            setStockFailure(null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setStockFailure({
              language,
              message: "Collection blueprints could not be loaded. Counts may be incomplete.",
            });
          }
        });
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [language]);

  const techGroups = (groups ?? [])
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.techCategory === techCategory),
    }))
    .filter((group) => group.items.length > 0);
  const techTypeIds = new Set(
    techGroups.flatMap((group) => group.items.map((item) => item.typeId)),
  );
  const eligibleAssets = assets.filter(
    (item) => techTypeIds.has(item.typeId) && isCountableBlueprintStock(item, mode),
  );
  const locationNames = new Map<number, string>();
  for (const item of eligibleAssets) {
    const locationId = blueprintStockLocationId(item);
    if (locationId !== undefined && !locationNames.has(locationId)) {
      locationNames.set(locationId, item.sourceLocationName ?? `Location ${locationId}`);
    }
  }
  const nameCounts = new Map<string, number>();
  for (const name of locationNames.values()) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const locations = [...locationNames]
    .map(([id, name]) => [id, (nameCounts.get(name) ?? 0) > 1 ? `${name} (${id})` : name] as const)
    .sort((left, right) => left[1].localeCompare(right[1], language));
  const activeLocationId =
    selectedLocationId !== null && locationNames.has(selectedLocationId)
      ? selectedLocationId
      : null;
  const locationAssets =
    activeLocationId === null
      ? assets
      : eligibleAssets.filter((item) => blueprintStockLocationId(item) === activeLocationId);
  const counts = countBlueprints(locationAssets, mode);
  const formulaCounts = countReactionFormulas(locationAssets, mode);
  const displayedGroups = groupBlueprintCategories(techGroups, detailedCategories, language);
  const total = displayedGroups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <div className="grid min-w-0 gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <div className="grid gap-2">
          <span className="eyebrow">INFORMATION / INDUSTRY</span>
          <h1 className="text-2xl font-semibold">Blueprints</h1>
          <p className="text-sm text-muted-foreground">
            {groups ? `${total.toLocaleString()} blueprint types` : "Loading catalog..."}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-2">
            <Label htmlFor="blueprint-tech">Tech</Label>
            <Select
              items={{
                tech1: "Tech 1",
                tech2: "Tech 2",
                tech3: "Tech 3",
                faction: "Faction",
                reaction: "Reaction Formulas",
              }}
              value={techCategory}
              onValueChange={(value) => {
                if (
                  value === "tech1"
                  || value === "tech2"
                  || value === "tech3"
                  || value === "faction"
                  || value === "reaction"
                ) {
                  setTechCategory(value);
                  setSelectedLocationId(null);
                }
              }}
            >
              <SelectTrigger id="blueprint-tech" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="tech1">Tech 1</SelectItem>
                  <SelectItem value="tech2">Tech 2</SelectItem>
                  <SelectItem value="tech3">Tech 3</SelectItem>
                  <SelectItem value="faction">Faction</SelectItem>
                  <SelectItem value="reaction">Reaction Formulas</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="blueprint-view">View</Label>
            <Select
              items={{ visible: "Visible", owned: "Owned" }}
              value={mode}
              onValueChange={(value) => {
                if (value === "visible" || value === "owned") {
                  setMode(value);
                  setSelectedLocationId(null);
                }
              }}
            >
              <SelectTrigger id="blueprint-view" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="visible">Visible</SelectItem>
                  <SelectItem value="owned">Owned</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="blueprint-location">Location</Label>
            <Select
              items={[
                { value: "all", label: "All locations" },
                ...locations.map(([id, name]) => ({ value: String(id), label: name })),
              ]}
              value={activeLocationId === null ? "all" : String(activeLocationId)}
              onValueChange={(value) => {
                if (value === "all") setSelectedLocationId(null);
                else if (value && locationNames.has(Number(value))) {
                  setSelectedLocationId(Number(value));
                }
              }}
            >
              <SelectTrigger id="blueprint-location" className="w-48 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All locations</SelectItem>
                  {locations.map(([id, name]) => (
                    <SelectItem key={id} value={String(id)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-h-8 items-center gap-2 self-end">
            <Label htmlFor="blueprint-detailed-categories">Detailed Categories</Label>
            <Switch
              id="blueprint-detailed-categories"
              checked={detailedCategories}
              onCheckedChange={setDetailedCategories}
            />
          </div>
        </div>
      </header>
      {catalogError && (
        <Alert variant="destructive">
          <AlertDescription>{catalogError}</AlertDescription>
        </Alert>
      )}
      {assetsError && (
        <Alert variant="destructive">
          <AlertDescription>{assetsError}</AlertDescription>
        </Alert>
      )}
      {mode === "owned" && connected === false && (
        <Alert>
          <AlertDescription>Connect a character to see owned blueprints.</AlertDescription>
        </Alert>
      )}
      {stock?.language !== language && !assetsError && (
        <p className="text-sm text-muted-foreground">Loading collection blueprints...</p>
      )}
      {!groups && !catalogError && (
        <div className="grid gap-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {groups && displayedGroups.length === 0 && (
        <Empty>
          <EmptyDescription>No blueprints found for this tech category.</EmptyDescription>
        </Empty>
      )}
      {displayedGroups.map((group) => (
        <section key={group.name} className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
            <h2 className="text-sm font-semibold">{group.name}</h2>
            <span className="text-xs text-muted-foreground">
              {group.items.length.toLocaleString()}
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2">
            {group.items.map((item) => {
              const stock = counts.get(item.typeId) ?? emptyCounts;
              const formulas = formulaCounts.get(item.typeId);
              const available =
                techCategory === "reaction"
                  ? (formulas?.availableCount ?? 0) > 0
                  : stock.availableBpcRuns > 0 || stock.availableBpoCount > 0;
              const content = (
                <>
                  <Image
                    src={eveTypeImageUrl(
                      item.typeId,
                      item.imageVariation
                        ?? (techCategory === "reaction" ? "bpc" : blueprintImageVariation(stock)),
                    )}
                    alt=""
                    width={64}
                    height={64}
                    className={available ? "size-16" : "size-16 opacity-40 grayscale"}
                  />
                  <span className="line-clamp-3 min-h-12 w-full text-xs leading-4" lang={language}>
                    {item.name}
                  </span>
                  {techCategory === "reaction" ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {(formulas?.totalCount ?? 0).toLocaleString()} formulas
                    </span>
                  ) : (
                    <span className="grid w-full grid-cols-3 gap-1 text-[10px] text-muted-foreground tabular-nums">
                      <span title="Blueprint copies">
                        {stock.bpcCount.toLocaleString()}
                        <br />
                        BPC
                      </span>
                      <span title="Copy runs">
                        {stock.bpcRuns.toLocaleString()}
                        <br />
                        runs
                      </span>
                      <span title="Blueprint originals">
                        {stock.bpoCount.toLocaleString()}
                        <br />
                        BPO
                      </span>
                    </span>
                  )}
                </>
              );
              return available ? (
                <NoPrefetchLink
                  key={item.typeId}
                  prefetch={false}
                  href={`/assets?typeId=${item.typeId}`}
                  title={item.name}
                  className={cn(
                    tileClassName,
                    "hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                  )}
                >
                  {content}
                </NoPrefetchLink>
              ) : (
                <div key={item.typeId} className={tileClassName}>
                  {content}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
