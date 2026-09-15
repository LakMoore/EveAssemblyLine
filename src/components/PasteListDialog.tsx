"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import type { TypeMetadata } from "@/lib/reference/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { parsePasteList } from "@/lib/reference/pasteList";
import { applyPasteListMode, type PasteListMode } from "@/lib/reference/pasteListOperations";
import { cn } from "@/lib/utils";
import { FileUp, X } from "lucide-react";
import { Label } from "./ui/label";

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
  assemblyLineGroup?: string;
};

type PasteListDialogProps = {
  language: SdeLanguage;
  title?: string;
  description?: string;
  placeholder?: string;
  ariaLabel?: string;
  allowSubtract?: boolean;
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
  allowSubtract = false,
  currentItems,
  onCancel,
  onImport,
}: PasteListDialogProps) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<PasteResult[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<PasteListMode>("add");
  const [activeRequest, setActiveRequest] = useState<{
    id: number;
    language: SdeLanguage;
    currentItems: PasteListItem[];
    mode: PasteListMode;
    text: string;
  } | null>(null);
  const resolveRequestId = useRef(0);
  const formId = useId();

  function invalidateResolution() {
    resolveRequestId.current += 1;
    setActiveRequest(null);
  }

  function cancelDialog() {
    invalidateResolution();
    onCancel();
  }

  useEffect(
    () => () => {
      resolveRequestId.current += 1;
    },
    [currentItems, language],
  );

  const isResolving =
    activeRequest !== null
    && activeRequest.language === language
    && activeRequest.currentItems === currentItems
    && activeRequest.mode === mode
    && activeRequest.text === text;
  const itemErrors = results.filter((item) => item.error);
  const visibleItemErrors = itemErrors.slice(0, 3);
  const hiddenItemErrorCount = itemErrors.length - visibleItemErrors.length;

  async function resolveItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parsePasteList(text);
    if (parsed.length === 0) {
      setError("Paste at least one item and quantity.");
      setResults([]);
      return;
    }
    const requestId = ++resolveRequestId.current;
    setActiveRequest({ id: requestId, language, currentItems, mode, text });
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
      if (requestId !== resolveRequestId.current) return;
      const resolvedItems = data.items ?? [];
      setResults(resolvedItems);
      if (resolvedItems.length > 0 && resolvedItems.every((item) => !item.error && item.typeId)) {
        const importedItems = resolvedItems as PasteListItem[];
        onImport(applyPasteListMode(currentItems, importedItems, mode));
      }
    }
    catch (resolveError) {
      if (requestId !== resolveRequestId.current) return;
      setResults([]);
      setError(
        resolveError instanceof Error ? resolveError.message : "Could not resolve the pasted list.",
      );
    }
    finally {
      if (requestId === resolveRequestId.current) setActiveRequest(null);
    }
  }

  const footer = (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {itemErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>
              {itemErrors.length === 1
                ? "One item could not be resolved:"
                : `${itemErrors.length} items could not be resolved:`}
            </p>
            <ul className="flex flex-col gap-1">
              {visibleItemErrors.map((item, index) => (
                <li key={`${item.name}-${index}`}>
                  <span className="font-medium">{item.name}:</span> {item.error}
                </li>
              ))}
              {hiddenItemErrorCount > 0 && <li>And {hiddenItemErrorCount} more items.</li>}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={cancelDialog}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={isResolving || text.trim().length === 0}>
          <FileUp aria-hidden="true" />
          <span>{isResolving ? "Checking list..." : "Import list"}</span>
          <b aria-hidden="true">→</b>
        </Button>
      </div>
    </div>
  );

  return (
    <ResponsiveDialogDrawer
      open
      onOpenChange={(open) => !open && cancelDialog()}
      title={title}
      description={description}
      dialogFooterContent={footer}
      drawerFooterContent={footer}
    >
      <form id={formId} onSubmit={resolveItems} className="flex flex-col gap-3">
        <Textarea
          className="min-h-48"
          value={text}
          onChange={(event) => {
            invalidateResolution();
            setText(event.target.value);
            setResults([]);
            setError("");
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus
        />
        {results.length > 0 && (
          <div className="flex flex-col gap-1">
            {results.map((item, index) => (
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2 border p-2 text-sm",
                  item.error && "border-destructive/50 bg-card",
                )}
                key={`${item.name}-${index}`}
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
                <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
                  {item.quantity ? (
                    <small className="text-right text-muted-foreground">
                      Quantity {item.quantity}
                    </small>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
        <RadioGroup
          className={cn("mt-1", allowSubtract ? "sm:grid-cols-3" : "sm:grid-cols-2")}
          value={mode}
          onValueChange={(value) => {
            invalidateResolution();
            setMode(value as PasteListMode);
          }}
          aria-label="Paste behavior"
        >
          <Label className="flex items-start gap-2">
            <RadioGroupItem value="add" />
            <span className="grid min-w-0 gap-1">
              <span className="text-sm font-medium">Add to list</span>
              <span className="text-xs text-muted-foreground">
                Keep the imported items with the current list.
              </span>
            </span>
          </Label>
          <Label className="flex items-start gap-2">
            <RadioGroupItem value="replace" />
            <span className="grid min-w-0 gap-1">
              <span className="text-sm font-medium">Replace list</span>
              <span className="text-xs text-muted-foreground">
                Clear the current list before importing.
              </span>
            </span>
          </Label>
          {allowSubtract && (
            <Label className="flex items-start gap-2">
              <RadioGroupItem value="subtract" />
              <span className="grid min-w-0 gap-1">
                <span className="text-sm font-medium">Subtract from list</span>
                <span className="text-xs text-muted-foreground">
                  Deduct the imported quantities from the current list.
                </span>
              </span>
            </Label>
          )}
        </RadioGroup>
      </form>
    </ResponsiveDialogDrawer>
  );
}

export type { PasteListDialogProps };
export type { PasteListItem };
