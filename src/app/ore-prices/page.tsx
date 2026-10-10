"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Gem, RefreshCw } from "lucide-react";
import { CompressSettingsPanel, useCompressSettings } from "@/components/CompressSettingsPanel";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createReprocessingProfile,
  type ReprocessingProfile,
} from "@/lib/planning/reprocessingProfile";
import { marketHubs } from "@/lib/reference/marketHubs";
import { useAppLanguage } from "../AppShell";
import { cn } from "@/lib/utils";

type OrePriceMaterial = {
  typeId: number;
  name: string;
  quantity: number;
  reprocessingEfficiency: number;
  unitVolume: number;
  volume: number;
  unitPrice: number | null;
  totalValue: number | null;
};

/** Price and reprocessing data for one compressed ore portion. */
type OrePriceItem = {
  typeId: number;
  name: string;
  quantity: number;
  reprocessingEfficiency: number;
  unitVolume: number;
  oreUnitPrice: number | null;
  oreCost: number | null;
  oreVolume: number;
  reprocessingAvailable: boolean;
  materials: OrePriceMaterial[];
  materialsVolume: number;
  materialsValue: number | null;
  difference: number | null;
  differencePercent: number | null;
};

/** Response returned by the ore-prices API route. */
type OrePricesResponse = {
  market: string;
  generatedAt: string;
  items: OrePriceItem[];
  error?: string;
};

type SortKey = "name" | "oreVolume" | "difference";
type SortDirection = "asc" | "desc";

const desktopGridColumns =
  "lg:grid-cols-[minmax(220px,1.8fr)_minmax(64px,0.45fr)_minmax(110px,0.8fr)_minmax(82px,0.65fr)_minmax(120px,0.85fr)_minmax(82px,0.65fr)_minmax(110px,0.85fr)_minmax(64px,0.45fr)]";
const sortOptions: {
  value: string;
  label: string;
  sortKey: SortKey;
  direction: SortDirection;
}[] = [
  { value: "name-asc", label: "Ore name (A to Z)", sortKey: "name", direction: "asc" },
  { value: "name-desc", label: "Ore name (Z to A)", sortKey: "name", direction: "desc" },
  {
    value: "volume-asc",
    label: "Ore volume (low to high)",
    sortKey: "oreVolume",
    direction: "asc",
  },
  {
    value: "volume-desc",
    label: "Ore volume (high to low)",
    sortKey: "oreVolume",
    direction: "desc",
  },
  {
    value: "difference-asc",
    label: "Difference (low to high)",
    sortKey: "difference",
    direction: "asc",
  },
  {
    value: "difference-desc",
    label: "Difference (high to low)",
    sortKey: "difference",
    direction: "desc",
  },
];

/** Formats currency consistently with the appraisal page. */
function formatIsk(value: number | null) {
  return value === null
    ? "-"
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)} ISK`;
}

/** Formats packaged volume for compact table cells. */
function formatVolume(value: number) {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)} m³`;
}

/** Formats difference as a percentage of the input ore cost. */
function formatDifferencePercent(value: number | null) {
  return value === null
    ? "-"
    : `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`;
}

/** Loads the current SDE-backed ore appraisal list for the selected language. */
async function fetchOrePrices(
  language: string,
  marketId: string,
  reprocessingProfile: ReprocessingProfile,
  signal: AbortSignal,
) {
  const response = await fetch(
    "/api/ore-prices",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ language, marketId, reprocessingProfile }),
    },
  );
  const result = (await response.json()) as OrePricesResponse;
  if (!response.ok) throw new Error(result.error ?? "Could not load ore prices.");
  return result;
}

/** Sorts ore rows by localized name, input volume, or ISK difference. */
function sortOrePrices(
  items: OrePriceItem[],
  sortKey: SortKey,
  direction: SortDirection,
  language: string,
) {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    if (sortKey === "name") {
      return left.name.localeCompare(right.name, language) * multiplier;
    }
    const leftValue = left[sortKey];
    const rightValue = right[sortKey];
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return (leftValue - rightValue) * multiplier;
  });
}

type SortHeaderProps = {
  label: string;
  sortKey: SortKey;
  activeSort: SortKey;
  direction: SortDirection;
  onSort: (sortKey: SortKey) => void;
  align?: "left" | "right";
};

/** Renders one accessible sortable column heading. */
function SortHeader({
  label,
  sortKey,
  activeSort,
  direction,
  onSort,
  align = "right",
}: SortHeaderProps) {
  const active = sortKey === activeSort;
  const SortIcon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto px-1 font-normal",
        align === "left" ? "mr-auto justify-start" : "ml-auto justify-end",
      )}
      aria-label={`Sort by ${label}${active ? `, ${direction}ending` : ""}`}
      onClick={() => {
        onSort(sortKey);
      }}
    >
      {label}
      <SortIcon data-icon="inline-end" aria-hidden="true" />
    </Button>
  );
}

/** Renders compressed ore reprocessing batches with live market appraisals. */
export default function OrePricesPage() {
  const { language } = useAppLanguage();
  const reprocessingSettings = useCompressSettings(language);
  const [items, setItems] = useState<OrePriceItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState("");
  const [loadedRequestKey, setLoadedRequestKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [activeRequestKey, setActiveRequestKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [errorRequestKey, setErrorRequestKey] = useState<string | null>(null);
  const activeRequestRef = useRef<{
    requestKey: string;
    controller: AbortController;
  } | null>(null);
  const requestIdRef = useRef(0);
  const [sortKey, setSortKey] = useState<SortKey>("difference");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [openTypeId, setOpenTypeId] = useState<number | null>(null);
  const selectedLocation = reprocessingSettings.selectedLocation;
  const reprocessingProfile = selectedLocation
    ? createReprocessingProfile(
        selectedLocation,
        reprocessingSettings.skillLevels,
        reprocessingSettings.selectedImplant?.level ?? 0,
      )
    : null;
  const marketId = reprocessingSettings.settings.marketId;
  const market = marketHubs.find((hub) => hub.id === marketId)?.name ?? marketHubs[0].name;
  const requestKey = JSON.stringify({ language, marketId, reprocessingProfile });
  const hasCurrentPrices = loadedRequestKey === requestKey;
  const isLoading = activeRequestKey === requestKey;
  const currentRequestError = errorRequestKey === requestKey ? error : "";
  const sortSelection =
    sortOptions.find((option) => option.sortKey === sortKey && option.direction === sortDirection)
      ?.value ?? "difference-desc";

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (activeRequest && activeRequest.requestKey !== requestKey) {
      activeRequest.controller.abort();
    }
  }, [requestKey]);

  useEffect(() => () => activeRequestRef.current?.controller.abort(), []);

  /** Fetches prices for the exact profile and market selected at click time. */
  async function fetchCurrentPrices() {
    if (
      reprocessingSettings.isLoading
      || reprocessingSettings.error
      || !selectedLocation
      || isLoading
    ) return;
    const selectedProfile = reprocessingProfile;
    if (!selectedProfile) return;
    const selectedLanguage = language;
    const selectedMarketId = marketId;
    const selectedRequestKey = requestKey;
    activeRequestRef.current?.controller.abort();
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    activeRequestRef.current = {
      requestKey: selectedRequestKey,
      controller,
    };
    setActiveRequestKey(selectedRequestKey);
    setError("");
    setErrorRequestKey(null);
    setItems([]);
    setGeneratedAt("");
    setLoadedRequestKey(null);
    try {
      const result = await fetchOrePrices(
        selectedLanguage,
        selectedMarketId,
        selectedProfile,
        controller.signal,
      );
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setItems(result.items);
      setGeneratedAt(result.generatedAt);
      setLoadedRequestKey(selectedRequestKey);
    }
    catch (caughtError: unknown) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(caughtError instanceof Error ? caughtError.message : "Could not load ore prices.");
      setErrorRequestKey(selectedRequestKey);
    }
    finally {
      if (requestId === requestIdRef.current) {
        activeRequestRef.current = null;
        setActiveRequestKey(null);
      }
    }
  }

  function changeSort(nextSortKey: SortKey) {
    if (nextSortKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextSortKey);
    setSortDirection(nextSortKey === "name" ? "asc" : "desc");
  }

  /** Applies a complete sort key and direction selected on small screens. */
  function changeSortSelection(value: string | null) {
    const option = sortOptions.find((candidate) => candidate.value === value);
    if (!option) return;
    setSortKey(option.sortKey);
    setSortDirection(option.direction);
  }

  const query = filter.trim().toLocaleLowerCase(language);
  const currentItems = hasCurrentPrices ? items : [];
  const filteredItems = currentItems.filter(
    (item) =>
      item.name.toLocaleLowerCase(language).includes(query)
      || item.materials.some((material) =>
        material.name.toLocaleLowerCase(language).includes(query),
      ),
  );
  const sortedItems = sortOrePrices(filteredItems, sortKey, sortDirection, language);

  return (
    <div className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <div className="grid gap-2">
          <span className="eyebrow">INFORMATION / MARKET</span>
          <h1 className="text-2xl font-semibold">Ore prices</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {market} minimum sell prices · minimum reprocessing batch · yield calculated per ore
          </p>
        </div>
        <div className="grid gap-1 text-right text-xs text-muted-foreground">
          <span>Market: {market}</span>
          {hasCurrentPrices && generatedAt && (
            <time dateTime={generatedAt}>Updated {new Date(generatedAt).toLocaleString()}</time>
          )}
        </div>
      </header>

      <CompressSettingsPanel
        state={reprocessingSettings}
        showOrderType={false}
        className="grid grid-cols-1 gap-3 border-b pb-5 sm:grid-cols-2 xl:grid-cols-4"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          {isLoading
            ? "Fetching ore prices..."
            : loadedRequestKey !== null && !hasCurrentPrices
              ? "Settings changed. Current results need an update."
              : hasCurrentPrices
                ? `Showing ${market} prices for the selected reprocessing profile.`
                : "No ore prices fetched yet."}
        </p>
        <Button
          type="button"
          disabled={
            reprocessingSettings.isLoading
            || Boolean(reprocessingSettings.error)
            || !selectedLocation
            || isLoading
          }
          onClick={() => void fetchCurrentPrices()}
        >
          <RefreshCw
            data-icon="inline-start"
            aria-hidden="true"
            className={isLoading ? "animate-spin" : undefined}
          />
          {isLoading
            ? "Fetching prices..."
            : hasCurrentPrices
              ? "Refresh prices"
              : "Fetch ore prices"}
        </Button>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field className="w-full max-w-sm gap-1">
          <FieldLabel htmlFor="ore-price-filter">Filter</FieldLabel>
          <Input
            id="ore-price-filter"
            type="search"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            placeholder="Ore or material name"
          />
        </Field>
        {hasCurrentPrices && (
          <p className="text-xs text-muted-foreground">
            {filteredItems.length} of {currentItems.length} ores
          </p>
        )}
      </div>

      {currentRequestError && (
        <Alert variant="destructive">
          <AlertDescription>{currentRequestError}</AlertDescription>
        </Alert>
      )}
      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading ore prices...</p>
      ) : sortedItems.length === 0 ? (
        <Empty className="min-h-48">
          <Gem aria-hidden="true" />
          <EmptyTitle>
            {currentRequestError
              ? "Ore prices unavailable"
              : hasCurrentPrices
                ? "No matching ores"
                : "No prices fetched"}
          </EmptyTitle>
          <EmptyDescription>
            {currentRequestError
              ? "Market or SDE data could not be loaded."
              : hasCurrentPrices
                ? "Try a different filter."
                : "Ore comparisons will appear here."}
          </EmptyDescription>
        </Empty>
      ) : (
        <div
          role="region"
          aria-label="Ore price comparison table"
          tabIndex={0}
          className="border-y"
        >
          <div className="border-b p-3 lg:hidden">
            <Field className="w-full gap-1">
              <FieldLabel htmlFor="ore-price-sort">Sort by</FieldLabel>
              <Select
                value={sortSelection}
                onValueChange={changeSortSelection}
                items={sortOptions.map(({ value, label }) => ({ value, label }))}
              >
                <SelectTrigger id="ore-price-sort" className="w-full" aria-label="Sort ore prices">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sortOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="overflow-x-auto">
            <div
              role="table"
              aria-label="Ore reprocessing appraisals"
              className="min-w-0 lg:min-w-280"
            >
              <div
                role="rowgroup"
                className="sticky top-0 z-10 hidden border-b bg-background lg:block"
              >
                <div
                  role="row"
                  className={`grid grid-cols-1 items-center gap-2 py-2 ${desktopGridColumns}`}
                >
                  <div
                    role="columnheader"
                    aria-sort={
                      sortKey === "name"
                        ? sortDirection === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className="flex px-2"
                  >
                    <SortHeader
                      label="Ore"
                      sortKey="name"
                      activeSort={sortKey}
                      direction={sortDirection}
                      onSort={changeSort}
                      align="left"
                    />
                  </div>
                  <div
                    role="columnheader"
                    className="px-2 text-right text-xs text-muted-foreground"
                  >
                    Batch qty
                  </div>
                  <div
                    role="columnheader"
                    className="px-2 text-right text-xs text-muted-foreground"
                  >
                    Ore cost
                  </div>
                  <div
                    role="columnheader"
                    aria-sort={
                      sortKey === "oreVolume"
                        ? sortDirection === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className="flex px-2"
                  >
                    <SortHeader
                      label="Ore volume"
                      sortKey="oreVolume"
                      activeSort={sortKey}
                      direction={sortDirection}
                      onSort={changeSort}
                    />
                  </div>
                  <div
                    role="columnheader"
                    className="px-2 text-right text-xs text-muted-foreground"
                  >
                    Material value
                  </div>
                  <div
                    role="columnheader"
                    className="px-2 text-right text-xs text-muted-foreground"
                  >
                    Material volume
                  </div>
                  <div
                    role="columnheader"
                    aria-sort={
                      sortKey === "difference"
                        ? sortDirection === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className="flex px-2"
                  >
                    <SortHeader
                      label="Difference"
                      sortKey="difference"
                      activeSort={sortKey}
                      direction={sortDirection}
                      onSort={changeSort}
                    />
                  </div>
                  <div
                    role="columnheader"
                    className="px-2 text-right text-xs text-muted-foreground"
                  >
                    Diff %
                  </div>
                </div>
              </div>
              <div role="rowgroup">
                {sortedItems.map((item) => (
                  <Collapsible
                    key={item.typeId}
                    open={openTypeId === item.typeId}
                    onOpenChange={(open) => {
                      setOpenTypeId(open ? item.typeId : null);
                    }}
                    className="contents"
                  >
                    <div
                      role="row"
                      className={`grid grid-cols-1 gap-2 border-b py-3 lg:items-center lg:gap-2 lg:py-0 ${desktopGridColumns}`}
                    >
                      <div role="cell" className="min-w-0 p-2">
                        <span className="mb-1 block px-2 text-xs text-muted-foreground lg:hidden">
                          Ore
                        </span>
                        <div className="flex min-w-0 items-center gap-1">
                          <TypeIdentity
                            name={item.name}
                            typeId={item.typeId}
                            imageSize={28}
                            linkPath={null}
                            subline={`${item.reprocessingEfficiency.toFixed(1)}% reprocessing yield`}
                            className="min-w-0 flex-1"
                          />
                          <CollapsibleTrigger
                            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
                            aria-label={`${openTypeId === item.typeId ? "Hide" : "Show"} ${item.name} reprocessing materials`}
                            title={`${openTypeId === item.typeId ? "Hide" : "Show"} reprocessing materials`}
                          >
                            <ChevronDown
                              aria-hidden="true"
                              className={cn(
                                "transition-transform",
                                openTypeId === item.typeId && "rotate-180",
                              )}
                            />
                          </CollapsibleTrigger>
                        </div>
                      </div>
                      <div role="cell" className="px-2 lg:text-right">
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Batch qty
                        </span>
                        <span className="block tabular-nums">{item.quantity.toLocaleString()}</span>
                      </div>
                      <div role="cell" className="px-2 lg:text-right">
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Ore cost
                        </span>
                        <span className="block tabular-nums">{formatIsk(item.oreCost)}</span>
                      </div>
                      <div role="cell" className="px-2 lg:text-right">
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Ore volume
                        </span>
                        <span className="block tabular-nums">{formatVolume(item.oreVolume)}</span>
                      </div>
                      <div role="cell" className="px-2 lg:text-right">
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Material value
                        </span>
                        <span className="block tabular-nums">{formatIsk(item.materialsValue)}</span>
                      </div>
                      <div role="cell" className="px-2 lg:text-right">
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Material volume
                        </span>
                        <span className="block tabular-nums">
                          {formatVolume(item.materialsVolume)}
                        </span>
                      </div>
                      <div
                        role="cell"
                        className={cn(
                          "px-2 lg:text-right",
                          item.difference === null
                            ? "text-muted-foreground"
                            : item.difference > 0
                              ? "text-primary"
                              : item.difference < 0
                                ? "text-destructive"
                                : "text-muted-foreground",
                        )}
                      >
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Difference
                        </span>
                        <span className="block tabular-nums">{formatIsk(item.difference)}</span>
                      </div>
                      <div role="cell" className="px-2 lg:text-right">
                        <span className="mb-1 block text-xs text-muted-foreground lg:hidden">
                          Diff %
                        </span>
                        <span className="block tabular-nums">
                          {formatDifferencePercent(item.differencePercent)}
                        </span>
                      </div>
                    </div>
                    <CollapsibleContent
                      role="row"
                      className={`col-span-full grid grid-cols-1 border-b bg-muted/20 ${desktopGridColumns}`}
                    >
                      <div role="cell" aria-colspan={8} className="col-span-full grid gap-3 p-4">
                        {!item.reprocessingAvailable ? (
                          <p className="text-sm text-muted-foreground">
                            No reprocessing materials are available in the SDE.
                          </p>
                        ) : item.materials.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            This portion produces no materials at the baseline yield.
                          </p>
                        ) : (
                          <>
                            <div className="hidden grid-cols-[minmax(220px,1fr)_100px_140px_140px_140px] gap-2 border-b pb-2 text-xs text-muted-foreground lg:grid">
                              <span>Output material</span>
                              <span className="text-right">Quantity</span>
                              <span className="text-right">Unit price</span>
                              <span className="text-right">Total value</span>
                              <span className="text-right">Volume</span>
                            </div>
                            {item.materials.map((material) => (
                              <div
                                key={material.typeId}
                                className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(220px,1fr)_100px_140px_140px_140px] lg:items-center"
                              >
                                <div className="grid min-w-0 gap-1">
                                  <span className="text-xs text-muted-foreground lg:hidden">
                                    Output material
                                  </span>
                                  <TypeIdentity
                                    name={material.name}
                                    typeId={material.typeId}
                                    imageSize={24}
                                    linkPath={null}
                                  />
                                </div>
                                <div>
                                  <span className="text-xs text-muted-foreground lg:hidden">
                                    Quantity
                                  </span>
                                  <span className="block tabular-nums lg:text-right">
                                    {material.quantity.toLocaleString()}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs text-muted-foreground lg:hidden">
                                    Unit price
                                  </span>
                                  <span className="block tabular-nums lg:text-right">
                                    {formatIsk(material.unitPrice)}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs text-muted-foreground lg:hidden">
                                    Total value
                                  </span>
                                  <span className="block tabular-nums lg:text-right">
                                    {formatIsk(material.totalValue)}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-xs text-muted-foreground lg:hidden">
                                    Volume
                                  </span>
                                  <span className="block tabular-nums lg:text-right">
                                    {formatVolume(material.volume)}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
