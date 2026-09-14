"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { BadgeDollarSign, ClipboardPaste, List, Trash2 } from "lucide-react";
import { useAppLanguage } from "../AppShell";
import CalculateButton from "@/components/CalculateButton";
import PasteListDialog from "@/components/PasteListDialog";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import TypeSearch, { type TypeSearchResult } from "@/components/TypeSearch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import styles from "../page.module.css";
import { Label } from "@/components/ui/label";

type AppraiseItem = {
  name: string;
  typeId?: number;
  quantity: number;
  prices: AppraisalPrices;
  price?: number;
  unitVolume?: number;
  volume?: number;
  total?: number;
  error?: string;
};

type AppraisalPrices = {
  fivePercentSellPrice: number | null;
  minSellPrice: number | null;
  splitPrice: number | null;
  maxBuyPrice: number | null;
  fivePercentBuyPrice: number | null;
};

type AppraisalTotals = {
  volume: number;
  prices: AppraisalPrices;
};

type AppraiseInputItem = {
  name: string;
  typeId: number;
  quantity: number;
};

type AppraiseResponse = {
  market?: string;
  items?: AppraiseItem[];
  totals?: AppraisalTotals;
  error?: string;
};

function formatIsk(value?: number | null) {
  return value === undefined || value === null
    ? "-"
    : `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(value)} ISK`;
}

function PriceMetric({ label, value }: { label: string; value?: number | null }) {
  const formattedValue = formatIsk(value);
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="text-sm font-medium break-all" title={formattedValue}>
        {formattedValue}
      </strong>
    </div>
  );
}

export default function AppraisePage() {
  const { language } = useAppLanguage();
  const [inputItems, setInputItems] = useState<AppraiseInputItem[]>([]);
  const [items, setItems] = useState<AppraiseItem[]>([]);
  const [totals, setTotals] = useState<AppraisalTotals | null>(null);
  const [market, setMarket] = useState("Jita");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const [showTotalValues, setShowTotalValues] = useState(false);
  const appraisalRequestId = useRef(0);
  const currentLanguage = useRef(language);
  const languageGeneration = useRef(0);

  useEffect(() => {
    currentLanguage.current = language;
    languageGeneration.current += 1;
    appraisalRequestId.current += 1;
    startTransition(() => {
      setItems([]);
      setTotals(null);
      setError("");
      setIsLoading(false);
    });
  }, [language]);

  function invalidateAppraisal() {
    appraisalRequestId.current += 1;
    setItems([]);
    setTotals(null);
    setError("");
    setIsLoading(false);
  }

  async function appraiseItems() {
    if (inputItems.length === 0) {
      setError("Add at least one item.");
      return;
    }
    const requestId = ++appraisalRequestId.current;
    const requestLanguage = language;
    const requestLanguageGeneration = languageGeneration.current;
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(
        "/api/appraise",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language, marketId: market.toLowerCase(), items: inputItems }),
        },
      );
      const data = (await response.json()) as AppraiseResponse;
      if (!response.ok) throw new Error(data.error ?? "Could not appraise this list.");
      if (
        requestId !== appraisalRequestId.current
        || requestLanguage !== currentLanguage.current
        || requestLanguageGeneration !== languageGeneration.current
      ) {
        return;
      }
      setItems(data.items ?? []);
      setTotals(data.totals ?? null);
    }
    catch (caughtError) {
      if (
        requestId !== appraisalRequestId.current
        || requestLanguage !== currentLanguage.current
        || requestLanguageGeneration !== languageGeneration.current
      ) {
        return;
      }
      setError(
        caughtError instanceof Error ? caughtError.message : "Could not appraise this list.",
      );
      setItems([]);
      setTotals(null);
    }
    finally {
      if (requestId === appraisalRequestId.current) setIsLoading(false);
    }
  }

  const appraisalPrices = totals?.prices;
  const valueColumnLabel = showTotalValues ? "Total value" : "Unit price";
  const volumeColumnLabel = showTotalValues ? "Total volume" : "Unit volume";

  function addItem(item: TypeSearchResult) {
    setInputItems((current) => {
      const existing = current.find((entry) => entry.typeId === item.typeId);
      if (existing) {
        return current.map((entry) =>
          entry.typeId === item.typeId ? { ...entry, quantity: entry.quantity + 1 } : entry,
        );
      }
      return [{ name: item.name, typeId: item.typeId, quantity: 1 }, ...current];
    });
    invalidateAppraisal();
  }

  return (
    <div className={styles.appraisePage}>
      <div className={styles.pageIntro}>
        <span className="eyebrow">TOOLS / APPRAISE</span>
        <h1>Appraise an item list</h1>
        <p>
          Build or paste an EVE item list, check current sell prices and total its ISK value and
          volume.
        </p>
      </div>
      <section className={styles.appraiseTool}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Field>
            <FieldLabel htmlFor="appraise-item-search">Item list</FieldLabel>
          </Field>
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            <div className="flex shrink-0 items-center gap-2">
              <FieldLabel htmlFor="appraise-market">Market</FieldLabel>
              <Select
                value={market}
                onValueChange={(value) => {
                  if (!value) return;
                  setMarket(value);
                  invalidateAppraisal();
                }}
                items={[
                  { value: "Jita", label: "Jita" },
                  { value: "Amarr", label: "Amarr" },
                  { value: "Hek", label: "Hek" },
                  { value: "Dodixie", label: "Dodixie" },
                  { value: "Rens", label: "Rens" },
                ]}
              >
                <SelectTrigger id="appraise-market" className="min-w-28" aria-label="Market">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="min-w-0">
                  <SelectGroup>
                    {[
                      ["Jita", "Jita"],
                      ["Amarr", "Amarr"],
                      ["Hek", "Hek"],
                      ["Dodixie", "Dodixie"],
                      ["Rens", "Rens"],
                    ].map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <Button type="button" variant="outline" onClick={() => setIsPasteOpen(true)}>
              <ClipboardPaste data-icon="inline-start" aria-hidden="true" />
              Paste multibuy
            </Button>
          </div>
        </div>
        <TypeSearch
          language={language}
          inputId="appraise-item-search"
          placeholder="Search items by name or type ID"
          ariaLabel="Search items by name or type ID"
          onSelect={addItem}
        />
        {inputItems.length === 0 ? (
          <p className={styles.appraiseEmpty}>Search for an item above to start your list.</p>
        ) : (
          <div className={styles.appraiseItems}>
            {inputItems.map((item, index) => (
              <div className={styles.appraiseInputRow} key={item.typeId}>
                <TypeIdentity name={item.name} typeId={item.typeId} />
                <Input
                  className="text-right"
                  type="number"
                  min="0"
                  step="1"
                  value={item.quantity}
                  aria-label={`${item.name} quantity`}
                  onChange={(event) => {
                    setInputItems(
                      inputItems.map((entry, itemIndex) =>
                        itemIndex === index
                          ? { ...entry, quantity: Math.max(0, Number(event.target.value) || 0) }
                          : entry,
                      ),
                    );
                    invalidateAppraisal();
                  }}
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => {
                    setInputItems(inputItems.filter((entry) => entry !== item));
                    invalidateAppraisal();
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <CalculateButton
          type="submit"
          onClick={appraiseItems}
          disabled={isLoading}
          icon={BadgeDollarSign}
          isLoading={isLoading}
          label="Appraise list"
          loadingLabel="Checking market..."
        />
        {error && (
          <Alert variant="destructive" className={styles.formError}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
      {isPasteOpen && (
        <PasteListDialog
          key={`${language}:${inputItems.map((item) => `${item.typeId}-${item.quantity}`).join(",")}`}
          language={language}
          title="BATCH IMPORT"
          description="Compatible with Eve Multibuy. One item per line, with the quantity at the end."
          placeholder={`Tritanium 120000
Pyerite 60000`}
          ariaLabel="Multibuy list"
          allowSubtract
          currentItems={inputItems}
          onCancel={() => setIsPasteOpen(false)}
          onImport={(importedItems) => {
            setInputItems(
              importedItems.map((item) => ({
                name: item.name,
                typeId: item.typeId,
                quantity: item.quantity ?? 1,
              })),
            );
            invalidateAppraisal();
            setIsPasteOpen(false);
          }}
        />
      )}
      {items.length > 0 && (
        <section className={`${styles.appraiseResults} min-w-0`}>
          <div className={`${styles.appraiseSummary} flex flex-col items-stretch gap-4`}>
            <div className="flex w-full items-center justify-between gap-4">
              <span className="text-xs font-medium">Grand total</span>
              <small>{market} order book</small>
            </div>
            <div className="grid w-full gap-3">
              <PriceMetric label="5% sell" value={appraisalPrices?.fivePercentSellPrice} />
              <PriceMetric label="Min sell" value={appraisalPrices?.minSellPrice} />
              <PriceMetric label="Split" value={appraisalPrices?.splitPrice} />
              <PriceMetric label="Max buy" value={appraisalPrices?.maxBuyPrice} />
              <PriceMetric label="5% buy" value={appraisalPrices?.fivePercentBuyPrice} />
            </div>
            <div className="flex w-full items-center justify-between gap-4">
              <div>
                <span>Total volume</span>
                <strong>{Math.ceil(totals?.volume ?? 0).toLocaleString()} m³</strong>
              </div>
              <ResponsiveDialogDrawer
                trigger={
                  <Button type="button" variant="outline">
                    <List aria-hidden="true" />
                    Item price ranges
                  </Button>
                }
                title="ITEM PRICE RANGES"
                description="Sell prices use the selected hub station; buy prices use the region."
                dialogClassName="sm:max-w-4xl"
              >
                <div className="grid gap-3">
                  {items.map((item) => (
                    <div className="grid gap-3 border p-3" key={item.typeId ?? item.name}>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <div className="grid min-w-0 gap-1">
                          {item.typeId ? (
                            <TypeIdentity name={item.name} typeId={item.typeId} imageSize={24} />
                          ) : (
                            <strong className="truncate text-xs">{item.name}</strong>
                          )}
                          {item.error && (
                            <span className="text-xs text-destructive">{item.error}</span>
                          )}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          Quantity {item.quantity.toLocaleString()}
                        </span>
                      </div>
                      <div className="grid gap-3">
                        <PriceMetric label="5% sell" value={item.prices.fivePercentSellPrice} />
                        <PriceMetric label="Min sell" value={item.prices.minSellPrice} />
                        <PriceMetric label="Split" value={item.prices.splitPrice} />
                        <PriceMetric label="Max buy" value={item.prices.maxBuyPrice} />
                        <PriceMetric label="5% buy" value={item.prices.fivePercentBuyPrice} />
                      </div>
                    </div>
                  ))}
                </div>
              </ResponsiveDialogDrawer>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-b py-3">
            <span className="text-xs font-medium">Appraisal details</span>
            <Label className="flex items-center gap-2 text-xs">
              <span>{valueColumnLabel}</span>
              <Switch
                id="appraise-total-values"
                checked={showTotalValues}
                onCheckedChange={setShowTotalValues}
                aria-label="Toggle total values"
              />
            </Label>
          </div>
          <div className="overflow-x-auto" role="table" aria-label="Appraisal results">
            <div
              className="grid min-w-xl grid-cols-[minmax(12rem,1fr)_minmax(6rem,auto)_minmax(8rem,auto)_minmax(7rem,auto)] gap-4 border-b py-2 text-xs font-medium text-muted-foreground"
              role="row"
            >
              <span className="text-left" role="columnheader">
                Item
              </span>
              <span className="text-right" role="columnheader">
                Quantity
              </span>
              <span className="text-right" role="columnheader">
                {valueColumnLabel}
              </span>
              <span className="text-right" role="columnheader">
                {volumeColumnLabel}
              </span>
            </div>
            {items.map((item) => (
              <div
                className="grid min-w-xl grid-cols-[minmax(12rem,1fr)_minmax(6rem,auto)_minmax(8rem,auto)_minmax(7rem,auto)] items-center gap-4 border-b py-3 text-right"
                key={`${item.typeId ?? item.name}-${item.quantity}`}
                role="row"
              >
                <div className="min-w-0 text-left" role="cell">
                  <div className="grid min-w-0 gap-1">
                    {item.typeId ? (
                      <TypeIdentity name={item.name} typeId={item.typeId} imageSize={32} />
                    ) : (
                      <strong className="truncate text-xs">{item.name}</strong>
                    )}
                    {item.error && <span className="text-xs text-destructive">{item.error}</span>}
                  </div>
                </div>
                <span className="text-xs whitespace-nowrap" role="cell">
                  {item.quantity.toLocaleString()}
                </span>
                <span className="text-xs whitespace-nowrap" role="cell">
                  {formatIsk(showTotalValues ? item.total : item.price)}
                </span>
                <span className="text-xs whitespace-nowrap" role="cell">
                  {Math
                    .ceil(showTotalValues ? (item.volume ?? 0) : (item.unitVolume ?? 0))
                    .toLocaleString()}{" "}
                  m³
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
