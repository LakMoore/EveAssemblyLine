"use client";

import { useState } from "react";
import { BadgeDollarSign, ClipboardPaste, Trash2 } from "lucide-react";
import { useAppLanguage } from "../AppShell";
import CalculateButton from "@/components/CalculateButton";
import PasteListDialog from "@/components/PasteListDialog";
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

type AppraiseItem = {
  name: string;
  typeId?: number;
  quantity: number;
  price?: number;
  volume?: number;
  total?: number;
  error?: string;
};

type AppraiseInputItem = {
  name: string;
  typeId: number;
  quantity: number;
};

type AppraiseResponse = {
  market?: string;
  items?: AppraiseItem[];
  error?: string;
};

function formatIsk(value?: number) {
  return value === undefined
    ? "-"
    : `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(value)} ISK`;
}

export default function AppraisePage() {
  const { language } = useAppLanguage();
  const [inputItems, setInputItems] = useState<AppraiseInputItem[]>([]);
  const [items, setItems] = useState<AppraiseItem[]>([]);
  const [market, setMarket] = useState("Jita");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const [showTotalValues, setShowTotalValues] = useState(false);

  async function appraiseItems() {
    if (inputItems.length === 0) {
      setError("Add at least one item.");
      return;
    }
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
      setItems(data.items ?? []);
    }
    catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Could not appraise this list.",
      );
      setItems([]);
    }
    finally {
      setIsLoading(false);
    }
  }

  const totalIsk = items.reduce((sum, item) => sum + (item.total ?? 0), 0);
  const totalVolume = items.reduce((sum, item) => sum + (item.volume ?? 0), 0);
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
    setItems([]);
    setError("");
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
                onValueChange={(value) => value && setMarket(value)}
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
                  min="1"
                  step="1"
                  value={item.quantity}
                  aria-label={`${item.name} quantity`}
                  onChange={(event) =>
                    setInputItems(
                      inputItems.map((entry, itemIndex) =>
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
                  onClick={() => setInputItems(inputItems.filter((entry) => entry !== item))}
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
          language={language}
          title="BATCH IMPORT"
          description="Compatible with Eve Multibuy. One item per line, with the quantity at the end."
          placeholder={`Tritanium 120000
Pyerite 60000`}
          ariaLabel="Multibuy list"
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
            setItems([]);
            setError("");
            setIsPasteOpen(false);
          }}
        />
      )}
      {items.length > 0 && (
        <section className={styles.appraiseResults}>
          <div className={`${styles.appraiseSummary} flex items-center justify-between gap-4`}>
            <div>
              <span>Total value</span>
              <strong>{formatIsk(totalIsk)}</strong>
            </div>
            <div>
              <span>Total volume</span>
              <strong>{Math.ceil(totalVolume).toLocaleString()} m³</strong>
            </div>
            <small>{market} sell orders</small>
          </div>
          <div className="flex items-center justify-between gap-4 border-b py-3">
            <span className="text-xs font-medium">Appraisal details</span>
            <label className="flex items-center gap-2 text-xs">
              <span>{valueColumnLabel}</span>
              <Switch
                id="appraise-total-values"
                checked={showTotalValues}
                onCheckedChange={setShowTotalValues}
                aria-label="Toggle total values"
              />
            </label>
          </div>
          <div className="overflow-x-auto" role="table" aria-label="Appraisal results">
            <div
              className="grid min-w-[36rem] grid-cols-[minmax(12rem,1fr)_minmax(6rem,auto)_minmax(8rem,auto)_minmax(7rem,auto)] gap-4 border-b py-2 text-xs font-medium text-muted-foreground"
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
                className="grid min-w-[36rem] grid-cols-[minmax(12rem,1fr)_minmax(6rem,auto)_minmax(8rem,auto)_minmax(7rem,auto)] items-center gap-4 border-b py-3 text-right"
                key={`${item.typeId ?? item.name}-${item.quantity}`}
                role="row"
              >
                <span className="min-w-0 text-left" role="cell">
                  {item.typeId ? (
                    <TypeIdentity name={item.name} typeId={item.typeId} imageSize={32} />
                  ) : (
                    <strong className="truncate text-xs">{item.name}</strong>
                  )}
                </span>
                <span className="whitespace-nowrap text-xs" role="cell">
                  {item.quantity.toLocaleString()}
                </span>
                <span className="whitespace-nowrap text-xs" role="cell">
                  {formatIsk(showTotalValues ? item.total : item.price)}
                </span>
                <span className="whitespace-nowrap text-xs" role="cell">
                  {Math
                    .ceil((item.volume ?? 0) * (showTotalValues ? item.quantity : 1))
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
