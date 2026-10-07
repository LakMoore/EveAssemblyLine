"use client";

import { FormEvent, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppLanguage } from "../AppShell";
import CalculateButton from "@/components/CalculateButton";
import PasteListDialog from "@/components/PasteListDialog";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import TypeSearch from "@/components/TypeSearch";
import {
  CompressSettingsPanel,
  mergeCompressItems,
  useCompressSettings,
  type ReprocessingLocationOption,
} from "@/components/CompressSettingsPanel";
import { toast } from "@/components/ui/toast";
import type { SdeLanguage } from "@/lib/reference/languages";
import {
  Clipboard,
  ClipboardList,
  Copy,
  Gauge,
  Minimize2,
  PackageOpen,
  ShoppingCart,
  Trash2,
  Upload,
} from "lucide-react";
import Image from "next/image";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { trackAnalyticsEvent } from "@/lib/client/analyticsConsent";
import { type CompressMaterial } from "@/lib/planning/compressSettingsStore";
import {
  loadPlannerStockpiles,
  savePlannerStockpiles,
} from "@/lib/planning/plannerStockpilesStore";
import type { ClientBuildItem, ClientPlanStockpile } from "@/lib/planning/types";
import { refreshPlannerStockpileEfficiencies } from "@/lib/planning/reprocessingClient";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { createReprocessingProfile } from "@/lib/planning/reprocessingProfile";

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
  const [result, setResult] = useState<CompressResult | null>(null);
  const [pasteDialogLoadKey, setPasteDialogLoadKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const compressionSettings = useCompressSettings(language);
  const { settings, updateSettings, selectedLocation, selectedImplant, skillLevels } =
    compressionSettings;
  const items = settings.items;
  const isPasteOpen =
    pasteDialogLoadKey === compressionSettings.loadKey && !compressionSettings.isLoading;
  const importedRef = useRef("");

  useEffect(() => {
    if (!isPasteOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isPasteOpen]);

  function updateItems(nextItems: CompressItem[] | ((current: CompressItem[]) => CompressItem[])) {
    updateSettings((current) => ({
      ...current,
      items: mergeCompressItems(
        typeof nextItems === "function" ? nextItems(current.items) : nextItems,
      ),
    }));
  }
  const updateItemsFromEffect = useEffectEvent(updateItems);

  useEffect(() => {
    if (
      compressionSettings.isLoading
      || !importedMultibuy
      || importedRef.current === `${language}:${importedMultibuy}`
    ) return;
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
        updateItemsFromEffect(
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
  }, [compressionSettings.isLoading, importedMultibuy, language]);

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
    if (
      compressionSettings.isLoading
      || compressionSettings.error
      || !selectedLocation
      || items.length === 0
      || isLoading
    ) return;
    setIsLoading(true);
    setError("");
    try {
      const reprocessingProfile = createReprocessingProfile(
        selectedLocation,
        skillLevels,
        selectedImplant?.level ?? 0,
      );
      const response = await fetch(
        "/api/compress",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            items: items.map(({ typeId, name, quantity }) => ({ typeId, name, quantity })),
            reprocessingProfile,
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
      trackAnalyticsEvent("compress", { outcome: "success" });
    }
    catch (error) {
      trackAnalyticsEvent("compress", { outcome: "failure" });
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
            <Button
              type="button"
              variant="outline"
              disabled={compressionSettings.isLoading}
              onClick={() => setPasteDialogLoadKey(compressionSettings.loadKey)}
            >
              <Clipboard aria-hidden="true" />
              <span>Paste multibuy</span>
            </Button>
          </div>
          <p className={styles.description}>
            Add the minerals you need, then find the compressed ores that can produce them.
          </p>
          <TypeSearch
            language={language}
            disabled={compressionSettings.isLoading}
            placeholder="Search material by name or type ID"
            ariaLabel="Search minerals"
            onSelect={(item) =>
              addItem({
                ...item,
                category: item.category === "reactionformula" ? "item" : item.category,
              })
            }
          />
          <CompressSettingsPanel state={compressionSettings} className={styles.compressOptions} />
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
                  disabled={compressionSettings.isLoading}
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
                  disabled={compressionSettings.isLoading}
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
              disabled={
                compressionSettings.isLoading
                || Boolean(compressionSettings.error)
                || !selectedLocation
                || items.length === 0
                || isLoading
              }
              icon={Minimize2}
              isLoading={isLoading}
              label="Compress"
              loadingLabel="Compressing..."
            />
          </div>
        </section>
      </form>

      {result && (
        <Results
          result={result}
          selectedLocation={selectedLocation}
          language={language}
          isSettingsLoading={compressionSettings.isLoading}
        />
      )}
      {isPasteOpen && (
        <PasteListDialog
          language={language}
          title="BATCH IMPORT"
          description="Compatible with Eve Multibuy. One item per line, with the quantity at the end."
          placeholder={`Tritanium 120000
Pyerite 60000`}
          ariaLabel="Multibuy list"
          currentItems={items}
          onCancel={() => setPasteDialogLoadKey(null)}
          onImport={(next) => {
            if (
              compressionSettings.isLoading
              || pasteDialogLoadKey !== compressionSettings.loadKey
            ) return;
            updateItems(
              next.map((item) => ({
                name: item.name,
                typeId: item.typeId,
                quantity: item.quantity ?? 1,
                category: item.category as CompressItem["category"],
              })),
            );
            setResult(null);
            setPasteDialogLoadKey(null);
          }}
        />
      )}
    </>
  );
}

function Results({
  result,
  selectedLocation,
  language,
  isSettingsLoading,
}: {
  result: CompressResult;
  selectedLocation: ReprocessingLocationOption | undefined;
  language: SdeLanguage;
  isSettingsLoading: boolean;
}) {
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
      const locationId = Number(selectedLocation?.id);
      if (!Number.isSafeInteger(locationId) || locationId <= 0 || !selectedLocation) {
        throw new Error("Select a reprocessing location before adding the results to a plan.");
      }
      const existingStockpiles = (await loadPlannerStockpiles()) ?? [];
      const autoStockpile = existingStockpiles.find(
        (stockpile) =>
          stockpile.kind === "special"
          && stockpile.name === "Compressed inputs (auto)"
          && stockpile.locations.stock === locationId
          && stockpile.locations.reprocessing === locationId,
      );
      const compressedItems: ClientBuildItem[] = additions.map((item) => ({
        name: item.name,
        categoryName: "Unknown",
        typeId: item.typeId,
        quantity: item.quantity,
        me: 0,
        te: 0,
        fromCompression: true,
        isIncluded: true,
      }));
      const nextStockpile: ClientPlanStockpile = autoStockpile
        ? {
            ...autoStockpile,
            items: mergeCompressedPlanItems(autoStockpile.items, compressedItems),
          }
        : {
            id: `stockpile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: "Compressed inputs (auto)",
            kind: "special",
            stockLocationName: selectedLocation.name,
            locations: {
              stock: locationId,
              manufacturing: locationId,
              reactions: locationId,
              reprocessing: locationId,
              copying: locationId,
              invention: locationId,
            },
            items: compressedItems,
          };
      const nextStockpiles = autoStockpile
        ? existingStockpiles.map((stockpile) =>
            stockpile.id === autoStockpile.id ? nextStockpile : stockpile,
          )
        : [...existingStockpiles, nextStockpile];
      const [savedStockpile] = await refreshPlannerStockpileEfficiencies(
        language,
        [nextStockpile],
        true,
      );
      const enrichedStockpiles = nextStockpiles.map((stockpile) =>
        stockpile.id === savedStockpile.id ? savedStockpile : stockpile,
      );
      await savePlannerStockpiles(enrichedStockpiles);
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
      <div className="flex items-center justify-between max-[640px]:flex-col max-[640px]:items-start max-[640px]:gap-3.5">
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
                    disabled={isSettingsLoading || isAddingToPlan}
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
                      <strong>
                        Total volume (m<sup>3</sup>)
                      </strong>
                      <strong data-label="Required">{totalQuantity.toLocaleString()}</strong>
                      <strong data-label="Reprocessed">{totalReprocessed.toLocaleString()}</strong>
                      <strong data-label="Surplus">{totalSurplus.toLocaleString()}</strong>
                    </div>
                  ) : active.key === "toBuy" ? (
                    <div className={styles.totalRow}>
                      <strong>
                        Total volume (m<sup>3</sup>)
                      </strong>
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

function mergeCompressedPlanItems(
  existingItems: ClientBuildItem[],
  additions: ClientBuildItem[],
): ClientBuildItem[] {
  const merged = existingItems.map((item) => ({ ...item }));
  for (const addition of additions) {
    const existing = merged.find((item) => item.typeId === addition.typeId && item.fromCompression);
    if (existing) existing.quantity += addition.quantity;
    else merged.push(addition);
  }
  return merged;
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
