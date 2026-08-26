"use client";

import { FormEvent, useState } from "react";
import type { TypeMetadata } from "@/lib/reference/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { DialogDescription, DialogHeader } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CircleAlert, FileUp, X } from "lucide-react";

type PasteResult = Partial<TypeMetadata> & {
  name: string;
  quantity?: number;
  error?: string;
};

type PasteListItem = {
  typeId: number;
  name: string;
  quantity?: number;
  category?: string;
  marketCategory?: string;
};

type PasteListDialogProps = {
  language: SdeLanguage;
  title?: string;
  description?: string;
  placeholder?: string;
  ariaLabel?: string;
  currentItems: PasteListItem[];
  onCancel: () => void;
  onImport: (items: PasteListItem[]) => void;
};

/** Resolves an EVE multibuy list and returns its published type metadata. */
export default function PasteListDialog({
  language,
  title = "Paste build list",
  description = "One item per line. Put the quantity at the end of each line.",
  placeholder = "Raven 2\nVargur 1",
  ariaLabel = "Build items and quantities",
  currentItems,
  onCancel,
  onImport,
}: PasteListDialogProps) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<PasteResult[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"add" | "replace">("add");

  async function resolveItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const parsed = lines.map((line) => {
      const match = line.match(/^(.*?)\s+(\d+)$/);
      return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: line };
    });
    if (parsed.length === 0) {
      setError("Paste at least one item and quantity.");
      setResults([]);
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
      if (!response.ok) throw new Error(data.error ?? "Could not resolve the pasted list.");
      const resolvedItems = data.items ?? [];
      setResults(resolvedItems);
      if (resolvedItems.length > 0 && resolvedItems.every((item) => !item.error && item.typeId)) {
        const importedItems = resolvedItems as PasteListItem[];
        if (mode === "replace") {
          onImport(importedItems);
          return;
        }
        const merged = [...currentItems];
        for (const item of importedItems) {
          const existing = merged.find((entry) => entry.typeId === item.typeId);
          if (existing) existing.quantity = (existing.quantity ?? 0) + (item.quantity ?? 0);
          else merged.push(item);
        }
        onImport(merged);
      }
    }
    catch (resolveError) {
      setResults([]);
      setError(
        resolveError instanceof Error ? resolveError.message : "Could not resolve the pasted list.",
      );
    }
    finally {
      setIsResolving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent render={<form onSubmit={resolveItems} />}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
          <Textarea
            className="min-h-48"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResults([]);
              setError("");
            }}
            placeholder={placeholder}
            aria-label={ariaLabel}
            autoFocus
          />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {results.length > 0 && (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {results.map((item, index) => (
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-2 border p-2 text-sm",
                    item.error && "border-destructive/50 bg-card",
                  )}
                  key={`${item.name}-${index}`}
                  aria-invalid={item.error ? "true" : undefined}
                >
                  <div className="min-w-0 flex-1">
                    {item.typeId ? (
                      <TypeIdentity
                        name={item.name}
                        typeId={item.typeId}
                        variation={item.category === "blueprint" ? "bp" : "icon"}
                        className="min-w-0"
                      />
                    ) : (
                      <span className="block min-w-0 truncate">{item.name}</span>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-3">
                    {item.quantity ? (
                      <small className="text-right text-muted-foreground">
                        Quantity {item.quantity}
                      </small>
                    ) : null}
                    {item.error ? (
                      <small className="flex max-w-[15rem] min-w-0 flex-nowrap items-center gap-1 whitespace-nowrap text-right text-destructive">
                        <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{item.error}</span>
                      </small>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          <RadioGroup
            className="mt-1 sm:grid-cols-2"
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
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            <X aria-hidden="true" />
            Cancel
          </Button>
          <Button type="submit" disabled={isResolving || text.trim().length === 0}>
            <FileUp aria-hidden="true" />
            <span>{isResolving ? "Checking list..." : "Import list"}</span>
            <b aria-hidden="true">→</b>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { PasteListDialogProps };
export type { PasteListItem };
