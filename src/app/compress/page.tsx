"use client";

import { FormEvent, KeyboardEvent, Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAppLanguage } from "../AppShell";
import TypeIdentity from "../components/TypeIdentity";
import { useToast } from "../components/ToastProvider";
import type { SdeLanguage } from "@/lib/reference/languages";
import { Clipboard, Copy, FileUp, Info, Minimize2, Upload, X } from "lucide-react";
import Image from "next/image";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import {
  loadCompressSettings,
  saveCompressSettings,
  type CompressMaterial,
  type CompressSettings,
} from "@/lib/planning/compressSettingsStore";
import type { KnownStructure } from "@/lib/planning/preferences";
import { loadClientSession, loadClientStateStatus } from "@/lib/client/requestCache";
import { loadBuildList, saveBuildList } from "@/lib/planning/buildListStore";
import { loadEndpointRecord, saveEndpointResponse } from "@/lib/client/refreshCache";
import { fetchFacilityResponse } from "@/lib/planning/facilitiesStore";
import styles from "./compress.module.css";
import { marketHubs } from "@/lib/reference/marketHubs";

type CompressItem = CompressMaterial;
type TypeResult = Pick<CompressItem, "name" | "typeId" | "category">;
type PasteResult = TypeResult & { quantity?: number; error?: string };
type ResultItem = {
  name: string;
  typeId?: number;
  quantity: number;
  ignored: boolean;
  reprocessingEfficiency?: number;
  packagedVolume?: number;
  fromReprocessing?: number;
  surplus?: number;
};
type EfficiencyGroup = {
  skillId?: number;
  skillName: string;
  efficiency: number;
  marketCategories: Array<{ name: string; typeId: number }>;
};
type EfficiencyResult = {
  averageAsteroid?: number;
  averageMoon?: number;
  ice: number;
  gas: number;
  scrapMetal: number;
  groups: EfficiencyGroup[];
};
type CompressResult = {
  plan?: ResultItem[];
  toBuy?: ResultItem[];
  surplus?: ResultItem[];
  efficiencies?: EfficiencyResult;
};
type CompressOption = {
  id: string;
  name?: string;
  structureTypeId?: number;
  securityStatus?: number;
  rigs?: string[];
  rankBonus?: number;
  baseYield?: number;
  canReprocess?: boolean;
};
type CharacterOption = {
  id: string;
  characterId: number;
  name: string;
  skills?: Record<string, number>;
  implants: number[];
};
type ImplantOption = { id: string; name: string; level: number; typeId?: number };
type CompressOptions = {
  locations: CompressOption[];
  characters: CharacterOption[];
  implants: ImplantOption[];
  relevantSkillIds: number[];
  scrapMetalSkillId?: number;
};

function variation(
  category?: CompressItem["category"],
  imageVariation?: CompressItem["imageVariation"],
  name?: string,
) {
  if (imageVariation) return imageVariation;
  if (name && / blueprint$/i.test(name)) return "bp";
  if (name && / formula$/i.test(name)) return "bpc";
  return category === "blueprint" || category === "bpo"
    ? "bp"
    : category === "bpc" || category === "reaction"
      ? "bpc"
      : "icon";
}

function resultVariation(name: string) {
  return /Blueprint Copy$/i.test(name) ? "bpc" : /Blueprint$/i.test(name) ? "bp" : "icon";
}

function reprocessingRigLevel(rigs: string[]) {
  const rig = rigs.find((name) => /Ore Grading Processor|Reprocessing Monitor/.test(name));
  return rig === undefined ? 0 : / II(?:$|\s)/.test(rig) ? 2 : 1;
}

function structureDisplayName(structure: KnownStructure) {
  return structure.name.startsWith(`${structure.systemName} - `)
    ? structure.name
    : `${structure.systemName} - ${structure.name}`;
}

function normalizeLocationName(name: string) {
  return name.replace(/^(.+?) - \1 - /i, "$1 - ");
}

function locationKey(location: CompressOption) {
  return location.structureTypeId !== undefined && location.structureTypeId !== 0 && location.name
    ? `structure:${normalizeLocationName(location.name).toLocaleLowerCase()}`
    : location.id;
}

export default function CompressPage() {
  return (
    <Suspense fallback={null}>
      <CompressContent />
    </Suspense>
  );
}

function CompressContent() {
  const searchParams = useSearchParams();
  const importedMultibuy = searchParams.get("multibuy");
  const { language } = useAppLanguage();
  const [items, setItems] = useState<CompressItem[]>([]);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<CompressOptions>({
    locations: [],
    characters: [],
    implants: [],
    relevantSkillIds: [],
  });
  const [settings, setSettings] = useState<CompressSettings>({
    locationId: "npc",
    characterId: "all-zero",
    implantId: "none",
    marketId: "jita",
    orderType: "buy-1-day",
    items: [],
  });
  const [optionsRefreshVersion, setOptionsRefreshVersion] = useState(0);
  const importedRef = useRef("");
  const optionsLoadKeyRef = useRef("");

  useEffect(() => {
    if (!isPasteOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isPasteOpen]);

  useEffect(() => {
    const optionsLoadKey = `${language}:${optionsRefreshVersion}`;
    if (optionsLoadKeyRef.current === optionsLoadKey) return;
    optionsLoadKeyRef.current = optionsLoadKey;
    const isRefreshLoad = optionsRefreshVersion > 0;
    Promise
      .all([
        loadCompressSettings(),
        fetchFacilityResponse(),
        loadClientSession(),
        loadEndpointRecord<CompressOptions>("compress/options"),
      ])
      .then(async ([loadedSettings, facilityResponse, session, cachedOptions]) => {
        const stateStatus = session.authenticated
          ? await loadClientStateStatus(isRefreshLoad)
          : null;
        const loadedFacilities = facilityResponse?.facilities ?? [];
        let loadedOptions = cachedOptions?.data;
        if (isRefreshLoad || !loadedOptions) {
          const optionsResponse = await fetch(
            "/api/compress/options",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                language,
              }),
            },
          );
          loadedOptions = (await optionsResponse.json()) as CompressOptions;
          if (!optionsResponse.ok) throw new Error("Could not load compression options.");
          await saveEndpointResponse("compress/options", "/api/compress/options", loadedOptions);
        }
        const rawLocations: CompressOption[] = [
          ...loadedFacilities.map((facility) => ({
            id: String(facility.id),
            name: facility.name,
            structureTypeId: facility.typeId,
            securityStatus: facility.securityStatus,
            rigs: facility.rigTypeIds.map((typeId) => String(typeId)),
            baseYield: (facility.activities.reprocessing.baseYield ?? 0) * 100,
            canReprocess: facility.activities.reprocessing.available,
          })),
        ].filter(
          (location, index, all) =>
            all.findIndex((candidate) => locationKey(candidate) === locationKey(location))
            === index,
        );
        const loadedLocations = rawLocations
          .map((location) => {
            const baseYield = location.baseYield ?? 50;
            return { ...location, rankBonus: baseYield - 50 };
          })
          .sort(
            (left, right) =>
              right.rankBonus - left.rankBonus
              || (left.name ?? left.id).localeCompare(right.name ?? right.id),
          );
        const normalizedSettings = {
          ...loadedSettings,
          items: Array.isArray(loadedSettings.items) ? loadedSettings.items : [],
          locationId: loadedLocations.some((location) => location.id === loadedSettings.locationId)
            ? loadedSettings.locationId
            : (loadedLocations[0]?.id ?? loadedSettings.locationId),
          marketId: marketHubs.some((market) => market.id === loadedSettings.marketId)
            ? loadedSettings.marketId
            : "jita",
        };
        const characters = loadedOptions.characters.map((character) => ({
          ...character,
          skills: Object.fromEntries(
            (
              stateStatus?.characters?.find(
                (status) => status.characterId === character.characterId,
              )?.skills?.body ?? []
            ).map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
          ),
        }));
        setOptions({ ...loadedOptions, characters, locations: loadedLocations });
        setSettings(normalizedSettings);
        setItems(normalizedSettings.items);
        void saveCompressSettings(normalizedSettings);
      })
      .catch(() => {
        optionsLoadKeyRef.current = "";
        setError("Could not load compression options.");
      });
  }, [language, optionsRefreshVersion]);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ rateLimitedUntil?: string | null }>).detail;
      if (!detail.rateLimitedUntil) setOptionsRefreshVersion((version) => version + 1);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, []);

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

  const locationOptions = options.locations;
  const selectedCharacter = options.characters.find(
    (character) => character.id === settings.characterId,
  );
  const selectedImplant =
    options.implants.find((implant) => implant.id === settings.implantId) ?? options.implants[0];
  const implantOptions = selectedCharacter
    ? options.implants.filter(
        (implant) =>
          implant.id === "none"
          || (implant.typeId !== undefined && selectedCharacter.implants.includes(implant.typeId)),
      )
    : options.implants;
  const skillLevels =
    settings.characterId === "all-zero"
      ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 0]))
      : settings.characterId === "all-iv"
        ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 4]))
        : settings.characterId === "all-v"
          ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 5]))
          : (selectedCharacter?.skills ?? {});

  useEffect(() => {
    if (!importedMultibuy || importedRef.current === `${language}:${importedMultibuy}`) return;
    importedRef.current = `${language}:${importedMultibuy}`;
    const parsed = importedMultibuy
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)\s+(\d+)$/);
        return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line };
      });
    if (!parsed.length) return;
    fetch(
      "/api/reference/types",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, items: parsed }),
      },
    )
      .then(async (response) => {
        const data = (await response.json()) as { items?: PasteResult[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Could not load the Buy list.");
        const resolved = (data.items ?? []).filter(
          (item): item is PasteResult & { typeId: number; quantity: number } =>
            Boolean(item.typeId && item.quantity && !item.error),
        );
        if (resolved.length !== parsed.length) {
          throw new Error("Every Buy item must be a published item name and quantity.");
        }
        updateItems(
          resolved.map(({ name, typeId, quantity, category }) => ({
            name,
            typeId,
            quantity,
            category,
          })),
        );
        setResult(null);
        setError("");
      })
      .catch((error) =>
        setError(error instanceof Error ? error.message : "Could not load the Buy list."),
      );
  }, [importedMultibuy, language]);

  function addItem(item: TypeResult) {
    updateItems((current) => {
      const existing = current.find((entry) => entry.typeId === item.typeId);
      return existing
        ? current.map((entry) =>
            entry.typeId === item.typeId ? { ...entry, quantity: entry.quantity + 1 } : entry,
          )
        : [...current, { ...item, quantity: 1 }];
    });
    setResult(null);
    setError("");
  }

  async function compress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (items.length === 0 || isLoading) return;
    setIsLoading(true);
    setError("");
    try {
      const selectedLocation = locationOptions.find(
        (location) => location.id === settings.locationId,
      );
      const response = await fetch(
        "/api/compress",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            items: items.map(({ typeId, name, quantity }) => ({ typeId, name, quantity })),
            structureTypeId: selectedLocation?.structureTypeId ?? 0,
            reprocessingRig: reprocessingRigLevel(selectedLocation?.rigs ?? []),
            skillLevels,
            implantLevel: selectedImplant.level,
            securityStatus: selectedLocation?.securityStatus,
            marketId:
              marketHubs.find((market) => market.id === settings.marketId)?.regionId
              ?? marketHubs[0].regionId,
            orderType: settings.orderType,
          }),
        },
      );
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? ((await response.json()) as CompressResult & { error?: string })
        : null;
      if (!response.ok) {
        throw new Error(data?.error ?? "The compression service is not available yet.");
      }
      if (!data) throw new Error("The compression service returned an invalid response.");
      setResult(data);
    }
    catch (error) {
      setError(error instanceof Error ? error.message : "Could not reach the compression service.");
    }
    finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>MATERIALS / REPROCESSING</p>
          <h1>Compress</h1>
          <p className={styles.subtitle}>
            Reverse-reprocess a raw material requirement into the smallest useful ore list.
          </p>
        </div>
        <div className={styles.introMark} aria-hidden="true">
          <Minimize2 size={30} />
        </div>
      </div>

      <form onSubmit={compress}>
        <section className={styles.inputPanel}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.kicker}>01 / REQUIREMENTS</p>
              <h2>Raw materials</h2>
            </div>
            <button
              type="button"
              className={`actionButton ${styles.secondaryButton}`}
              onClick={() => setIsPasteOpen(true)}
            >
              <Clipboard aria-hidden="true" />
              <span>Paste multibuy</span>
            </button>
          </div>
          <p className={styles.description}>
            Add the minerals you need, then find the compressed ores that can produce them.
          </p>
          <TypeSearch language={language} onSelect={addItem} />
          <div className={styles.compressOptions}>
            {locationOptions.length > 0 ? (
              <label>
                <span>LOCATION</span>
                <select
                  value={settings.locationId}
                  onChange={(event) => updateSettings({ locationId: event.target.value })}
                >
                  {locationOptions.map((location) => (
                    <option
                      value={location.id}
                      key={location.id}
                      disabled={location.canReprocess === false}
                    >
                      {location.name ?? `Location ${location.id}`}
                      {location.canReprocess === false ? " [No Reprocessing]" : ""} ·{" "}
                      {Math.round(location.baseYield ?? 50)}%
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className={styles.locationAlert} role="alert">
                <Info className={styles.locationAlertIcon} aria-hidden="true" />
                <div className={styles.locationAlertContent}>
                  <strong>No reprocessing locations found.</strong>
                  <span>
                    Add a reprocessing location on the <Link href="/locations">Locations</Link> page
                    or <Link href="/api/auth/eve/start">authenticate a character</Link> to find the
                    best location automatically.
                  </span>
                </div>
              </div>
            )}
            <label>
              <span>CHARACTER / SKILLS</span>
              <select
                value={settings.characterId}
                onChange={(event) =>
                  updateSettings({ characterId: event.target.value, implantId: "none" })
                }
              >
                <option value="all-zero">All zero</option>
                <option value="all-iv">All IV</option>
                <option value="all-v">All V</option>
                {options.characters.map((character) => (
                  <option value={character.id} key={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>IMPLANT</span>
              <select
                value={
                  implantOptions.some((implant) => implant.id === settings.implantId)
                    ? settings.implantId
                    : "none"
                }
                onChange={(event) => updateSettings({ implantId: event.target.value })}
              >
                {implantOptions.map((implant) => (
                  <option value={implant.id} key={implant.id}>
                    {implant.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>MARKET</span>
              <select
                value={settings.marketId}
                onChange={(event) => updateSettings({ marketId: event.target.value })}
              >
                {marketHubs.map((market) => (
                  <option value={market.id} key={market.id}>
                    {market.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>ORDER TYPE</span>
              <select
                value={settings.orderType}
                onChange={(event) =>
                  updateSettings({ orderType: event.target.value as CompressSettings["orderType"] })
                }
              >
                <option value="buy-1-day">Buy (1 Day)</option>
                <option value="buy-5-day">Buy (5 Day)</option>
                <option value="sell">Sell</option>
              </select>
            </label>
          </div>
          <div className={styles.listHeader}>
            <span>ITEM</span>
            <span>QUANTITY</span>
            <span />
          </div>
          {items.length === 0 ? (
            <div className={styles.empty}>
              Search for a mineral above to build your requirement.
            </div>
          ) : (
            items.map((item, index) => (
              <div className={styles.itemRow} key={item.typeId}>
                <TypeIdentity
                  name={item.name}
                  typeId={item.typeId}
                  variation={variation(item.category, item.imageVariation, item.name)}
                />
                <input
                  aria-label={`${item.name} quantity`}
                  type="number"
                  min="1"
                  step="1"
                  value={item.quantity}
                  onChange={(event) =>
                    updateItems((current) =>
                      current.map((entry, itemIndex) =>
                        itemIndex === index
                          ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) }
                          : entry,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className={styles.removeButton}
                  aria-label={`Remove ${item.name}`}
                  onClick={() =>
                    updateItems((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  ×
                </button>
              </div>
            ))
          )}
          {error && (
            <p className={styles.error} role="alert" aria-live="polite">
              {error}
            </p>
          )}
          <div className={styles.actionBar}>
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={items.length === 0 || isLoading}
            >
              <span className={styles.primaryButtonLead}>
                <Minimize2 size={16} aria-hidden="true" />
                <span>{isLoading ? "Compressing..." : "Compress"}</span>
              </span>
              <b aria-hidden="true">→</b>
            </button>
          </div>
        </section>
      </form>

      {result && <Results result={result} />}
      {isPasteOpen && (
        <PasteDialog
          language={language}
          currentItems={items}
          onCancel={() => setIsPasteOpen(false)}
          onReplace={(next) => {
            updateItems(next);
            setResult(null);
            setIsPasteOpen(false);
          }}
        />
      )}
    </>
  );
}

function TypeSearch({
  language,
  onSelect,
}: {
  language: SdeLanguage;
  onSelect: (item: TypeResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const requestId = useRef(0);
  useEffect(() => {
    if (query.trim().length < 2) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(
      () =>
        fetch(`/api/reference/types?query=${encodeURIComponent(query.trim())}&language=${language}`)
          .then((response) => response.json() as Promise<{ items?: TypeResult[] }>)
          .then((data) => {
            if (id === requestId.current) {
              setResults(data.items ?? []);
              setIsOpen(true);
            }
          })
          .catch(() => setResults([])),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [language, query]);
  function choose(item: TypeResult) {
    onSelect(item);
    setQuery("");
    setResults([]);
    setIsOpen(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") setIsOpen(false);
    if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      choose(results[0]);
    }
  }
  return (
    <div className={styles.searchWrap}>
      <div className={styles.search}>
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search minerals by name or type ID"
          aria-label="Search minerals"
        />
      </div>
      {isOpen && query.trim().length >= 2 && (
        <div className={styles.searchResults} role="listbox">
          {results.length ? (
            results.map((item) => (
              <div
                role="option"
                aria-selected="false"
                tabIndex={0}
                className={styles.searchResult}
                key={item.typeId}
                onMouseDown={() => choose(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(item);
                  }
                }}
              >
                <TypeIdentity
                  name={item.name}
                  typeId={item.typeId}
                  variation={variation(item.category)}
                />
              </div>
            ))
          ) : (
            <div className={styles.noResults}>No matching published items.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Results({ result }: { result: CompressResult }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isAddingToPlan, setIsAddingToPlan] = useState(false);
  const tabs = [
    { key: "efficiency", label: "Efficiency", note: "Reprocessing efficiencies used by the solve" },
    { key: "plan", label: "Plan", note: "Required materials and recovered quantities" },
    { key: "toBuy", label: "To buy", note: "Compressed ores and unrecoverable minerals" },
    { key: "surplus", label: "Surplus", note: "Recovered materials beyond the requirement" },
  ] as const;
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]["key"]>("efficiency");
  const active = tabs.find((tab) => tab.key === activeTab) ?? tabs[0];
  const efficiencyGroups = result.efficiencies?.groups ?? [];
  const items = active.key === "efficiency" ? [] : (result[active.key] ?? []);
  const itemCount = active.key === "efficiency" ? efficiencyGroups.length : items.length;
  const volumeOf = (quantity: number, item: ResultItem) => quantity * (item.packagedVolume ?? 0);
  const totalQuantity = Math.ceil(
    items.reduce((total, item) => total + volumeOf(item.quantity, item), 0),
  );
  const totalReprocessed = Math.ceil(
    items.reduce((total, item) => total + volumeOf(item.fromReprocessing ?? 0, item), 0),
  );
  const totalSurplus = Math.ceil(
    items.reduce((total, item) => total + volumeOf(item.surplus ?? 0, item), 0),
  );
  async function copyToBuyList() {
    try {
      await navigator.clipboard.writeText(
        items.map((item) => `${item.name}\t${item.quantity}`).join("\n"),
      );
      showToast("To Buy multibuy list copied");
    }
    catch {
      showToast("Could not copy To Buy multibuy list");
    }
  }
  async function addToPlan() {
    if (isAddingToPlan) return;
    setIsAddingToPlan(true);
    try {
      const additions = items.filter(
        (item): item is ResultItem & { typeId: number } =>
          item.typeId !== undefined && !item.ignored,
      );
      const existing = await loadBuildList();
      const next = [...existing];
      for (const item of additions) {
        const match = next.find((entry) => entry.typeId === item.typeId && entry.fromCompression);
        if (match) match.quantity += item.quantity;
        else {
          next.push({
            name: item.name,
            categoryName: "Unknown",
            typeId: item.typeId,
            quantity: item.quantity,
            me: 0,
            te: 0,
            fromCompression: true,
            ...(item.reprocessingEfficiency === undefined
              ? {}
              : { reprocessingEfficiency: item.reprocessingEfficiency }),
          });
        }
      }
      await saveBuildList(next);
      router.push("/planner");
    }
    catch {
      setIsAddingToPlan(false);
      showToast("Could not add compression items to the build plan");
    }
  }
  return (
    <section className={styles.results}>
      <div className={styles.resultsHeader}>
        <div>
          <p className={styles.kicker}>02 / OUTPUT</p>
          <h2>Compression result</h2>
        </div>
        <span className={styles.resultStamp}>SDE + ESI REPROCESSING</span>
      </div>
      <div className={styles.tabs}>
        {tabs.map((tab, index) => (
          <button
            type="button"
            key={tab.key}
            className={activeTab === tab.key ? styles.tabActive : ""}
            onClick={() => setActiveTab(tab.key)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {tab.label}
          </button>
        ))}
      </div>
      <div className={styles.resultPanel}>
        <div className={styles.resultPanelHeader}>
          <div>
            <h3>{active.label}</h3>
            <p>{active.note}</p>
          </div>
          <div className={styles.resultPanelActions}>
            {active.key === "toBuy" && items.length > 0 && (
              <button
                type="button"
                className={`actionButton ${styles.secondaryButton}`}
                onClick={() => void copyToBuyList()}
              >
                <Copy aria-hidden="true" />
                Copy multibuy
              </button>
            )}
            {active.key === "toBuy" && items.some((item) => !item.ignored) && (
              <button
                type="button"
                className={`actionButton ${styles.secondaryButton}`}
                onClick={() => void addToPlan()}
                disabled={isAddingToPlan}
              >
                <Upload aria-hidden="true" />
                Add to Plan
              </button>
            )}
            <strong>{itemCount}</strong>
          </div>
        </div>
        {active.key === "efficiency" ? (
          <EfficiencyTable efficiency={result.efficiencies} />
        ) : items.length ? (
          <>
            {active.key === "plan" && (
              <div className={styles.planTableHeader}>
                <span>Material</span>
                <span>Required</span>
                <span>Reprocessed</span>
                <span>Surplus</span>
              </div>
            )}
            <div className={styles.resultList}>
              {items.map((item) => (
                <div
                  className={`${styles.resultRow} ${active.key === "plan" ? styles.planResultRow : ""}`}
                  key={`${active.key}-${item.typeId ?? item.name}-${item.ignored ? "ignored" : "included"}`}
                >
                  <span>
                    {item.typeId ? (
                      <TypeIdentity
                        name={item.name}
                        typeId={item.typeId}
                        variation={resultVariation(item.name)}
                      />
                    ) : (
                      item.name
                    )}
                    {item.ignored && <small className={styles.ignoredBadge}>ignored</small>}
                  </span>
                  <strong data-label="Required">{item.quantity.toLocaleString()}</strong>
                  {active.key === "plan" && (
                    <>
                      <strong data-label="Reprocessed">
                        {item.fromReprocessing?.toLocaleString() ?? "0"}
                      </strong>
                      <strong data-label="Surplus">{item.surplus?.toLocaleString() ?? "0"}</strong>
                    </>
                  )}
                </div>
              ))}
              {active.key === "plan" ? (
                <div className={`${styles.resultRow} ${styles.planResultRow} ${styles.totalRow}`}>
                  <strong>Total volume (m3)</strong>
                  <strong data-label="Required">{totalQuantity.toLocaleString()}</strong>
                  <strong data-label="Reprocessed">{totalReprocessed.toLocaleString()}</strong>
                  <strong data-label="Surplus">{totalSurplus.toLocaleString()}</strong>
                </div>
              ) : active.key === "toBuy" ? (
                <div className={styles.totalRow}>
                  <strong>Total volume (m3)</strong>
                  <strong>{totalQuantity.toLocaleString()}</strong>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className={styles.emptyResult}>No entries returned.</div>
        )}
      </div>
    </section>
  );
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
  return (
    <div className={styles.efficiencyContent}>
      <div className={styles.efficiencySummary}>
        {summary.map(([name, value]) => (
          <div className={styles.efficiencyMetric} key={name}>
            <span>{name}</span>
            <strong>{value.toFixed(1)}%</strong>
          </div>
        ))}
      </div>
      <div className={styles.efficiencyTableHeader}>
        <span>Skill</span>
        <span>Ores</span>
        <span>Efficiency</span>
      </div>
      <div className={styles.resultList}>
        {efficiency.groups.map((group) => (
          <div className={styles.efficiencyRow} key={group.skillId ?? group.skillName}>
            <strong>{group.skillName}</strong>
            <span className={styles.marketCategories}>
              {group.marketCategories.map((category) => (
                <span className={styles.marketCategory} key={category.name}>
                  {category.typeId ? (
                    <Image
                      src={eveTypeImageUrl(category.typeId, "icon", 32)}
                      alt=""
                      width={20}
                      height={20}
                    />
                  ) : null}
                  <span>{category.name}</span>
                </span>
              ))}
            </span>
            <strong>{group.efficiency.toFixed(1)}%</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function PasteDialog({
  language,
  currentItems,
  onCancel,
  onReplace,
}: {
  language: SdeLanguage;
  currentItems: CompressItem[];
  onCancel: () => void;
  onReplace: (items: CompressItem[]) => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [error, setError] = useState("");
  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)\s+(\d+)$/);
        return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line };
      });
    if (!parsed.length) {
      setError("Paste at least one item and quantity.");
      return;
    }
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
      if (!response.ok) throw new Error(data.error ?? "Could not resolve the pasted list.");
      const resolved = (data.items ?? []).filter(
        (item): item is PasteResult & { typeId: number; quantity: number } =>
          Boolean(item.typeId && item.quantity && !item.error),
      );
      if (resolved.length !== parsed.length) {
        throw new Error("Every line must contain a published item name and quantity.");
      }
      const imported = resolved.map(({ name, typeId, quantity, category }) => ({
        name,
        typeId,
        quantity,
        category,
      }));
      if (mode === "add") {
        const merged = [...currentItems];
        for (const item of imported) {
          const existing = merged.find((entry) => entry.typeId === item.typeId);
          if (existing) existing.quantity += item.quantity;
          else merged.push(item);
        }
        onReplace(merged);
      }
      else onReplace(imported);
    }
    catch (resolveError) {
      setError(
        resolveError instanceof Error ? resolveError.message : "Could not resolve the pasted list.",
      );
    }
  }
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compress-paste-title"
        onSubmit={resolve}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.kicker}>BATCH IMPORT</p>
            <h2 id="compress-paste-title">Paste multibuy list</h2>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onCancel}
            aria-label="Close paste dialog"
          >
            ×
          </button>
        </div>
        <p className={styles.description}>
          Compatible with Eve Multibuy. One item per line, with the quantity at the end.
        </p>
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
          placeholder="Tritanium 120000\nPyerite 60000"
          aria-label="Multibuy list"
          spellCheck={false}
          autoFocus
        />
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.modeToggle} role="radiogroup" aria-label="Paste behavior">
          <label className={`${styles.choiceCard} ${mode === "add" ? styles.modeActive : ""}`}>
            <input
              type="radio"
              name="paste-behavior"
              value="add"
              checked={mode === "add"}
              onChange={() => setMode("add")}
            />
            <span className={styles.choiceCardContent}>
              <strong>Add to list</strong>
              <small>Keep the imported items with the current list.</small>
            </span>
          </label>
          <label className={`${styles.choiceCard} ${mode === "replace" ? styles.modeActive : ""}`}>
            <input
              type="radio"
              name="paste-behavior"
              value="replace"
              checked={mode === "replace"}
              onChange={() => setMode("replace")}
            />
            <span className={styles.choiceCardContent}>
              <strong>Replace list</strong>
              <small>Clear the current list before importing.</small>
            </span>
          </label>
        </div>
        <div className={styles.modalActions}>
          <button
            type="button"
            className={`actionButton ${styles.secondaryButton}`}
            onClick={onCancel}
          >
            <X aria-hidden="true" />
            Cancel
          </button>
          <button
            type="submit"
            className={`actionButton ${styles.primaryButton}`}
            disabled={!text.trim()}
          >
            <span className={styles.primaryButtonLead}>
              <FileUp aria-hidden="true" />
              <span>Import list</span>
            </span>
            <b aria-hidden="true">→</b>
          </button>
        </div>
      </form>
    </div>
  );
}
