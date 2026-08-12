"use client";

import { FormEvent, KeyboardEvent, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAppLanguage } from "../AppShell";
import TypeIdentity from "../components/TypeIdentity";
import { useToast } from "../components/ToastProvider";
import type { SdeLanguage } from "@/lib/reference/languages";
import { Clipboard, Minimize2 } from "lucide-react";
import Image from "next/image";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { loadStructures } from "@/lib/planning/structureStore";
import { loadCompressSettings, saveCompressSettings, type CompressMaterial, type CompressSettings } from "@/lib/planning/compressSettingsStore";
import type { KnownStructure } from "@/lib/planning/preferences";
import { loadClientStock } from "@/lib/client/requestCache";
import styles from "./compress.module.css";
import { marketHubs } from "@/lib/reference/marketHubs";

type CompressItem = CompressMaterial;
type TypeResult = Pick<CompressItem, "name" | "typeId" | "category">;
type PasteResult = TypeResult & { quantity?: number; error?: string };
type ResultItem = { name: string; typeId?: number; quantity: number; packagedVolume?: number; fromReprocessing?: number; surplus?: number };
type EfficiencyGroup = { skillId?: number; skillName: string; efficiency: number; marketCategories: Array<{ name: string; typeId: number }> };
type EfficiencyResult = { averageAsteroid?: number; averageMoon?: number; ice: number; gas: number; scrapMetal: number; groups: EfficiencyGroup[] };
type CompressResult = {
  plan?: ResultItem[];
  toBuy?: ResultItem[];
  surplus?: ResultItem[];
  efficiencies?: EfficiencyResult;
};
type CompressOption = { id: string; name?: string; structureTypeId?: number; structureType?: "NPC" | "Athanor" | "Tatara" | "Sotiyo"; securityStatus?: number; rigs?: string[]; rankBonus?: number; baseYield?: number; canReprocess?: boolean };
type CharacterOption = { id: string; characterId: number; name: string; skills: Record<string, number>; implants: number[] };
type ImplantOption = { id: string; name: string; level: number; typeId?: number };
type CompressOptions = { locations: CompressOption[]; characters: CharacterOption[]; implants: ImplantOption[]; relevantSkillIds: number[]; scrapMetalSkillId?: number };

function variation(category?: CompressItem["category"], imageVariation?: CompressItem["imageVariation"], name?: string) {
  if (imageVariation) return imageVariation;
  if (name && / blueprint$/i.test(name)) return "bp";
  if (name && / formula$/i.test(name)) return "bpc";
  return category === "blueprint" || category === "bpo" ? "bp" : category === "bpc" || category === "reaction" ? "bpc" : "icon";
}

function resultVariation(name: string) {
  return /Blueprint Copy$/i.test(name) ? "bpc" : /Blueprint$/i.test(name) ? "bp" : "icon";
}

function reprocessingRigLevel(rigs: string[]) {
  const rig = rigs.find((name) => /Ore Grading Processor|Reprocessing Monitor/.test(name));
  return rig === undefined ? 0 : / II(?:$|\s)/.test(rig) ? 2 : 1;
}

function structureDisplayName(structure: KnownStructure) {
  return structure.name.startsWith(`${structure.systemName} - `) ? structure.name : `${structure.systemName} - ${structure.name}`;
}

function normalizeLocationName(name: string) {
  return name.replace(/^(.+?) - \1 - /i, "$1 - ");
}

function locationKey(location: CompressOption) {
  return location.structureType && location.structureType !== "NPC" && location.name ? `structure:${normalizeLocationName(location.name).toLocaleLowerCase()}` : location.id;
}

export default function CompressPage() {
  return <Suspense fallback={null}><CompressContent /></Suspense>;
}

function CompressContent() {
  const searchParams = useSearchParams();
  const importedMultibuy = searchParams.get("multibuy");
  const { language } = useAppLanguage();
  const [items, setItems] = useState<CompressItem[]>([]);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("Ready to compress");
  const [options, setOptions] = useState<CompressOptions>({ locations: [], characters: [], implants: [], relevantSkillIds: [] });
  const [knownStructures, setKnownStructures] = useState<KnownStructure[]>([]);
  const [settings, setSettings] = useState<CompressSettings>({ locationId: "npc", characterId: "all-zero", implantId: "none", marketId: "jita", orderType: "buy-1-day", items: [] });
  const importedRef = useRef("");
  const optionsLoadLanguageRef = useRef<SdeLanguage | null>(null);

  useEffect(() => {
    if (optionsLoadLanguageRef.current === language) return;
    optionsLoadLanguageRef.current = language;
    Promise.all([loadStructures(), loadCompressSettings(), loadClientStock(language)]).then(async ([structures, loadedSettings, stock]) => {
      const loadedOptions = await fetch("/api/compress/options", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({
        language,
        structures: structures.filter((structure) => structure.typeId !== undefined && structure.rigTypeIds !== undefined && Number.isSafeInteger(structure.systemId) && structure.systemId > 0).map((structure) => ({ id: structure.esiStructureId === undefined ? structure.id : `structure:${structure.esiStructureId}`, type: structure.typeId, systemId: structure.systemId, rigs: structure.rigTypeIds })),
        assetLocations: (stock.locations ?? []).filter((location) => location.locationType !== "anchored").map(({ locationId, name, locationType, typeId, systemId }) => ({ locationId, name, locationType, ...(typeId === undefined ? {} : { typeId }), ...(systemId === undefined ? {} : { systemId }) })),
      }) }).then((response) => response.json() as Promise<CompressOptions>);
      const structuresWithSecurity = structures.map((structure) => {
        const suppliedSecurityStatus = loadedOptions.locations.find((location) => location.id === structure.id)?.securityStatus;
        if (suppliedSecurityStatus !== undefined) return { ...structure, securityStatus: suppliedSecurityStatus };
        return structure;
      });
      const rawLocations: CompressOption[] = [
        ...loadedOptions.locations.map((location) => {
          const known = structuresWithSecurity.find((structure) => location.id === `structure:${structure.esiStructureId}` || location.id === structure.id || (location.name !== undefined && normalizeLocationName(location.name).toLocaleLowerCase() === structureDisplayName(structure).toLocaleLowerCase()));
          return { ...location, ...(known ? { name: structureDisplayName(known), rigs: known.rigs } : location.name ? { name: normalizeLocationName(location.name) } : {}) };
        }),
        ...structuresWithSecurity.filter((structure) => structure.type === "Athanor" || structure.type === "Tatara").map((structure) => ({
          id: structure.id,
          name: structureDisplayName(structure),
          structureTypeId: structure.typeId,
          structureType: structure.type === "Athanor" ? "Athanor" as const : structure.type === "Tatara" ? "Tatara" as const : "NPC" as const,
          securityStatus: structure.securityStatus,
          rigs: structure.rigs,
        })),
      ].filter((location, index, all) => all.findIndex((candidate) => locationKey(candidate) === locationKey(location)) === index);
      const loadedLocations = rawLocations.map((location) => {
        const baseYield = location.baseYield ?? 50;
        return { ...location, rankBonus: baseYield - 50 };
      }).sort((left, right) => (right.rankBonus ?? 0) - (left.rankBonus ?? 0) || (left.name ?? left.id).localeCompare(right.name ?? right.id));
      const normalizedSettings = { ...loadedSettings, items: Array.isArray(loadedSettings.items) ? loadedSettings.items : [], locationId: loadedLocations.some((location) => location.id === loadedSettings.locationId) ? loadedSettings.locationId : loadedLocations[0]?.id ?? loadedSettings.locationId, marketId: marketHubs.some((market) => market.id === loadedSettings.marketId) ? loadedSettings.marketId : "jita", orderType: loadedSettings.orderType ?? "buy-1-day" };
      setOptions({ ...loadedOptions, locations: loadedLocations });
      setKnownStructures(structuresWithSecurity);
      setSettings(normalizedSettings);
      setItems(normalizedSettings.items);
      void saveCompressSettings(normalizedSettings);
    }).catch(() => {
      optionsLoadLanguageRef.current = null;
      setStatus("Could not load compression options.");
    });
  }, [language]);

  function updateSettings(next: Partial<CompressSettings>) {
    setSettings((current) => {
      const updated = { ...current, ...next };
      void saveCompressSettings(updated);
      return updated;
    });
  }

  function updateItems(nextItems: CompressItem[] | ((current: CompressItem[]) => CompressItem[])) {
    setItems((current) => {
      const updated = typeof nextItems === "function" ? nextItems(current) : nextItems;
      setSettings((currentSettings) => {
        const updatedSettings = { ...currentSettings, items: updated };
        void saveCompressSettings(updatedSettings);
        return updatedSettings;
      });
      return updated;
    });
  }

  const locationOptions: CompressOption[] = [
    ...options.locations,
    ...knownStructures.filter((structure) => !options.locations.some((location) => locationKey(location) === `structure:${structureDisplayName(structure).toLocaleLowerCase()}`)).map((structure) => ({ id: structure.id, name: structureDisplayName(structure), structureTypeId: structure.typeId, structureType: structure.type as CompressOption["structureType"], securityStatus: structure.securityStatus, rigs: structure.rigs, canReprocess: structure.type === "Sotiyo" ? false : undefined })),
  ].filter((location, index, all) => all.findIndex((candidate) => locationKey(candidate) === locationKey(location)) === index);
  const selectedCharacter = options.characters.find((character) => character.id === settings.characterId);
  const selectedImplant = options.implants.find((implant) => implant.id === settings.implantId) ?? options.implants[0];
  const implantOptions = selectedCharacter ? options.implants.filter((implant) => implant.id === "none" || (implant.typeId !== undefined && selectedCharacter.implants.includes(implant.typeId))) : options.implants;
  const skillLevels = settings.characterId === "all-zero" ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 0])) : settings.characterId === "all-iv" ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 4])) : settings.characterId === "all-v" ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 5])) : selectedCharacter?.skills ?? {};


  useEffect(() => {
    if (!importedMultibuy || importedRef.current === `${language}:${importedMultibuy}`) return;
    importedRef.current = `${language}:${importedMultibuy}`;
    const parsed = importedMultibuy.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(.*?)\s+(\d+)$/);
      return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line };
    });
    if (!parsed.length) return;
    fetch("/api/reference/types", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language, items: parsed }) })
      .then(async (response) => {
        const data = await response.json() as { items?: PasteResult[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Could not load the Buy list.");
        const resolved = (data.items ?? []).filter((item): item is PasteResult & { typeId: number; quantity: number } => Boolean(item.typeId && item.quantity && !item.error));
        if (resolved.length !== parsed.length) throw new Error("Every Buy item must be a published item name and quantity.");
        updateItems(resolved.map(({ name, typeId, quantity, category }) => ({ name, typeId, quantity, category })));
        setResult(null);
        setStatus("Buy list loaded");
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : "Could not load the Buy list."));
  }, [importedMultibuy, language]);

  function addItem(item: TypeResult) {
    updateItems((current) => {
      const existing = current.find((entry) => entry.typeId === item.typeId);
      return existing
        ? current.map((entry) => entry.typeId === item.typeId ? { ...entry, quantity: entry.quantity + 1 } : entry)
        : [...current, { ...item, quantity: 1 }];
    });
    setResult(null);
  }

  async function compress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (items.length === 0 || isLoading) return;
    setIsLoading(true);
    setStatus("Reprocessing requirements...");
    try {
      const selectedLocation = locationOptions.find((location) => location.id === settings.locationId);
      const response = await fetch("/api/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, items: items.map(({ typeId, name, quantity }) => ({ typeId, name, quantity })), structureTypeId: selectedLocation?.structureTypeId ?? 0, reprocessingRig: reprocessingRigLevel(selectedLocation?.rigs ?? []), skillLevels, implantLevel: selectedImplant?.level ?? 0, securityStatus: selectedLocation?.securityStatus, marketId: marketHubs.find((market) => market.id === settings.marketId)?.regionId ?? marketHubs[0].regionId, orderType: settings.orderType }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? (await response.json()) as CompressResult & { error?: string }
        : null;
      if (!response.ok) {
        throw new Error(data?.error ?? "The compression service is not available yet.");
      }
      if (!data) throw new Error("The compression service returned an invalid response.");
      setResult(data);
      setStatus("Compression complete");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reach the compression service.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>MATERIALS / REPROCESSING</p>
          <h1>Compress</h1>
          <p className={styles.subtitle}>Reverse-reprocess a raw material requirement into the smallest useful ore list.</p>
        </div>
        <div className={styles.introMark} aria-hidden="true"><Minimize2 size={30} /></div>
      </div>

      <form onSubmit={compress}>
        <section className={styles.inputPanel}>
          <div className={styles.panelHeader}>
            <div><p className={styles.kicker}>01 / REQUIREMENTS</p><h2>Raw materials</h2></div>
            <button type="button" className={`actionButton ${styles.secondaryButton}`} onClick={() => setIsPasteOpen(true)}><Clipboard aria-hidden="true" /><span>Paste multibuy</span></button>
          </div>
          <p className={styles.description}>Add the minerals you need, then find the compressed ores that can produce them.</p>
          <TypeSearch language={language} onSelect={addItem} />
          <div className={styles.compressOptions}>
            {locationOptions.length > 0 ? <label><span>LOCATION</span><select value={settings.locationId} onChange={(event) => updateSettings({ locationId: event.target.value })}>{locationOptions.map((location) => <option value={location.id} key={location.id} disabled={location.canReprocess === false}>{location.name ?? `Location ${location.id}`}{location.canReprocess !== false && location.structureType !== "NPC" && reprocessingRigLevel(location.rigs ?? []) === 0 ? " [No Rigs]" : ""}{location.canReprocess === false ? " [No Reprocessing]" : ""} · {Math.round(location.baseYield ?? 50)}%</option>)}</select></label> : <div className={styles.locationHelp}><span>LOCATION</span><p>No reprocessing locations found. <Link href="/locations">Add a reprocessing location</Link> or <Link href="/api/auth/eve/start">authenticate a character</Link> to find the best location automatically.</p></div>}
            <label><span>CHARACTER / SKILLS</span><select value={settings.characterId} onChange={(event) => updateSettings({ characterId: event.target.value, implantId: "none" })}><option value="all-zero">All zero</option><option value="all-iv">All IV</option><option value="all-v">All V</option>{options.characters.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}</select></label>
            <label><span>IMPLANT</span><select value={implantOptions.some((implant) => implant.id === settings.implantId) ? settings.implantId : "none"} onChange={(event) => updateSettings({ implantId: event.target.value })}>{implantOptions.map((implant) => <option value={implant.id} key={implant.id}>{implant.name}</option>)}</select></label>
            <label><span>MARKET</span><select value={settings.marketId} onChange={(event) => updateSettings({ marketId: event.target.value })}>{marketHubs.map((market) => <option value={market.id} key={market.id}>{market.name}</option>)}</select></label>
            <label><span>ORDER TYPE</span><select value={settings.orderType} onChange={(event) => updateSettings({ orderType: event.target.value as CompressSettings["orderType"] })}><option value="buy-1-day">Buy (1 Day)</option><option value="buy-5-day">Buy (5 Day)</option><option value="sell">Sell</option></select></label>
          </div>
          <div className={styles.listHeader}><span>ITEM</span><span>QUANTITY</span><span /></div>
          {items.length === 0 ? <div className={styles.empty}>Search for a mineral above to build your requirement.</div> : items.map((item, index) => (
            <div className={styles.itemRow} key={item.typeId}>
              <TypeIdentity name={item.name} typeId={item.typeId} variation={variation(item.category, item.imageVariation, item.name)} />
              <input aria-label={`${item.name} quantity`} type="number" min="1" step="1" value={item.quantity} onChange={(event) => updateItems((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) } : entry))} />
              <button type="button" className={styles.removeButton} aria-label={`Remove ${item.name}`} onClick={() => updateItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
            </div>
          ))}
          <div className={styles.actionBar}>
            <span className={styles.status}>{status}</span>
            <button className={styles.primaryButton} type="submit" disabled={items.length === 0 || isLoading}><Minimize2 size={16} />{isLoading ? "Compressing..." : "Compress"}</button>
          </div>
        </section>
      </form>

      {result && <Results result={result} />}
      {isPasteOpen && <PasteDialog language={language} currentItems={items} onCancel={() => setIsPasteOpen(false)} onReplace={(next) => { updateItems(next); setResult(null); setIsPasteOpen(false); }} />}
    </>
  );
}

function TypeSearch({ language, onSelect }: { language: SdeLanguage; onSelect: (item: TypeResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const requestId = useRef(0);
  useEffect(() => {
    if (query.trim().length < 2) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(() => fetch(`/api/reference/types?query=${encodeURIComponent(query.trim())}&language=${language}`).then((response) => response.json() as Promise<{ items?: TypeResult[] }>).then((data) => { if (id === requestId.current) { setResults(data.items ?? []); setIsOpen(true); } }).catch(() => setResults([])), 180);
    return () => window.clearTimeout(timer);
  }, [language, query]);
  function choose(item: TypeResult) { onSelect(item); setQuery(""); setResults([]); setIsOpen(false); }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) { if (event.key === "Escape") setIsOpen(false); if (event.key === "Enter" && results[0]) { event.preventDefault(); choose(results[0]); } }
  return <div className={styles.searchWrap}><div className={styles.search}><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setIsOpen(true); }} onFocus={() => results.length > 0 && setIsOpen(true)} onKeyDown={onKeyDown} placeholder="Search minerals by name or type ID" aria-label="Search minerals" /></div>{isOpen && query.trim().length >= 2 && <div className={styles.searchResults} role="listbox">{results.length ? results.map((item) => <div role="option" aria-selected="false" tabIndex={0} className={styles.searchResult} key={item.typeId} onMouseDown={() => choose(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(item); } }}><TypeIdentity name={item.name} typeId={item.typeId} variation={variation(item.category)} /></div>) : <div className={styles.noResults}>No matching published items.</div>}</div>}</div>;
}

function Results({ result }: { result: CompressResult }) {
  const { showToast } = useToast();
  const tabs = [
    { key: "efficiency", label: "Efficiency", note: "Reprocessing efficiencies used by the solve" },
    { key: "plan", label: "Plan", note: "Required materials and recovered quantities" },
    { key: "toBuy", label: "To buy", note: "Compressed ores and unrecoverable minerals" },
    { key: "surplus", label: "Surplus", note: "Recovered materials beyond the requirement" },
  ] as const;
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]["key"]>("efficiency");
  const active = tabs.find((tab) => tab.key === activeTab) ?? tabs[0];
  const efficiencyGroups = result.efficiencies?.groups ?? [];
  const items = active.key === "efficiency" ? [] : result[active.key] ?? [];
  const itemCount = active.key === "efficiency" ? efficiencyGroups.length : items.length;
  const volumeOf = (quantity: number, item: ResultItem) => quantity * (item.packagedVolume ?? 0);
  const totalQuantity = Math.ceil(items.reduce((total, item) => total + volumeOf(item.quantity, item), 0));
  const totalReprocessed = Math.ceil(items.reduce((total, item) => total + volumeOf(item.fromReprocessing ?? 0, item), 0));
  const totalSurplus = Math.ceil(items.reduce((total, item) => total + volumeOf(item.surplus ?? 0, item), 0));
  async function copyToBuyList() {
    try {
      await navigator.clipboard.writeText(items.map((item) => `${item.name}\t${item.quantity}`).join("\n"));
      showToast("To Buy multibuy list copied");
    } catch {
      showToast("Could not copy To Buy multibuy list");
    }
  }
  return <section className={styles.results}><div className={styles.resultsHeader}><div><p className={styles.kicker}>02 / OUTPUT</p><h2>Compression result</h2></div><span className={styles.resultStamp}>SDE + ESI REPROCESSING</span></div><div className={styles.tabs}>{tabs.map((tab, index) => <button type="button" key={tab.key} className={activeTab === tab.key ? styles.tabActive : ""} onClick={() => setActiveTab(tab.key)}><span>{String(index + 1).padStart(2, "0")}</span>{tab.label}</button>)}</div><div className={styles.resultPanel}><div className={styles.resultPanelHeader}><div><h3>{active.label}</h3><p>{active.note}</p></div><div className={styles.resultPanelActions}>{active.key === "toBuy" && items.length > 0 && <button type="button" className={styles.secondaryButton} onClick={() => void copyToBuyList()}>Copy multibuy</button>}<strong>{itemCount}</strong></div></div>{active.key === "efficiency" ? <EfficiencyTable efficiency={result.efficiencies} /> : items.length ? <>{active.key === "plan" && <div className={styles.planTableHeader}><span>Material</span><span>Required</span><span>Reprocessed</span><span>Surplus</span></div>}<div className={styles.resultList}>{items.map((item) => <div className={`${styles.resultRow} ${active.key === "plan" ? styles.planResultRow : ""}`} key={`${active.key}-${item.typeId ?? item.name}`}><span>{item.typeId ? <TypeIdentity name={item.name} typeId={item.typeId} variation={resultVariation(item.name)} /> : item.name}</span><strong data-label="Required">{item.quantity.toLocaleString()}</strong>{active.key === "plan" && <><strong data-label="Reprocessed">{item.fromReprocessing?.toLocaleString() ?? "0"}</strong><strong data-label="Surplus">{item.surplus?.toLocaleString() ?? "0"}</strong></>}</div>)}{active.key === "plan" ? <div className={`${styles.resultRow} ${styles.planResultRow} ${styles.totalRow}`}><strong>Total volume (m3)</strong><strong data-label="Required">{totalQuantity.toLocaleString()}</strong><strong data-label="Reprocessed">{totalReprocessed.toLocaleString()}</strong><strong data-label="Surplus">{totalSurplus.toLocaleString()}</strong></div> : active.key === "toBuy" ? <div className={styles.totalRow}><strong>Total volume (m3)</strong><strong>{totalQuantity.toLocaleString()}</strong></div> : null}</div></> : <div className={styles.emptyResult}>No entries returned.</div>}</div></section>;
}

function EfficiencyTable({ efficiency }: { efficiency?: EfficiencyResult }) {
  if (!efficiency) return <div className={styles.emptyResult}>No efficiency data returned.</div>;
  const summary = [
    ["Asteroid Ore", efficiency.averageAsteroid ?? 0],
    ["Moon Ore", efficiency.averageMoon ?? 0],
    ["Ice", efficiency.ice],
    ["Gas", efficiency.gas],
    ["Scrap Metal", efficiency.scrapMetal],
  ] as const;
  return <div className={styles.efficiencyContent}><div className={styles.efficiencySummary}>{summary.map(([name, value]) => <div className={styles.efficiencyMetric} key={name}><span>{name}</span><strong>{value.toFixed(1)}%</strong></div>)}</div><div className={styles.efficiencyTableHeader}><span>Skill</span><span>Ores</span><span>Efficiency</span></div><div className={styles.resultList}>{efficiency.groups.map((group) => <div className={styles.efficiencyRow} key={group.skillId ?? group.skillName}><strong>{group.skillName}</strong><span className={styles.marketCategories}>{group.marketCategories.map((category) => <span className={styles.marketCategory} key={category.name}>{category.typeId ? <Image src={eveTypeImageUrl(category.typeId, "icon", 32)} alt="" width={20} height={20} /> : null}<span>{category.name}</span></span>)}</span><strong>{group.efficiency.toFixed(1)}%</strong></div>)}</div></div>;
}

function PasteDialog({ language, currentItems, onCancel, onReplace }: { language: SdeLanguage; currentItems: CompressItem[]; onCancel: () => void; onReplace: (items: CompressItem[]) => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [error, setError] = useState("");
  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const match = line.match(/^(.*?)\s+(\d+)$/); return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line }; });
    if (!parsed.length) { setError("Paste at least one item and quantity."); return; }
    try {
      const response = await fetch("/api/reference/types", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language, items: parsed }) });
      const data = await response.json() as { items?: PasteResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not resolve the pasted list.");
      const resolved = (data.items ?? []).filter((item): item is PasteResult & { typeId: number; quantity: number } => Boolean(item.typeId && item.quantity && !item.error));
      if (resolved.length !== parsed.length) throw new Error("Every line must contain a published item name and quantity.");
      const imported = resolved.map(({ name, typeId, quantity, category }) => ({ name, typeId, quantity, category }));
      if (mode === "add") { const merged = [...currentItems]; for (const item of imported) { const existing = merged.find((entry) => entry.typeId === item.typeId); if (existing) existing.quantity += item.quantity; else merged.push(item); } onReplace(merged); } else onReplace(imported);
    } catch (resolveError) { setError(resolveError instanceof Error ? resolveError.message : "Could not resolve the pasted list."); }
  }
  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="compress-paste-title" onSubmit={resolve}><div className={styles.panelHeader}><div><p className={styles.kicker}>BATCH IMPORT</p><h2 id="compress-paste-title">Paste multibuy list</h2></div><button type="button" className={styles.closeButton} onClick={onCancel} aria-label="Close paste dialog">×</button></div><p className={styles.description}>One item per line, with the quantity at the end.</p><textarea value={text} onChange={(event) => { setText(event.target.value); setError(""); }} placeholder="Tritanium 120000\nPyerite 60000" aria-label="Multibuy list" autoFocus />{error && <p className={styles.error}>{error}</p>}<div className={styles.modeToggle} role="group" aria-label="Paste behavior"><button type="button" className={mode === "add" ? styles.modeActive : ""} onClick={() => setMode("add")}>Add to list</button><button type="button" className={mode === "replace" ? styles.modeActive : ""} onClick={() => setMode("replace")}>Replace list</button></div><div className={styles.modalActions}><button type="button" className={styles.secondaryButton} onClick={onCancel}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={!text.trim()}>Import list</button></div></form></div>;
}