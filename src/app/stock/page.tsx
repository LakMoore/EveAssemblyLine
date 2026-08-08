"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import AppShell, { languageStorageKey } from "../AppShell";
import {
  deleteStock,
  loadStockRecords,
  locationKey,
  saveStock,
  type StockItem,
  type StockRecord,
} from "@/lib/planning/stockStore";
import { loadStructures } from "@/lib/planning/structureStore";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { type KnownStructure } from "@/lib/planning/preferences";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import styles from "../page.module.css";

type StructureOption = { id: string; name: string };
type SystemOption = { id: number; name: string };
type EsiStockLocation = {
  structureId: number;
  name: string;
  systemId?: number;
  systemName?: string;
  locationType: "structure" | "station" | "anchored";
  items: StockItem[];
};
type EsiStockResponse = {
  locations?: Array<EsiStockLocation & { locationId: number }>;
  filteredLocationIds?: number[];
};
type PasteResult = {
  name: string;
  quantity?: number;
  typeId?: number;
  assembledVolume?: number;
  packagedVolume?: number;
  category?: StockItem["category"];
  marketCategory?: string;
  error?: string;
};
type StockFilter = { kind: "all" } | { kind: "category" | "market"; value: string };
type StockSort = "alphabetical" | "totalVolume" | "totalCount";

const stockSortOptions: Array<{ value: StockSort; label: string }> = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "totalVolume", label: "Total volume" },
  { value: "totalCount", label: "Total count" },
];

const defaultSystems: SystemOption[] = [
  { id: 30000142, name: "Jita" },
  { id: 30000144, name: "Perimeter" },
  { id: 30002187, name: "Amarr" },
  { id: 30002659, name: "Dodixie" },
  { id: 30002053, name: "Hek" },
  { id: 30002510, name: "Rens" },
];

function formatVolume(volume: number) {
  return `${volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`;
}

function stockItemVolume(item: StockItem) {
  return (
    item.quantity *
    (item.isPackaged
      ? (item.packagedVolume ?? item.assembledVolume ?? 0)
      : (item.assembledVolume ?? 0))
  );
}

function stockTotalCount(location: StockRecord) {
  return location.items.reduce((total, item) => total + item.quantity, 0);
}

function stockTotalVolume(location: StockRecord) {
  return location.items.reduce((total, item) => total + stockItemVolume(item), 0);
}

function StockItemImage({
  typeId,
  variation,
}: {
  typeId: number;
  variation: "icon" | "render" | "bp" | "bpc";
}) {
  const [useFallback, setUseFallback] = useState(false);
  const activeVariation = useFallback ? "icon" : variation;

  return (
    <Image
      className={styles.stockItemImage}
      src={eveTypeImageUrl(typeId, activeVariation)}
      alt=""
      width={40}
      height={40}
      onError={() => {
        if (variation === "render") setUseFallback(true);
      }}
    />
  );
}

function emptyLocation(system: SystemOption, structure: StructureOption | null): StockRecord {
  return {
    systemId: system.id,
    systemName: system.name,
    structureId: structure?.id ?? null,
    structureName: structure?.name ?? "System stock",
    items: [],
  };
}

function uniqueById<T extends { id: string | number }>(entries: T[]) {
  return [...new Map(entries.map((entry) => [String(entry.id), entry])).values()];
}

export default function StockPage() {
  const [language, setLanguage] = useState<SdeLanguage>(() => {
    if (typeof window === "undefined") return "en";
    const saved = window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(saved) ? saved : "en";
  });
  const [locations, setLocations] = useState<StockRecord[]>([]);
  const [esiLocationIds, setEsiLocationIds] = useState<Set<string>>(new Set());
  const [knownStructures, setKnownStructures] = useState<KnownStructure[]>([]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [viewing, setViewing] = useState<StockRecord | null>(null);
  const [viewingFilter, setViewingFilter] = useState<StockFilter>({ kind: "all" });
  const [stockSort, setStockSort] = useState<StockSort>("alphabetical");
  const [pasting, setPasting] = useState<StockRecord | null>(null);
  const [isHydratingVolumes, setIsHydratingVolumes] = useState(false);
  useEffect(() => {
    async function loadPageData() {
      setIsHydratingVolumes(true);
      try {
        const [records, structures, esiResponse] = await Promise.all([
          loadStockRecords().catch(() => []),
          loadStructures().catch(() => []),
          fetch(
            `/api/state/stock?${new URLSearchParams({
              language,
            }).toString()}`,
          ),
        ]);
        const esiData = (await esiResponse.json()) as EsiStockResponse;
        const esiLocations = esiResponse.ok
          ? (esiData.locations ?? []).map((location) => ({
              ...location,
              structureId: location.locationId,
            }))
          : [];
        setEsiLocationIds(new Set(esiLocations.map((location) => String(location.structureId))));
        setKnownStructures(structures);
        const correctedRecords = records.map((record) => {
          const structure = structures.find((entry) => entry.id === record.structureId);
          if (!structure) return record;
          return {
            ...record,
            systemId: structure.systemId,
            systemName: structure.systemName,
            structureName: structure.name,
          };
        });
        const esiRecords = esiLocations.map((location) => {
          const knownStructure = structures.find(
            (structure) => structure.esiStructureId === location.structureId,
          );
          return {
            systemId: location.systemId ?? knownStructure?.systemId ?? 0,
            systemName: location.systemName ?? knownStructure?.systemName ?? "Unknown system",
            structureId: String(location.structureId),
            structureName: knownStructure?.name ?? location.name,
            items: location.items,
          };
        });
        const esiKeys = new Set(esiRecords.map((record) => locationKey(record)));
        const esiLocationIds = new Set(
          esiLocations.map((location) => String(location.structureId)),
        );
        const esiBlueprintItemIds = new Set(
          esiLocations.flatMap((location) =>
            location.items.flatMap(
              (item) => item.blueprintPrints?.map((print) => print.itemId) ?? [],
            ),
          ),
        );
        const filteredEsiLocationIds = new Set(esiData.filteredLocationIds ?? []);
        const esiStructureIds = new Set(
          structures
            .map((structure) => structure.esiStructureId)
            .filter((structureId): structureId is number => structureId !== undefined),
        );
        const isEsiRecord = (record: StockRecord) =>
          esiKeys.has(locationKey(record)) ||
          esiLocationIds.has(record.structureId ?? "") ||
          filteredEsiLocationIds.has(Number(record.structureId)) ||
          esiStructureIds.has(Number(record.structureId)) ||
          record.items.some((item) =>
            item.blueprintPrints?.some((print) => esiBlueprintItemIds.has(print.itemId)),
          ) ||
          (record.systemName === "Unknown system" && record.structureName.startsWith("Location "));
        const combinedRecords = [
          ...esiRecords,
          ...correctedRecords.filter((record) => !isEsiRecord(record)),
        ];
        setLocations(
          [...combinedRecords].sort((left, right) =>
            left.systemName.localeCompare(right.systemName),
          ),
        );
        const hydratedRecords = await hydrateVolumes(combinedRecords, language);
        const sortedHydratedRecords = [...hydratedRecords].sort((left, right) =>
          left.systemName.localeCompare(right.systemName),
        );
        const manualRecords = hydratedRecords.filter((record) => !isEsiRecord(record));
        setLocations(sortedHydratedRecords);
        setViewing((current) => {
          if (!current) return current;
          return (
            sortedHydratedRecords.find((record) => locationKey(record) === locationKey(current)) ??
            current
          );
        });
        const previousByLocation = new Map(records.map((record) => [locationKey(record), record]));
        const manualKeys = new Set(manualRecords.map((record) => locationKey(record)));
        await Promise.all([
          ...manualRecords.flatMap((record) => {
            const previous = previousByLocation.get(locationKey(record));
            const writes = record !== previous ? [saveStock(record)] : [];
            if (previous && locationKey(previous) !== locationKey(record))
              writes.push(deleteStock(previous));
            return writes;
          }),
          ...records
            .filter((record) => isEsiRecord(record) && !manualKeys.has(locationKey(record)))
            .map((record) => deleteStock(record)),
        ]);
      } catch {
        setEsiLocationIds(new Set());
        setLocations([]);
      } finally {
        setIsHydratingVolumes(false);
      }
    }
    void loadPageData();
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ rateLimitedUntil?: string | null }>).detail;
      if (detail?.rateLimitedUntil) return;
      void loadPageData();
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, [language]);

  const sortedLocations = [...locations].sort((left, right) => {
    if (stockSort === "totalVolume") return stockTotalVolume(right) - stockTotalVolume(left);
    if (stockSort === "totalCount") return stockTotalCount(right) - stockTotalCount(left);
    return `${left.systemName} ${left.structureName}`.localeCompare(
      `${right.systemName} ${right.structureName}`,
    );
  });

  async function addLocation(location: StockRecord) {
    if (locations.some((current) => locationKey(current) === locationKey(location))) {
      setIsAddOpen(false);
      return;
    }
    await saveStock(location);
    setLocations((current) =>
      [...current, location].sort((left, right) => left.systemName.localeCompare(right.systemName)),
    );
    setIsAddOpen(false);
  }

  async function updateLocation(record: StockRecord) {
    await saveStock(record);
    setLocations((current) =>
      current.map((location) =>
        locationKey(location) === locationKey(record) ? record : location,
      ),
    );
    setPasting(null);
  }

  async function removeLocation(location: StockRecord) {
    const confirmed = window.confirm(
      `Remove stock location "${location.structureName}" in ${location.systemName}? All stock held there will be deleted.`,
    );
    if (!confirmed) return;
    await deleteStock(location);
    setLocations((current) =>
      current.filter((entry) => locationKey(entry) !== locationKey(location)),
    );
    setViewing((current) =>
      current && locationKey(current) === locationKey(location) ? null : current,
    );
    setPasting((current) =>
      current && locationKey(current) === locationKey(location) ? null : current,
    );
  }

  function openItems(location: StockRecord, filter: StockFilter = { kind: "all" }) {
    setViewing(location);
    setViewingFilter(filter);
  }

  return (
    <AppShell activePage="stock" language={language} onLanguageChange={setLanguage}>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>WORKSPACE / INVENTORY</p>
          <h1>Stock</h1>
          <p className={styles.subtitle}>Track available materials and components by location.</p>
        </div>
        <button type="button" className={styles.importButton} onClick={() => setIsAddOpen(true)}>
          Add location
        </button>
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / LOCATIONS</p>
            <h2>Stock locations</h2>
          </div>
          <div className={styles.locationControls}>
            <label>
              <span>SORT</span>
              <select
                aria-label="Sort stock locations"
                value={stockSort}
                onChange={(event) => setStockSort(event.target.value as StockSort)}
              >
                {stockSortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span className={styles.panelDescription}>{locations.length} saved</span>
          </div>
        </div>
        {locations.length === 0 ? (
          <div className={styles.emptyBuildList}>
            No stock locations yet. Add a location to begin tracking items.
          </div>
        ) : (
          <div className={styles.stockCardGrid}>
            {sortedLocations.map((location) => {
              return (
                <StockLocationCard
                  key={locationKey(location)}
                  location={location}
                  isEsiLocation={esiLocationIds.has(location.structureId ?? "")}
                  isVolumesLoading={isHydratingVolumes}
                  onView={openItems}
                  onPaste={() => setPasting(location)}
                  onRemove={() => removeLocation(location)}
                />
              );
            })}
          </div>
        )}
      </div>
      {isAddOpen && (
        <AddLocationModal
          language={language}
          knownStructures={knownStructures}
          existingLocations={locations}
          onCancel={() => setIsAddOpen(false)}
          onAdd={addLocation}
        />
      )}
      {viewing && (
        <ViewItemsModal
          location={viewing}
          filter={viewingFilter}
          onFilterChange={setViewingFilter}
          onCancel={() => setViewing(null)}
        />
      )}
      {pasting && (
        <StockPasteModal
          language={language}
          location={pasting}
          onCancel={() => setPasting(null)}
          onImport={(items) => updateLocation({ ...pasting, items })}
        />
      )}
    </AppShell>
  );
}

function AddLocationModal({
  language,
  knownStructures,
  existingLocations,
  onCancel,
  onAdd,
}: {
  language: SdeLanguage;
  knownStructures: KnownStructure[];
  existingLocations: StockRecord[];
  onCancel: () => void;
  onAdd: (location: StockRecord) => void;
}) {
  const [systemName, setSystemName] = useState(defaultSystems[0].name);
  const [system, setSystem] = useState(defaultSystems[0]);
  const [suggestions, setSuggestions] = useState<SystemOption[]>(defaultSystems);
  const [isOpen, setIsOpen] = useState(false);
  const [structures, setStructures] = useState<StructureOption[]>([]);
  const [structureId, setStructureId] = useState("system");

  useEffect(() => {
    const controller = new AbortController();
    const localStructures = knownStructures
      .filter((structure) => structure.systemId === system.id)
      .map((structure) => ({ id: structure.id, name: structure.name }));
    fetch(`/api/reference/structures?systemId=${system.id}&language=${language}`, {
      signal: controller.signal,
    })
      .then(
        (response) =>
          response.json() as Promise<{
            items?: Array<{ structureId: number; name: string }>;
          }>,
      )
      .then((data) => {
        const npcStructures = (data.items ?? []).map((item) => ({
          id: String(item.structureId),
          name: item.name,
        }));
        setStructures([
          ...npcStructures,
          ...localStructures.filter((local) => !npcStructures.some((npc) => npc.id === local.id)),
        ]);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          setStructures(localStructures);
      });
    return () => controller.abort();
  }, [knownStructures, language, system.id]);

  useEffect(() => {
    if (!isOpen || systemName.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/reference/systems?query=${encodeURIComponent(systemName)}&language=${language}`, {
        signal: controller.signal,
      })
        .then(
          (response) =>
            response.json() as Promise<{
              items?: Array<{ systemId: number; name: string }>;
            }>,
        )
        .then((data) =>
          setSuggestions(
            (data.items ?? []).map((entry) => ({ id: entry.systemId, name: entry.name })),
          ),
        )
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setSuggestions([]);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, language, systemName]);

  function chooseSystem(nextSystem: SystemOption) {
    setSystem(nextSystem);
    setSystemName(nextSystem.name);
    setStructureId("system");
    setIsOpen(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const structure = structures.find((entry) => entry.id === structureId) ?? null;
    const location = emptyLocation(system, structure);
    if (existingLocations.some((current) => locationKey(current) === locationKey(location))) return;
    onAdd(location);
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
        aria-labelledby="add-location-title"
        onSubmit={submit}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STOCK DIRECTORY</p>
            <h2 id="add-location-title">Add location</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close add location dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <label className={styles.field}>
          SYSTEM
          <div className={styles.searchWrap}>
            <div className={styles.search}>
              ⌕{" "}
              <input
                role="combobox"
                aria-expanded={isOpen}
                aria-controls="add-location-system-options"
                value={systemName}
                onFocus={() => setIsOpen(true)}
                onChange={(event) => {
                  setSystemName(event.target.value);
                  setIsOpen(true);
                }}
                aria-label="Search systems"
                aria-autocomplete="list"
              />
            </div>
            {isOpen && suggestions.length > 0 && (
              <div className={styles.searchResults} id="add-location-system-options" role="listbox">
                {uniqueById(suggestions).map((entry) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={entry.id === system.id}
                    className={
                      entry.id === system.id ? styles.searchResultActive : styles.searchResult
                    }
                    key={entry.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSystem(entry)}
                  >
                    <span>{entry.name}</span>
                    <small>System ID {entry.id}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </label>
        <label className={styles.field}>
          STRUCTURE
          <select value={structureId} onChange={(event) => setStructureId(event.target.value)}>
            <option value="system">System stock (no specific structure)</option>
            {uniqueById(structures).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <Link className={styles.dialogLink} href="/locations">
          Add or manage structures
        </Link>
        <div className={styles.modalActions}>
          <button type="button" className={styles.refresh} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.calculate}>
            <span>Add location</span>
            <b>→</b>
          </button>
        </div>
      </form>
    </div>
  );
}

const stockCategories: Array<{ id: NonNullable<StockItem["category"]>; label: string }> = [
  { id: "bpc", label: "Blueprints" },
  { id: "reaction", label: "Reaction formulas" },
  { id: "item", label: "Items" },
];

function formatBlueprintDate(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

type BlueprintDetail = {
  kind: "BPO" | "BPC";
  source: "Asset" | "In use" | "In Progress";
  runs?: number;
  copies: number;
  me?: number;
  te?: number;
  activity?: string;
  endDate?: string;
  quantity?: number;
  estimated?: boolean;
};

function StockLocationCard({
  location,
  isEsiLocation,
  isVolumesLoading,
  onView,
  onPaste,
  onRemove,
}: {
  location: StockRecord;
  isEsiLocation: boolean;
  isVolumesLoading: boolean;
  onView: (location: StockRecord, filter?: StockFilter) => void;
  onPaste: () => void;
  onRemove: () => void;
}) {
  const marketCategories = [
    ...new Set(
      location.items
        .map((item) => item.marketCategory)
        .filter(
          (category) => category && category !== "Blueprints" && category !== "Reaction Formulas",
        ),
    ),
  ] as string[];
  return (
    <article className={styles.stockCard}>
      <div className={styles.stockCardHeading}>
        <div>
          <p className={styles.panelKicker}>{location.systemName}</p>
          <h3>{location.structureName}</h3>
        </div>
        {!isEsiLocation && (
          <div className={styles.stockCardActions}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Paste items at ${location.structureName}`}
              title="Paste items"
              onClick={onPaste}
            >
              ⇩
            </button>
            <button
              type="button"
              className={styles.stockRemoveButton}
              aria-label={`Remove stock at ${location.structureName}`}
              title="Remove stock location"
              onClick={onRemove}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <div className={styles.stockCardTotals}>
        {stockCategories.map((category) => {
          const items = location.items.filter((item) =>
            category.id === "bpc"
              ? item.category === "bpo" || item.category === "bpc"
              : (item.category ?? "item") === category.id,
          );
          const volume = items.reduce((total, item) => total + stockItemVolume(item), 0);
          return (
            <button
              type="button"
              className={styles.stockMetric}
              key={category.id}
              onClick={() => onView(location, { kind: "category", value: category.id })}
            >
              <span>{category.label}</span>
              <strong>{items.length.toLocaleString()}</strong>
              <small>
                {isVolumesLoading ? "Calculating..." : `${formatVolume(volume)} Volume`}
              </small>
            </button>
          );
        })}
      </div>
      <div className={styles.stockMarketCategories}>
        {marketCategories.length === 0 ? (
          <span>No market categories</span>
        ) : (
          marketCategories.map((category) => (
            <button
              type="button"
              key={category}
              onClick={() => onView(location, { kind: "market", value: category })}
            >
              {category}
            </button>
          ))
        )}
      </div>
      <button type="button" className={styles.stockCardViewAll} onClick={() => onView(location)}>
        <span>View all items</span>
        <b>→</b>
      </button>
    </article>
  );
}

function ViewItemsModal({
  location,
  filter,
  onFilterChange,
  onCancel,
}: {
  location: StockRecord;
  filter: StockFilter;
  onFilterChange: (filter: StockFilter) => void;
  onCancel: () => void;
}) {
  const [openBlueprintTypeId, setOpenBlueprintTypeId] = useState<number | null>(null);
  const [openReactionTypeId, setOpenReactionTypeId] = useState<number | null>(null);
  const blueprintCounts = new Map<number, { bpo: number; bpc: number; runs: number }>();
  for (const item of location.items) {
    if (item.category !== "bpo" && item.category !== "bpc") continue;
    const counts = blueprintCounts.get(item.typeId) ?? { bpo: 0, bpc: 0, runs: 0 };
    if (item.category === "bpo") counts.bpo += item.quantity;
    else {
      counts.bpc += item.quantity;
      if (item.runCount !== undefined && item.runCount >= 0) counts.runs += item.runCount;
    }
    blueprintCounts.set(item.typeId, counts);
  }
  const filteredItems = location.items.filter((item) => {
    if (filter.kind === "all") return true;
    if (filter.kind === "market") return item.marketCategory === filter.value;
    return filter.value === "bpc"
      ? item.category === "bpo" || item.category === "bpc"
      : (item.category ?? "item") === filter.value;
  });
  const displayItems: Array<{
    item: StockItem;
    blueprints?: StockItem[];
    reactionJobs?: StockItem[];
  }> = [];
  for (const item of filteredItems) {
    if (item.category === "reaction") {
      const existing = displayItems.find(
        (entry) => entry.item.typeId === item.typeId && entry.item.category === "reaction",
      );
      if (!existing) {
        displayItems.push({ item, reactionJobs: item.inUse ? [item] : [] });
        continue;
      }
      existing.item = { ...existing.item, quantity: existing.item.quantity + item.quantity };
      if (item.inUse) existing.reactionJobs?.push(item);
      continue;
    }
    if (item.category !== "bpo" && item.category !== "bpc") {
      displayItems.push({ item });
      continue;
    }
    const existing = displayItems.find((entry) => entry.item.typeId === item.typeId);
    if (!existing) {
      displayItems.push({ item, blueprints: [item] });
      continue;
    }
    existing.blueprints?.push(item);
    existing.item = {
      ...existing.item,
      quantity: existing.item.quantity + item.quantity,
      inBuild: existing.item.inBuild || item.inBuild,
      inUse: existing.item.inUse || item.inUse,
    };
    if (!existing.item.inBuild && item.inBuild) existing.item = item;
  }
  const title =
    filter.kind === "all"
      ? "All items"
      : filter.kind === "market"
        ? filter.value
        : stockCategories.find((category) => category.id === filter.value)?.label;
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
        aria-labelledby="view-items-title"
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>LOCATION STOCK</p>
            <h2 id="view-items-title">{location.structureName}</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close items dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <p className={styles.panelDescription}>
          {location.systemName} · {title} · {displayItems.length} item types
        </p>
        <div className={styles.stockViewFilters}>
          <button
            type="button"
            className={filter.kind === "all" ? styles.stockFilterActive : ""}
            onClick={() => onFilterChange({ kind: "all" })}
          >
            All
          </button>
          {stockCategories.map((category) => (
            <button
              type="button"
              className={
                filter.kind === "category" && filter.value === category.id
                  ? styles.stockFilterActive
                  : ""
              }
              key={category.id}
              onClick={() => onFilterChange({ kind: "category", value: category.id })}
            >
              {category.label}
            </button>
          ))}
        </div>
        {displayItems.length === 0 ? (
          <div className={styles.emptyBuildList}>No items recorded at this location.</div>
        ) : (
          <div className={styles.stockList}>
            {displayItems.map(({ item, blueprints, reactionJobs }) => {
              const counts = blueprintCounts.get(item.typeId);
              const isBlueprint = Boolean(blueprints);
              const isReaction = Boolean(reactionJobs);
              const reactionInUse =
                reactionJobs?.reduce((total, job) => total + job.quantity, 0) ?? 0;
              const details: BlueprintDetail[] | undefined = blueprints
                ? (() => {
                    const buckets = new Map<string, BlueprintDetail>();
                    const addToBucket = (detail: BlueprintDetail) => {
                      const key = `${detail.kind}:${detail.activity ?? "-"}:${detail.me ?? "-"}:${detail.te ?? "-"}`;
                      const existing = buckets.get(key);
                      if (!existing) {
                        buckets.set(key, detail);
                        return;
                      }
                      existing.copies += detail.copies;
                      if (detail.runs !== undefined) existing.runs = (existing.runs ?? 0) + detail.runs;
                    };

                    for (const blueprint of blueprints) {
                      const kind = blueprint.category === "bpo" ? "BPO" : "BPC";
                      const source = blueprint.inBuild
                        ? blueprint.activityName === "Invention" && !blueprint.blueprintPrints?.length
                          ? "In Progress"
                          : "In use"
                        : "Asset";
                      if (blueprint.blueprintPrints?.length) {
                        for (const print of blueprint.blueprintPrints) {
                          addToBucket({
                            kind,
                            source,
                            copies: 1,
                            ...(kind === "BPC" && print.runs >= 0 ? { runs: print.runs } : {}),
                            me: print.me,
                            te: print.te,
                            activity: print.activity,
                            endDate: print.endDate,
                          });
                        }
                        continue;
                      }
                      addToBucket({
                        kind,
                        source,
                        copies: blueprint.quantity,
                        ...(kind === "BPC" && blueprint.runCount !== undefined
                          ? { runs: blueprint.runCount }
                          : {}),
                        ...(source === "In Progress"
                          ? { estimated: true }
                          : { me: blueprint.me, te: blueprint.te }),
                        activity: blueprint.activityName,
                        endDate: blueprint.endDate,
                      });
                    }
                    return [...buckets.values()];
                  })()
                : undefined;
              const showTooltip = isBlueprint && openBlueprintTypeId === item.typeId;
              const showReactionTooltip = isReaction && openReactionTypeId === item.typeId;
              return (
                <div
                  className={styles.stockRow}
                  key={`${item.typeId}:${item.category ?? "item"}:${isReaction ? "reaction" : item.isPackaged ? "packaged" : "assembled"}:${item.jobId ?? "asset"}`}
                >
                  <StockItemImage
                    typeId={item.typeId}
                    variation={
                      counts?.bpo
                        ? "bp"
                        : item.category === "bpo"
                          ? "bp"
                          : item.category === "bpc" || item.category === "reaction"
                            ? "bpc"
                            : item.techLevel === 1
                              ? "render"
                              : "icon"
                    }
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      Type ID {item.typeId} · Volume{" "}
                      {formatVolume(
                        item.quantity *
                          (item.isPackaged
                            ? (item.packagedVolume ?? item.assembledVolume ?? 0)
                            : (item.assembledVolume ?? 0)),
                      )}
                    </small>
                  </span>
                  {item.inBuild && item.endDate && (
                    <small className={styles.stockCompletion}>
                      <span>{item.activityName ?? "Industry job"} completes</span>
                      <span>
                        {new Date(item.endDate).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                        })}{" "}
                        {new Date(item.endDate).toLocaleTimeString("en-GB", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </span>
                    </small>
                  )}
                  {isReaction ? (
                    <div
                      className={styles.stockBlueprintSummary}
                      onMouseEnter={() => setOpenReactionTypeId(item.typeId)}
                      onMouseLeave={() => setOpenReactionTypeId(null)}
                    >
                      <button
                        type="button"
                        className={styles.stockBlueprintSummaryButton}
                        aria-label={`Show installed reaction formulas for ${item.name}`}
                        aria-expanded={showReactionTooltip}
                        onClick={() =>
                          setOpenReactionTypeId(showReactionTooltip ? null : item.typeId)
                        }
                      >
                        {reactionInUse > 0 && <b className={styles.stockBlueprintHelp}>?</b>}
                        <span>
                          {reactionInUse.toLocaleString()} / {item.quantity.toLocaleString()} in use
                        </span>
                      </button>
                      {showReactionTooltip && reactionJobs && reactionJobs.length > 0 && (
                        <div className={styles.stockBlueprintTooltip} role="tooltip">
                          {reactionJobs.map((job, index) => (
                            <div
                              className={styles.stockBlueprintDetail}
                              key={`${job.jobId ?? index}`}
                            >
                              <strong>In use · {job.blueprintRunsUsed ?? 0} runs</strong>
                              <span>
                                {job.endDate
                                  ? formatBlueprintDate(job.endDate)
                                  : "Completion date unavailable"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : isBlueprint && counts ? (
                    <div
                      className={styles.stockBlueprintSummary}
                      onMouseEnter={() => setOpenBlueprintTypeId(item.typeId)}
                      onMouseLeave={() => setOpenBlueprintTypeId(null)}
                    >
                      <button
                        type="button"
                        className={styles.stockBlueprintSummaryButton}
                        aria-label={`Show details for ${item.name}`}
                        aria-expanded={showTooltip}
                        onClick={() => setOpenBlueprintTypeId(showTooltip ? null : item.typeId)}
                      >
                        <span>
                          {counts.bpo > 0 && (
                            <span className={styles.stockSummaryLine}>
                              {counts.bpo.toLocaleString()} BPO
                            </span>
                          )}
                          {counts.bpc > 0 && (
                            <span className={styles.stockSummaryLine}>
                              {counts.runs > 0
                                ? `${counts.runs.toLocaleString()} Runs on ${counts.bpc.toLocaleString()} BPC`
                                : `${counts.bpc.toLocaleString()} BPC`}
                            </span>
                          )}
                        </span>
                        <b className={styles.stockBlueprintHelp}>?</b>
                      </button>
                      {showTooltip && details && (
                        <div className={styles.stockBlueprintTooltip} role="tooltip">
                          {details.map((detail, index) => (
                            <div
                              className={styles.stockBlueprintDetail}
                              key={`${item.typeId}-${index}`}
                            >
                              <strong>
                                {detail.copies.toLocaleString()} {detail.kind === "BPO"
                                  ? detail.copies === 1
                                    ? "Original"
                                    : "Originals"
                                  : detail.copies === 1
                                    ? "Copy"
                                    : "Copies"}
                              </strong>
                              <span>
                                {detail.me !== undefined ? `ME ${detail.me}` : ""}
                                {detail.te !== undefined ? ` · TE ${detail.te}` : ""}
                                {detail.runs !== undefined
                                  ? ` · ${detail.estimated ? "~" : ""}${detail.runs.toLocaleString()} runs`
                                  : ""}
                                {detail.activity ? ` · ${detail.activity}` : ""}
                                {detail.endDate ? ` · ${formatBlueprintDate(detail.endDate)}` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <strong>{`${item.quantity.toLocaleString()}${item.inBuild ? " · In Build" : ""}${item.inUse ? " · In Use" : ""}`}</strong>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StockPasteModal({
  location,
  language,
  onCancel,
  onImport,
}: {
  location: StockRecord;
  language: SdeLanguage;
  onCancel: () => void;
  onImport: (items: StockItem[]) => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"replace" | "add">("add");
  const [results, setResults] = useState<PasteResult[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState("");

  async function resolveItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)\s+(\d+)$/);
        return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line };
      });
    if (parsed.length === 0) {
      setError("Paste at least one item and quantity.");
      return;
    }
    setIsResolving(true);
    setError("");
    try {
      const response = await fetch("/api/reference/types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, items: parsed }),
      });
      const data = (await response.json()) as { items?: PasteResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not resolve the pasted stock.");
      const resolved = data.items ?? [];
      setResults(resolved);
      if (resolved.length > 0 && resolved.every((item) => !item.error)) {
        const imported = resolved.map((item) => ({
          typeId: item.typeId!,
          name: item.name,
          quantity: item.quantity!,
          assembledVolume: item.assembledVolume ?? 0,
          packagedVolume: item.packagedVolume,
          category: item.category ?? "item",
          marketCategory: item.marketCategory,
        }));
        const normalized = mergeItems([], imported);
        onImport(mode === "replace" ? normalized : mergeItems(location.items, normalized));
      }
    } catch (resolveError) {
      setResults([]);
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "Could not resolve the pasted stock.",
      );
    } finally {
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
        aria-labelledby="paste-stock-title"
        onSubmit={resolveItems}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STOCK IMPORT</p>
            <h2 id="paste-stock-title">Paste items</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close paste items dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <p className={styles.panelDescription}>
          One item per line. Put the quantity at the end of each line.
        </p>
        <div className={styles.stockMode} role="group" aria-label="Paste mode">
          <label>
            <input
              type="radio"
              name="paste-mode"
              checked={mode === "add"}
              onChange={() => setMode("add")}
            />
            Add to existing
          </label>
          <label>
            <input
              type="radio"
              name="paste-mode"
              checked={mode === "replace"}
              onChange={() => setMode("replace")}
            />
            Replace existing
          </label>
        </div>
        <textarea
          className={styles.importTextarea}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setResults([]);
            setError("");
          }}
          placeholder={"Tritanium 100000\nPyerite 50000"}
          aria-label="Stock items and quantities"
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
                <span>
                  {item.name}
                  {item.quantity ? ` × ${item.quantity}` : ""}
                </span>
                <small>{item.error ?? `Type ID ${item.typeId}`}</small>
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
            <span>{isResolving ? "Checking list..." : "Save items"}</span>
            <b>→</b>
          </button>
        </div>
      </form>
    </div>
  );
}

function mergeItems(existing: StockItem[], imported: StockItem[]) {
  const items = existing.map((item) => ({ ...item }));
  for (const item of imported) {
    const current = items.find(
      (entry) =>
        entry.typeId === item.typeId &&
        entry.isPackaged === item.isPackaged &&
        (entry.category ?? "item") === (item.category ?? "item"),
    );
    if (current) {
      current.quantity += item.quantity;
      if (item.runCount !== undefined) {
        current.runCount = (current.runCount ?? 0) + item.runCount;
      }
      current.me ??= item.me;
      current.te ??= item.te;
      if (item.blueprintPrints) {
        current.blueprintPrints = [...(current.blueprintPrints ?? []), ...item.blueprintPrints];
      }
      current.assembledVolume = item.assembledVolume;
      current.packagedVolume = item.packagedVolume;
    } else {
      items.push(item);
    }
  }
  return items;
}

async function hydrateVolumes(records: StockRecord[], language: SdeLanguage) {
  let metadata: Awaited<ReturnType<typeof fetchTypeMetadata>> = [];
  try {
    metadata = await fetchTypeMetadata(
      records.flatMap((record) => record.items.map((item) => item.typeId)),
      language,
    );
  } catch {
    return records;
  }
  const metadataByTypeId = new Map(metadata.map((item) => [item.typeId, item]));
  const hydrated = await Promise.all(
    records.map(async (record) => {
      const items = record.items.map((item) => {
        const itemMetadata = metadataByTypeId.get(item.typeId);
        return itemMetadata
          ? {
              ...item,
              assembledVolume: itemMetadata.assembledVolume ?? 0,
              packagedVolume: itemMetadata.packagedVolume,
              techLevel: itemMetadata.techLevel,
              category: item.category ?? itemMetadata.category ?? "item",
              marketCategory: itemMetadata.marketCategory,
            }
          : item;
      });
      return items.every((item, index) => item === record.items[index])
        ? record
        : { ...record, items };
    }),
  );
  return hydrated;
}
