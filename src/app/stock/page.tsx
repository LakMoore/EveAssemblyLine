"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useAppLanguage } from "../AppShell";
import {
  deleteStock,
  loadStockRecords,
  locationKey,
  saveStock,
  type StockRecord,
} from "@/lib/planning/stockStore";
import { loadStructures } from "@/lib/planning/structureStore";
import type { SdeLanguage } from "@/lib/reference/languages";
import { fetchTypeMetadata } from "@/lib/reference/types";
import { groupClientStockByLocation, loadClientStock } from "@/lib/client/requestCache";
import { type KnownStructure } from "@/lib/planning/preferences";
import TypeIdentity from "../components/TypeIdentity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import styles from "../page.module.css";
import {
  Atom,
  ChartLine,
  Clipboard,
  Factory,
  FileBox,
  Files,
  Package,
  Plus,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import type { StockItem } from "@/lib/planning/types";

type StructureOption = { id: string; name: string };
type SystemOption = { id: number; name: string };
type EsiStockLocation = {
  structureId?: number;
  name: string;
  systemId?: number;
  systemName?: string;
  locationType: "structure" | "station" | "anchored";
  items?: StockItem[];
};
type EsiStockResponse = {
  locations?: Array<EsiStockLocation & { locationId: number }>;
  workingStock?: StockItem[];
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
type StockFilter =
  | { kind: "all" }
  | { kind: "sales" }
  | { kind: "jobs" }
  | { kind: "category" | "market"; value: string };
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
  return `${Math.ceil(volume).toLocaleString()} m³`;
}

function stockItemVolume(item: StockItem) {
  return (
    item.quantity
    * (item.isPackaged
      ? (item.packagedVolume ?? item.assembledVolume ?? 0)
      : (item.assembledVolume ?? 0))
  );
}

function isBlueprintStockItem(item: StockItem) {
  return item.category === "blueprint";
}

function stockTotalCount(location: StockRecord) {
  return location.items.reduce((total, item) => total + item.quantity, 0);
}

function stockTotalVolume(location: StockRecord) {
  return location.items.reduce((total, item) => total + stockItemVolume(item), 0);
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
  const { language } = useAppLanguage();
  const [locations, setLocations] = useState<StockRecord[]>([]);
  const [esiLocationIds, setEsiLocationIds] = useState<Set<string>>(new Set());
  const [viewingFilter, setViewingFilter] = useState<StockFilter>({ kind: "all" });
  const [knownStructures, setKnownStructures] = useState<KnownStructure[]>([]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [viewing, setViewing] = useState<StockRecord | null>(null);
  const [stockSort, setStockSort] = useState<StockSort>("alphabetical");
  const [pasting, setPasting] = useState<StockRecord | null>(null);
  const [isHydratingVolumes, setIsHydratingVolumes] = useState(false);
  useEffect(() => {
    async function loadPageData(
      refreshedLocations?: EsiStockResponse["locations"],
      loadEsiStock = true,
    ) {
      setIsHydratingVolumes(true);
      try {
        const [records, structures, esiResponse] = await Promise.all([
          loadStockRecords().catch(() => []),
          loadStructures().catch(() => []),
          refreshedLocations
            ? Promise.resolve({ ok: true, json: async () => ({ locations: refreshedLocations }) })
            : loadEsiStock
              ? loadClientStock(language).then((data) => ({ ok: true, json: async () => data }))
              : Promise.resolve({ ok: false, json: async () => ({}) }),
        ]);
        const esiData = (await esiResponse.json()) as EsiStockResponse;
        const esiLocations = esiResponse.ok
          ? (
              refreshedLocations?.map((location) => ({
                ...location,
                structureId: location.structureId ?? location.locationId,
                items: location.items ?? [],
              }))
              ?? groupClientStockByLocation(esiData).map((location) => ({
                ...location,
                structureId: location.locationId,
              }))
            )
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
        const marketOrders = esiData.workingStock ?? [];
        const esiRecords = esiLocations.map((location) => {
          const knownStructure = structures.find(
            (structure) => structure.esiStructureId === location.structureId,
          );
          return {
            systemId: location.systemId ?? knownStructure?.systemId ?? 0,
            systemName: location.systemName ?? knownStructure?.systemName ?? "Unknown system",
            structureId: String(location.structureId),
            structureName: knownStructure?.name ?? location.name,
            source: "esi" as const,
            items: [
              ...location.items,
              ...marketOrders.filter((item) => item.sourceLocationId === location.locationId),
            ],
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
          esiKeys.has(locationKey(record))
          || esiLocationIds.has(record.structureId ?? "")
          || filteredEsiLocationIds.has(Number(record.structureId))
          || esiStructureIds.has(Number(record.structureId))
          || record.items.some((item) =>
            item.blueprintPrints?.some((print) => esiBlueprintItemIds.has(print.itemId)),
          )
          || (
            record.systemName === "Unknown system"
            && record.structureName.startsWith("Location ")
          );
        const combinedRecords = esiResponse.ok
          ? [...esiRecords, ...correctedRecords.filter((record) => !isEsiRecord(record))]
          : correctedRecords;
        const hydratedRecords = await hydrateVolumes(combinedRecords, language);
        const marketOrderQuantities = new Map<number, number>();
        for (const record of hydratedRecords) {
          if (record.source !== "marketOrder") continue;
          for (const item of record.items) {
            marketOrderQuantities.set(
              item.typeId,
              (marketOrderQuantities.get(item.typeId) ?? 0) + item.quantity,
            );
          }
        }
        const recordsWithMarketQuantities = hydratedRecords.map((record) =>
          record.source === "marketOrder"
            ? record
            : {
                ...record,
                items: record.items.map((item) => ({
                  ...item,
                  marketOrderQuantity: marketOrderQuantities.get(item.typeId),
                })),
              },
        );
        const sortedHydratedRecords = [...recordsWithMarketQuantities].sort((left, right) =>
          left.systemName.localeCompare(right.systemName),
        );
        setLocations(sortedHydratedRecords);
        setViewing((current) => {
          if (!current) return current;
          return (
            sortedHydratedRecords.find((record) => locationKey(record) === locationKey(current))
            ?? current
          );
        });
        const previousByLocation = new Map(records.map((record) => [locationKey(record), record]));
        const currentKeys = new Set(
          recordsWithMarketQuantities.map((record) => locationKey(record)),
        );
        await Promise.all([
          ...recordsWithMarketQuantities.flatMap((record) => {
            const previous = previousByLocation.get(locationKey(record));
            const writes = record !== previous ? [saveStock(record)] : [];
            if (previous && locationKey(previous) !== locationKey(record)) {
              writes.push(deleteStock(previous));
            }
            return writes;
          }),
          ...(esiResponse.ok
            ? records
                .filter((record) => isEsiRecord(record) && !currentKeys.has(locationKey(record)))
                .map((record) => deleteStock(record))
            : []),
        ]);
      }
      catch {
        setEsiLocationIds(new Set());
        setLocations([]);
      }
      finally {
        setIsHydratingVolumes(false);
      }
    }
    void loadPageData(undefined, false);
    const handleRefresh = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          rateLimitedUntil?: string | null;
          stockLocations?: EsiStockResponse["locations"];
        }>
      ).detail;
      if (detail.rateLimitedUntil) return;
      if (!detail.stockLocations) {
        void loadPageData();
        return;
      }
      void loadPageData(detail.stockLocations);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, [language]);

  useEffect(() => {
    if (!isAddOpen && !viewing && !pasting) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isAddOpen, pasting, viewing]);

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
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>WORKSPACE / INVENTORY</p>
          <h1>Stock</h1>
          <p className={styles.subtitle}>Track available materials and components by location.</p>
        </div>
        <button type="button" className={styles.importButton} onClick={() => setIsAddOpen(true)}>
          <Plus aria-hidden="true" />
          Add location
        </button>
      </div>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / LOCATIONS</p>
            <h2>Stock locations</h2>
          </div>
          <div className={styles.locationControls}>
            <label>
              <span>SORT</span>
              <Select
                aria-label="Sort stock locations"
                value={stockSort}
                onValueChange={(value) => {
                  if (value !== null) setStockSort(value as StockSort);
                }}
                items={stockSortOptions}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {stockSortOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <span className={styles.panelDescription}>{locations.length} saved</span>
          </div>
        </div>
        {locations.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>
              No stock locations yet. Add a location to begin tracking items.
            </EmptyDescription>
          </Empty>
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
      </section>
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
    </>
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
  const systemAnchor = useComboboxAnchor();

  useEffect(() => {
    const controller = new AbortController();
    const localStructures = knownStructures
      .filter((structure) => structure.systemId === system.id)
      .map((structure) => ({ id: structure.id, name: structure.name }));
    fetch(
      `/api/reference/structures?systemId=${system.id}&language=${language}`,
      {
        signal: controller.signal,
      },
    )
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
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setStructures(localStructures);
        }
      });
    return () => controller.abort();
  }, [knownStructures, language, system.id]);

  useEffect(() => {
    if (!isOpen || systemName.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        fetch(
          `/api/reference/systems?query=${encodeURIComponent(systemName)}&language=${language}`,
          {
            signal: controller.signal,
          },
        )
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
      },
      180,
    );
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
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className={styles.importModal} render={<form onSubmit={submit} />}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STOCK DIRECTORY</p>
            <DialogTitle>Add location</DialogTitle>
          </div>
        </div>
        <div className="no-scrollbar max-h-[70vh] overflow-y-auto overscroll-contain">
          <label className={styles.field}>
            SYSTEM
            <div ref={systemAnchor} className={styles.searchWrap}>
              <Combobox
                open={isOpen && systemName.trim().length >= 2}
                inputValue={systemName}
                onOpenChange={setIsOpen}
                onInputValueChange={(value) => {
                  setSystemName(value);
                  setIsOpen(true);
                }}
                onValueChange={(value) => {
                  const match = suggestions.find((entry) => String(entry.id) === String(value));
                  if (match) chooseSystem(match);
                }}
              >
                <ComboboxInput
                  showTrigger={false}
                  onFocus={() => suggestions.length > 0 && setIsOpen(true)}
                  placeholder="Type a system name"
                  aria-label="Search systems"
                />
                <ComboboxContent anchor={systemAnchor} className={styles.searchResults}>
                  <ComboboxList>
                    {suggestions.length > 0 ? (
                      uniqueById(suggestions).map((entry) => (
                        <ComboboxItem key={entry.id} value={String(entry.id)}>
                          <span>{entry.name}</span>
                          <small>System ID {entry.id}</small>
                        </ComboboxItem>
                      ))
                    ) : (
                      <ComboboxEmpty>No matching systems.</ComboboxEmpty>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
          </label>
          <label className={styles.field}>
            STRUCTURE
            <Select
              value={structureId}
              onValueChange={(value) => value && setStructureId(value)}
              items={[
                { value: "system", label: "System stock (no specific structure)" },
                ...uniqueById(structures).map((entry) => ({
                  value: String(entry.id),
                  label: entry.name,
                })),
              ]}
            >
              <SelectTrigger aria-label="Stock structure">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="system">System stock (no specific structure)</SelectItem>
                  {uniqueById(structures).map((entry) => (
                    <SelectItem key={entry.id} value={String(entry.id)}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <Link className={styles.dialogLink} href="/locations">
            Add or manage structures
          </Link>
        </div>
        <DialogFooter>
          <button type="button" className={styles.refresh} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.calculate}>
            <span>Add location</span>
            <b>→</b>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const stockCategories = [
  { id: "bpc" as const, label: "Blueprints", icon: FileBox },
  { id: "reaction" as const, label: "Reaction formulas", icon: Atom },
  { id: "item" as const, label: "Items", icon: Package },
];

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
  const sellOrderCount = location.items.filter((item) => item.source === "marketOrder").length;
  const installedJobCount = new Set(
    location.items
      .map((item) => item.jobId)
      .filter((jobId): jobId is number => jobId !== undefined),
  ).size;
  const stockMetrics = [
    ...stockCategories.map((category) => {
      const items = location.items.filter((item) =>
        category.id === "bpc"
          ? isBlueprintStockItem(item)
          : (item.category ?? "item") === category.id,
      );
      return {
        ...category,
        count: items.length,
        detail: isVolumesLoading
          ? "Calculating..."
          : formatVolume(items.reduce((total, item) => total + stockItemVolume(item), 0)),
        filter: { kind: "category" as const, value: category.id },
      };
    }),
    {
      id: "sales",
      label: "Sales",
      icon: ChartLine,
      count: sellOrderCount,
      detail: "Sell orders",
      filter: { kind: "sales" as const },
    },
    {
      id: "jobs",
      label: "Jobs",
      icon: Factory,
      count: installedJobCount,
      detail: "Installed jobs",
      filter: { kind: "jobs" as const },
    },
  ].filter((metric) => metric.count > 0);
  return (
    <article className={styles.stockCard}>
      <div className={styles.stockCardHeading}>
        <div>
          <p className={styles.panelKicker}>{location.systemName}</p>
          <h3>{location.structureName}</h3>
        </div>
        {!isEsiLocation && location.source !== "marketOrder" && (
          <div className={styles.stockCardActions}>
            <button
              type="button"
              className={`actionButton ${styles.stockPasteButton}`}
              aria-label={`Paste items at ${location.structureName}`}
              title="Paste items"
              onClick={onPaste}
            >
              <Clipboard aria-hidden="true" />
              <span>Paste</span>
            </button>
            <button
              type="button"
              className={`actionButton ${styles.stockRemoveButton}`}
              aria-label={`Remove stock at ${location.structureName}`}
              title="Remove stock location"
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
              <span>Remove</span>
            </button>
          </div>
        )}
      </div>
      <div className={styles.stockCardTotals}>
        {stockMetrics.length === 0 ? (
          <Empty className={styles.stockMetricsEmpty}>
            <EmptyDescription>No stock metrics available</EmptyDescription>
          </Empty>
        ) : (
          stockMetrics.map((metric) => (
            <button
              type="button"
              className={styles.stockMetric}
              key={metric.id}
              onClick={() => onView(location, metric.filter)}
            >
              <span>
                <metric.icon aria-hidden="true" />
                {metric.label}
              </span>
              <strong>{metric.count.toLocaleString()}</strong>
              <small>{metric.detail}</small>
            </button>
          ))
        )}
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

type StockTypeBucket = {
  item: StockItem;
  stockQuantity: number;
  productionQuantity: number;
  marketQuantity: number;
  bpoCount: number;
  bpoInUseCount: number;
  bpcProductionCount: number;
  bpcProductionRuns: number;
  bpcStockCount: number;
  bpcStockRuns: number;
  category: StockItem["category"];
  marketCategory?: string;
};

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
  const filteredItems = location.items.filter((item) => {
    if (filter.kind === "all") return true;
    if (filter.kind === "sales") return item.source === "marketOrder";
    if (filter.kind === "jobs") return item.inBuild || item.jobId !== undefined;
    if (filter.kind === "market") return item.marketCategory === filter.value;
    return filter.value === "bpc"
      ? isBlueprintStockItem(item)
      : (item.category ?? "item") === filter.value;
  });
  const displayItems = new Map<number, StockTypeBucket>();
  for (const item of filteredItems) {
    const existing = displayItems.get(item.typeId);
    const isMarketOrder = item.source === "marketOrder";
    const isProduction = item.inBuild && !isBlueprintStockItem(item);
    const stockQuantity = !isMarketOrder && !isProduction ? item.quantity : 0;
    const productionQuantity = isProduction ? (item.inBuildQuantity ?? item.quantity) : 0;
    const marketQuantity = isMarketOrder ? item.quantity : 0;
    const isBlueprint = isBlueprintStockItem(item);
    const isBpo = isBlueprint && item.blueprintType === "bpo";
    const isBpc = isBlueprint && item.blueprintType !== "bpo";
    const bpcRuns =
      item.blueprintPrints?.reduce((total, print) => total + Math.max(0, print.runs), 0) ?? 0;
    const blueprintSummary = {
      bpoCount: isBpo ? item.quantity : 0,
      bpoInUseCount: isBpo && item.inUse ? item.quantity : 0,
      bpcProductionCount: isBpc && item.inBuild ? item.quantity : 0,
      bpcProductionRuns: isBpc && item.inBuild ? (item.jobRuns ?? 0) * (item.licensedRuns ?? 0) : 0,
      bpcStockCount: isBpc && !item.inBuild ? item.quantity : 0,
      bpcStockRuns: isBpc && !item.inBuild ? bpcRuns : 0,
    };
    if (!existing) {
      displayItems.set(
        item.typeId,
        {
          item,
          stockQuantity,
          productionQuantity,
          marketQuantity,
          ...blueprintSummary,
          category: item.category,
          marketCategory: item.marketCategory,
        },
      );
      continue;
    }
    existing.stockQuantity += stockQuantity;
    existing.productionQuantity += productionQuantity;
    existing.marketQuantity += marketQuantity;
    existing.bpoCount += blueprintSummary.bpoCount;
    existing.bpoInUseCount += blueprintSummary.bpoInUseCount;
    existing.bpcProductionCount += blueprintSummary.bpcProductionCount;
    existing.bpcProductionRuns += blueprintSummary.bpcProductionRuns;
    existing.bpcStockCount += blueprintSummary.bpcStockCount;
    existing.bpcStockRuns += blueprintSummary.bpcStockRuns;
    if (isProduction && !existing.item.inBuild) existing.item = item;
  }
  const buckets = [...displayItems.values()];
  const title =
    filter.kind === "all"
      ? "All items"
      : filter.kind === "sales"
        ? "Sales"
        : filter.kind === "jobs"
          ? "Jobs"
          : filter.kind === "market"
            ? filter.value
            : stockCategories.find((category) => category.id === filter.value)?.label;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className={styles.importModal}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>LOCATION STOCK</p>
            <DialogTitle>{location.structureName}</DialogTitle>
          </div>
        </div>
        <div className="no-scrollbar max-h-[70vh] overflow-y-auto overscroll-contain">
          <p className={styles.panelDescription}>
            {location.systemName} · {title} · {buckets.length} item types
          </p>
          <div className={styles.stockViewFilters}>
            <button
              type="button"
              className={filter.kind === "all" ? styles.stockFilterActive : ""}
              onClick={() => onFilterChange({ kind: "all" })}
            >
              All
            </button>
            <button
              type="button"
              className={filter.kind === "sales" ? styles.stockFilterActive : ""}
              onClick={() => onFilterChange({ kind: "sales" })}
            >
              Sales
            </button>
            <button
              type="button"
              className={filter.kind === "jobs" ? styles.stockFilterActive : ""}
              onClick={() => onFilterChange({ kind: "jobs" })}
            >
              Jobs
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
        </div>
        {buckets.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>No items recorded at this location.</EmptyDescription>
          </Empty>
        ) : (
          <div className={styles.stockList}>
            {buckets.map(
              (
                {
                  item,
                  stockQuantity,
                  productionQuantity,
                  marketQuantity,
                  bpoCount,
                  bpoInUseCount,
                  bpcProductionCount,
                  bpcProductionRuns,
                  bpcStockCount,
                  bpcStockRuns,
                },
                itemIndex,
              ) => {
                const categoryLabel = item.marketCategory ?? item.category ?? "Item";
                const showCategory =
                  filter.kind === "all" || (filter.kind === "category" && filter.value === "item");
                const isBlueprint = isBlueprintStockItem(item);
                const isReaction = item.category === "reactionformula";
                return (
                  <div className={styles.stockRow} key={`${item.typeId}:${itemIndex}`}>
                    <div className={styles.stockIdentityStack}>
                      <TypeIdentity
                        name={item.name}
                        subline={showCategory ? categoryLabel : undefined}
                        typeId={item.typeId}
                        imageSize={40}
                        className={styles.stockTypeIdentity}
                        variation={item.category === "reactionformula" ? "bpc" : "icon"}
                        blueprintType={
                          isBlueprintStockItem(item) ? (bpoCount > 0 ? "bpo" : "bpc") : undefined
                        }
                      />
                    </div>
                    {isBlueprint ? (
                      <div className={styles.stockAggregateList}>
                        {bpoCount > 0 && (
                          <span>
                            <FileBox aria-hidden="true" />
                            <b>{`${bpoInUseCount.toLocaleString()} / ${bpoCount.toLocaleString()}`}</b>
                            <small>BPO in use</small>
                          </span>
                        )}
                        {bpcProductionCount > 0 && (
                          <span>
                            <Files aria-hidden="true" />
                            <b>
                              {`${bpcProductionRuns.toLocaleString()} Runs on ${bpcProductionCount.toLocaleString()} BPC`}
                            </b>
                            <small>In production</small>
                          </span>
                        )}
                        <span>
                          <Package aria-hidden="true" />
                          <b>
                            {`${bpcStockRuns.toLocaleString()} Runs on ${bpcStockCount.toLocaleString()} BPC`}
                          </b>
                          <small>In stock</small>
                        </span>
                      </div>
                    ) : (
                      <div className={styles.stockAggregateList}>
                        {productionQuantity > 0 && (
                          <span>
                            {isReaction ? (
                              <Atom aria-hidden="true" />
                            ) : (
                              <Factory aria-hidden="true" />
                            )}
                            <b>{productionQuantity.toLocaleString()}</b>
                            <small>{isReaction ? "In use" : "In production"}</small>
                          </span>
                        )}
                        <span
                          className={`${styles.stockAggregateStock} ${
                            isReaction ? styles.stockAggregateReactionStock : ""
                          }`}
                        >
                          <Package aria-hidden="true" />
                          <b>{stockQuantity.toLocaleString()}</b>
                          <small>Available</small>
                        </span>
                        {marketQuantity > 0 && (
                          <span>
                            <ShoppingCart aria-hidden="true" />
                            <b>{marketQuantity.toLocaleString()}</b>
                            <small>On market</small>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              },
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
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
      const response = await fetch(
        "/api/reference/types",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language, items: parsed }),
        },
      );
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
    }
    catch (resolveError) {
      setResults([]);
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "Could not resolve the pasted stock.",
      );
    }
    finally {
      setIsResolving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className={styles.importModal} render={<form onSubmit={resolveItems} />}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STOCK IMPORT</p>
            <DialogTitle>Paste items</DialogTitle>
          </div>
        </div>
        <p className={styles.panelDescription}>
          One item per line. Put the quantity at the end of each line.
        </p>
        <RadioGroup
          className={styles.stockMode}
          value={mode}
          onValueChange={(value) => setMode(value as "add" | "replace")}
          aria-label="Paste mode"
        >
          <label>
            <RadioGroupItem value="add" />
            Add to existing
          </label>
          <label>
            <RadioGroupItem value="replace" />
            Replace existing
          </label>
        </RadioGroup>
        <Textarea
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
        {error && (
          <Alert variant="destructive" className={styles.importError}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
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
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function mergeItems(existing: StockItem[], imported: StockItem[]) {
  const items = existing.map((item) => ({ ...item }));
  for (const item of imported) {
    const current = items.find(
      (entry) =>
        entry.typeId === item.typeId
        && entry.isPackaged === item.isPackaged
        && (entry.category ?? "item") === (item.category ?? "item"),
    );
    if (current) {
      current.quantity += item.quantity;
      current.blueprintType ??= item.blueprintType;
      current.me ??= item.me;
      current.te ??= item.te;
      if (item.blueprintPrints) {
        current.blueprintPrints = [...(current.blueprintPrints ?? []), ...item.blueprintPrints];
      }
      current.assembledVolume = item.assembledVolume;
      current.packagedVolume = item.packagedVolume;
    }
    else {
      items.push(item);
    }
  }
  return items;
}

async function hydrateVolumes(records: StockRecord[], language: SdeLanguage) {
  const typeIdsNeedingMetadata = records.flatMap((record) =>
    record.items
      .filter(
        (item) =>
          item.assembledVolume === undefined
          || (item.isPackaged && item.packagedVolume === undefined)
          || item.techLevel === undefined
          || item.category === undefined
          || item.marketCategory === undefined,
      )
      .map((item) => item.typeId),
  );
  if (typeIdsNeedingMetadata.length === 0) return records;
  let metadata: Awaited<ReturnType<typeof fetchTypeMetadata>> = [];
  try {
    metadata = await fetchTypeMetadata(typeIdsNeedingMetadata, language);
  }
  catch {
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
