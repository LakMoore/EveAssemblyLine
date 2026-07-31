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
import type { KnownStructure } from "@/lib/planning/preferences";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import styles from "../page.module.css";

type StructureOption = { id: string; name: string };
type SystemOption = { id: number; name: string };
type PasteResult = {
  name: string;
  quantity?: number;
  typeId?: number;
  volume?: number;
  category?: StockItem["category"];
  marketCategory?: string;
  error?: string;
};
type StockFilter = { kind: "all" } | { kind: "category" | "market"; value: string };

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
  const [knownStructures, setKnownStructures] = useState<KnownStructure[]>([]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [viewing, setViewing] = useState<StockRecord | null>(null);
  const [viewingFilter, setViewingFilter] = useState<StockFilter>({ kind: "all" });
  const [pasting, setPasting] = useState<StockRecord | null>(null);

  useEffect(() => {
    async function loadPageData() {
      try {
        const [records, structures] = await Promise.all([loadStockRecords(), loadStructures()]);
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
        const hydratedRecords = await hydrateVolumes(correctedRecords, language);
        setLocations(
          [...hydratedRecords].sort((left, right) =>
            left.systemName.localeCompare(right.systemName),
          ),
        );
        setKnownStructures(structures);
        await Promise.all(
          hydratedRecords.flatMap((record, index) => {
            const previous = records[index];
            const writes = record !== previous ? [saveStock(record)] : [];
            if (previous && locationKey(previous) !== locationKey(record))
              writes.push(deleteStock(previous));
            return writes;
          }),
        );
      } catch {
        setLocations([]);
      }
    }
    void loadPageData();
  }, [language]);

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
          <span className={styles.panelDescription}>{locations.length} saved</span>
        </div>
        {locations.length === 0 ? (
          <div className={styles.emptyBuildList}>
            No stock locations yet. Add a location to begin tracking items.
          </div>
        ) : (
          <div className={styles.stockCardGrid}>
            {locations.map((location) => {
              return (
                <StockLocationCard
                  key={locationKey(location)}
                  location={location}
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
          ...localStructures.filter(
            (local) => !npcStructures.some((npc) => npc.id === local.id),
          ),
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
      fetch(
        `/api/reference/systems?query=${encodeURIComponent(systemName)}&language=${language}`,
        { signal: controller.signal },
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
          if (!(error instanceof DOMException && error.name === "AbortError"))
            setSuggestions([]);
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
              <div
                className={styles.searchResults}
                id="add-location-system-options"
                role="listbox"
              >
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
  { id: "bpo", label: "BPOs" },
  { id: "bpc", label: "BPCs" },
  { id: "reaction", label: "Reaction formulas" },
  { id: "item", label: "Items" },
];

function StockLocationCard({
  location,
  onView,
  onPaste,
  onRemove,
}: {
  location: StockRecord;
  onView: (location: StockRecord, filter?: StockFilter) => void;
  onPaste: () => void;
  onRemove: () => void;
}) {
  const marketCategories = [...new Set(location.items.map((item) => item.marketCategory).filter(Boolean))] as string[];
  return (
    <article className={styles.stockCard}>
      <div className={styles.stockCardHeading}>
        <div>
          <p className={styles.panelKicker}>{location.systemName}</p>
          <h3>{location.structureName}</h3>
        </div>
        <div className={styles.stockCardActions}>
          <button type="button" className={styles.iconButton} aria-label={`Paste items at ${location.structureName}`} title="Paste items" onClick={onPaste}>⇩</button>
          <button type="button" className={styles.stockRemoveButton} aria-label={`Remove stock at ${location.structureName}`} title="Remove stock location" onClick={onRemove}>×</button>
        </div>
      </div>
      <div className={styles.stockCardTotals}>
        {stockCategories.map((category) => {
          const items = location.items.filter((item) => (item.category ?? "item") === category.id);
          const volume = items.reduce((total, item) => total + item.quantity * (item.volume ?? 0), 0);
          return (
            <button type="button" className={styles.stockMetric} key={category.id} onClick={() => onView(location, { kind: "category", value: category.id })}>
              <span>{category.label}</span>
              <strong>{items.length.toLocaleString()}</strong>
              <small>{formatVolume(volume)}</small>
            </button>
          );
        })}
      </div>
      <div className={styles.stockMarketCategories}>
        {marketCategories.length === 0 ? <span>No market categories</span> : marketCategories.map((category) => <button type="button" key={category} onClick={() => onView(location, { kind: "market", value: category })}>{category}</button>)}
      </div>
      <button type="button" className={styles.stockCardViewAll} onClick={() => onView(location)}>
        <span>View all items</span><b>→</b>
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
  const filteredItems = location.items.filter((item) => {
    if (filter.kind === "all") return true;
    if (filter.kind === "market") return item.marketCategory === filter.value;
    return (item.category ?? "item") === filter.value;
  });
  const title = filter.kind === "all" ? "All items" : filter.kind === "market" ? filter.value : stockCategories.find((category) => category.id === filter.value)?.label;
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
          {location.systemName} · {title} · {filteredItems.length} item types
        </p>
        <div className={styles.stockViewFilters}>
          <button type="button" className={filter.kind === "all" ? styles.stockFilterActive : ""} onClick={() => onFilterChange({ kind: "all" })}>All</button>
          {stockCategories.map((category) => <button type="button" className={filter.kind === "category" && filter.value === category.id ? styles.stockFilterActive : ""} key={category.id} onClick={() => onFilterChange({ kind: "category", value: category.id })}>{category.label}</button>)}
        </div>
        {filteredItems.length === 0 ? (
          <div className={styles.emptyBuildList}>No items recorded at this location.</div>
        ) : (
          <div className={styles.stockList}>
            {filteredItems.map((item) => (
              <div className={styles.stockRow} key={item.typeId}>
                <Image
                  className={styles.stockItemImage}
                  src={eveTypeImageUrl(
                    item.typeId,
                    item.category === "bpo" || item.category === "bpc" || item.category === "reaction" ? "bpc" : "icon",
                  )}
                  alt=""
                  width={40}
                  height={40}
                />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    Type ID {item.typeId} · {formatVolume(item.quantity * (item.volume ?? 0))}
                  </small>
                </span>
                <strong>{item.quantity.toLocaleString()}</strong>
              </div>
            ))}
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
          volume: item.volume ?? 0,
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
    const current = items.find((entry) => entry.typeId === item.typeId);
    if (current) {
      current.quantity += item.quantity;
      current.volume = item.volume;
    } else {
      items.push(item);
    }
  }
  return items;
}

async function hydrateVolumes(records: StockRecord[], language: SdeLanguage) {
  const hydrated = await Promise.all(
    records.map(async (record) => {
      const items = await Promise.all(
        record.items.map(async (item) => {
          try {
            const response = await fetch(
              `/api/reference/types?typeId=${item.typeId}&language=${language}`,
            );
            const data = (await response.json()) as {
              items?: Array<{
                volume?: number;
                category?: StockItem["category"];
                marketCategory?: string;
              }>;
            };
            const metadata = data.items?.[0];
            return {
              ...item,
              volume: metadata?.volume ?? 0,
              category: metadata?.category ?? "item",
              marketCategory: metadata?.marketCategory,
            };
          } catch {
            return item;
          }
        }),
      );
      return items.every((item, index) => item === record.items[index])
        ? record
        : { ...record, items };
    }),
  );
  return hydrated;
}
