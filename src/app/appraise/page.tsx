"use client";

import { useState } from "react";
import { BadgeDollarSign } from "lucide-react";
import { useAppLanguage } from "../AppShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
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

type AppraiseResponse = {
  market?: string;
  items?: AppraiseItem[];
  error?: string;
};

function parsePastedItems(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = line
        .split(/\t|\s{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);
      const leadingQuantity = columns[0]?.match(/^\d+$/);
      const trailingQuantity = columns.at(-1)?.match(/^\d+$/);
      if (leadingQuantity && columns.length > 1) {
        return { name: columns.slice(1).join(" "), quantity: Number(columns[0]) };
      }
      if (trailingQuantity && columns.length > 1) {
        return { name: columns.slice(0, -1).join(" "), quantity: Number(columns.at(-1)) };
      }
      return { name: line, quantity: 1 };
    });
}

function formatIsk(value?: number) {
  return value === undefined ? "-" : `${Math.round(value).toLocaleString()} ISK`;
}

export default function AppraisePage() {
  const { language } = useAppLanguage();
  const [pastedItems, setPastedItems] = useState("");
  const [items, setItems] = useState<AppraiseItem[]>([]);
  const [market, setMarket] = useState("Jita");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function appraiseItems() {
    const parsedItems = parsePastedItems(pastedItems);
    if (parsedItems.length === 0) {
      setError("Paste at least one item.");
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
          body: JSON.stringify({ language, marketId: market.toLowerCase(), items: parsedItems }),
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

  return (
    <div className={styles.appraisePage}>
      <div className={styles.pageIntro}>
        <span className={styles.eyebrow}>TOOLS / APPRAISE</span>
        <h1>Appraise an item list</h1>
        <p>
          Paste an EVE item list to resolve names, check current sell orders, and total its ISK
          value and volume.
        </p>
      </div>
      <section className={styles.appraiseTool}>
        <div className={styles.appraiseInputHeader}>
          <Field>
            <FieldLabel htmlFor="appraise-list">Item list</FieldLabel>
          </Field>
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
            <SelectTrigger aria-label="Market hub">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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
        <Textarea
          id="appraise-list"
          className={styles.appraiseTextarea}
          value={pastedItems}
          onChange={(event) => setPastedItems(event.target.value)}
          placeholder="100 Tritanium\n25,000 Mexallon"
          rows={10}
        />
        <Button
          type="button"
          className={styles.actionButton}
          onClick={appraiseItems}
          disabled={isLoading}
        >
          <span className={styles.appraiseActionLead}>
            {isLoading ? (
              <Spinner aria-hidden="true" />
            ) : (
              <BadgeDollarSign size={16} aria-hidden="true" />
            )}
            <span>{isLoading ? "Checking market..." : "Appraise list"}</span>
          </span>
          <b aria-hidden="true">→</b>
        </Button>
        {error && (
          <Alert variant="destructive" className={styles.formError}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
      {items.length > 0 && (
        <section className={styles.appraiseResults}>
          <div className={styles.appraiseSummary}>
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
          <div className={styles.appraiseTable}>
            {items.map((item) => (
              <div
                className={styles.appraiseRow}
                key={`${item.typeId ?? item.name}-${item.quantity}`}
              >
                <BadgeDollarSign size={17} aria-hidden="true" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.quantity.toLocaleString()} units</small>
                </span>
                <span>
                  {formatIsk(item.price)}
                  <small>
                    {item.error ?? `${Math.ceil(item.volume ?? 0).toLocaleString()} m³`}
                  </small>
                </span>
                <strong>{formatIsk(item.total)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
