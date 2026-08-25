"use client";

import { FormEvent, KeyboardEvent, Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAppLanguage } from "../AppShell";
import CalculateButton from "@/components/CalculateButton";
import DialogBody from "@/components/DialogBody";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import TypeSearch from "@/components/TypeSearch";
import { toast } from "@/components/ui/toast";
import type { SdeLanguage } from "@/lib/reference/languages";
import {
  Clipboard,
  ClipboardList,
  Copy,
  FileUp,
  Gauge,
  Info,
  Minimize2,
  PackageOpen,
  ShoppingCart,
  Trash2,
  Upload,
  X,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const selectedLocation = locationOptions.find((location) => location.id === settings.locationId);
  const selectedCharacter = options.characters.find(
    (character) => character.id === settings.characterId,
  );
  const selectedImplant = options.implants.find((implant) => implant.id === settings.implantId);
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
            implantLevel: selectedImplant?.level ?? 0,
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
          <p className="eyebrow">MATERIALS / REPROCESSING</p>
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
            <Button type="button" variant="outline" onClick={() => setIsPasteOpen(true)}>
              <Clipboard aria-hidden="true" />
              <span>Paste multibuy</span>
            </Button>
          </div>
          <p className={styles.description}>
            Add the minerals you need, then find the compressed ores that can produce them.
          </p>
          <TypeSearch
            language={language}
            placeholder="Search material by name or type ID"
            ariaLabel="Search minerals"
            onSelect={(item) =>
              addItem({
                ...item,
                category: item.category === "reactionformula" ? "item" : item.category,
              })
            }
          />
          <div className={styles.compressOptions}>
            {locationOptions.length > 0 ? (
              <Label className="flex-col items-start gap-1.5">
                <span className="text-muted-foreground text-xs">LOCATION</span>
                <Select
                  value={settings.locationId}
                  onValueChange={(value) => value && updateSettings({ locationId: value })}
                  items={locationOptions.map((location) => ({
                    value: location.id,
                    label: `${location.name ?? `Location ${location.id}`}${location.canReprocess === false ? " [No Reprocessing]" : ""} · ${Math.round(location.baseYield ?? 50)}%`,
                    disabled: location.canReprocess === false,
                  }))}
                >
                  <SelectTrigger className="w-full" aria-label="Reprocessing location">
                    <SelectValue className={styles.selectValue}>
                      <span className={styles.selectName}>
                        {selectedLocation?.name ?? `Location ${settings.locationId}`}
                      </span>
                      <span className={styles.selectBonus}>
                        {Math.round(selectedLocation?.baseYield ?? 50)}%
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className={styles.locationSelectContent}>
                    <SelectGroup>
                      {locationOptions.map((location) => (
                        <SelectItem
                          value={location.id}
                          key={location.id}
                          className={styles.locationSelectItem}
                          disabled={location.canReprocess === false}
                        >
                          {location.name ?? `Location ${location.id}`}
                          {location.canReprocess === false ? " [No Reprocessing]" : ""} ·{" "}
                          {Math.round(location.baseYield ?? 50)}%
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Label>
            ) : (
              <Alert>
                <Info aria-hidden="true" />
                <AlertTitle>No reprocessing locations found.</AlertTitle>
                <AlertDescription>
                  Add a reprocessing location on the <Link href="/locations">Locations</Link> page
                  or <Link href="/api/auth/eve/start">authenticate a character</Link> to find the
                  best location automatically.
                </AlertDescription>
              </Alert>
            )}
            <Label className="flex-col items-start gap-1.5">
              <span className="text-muted-foreground text-xs">CHARACTER / SKILLS</span>
              <Select
                value={settings.characterId}
                onValueChange={(value) =>
                  value && updateSettings({ characterId: value, implantId: "none" })
                }
                items={[
                  { value: "all-zero", label: "All zero" },
                  { value: "all-iv", label: "All IV" },
                  { value: "all-v", label: "All V" },
                  ...options.characters.map((character) => ({
                    value: character.id,
                    label: character.name,
                  })),
                ]}
              >
                <SelectTrigger className="w-full" aria-label="Character skills">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all-zero">All zero</SelectItem>
                    <SelectItem value="all-iv">All IV</SelectItem>
                    <SelectItem value="all-v">All V</SelectItem>
                    {options.characters.map((character) => (
                      <SelectItem value={character.id} key={character.id}>
                        {character.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Label>
            <Label className="flex-col items-start gap-1.5">
              <span className="text-muted-foreground text-xs">IMPLANT</span>
              <Select
                value={
                  implantOptions.some((implant) => implant.id === settings.implantId)
                    ? settings.implantId
                    : "none"
                }
                onValueChange={(value) => value && updateSettings({ implantId: value })}
                items={implantOptions.map((implant) => ({
                  value: implant.id,
                  label: implant.name,
                }))}
              >
                <SelectTrigger className="w-full" aria-label="Reprocessing implant">
                  <SelectValue className={styles.selectValue}>
                    <span className={styles.selectName}>
                      {selectedImplant?.name ?? "No implant"}
                    </span>
                    <span className={styles.selectBonus}>+{selectedImplant?.level ?? 0}%</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {implantOptions.map((implant) => (
                      <SelectItem value={implant.id} key={implant.id}>
                        {implant.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Label>
            <Label className="flex-col items-start gap-1.5">
              <span className="text-muted-foreground text-xs">MARKET</span>
              <Select
                value={settings.marketId}
                onValueChange={(value) => value && updateSettings({ marketId: value })}
                items={marketHubs.map((market) => ({
                  value: market.id,
                  label: market.name,
                }))}
              >
                <SelectTrigger className="w-full" aria-label="Market hub">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {marketHubs.map((market) => (
                      <SelectItem value={market.id} key={market.id}>
                        {market.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Label>
            <Label className="flex-col items-start gap-1.5">
              <span className="text-muted-foreground text-xs">ORDER TYPE</span>
              <Select
                value={settings.orderType}
                onValueChange={(value) =>
                  value && updateSettings({ orderType: value as CompressSettings["orderType"] })
                }
                items={[
                  { value: "buy-1-day", label: "Buy (1 Day)" },
                  { value: "buy-5-day", label: "Buy (5 Day)" },
                  { value: "sell", label: "Sell" },
                ]}
              >
                <SelectTrigger className="w-full" aria-label="Order type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="buy-1-day">Buy (1 Day)</SelectItem>
                    <SelectItem value="buy-5-day">Buy (5 Day)</SelectItem>
                    <SelectItem value="sell">Sell</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Label>
          </div>
          <div className={styles.listHeader}>
            <span>ITEM</span>
            <span>QUANTITY</span>
            <span />
          </div>
          {items.length === 0 ? (
            <Empty>
              <EmptyDescription>
                Search for a mineral above to build your requirement.
              </EmptyDescription>
            </Empty>
          ) : (
            items.map((item, index) => (
              <div className={styles.itemRow} key={item.typeId}>
                <TypeIdentity
                  name={item.name}
                  typeId={item.typeId}
                  variation={variation(item.category, item.imageVariation, item.name)}
                />
                <Input
                  className="text-right"
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
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  aria-label={`Remove ${item.name}`}
                  onClick={() =>
                    updateItems((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className={styles.actionBar}>
            <CalculateButton
              type="submit"
              disabled={items.length === 0 || isLoading}
              icon={Minimize2}
              isLoading={isLoading}
              label="Compress"
              loadingLabel="Compressing..."
            />
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

function Results({ result }: { result: CompressResult }) {
  const router = useRouter();
  const [isAddingToPlan, setIsAddingToPlan] = useState(false);
  const tabs = [
    {
      key: "efficiency",
      label: "Efficiency",
      note: "Reprocessing efficiencies used by the solve",
      icon: Gauge,
    },
    {
      key: "plan",
      label: "Plan",
      note: "Required materials and recovered quantities",
      icon: ClipboardList,
    },
    {
      key: "toBuy",
      label: "To buy",
      note: "Compressed ores and unrecoverable minerals",
      icon: ShoppingCart,
    },
    {
      key: "surplus",
      label: "Surplus",
      note: "Recovered materials beyond the requirement",
      icon: PackageOpen,
    },
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
      toast.add({ description: "To Buy multibuy list copied" });
    }
    catch {
      toast.add({ description: "Could not copy To Buy multibuy list", type: "error" });
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
      toast.add({
        description: "Could not add compression items to the build plan",
        type: "error",
      });
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
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as (typeof tabs)[number]["key"])}
      >
        <TabsList className={styles.resultTabs} variant="line">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              <tab.icon data-icon="inline-start" aria-hidden="true" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className={styles.resultViewSelect}>
          <Label htmlFor="compress-result-view" className="shrink-0">
            View
          </Label>
          <Select
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as (typeof tabs)[number]["key"])}
          >
            <SelectTrigger
              id="compress-result-view"
              className="min-w-36 *:data-[slot=select-value]:gap-2"
              aria-label="Compression result view"
            >
              <SelectValue>
                <active.icon data-icon="inline-start" aria-hidden="true" />
                {active.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {tabs.map((tab) => (
                  <SelectItem key={tab.key} value={tab.key}>
                    <tab.icon data-icon="inline-start" aria-hidden="true" className="self-center" />
                    {tab.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <TabsContent value={activeTab}>
          <div className={styles.resultPanel}>
            <div className={styles.resultPanelHeader}>
              <div>
                <h3>{active.label}</h3>
                <p>{active.note}</p>
              </div>
              <div className={styles.resultPanelActions}>
                {active.key === "toBuy" && items.length > 0 && (
                  <Button type="button" variant="outline" onClick={() => void copyToBuyList()}>
                    <Copy aria-hidden="true" />
                    Copy multibuy
                  </Button>
                )}
                {active.key === "toBuy" && items.some((item) => !item.ignored) && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void addToPlan()}
                    disabled={isAddingToPlan}
                  >
                    <Upload aria-hidden="true" />
                    Add to Plan
                  </Button>
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
                          <strong data-label="Surplus">
                            {item.surplus?.toLocaleString() ?? "0"}
                          </strong>
                        </>
                      )}
                    </div>
                  ))}
                  {active.key === "plan" ? (
                    <div
                      className={`${styles.resultRow} ${styles.planResultRow} ${styles.totalRow}`}
                    >
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
              <Empty>
                <EmptyDescription>No entries returned.</EmptyDescription>
              </Empty>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

function EfficiencyTable({ efficiency }: { efficiency?: EfficiencyResult }) {
  if (!efficiency) {
    return (
      <Empty>
        <EmptyDescription>No efficiency data returned.</EmptyDescription>
      </Empty>
    );
  }
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
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent render={<form onSubmit={resolve} />}>
        <DialogHeader>
          <DialogTitle>BATCH IMPORT</DialogTitle>
          <DialogDescription>
            Compatible with Eve Multibuy. One item per line, with the quantity at the end.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Textarea
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
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <RadioGroup
            className="mt-4 sm:grid-cols-2"
            value={mode}
            onValueChange={(value) => setMode(value as "add" | "replace")}
            aria-label="Paste behavior"
          >
            <label className="flex items-start gap-2">
              <RadioGroupItem value="add" />
              <span className="grid min-w-0 gap-1">
                <span className="text-sm font-medium">Add to list</span>
                <span className="text-muted-foreground text-xs">
                  Keep the imported items with the current list.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <RadioGroupItem value="replace" />
              <span className="grid min-w-0 gap-1">
                <span className="text-sm font-medium">Replace list</span>
                <span className="text-muted-foreground text-xs">
                  Clear the current list before importing.
                </span>
              </span>
            </label>
          </RadioGroup>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            <X aria-hidden="true" />
            Cancel
          </Button>
          <Button type="submit" disabled={!text.trim()}>
            <span className="flex min-w-0 items-center gap-1.5 text-left">
              <FileUp aria-hidden="true" />
              <span>Import list</span>
            </span>
            <b aria-hidden="true">→</b>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
