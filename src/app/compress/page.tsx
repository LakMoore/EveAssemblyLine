"use client";

import { Suspense, type SubmitEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppLanguage } from "../AppShell";
import ActionButton from "@/components/ActionButton";
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
import { z } from "zod";

type CompressItem = CompressMaterial;
type TypeResult = Pick<CompressItem, "name" | "typeId" | "category">;
type PasteResult = TypeResult & { quantity?: number; error?: string };
type ResultItem = {
  name: string;
  typeId?: number;
  quantity: number;
  ignored: boolean;
  sellPrice?: number | null;
  sellTotal?: number | null;
  reprocessable?: boolean;
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
  marketName?: string;
  plan?: ResultItem[];
  toBuy?: ResultItem[];
  surplus?: ResultItem[];
  efficiencies?: EfficiencyResult;
  metrics?: {
    originalVolume: number;
    purchasedVolume: number;
    volumeLimit: number;
    originalCost: number;
    purchaseCost: number;
    surplusCredit: number;
    estimatedSavings: number;
  };
};

function formatIsk(value?: number | null) {
  return value === undefined || value === null
    ? "Unavailable"
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)} ISK`;
}

function formatVolume(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0, roundingMode: "ceil" });
}

const plannerCompressImportKey = "assemblyline:compress:planner-import";
const plannerCompressImportSchema = z.array(
  z
    .object({
      name: z.string().min(1),
      typeId: z.number().int().positive(),
      quantity: z.number().positive(),
      category: z.literal("item"),
    })
    .strict(),
);

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
  const [resultKey, setResultKey] = useState("");
  const [pasteDialogLoadKey, setPasteDialogLoadKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const compressionSettings = useCompressSettings(language);
  const { settings, updateSettings, selectedLocation, selectedImplant, skillLevels } =
    compressionSettings;
  const items = settings.items;
  const requestBody = selectedLocation
    ? {
        language,
        items: items.map(({ typeId, name, quantity }) => ({ typeId, name, quantity })),
        reprocessingProfile: createReprocessingProfile(
          selectedLocation,
          skillLevels,
          selectedImplant?.level ?? 0,
        ),
        marketId:
          marketHubs.find((market) => market.id === settings.marketId)?.regionId
          ?? marketHubs[0].regionId,
        orderType: settings.orderType,
      }
    : null;
  const requestKey = JSON.stringify(requestBody);
  const isPasteOpen =
    pasteDialogLoadKey === compressionSettings.loadKey && !compressionSettings.isLoading;
  const importedRef = useRef("");
  const plannerImportRef = useRef(false);

  useEffect(() => {
    if (!isPasteOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isPasteOpen]);

  function updateItems(nextItems: CompressItem[] | ((current: CompressItem[]) => CompressItem[])) {
    if (isLoading) return;
    updateSettings((current) => ({
      ...current,
      items: mergeCompressItems(
        typeof nextItems === "function" ? nextItems(current.items) : nextItems,
      ),
    }));
    setResult(null);
  }
  const updateItemsFromEffect = useEffectEvent(updateItems);
  const applyPlannerImportFromEffect = useEffectEvent((nextItems: CompressItem[]) => {
    if (isLoading) return;
    updateSettings((current) => ({ ...current, items: nextItems }));
    setResult(null);
    setError("");
  });

  useEffect(() => {
    if (
      compressionSettings.isLoading
      || !compressionSettings.isSettingsLoaded
      || isLoading
      || plannerImportRef.current
    ) return;
    plannerImportRef.current = true;

    let serializedItems: string | null;
    try {
      serializedItems = window.sessionStorage.getItem(plannerCompressImportKey);
      if (serializedItems) window.sessionStorage.removeItem(plannerCompressImportKey);
    }
    catch {
      queueMicrotask(() => {
        setError("Could not load planner materials for compression.");
      });
      return;
    }
    if (!serializedItems) return;

    let importedItems: unknown;
    try {
      importedItems = JSON.parse(serializedItems);
    }
    catch {
      queueMicrotask(() => {
        setError("Could not load planner materials for compression.");
      });
      return;
    }
    const parsedItems = plannerCompressImportSchema.safeParse(importedItems);
    if (!parsedItems.success) {
      queueMicrotask(() => {
        setError("Could not load planner materials for compression.");
      });
      return;
    }

    queueMicrotask(() => {
      applyPlannerImportFromEffect(parsedItems.data);
    });
  }, [compressionSettings.isLoading, compressionSettings.isSettingsLoaded, isLoading]);

  useEffect(() => {
    if (
      compressionSettings.isLoading
      || !compressionSettings.isSettingsLoaded
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
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : "Could not load the Buy list.");
      });
  }, [
    compressionSettings.isLoading,
    compressionSettings.isSettingsLoaded,
    importedMultibuy,
    language,
  ]);

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

  async function compress(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      compressionSettings.isLoading
      || compressionSettings.error
      || !selectedLocation
      || items.length === 0
      || isLoading
    ) return;
    setIsLoading(true);
    setResult(null);
    setError("");
    try {
      const response = await fetch(
        "/api/compress",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestKey,
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
      setResultKey(requestKey);
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

      <form onSubmit={(event) => void compress(event)}>
        <section className={styles.inputPanel}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.kicker}>01 / REQUIREMENTS</p>
              <h2>Raw materials</h2>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={compressionSettings.isLoading || isLoading}
              onClick={() => {
                setPasteDialogLoadKey(compressionSettings.loadKey);
              }}
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
            disabled={compressionSettings.isLoading || isLoading}
            placeholder="Search material by name or type ID"
            ariaLabel="Search minerals"
            onSelect={(item) => {
              addItem({
                ...item,
                category: item.category === "reactionformula" ? "item" : item.category,
              });
            }}
          />
          <CompressSettingsPanel
            state={isLoading ? { ...compressionSettings, isLoading: true } : compressionSettings}
            className={styles.compressOptions}
          />
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
                  disabled={compressionSettings.isLoading || isLoading}
                  type="number"
                  min="1"
                  step="1"
                  value={item.quantity}
                  onChange={(event) => {
                    updateItems((current) =>
                      current.map((entry, itemIndex) =>
                        itemIndex === index
                          ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) }
                          : entry,
                      ),
                    );
                  }}
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  aria-label={`Remove ${item.name}`}
                  disabled={compressionSettings.isLoading || isLoading}
                  onClick={() => {
                    updateItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
                  }}
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
            <ActionButton
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

      {result && resultKey === requestKey && (
        <Results
          result={result}
          inputItems={items}
          selectedLocation={selectedLocation}
          language={language}
          isBusy={compressionSettings.isLoading || isLoading}
          onRemoveIgnored={(typeIds) => {
            updateItems((current) => current.filter((item) => !typeIds.has(item.typeId)));
          }}
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
          onCancel={() => {
            setPasteDialogLoadKey(null);
          }}
          onImport={(next) => {
            if (
              compressionSettings.isLoading
              || isLoading
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
  inputItems,
  selectedLocation,
  language,
  isBusy,
  onRemoveIgnored,
}: {
  result: CompressResult;
  inputItems: readonly CompressItem[];
  selectedLocation: ReprocessingLocationOption | undefined;
  language: SdeLanguage;
  isBusy: boolean;
  onRemoveIgnored: (typeIds: ReadonlySet<number>) => void;
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
  const isBuyOrSurplusTab = active.key === "toBuy" || active.key === "surplus";
  const isSurplusTab = active.key === "surplus";
  const ignoredTypeIds = new Set(
    [...(result.plan ?? []), ...(result.toBuy ?? []), ...(result.surplus ?? [])].flatMap((item) =>
      item.ignored && item.typeId !== undefined ? [item.typeId] : [],
    ),
  );
  const ignoredInputTypeIds = new Set(
    inputItems.filter((item) => ignoredTypeIds.has(item.typeId)).map((item) => item.typeId),
  );
  const efficiencyGroups = result.efficiencies?.groups ?? [];
  const items = active.key === "efficiency" ? [] : (result[active.key] ?? []);
  const reprocessablePurchases = (result.toBuy ?? []).filter(
    (item): item is ResultItem & { typeId: number } =>
      item.typeId !== undefined && !item.ignored && item.reprocessable === true,
  );
  const itemCount = active.key === "efficiency" ? efficiencyGroups.length : items.length;
  const volumeOf = (quantity: number, item: ResultItem) => quantity * (item.packagedVolume ?? 0);
  const totalQuantity = items.reduce(
    (total, item) => total + (item.ignored ? 0 : volumeOf(item.quantity, item)),
    0,
  );
  const totalReprocessed = Math.ceil(
    items.reduce((total, item) => total + volumeOf(item.fromReprocessing ?? 0, item), 0),
  );
  const totalSurplus = Math.ceil(
    items.reduce((total, item) => total + volumeOf(item.surplus ?? 0, item), 0),
  );
  const totalSellValue = items.some(
    (item) => !item.ignored && (item.sellTotal === undefined || item.sellTotal === null),
  )
    ? null
    : items.reduce((total, item) => total + (item.ignored ? 0 : (item.sellTotal ?? 0)), 0);
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
    if (isAddingToPlan || reprocessablePurchases.length === 0) return;
    setIsAddingToPlan(true);
    try {
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
      const compressedItems: ClientBuildItem[] = reprocessablePurchases.map((item) => ({
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
        <span className={styles.resultStamp}>
          SDE + ESI REPROCESSING · {result.marketName ?? "Selected market"}
        </span>
      </div>
      {result.metrics && result.metrics.originalVolume > 0 && (
        <dl className="grid gap-3 border-y py-3 sm:grid-cols-2 xl:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">Original cargo</dt>
            <dd className="tabular-nums">{formatVolume(result.metrics.originalVolume)} m³</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">
              To buy (
              {result.metrics.originalVolume - result.metrics.volumeLimit < 0.00001
                ? `less than ${formatVolume(result.metrics.originalVolume)} m³`
                : `max ${result.metrics.volumeLimit.toLocaleString(undefined, { maximumFractionDigits: 9, roundingMode: "floor" })} m³`}
              )
            </dt>
            <dd className="tabular-nums">{formatVolume(result.metrics.purchasedVolume)} m³</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Original purchase estimate</dt>
            <dd className="tabular-nums">{formatIsk(result.metrics.originalCost)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Purchase estimate</dt>
            <dd className="tabular-nums">{formatIsk(result.metrics.purchaseCost)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Purchase savings</dt>
            <dd className="tabular-nums">{formatIsk(result.metrics.estimatedSavings)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">
              Savings including surplus bids (estimate)
            </dt>
            <dd className="tabular-nums">
              {formatIsk(result.metrics.estimatedSavings + result.metrics.surplusCredit)}
            </dd>
          </div>
        </dl>
      )}
      {result.metrics && result.surplus?.some((item) => !item.ignored && item.quantity > 0) && (
        <p className="text-sm text-muted-foreground">
          Additional surplus bid estimate: {formatIsk(result.metrics.surplusCredit)}. Not included
          in purchase savings;{" "}
          {result.metrics.surplusCredit === 0
            ? "no station bids cover this surplus."
            : "actual sales and fees may differ."}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={isBusy || ignoredInputTypeIds.size === 0}
          onClick={() => {
            onRemoveIgnored(ignoredInputTypeIds);
          }}
        >
          <Trash2 aria-hidden="true" />
          Remove Ignored
        </Button>
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value as (typeof tabs)[number]["key"]);
        }}
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
            onValueChange={(value) => {
              setActiveTab(value as (typeof tabs)[number]["key"]);
            }}
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
                <p>
                  {active.note}
                  {active.key === "plan"
                    && ` Sell orders at ${result.marketName ?? "the selected market"}.`}
                  {active.key === "toBuy"
                    && ` Estimated purchase prices at ${result.marketName ?? "the selected market"}.`}
                  {active.key === "surplus"
                    && ` Indicative buy-order bids at ${result.marketName ?? "the selected market"}.`}
                </p>
              </div>
              <div className={styles.resultPanelActions}>
                {active.key === "toBuy" && items.length > 0 && (
                  <Button type="button" variant="outline" onClick={() => void copyToBuyList()}>
                    <Copy aria-hidden="true" />
                    Copy multibuy
                  </Button>
                )}
                {active.key === "toBuy" && reprocessablePurchases.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void addToPlan()}
                    disabled={isBusy || isAddingToPlan}
                  >
                    <Upload aria-hidden="true" />
                    Add Compressed to Plan
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
                    <span>Sell value</span>
                  </div>
                )}
                {isBuyOrSurplusTab && (
                  <div className={styles.toBuyTableHeader}>
                    <span>Item</span>
                    <span>Quantity</span>
                    <span>{isSurplusTab ? "Bid estimate" : "Purchase estimate"}</span>
                  </div>
                )}
                <div className={styles.resultList}>
                  {items.map((item) => (
                    <div
                      className={`${styles.resultRow} ${active.key === "plan" ? styles.planResultRow : isBuyOrSurplusTab ? styles.toBuyResultRow : ""}`}
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
                      <strong data-label={active.key === "plan" ? "Required" : "Quantity"}>
                        {item.quantity.toLocaleString()}
                      </strong>
                      {active.key === "plan" && (
                        <>
                          <strong data-label="Reprocessed">
                            {item.fromReprocessing?.toLocaleString() ?? "0"}
                          </strong>
                          <strong data-label="Surplus">
                            {item.surplus?.toLocaleString() ?? "0"}
                          </strong>
                          <strong data-label="Sell value">{formatIsk(item.sellTotal)}</strong>
                        </>
                      )}
                      {isBuyOrSurplusTab && (
                        <strong data-label={isSurplusTab ? "Bid estimate" : "Purchase estimate"}>
                          {formatIsk(item.sellTotal)}
                        </strong>
                      )}
                    </div>
                  ))}
                  {active.key === "plan" ? (
                    <div
                      className={`${styles.resultRow} ${styles.planResultRow} ${styles.totalRow}`}
                    >
                      <strong className={styles.totalLabel}>
                        Total volume (m<sup>3</sup>)
                      </strong>
                      <strong data-label="Required volume (m³)">
                        {formatVolume(totalQuantity)}
                      </strong>
                      <strong data-label="Reprocessed volume (m³)">
                        {totalReprocessed.toLocaleString()}
                      </strong>
                      <strong data-label="Surplus volume (m³)">
                        {totalSurplus.toLocaleString()}
                      </strong>
                      <strong data-label="Sell value">{formatIsk(totalSellValue)}</strong>
                    </div>
                  ) : isBuyOrSurplusTab ? (
                    <div
                      className={`${styles.resultRow} ${styles.toBuyResultRow} ${styles.totalRow}`}
                    >
                      <strong className={styles.totalLabel}>
                        {isSurplusTab ? "Total surplus volume (m" : "Total volume (m"}
                        <sup>3</sup>)
                      </strong>
                      <strong data-label="Volume (m³)">{formatVolume(totalQuantity)}</strong>
                      <strong data-label={isSurplusTab ? "Bid estimate" : "Purchase estimate"}>
                        {formatIsk(totalSellValue)}
                      </strong>
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
