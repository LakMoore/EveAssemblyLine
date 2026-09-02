"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clipboard, Copy, Save, Trash2, X } from "lucide-react";
import type { ClientBuildItem, ClientPlanBucket, PlanBucketLocations } from "@/lib/planning/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import TypeSearch from "@/components/TypeSearch";
import PasteListDialog from "@/components/PasteListDialog";
import StationSearch, { type StationSearchResult } from "@/components/StationSearch";
import type { SdeLanguage } from "@/lib/reference/languages";
import { ScrollArea } from "@/components/ui/scroll-area";

type ActivityLocationOption = {
  locationId: number;
  name: string;
  baseManufacturingMe: number;
  baseReactionMe: number;
};

type StockLocationOption = {
  locationId: number;
  name: string;
};

function ActivityLocationCombobox({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: ActivityLocationOption[];
  selected: ActivityLocationOption | undefined;
  onSelect: (locationId: number) => void;
}) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState(selected?.name ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const filteredOptions = options.filter((location) =>
    location.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <div ref={anchor} className="w-full">
      <Combobox
        items={filteredOptions}
        open={isOpen}
        itemToStringLabel={(location: ActivityLocationOption) => location.name}
        inputValue={query}
        onOpenChange={setIsOpen}
        onInputValueChange={(value, eventDetails) => {
          if (eventDetails.reason !== "input-change") {
            setQuery(selected?.name ?? "");
            setIsOpen(false);
            return;
          }
          setQuery(value);
          setIsOpen(true);
        }}
        onValueChange={(location) => {
          if (!location) return;
          setQuery(location.name);
          setIsOpen(false);
          onSelect(location.locationId);
        }}
      >
        <ComboboxInput
          className="w-full"
          showTrigger={false}
          placeholder="Search activity locations"
          aria-label={label}
          onFocus={() => setIsOpen(true)}
        />
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>No matching activity locations.</ComboboxEmpty>
          <ComboboxList>
            {filteredOptions.map((location) => (
              <ComboboxItem key={location.locationId} value={location}>
                {location.name}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

type PlannerBucketEditorProps = {
  bucket: ClientPlanBucket | null;
  open: boolean;
  language: SdeLanguage;
  activityLocations: ActivityLocationOption[];
  stockLocations: StockLocationOption[];
  excludedStockLocationIds: number[];
  onOpenChange: (open: boolean) => void;
  onSave: (bucket: ClientPlanBucket) => boolean | void;
};

const activityLocationFields: Array<{
  key: keyof Omit<PlanBucketLocations, "stock">;
  label: string;
}> = [
  { key: "manufacturing", label: "Build location" },
  { key: "reactions", label: "Reaction location" },
  { key: "reprocessing", label: "Reprocessing location" },
  { key: "copying", label: "Copying location" },
  { key: "invention", label: "Invention location" },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function addItems(
  current: ClientBuildItem[],
  importedItems: Array<{
    name: string;
    typeId: number;
    quantity?: number;
    category?: string;
  }>,
): ClientBuildItem[] {
  const next = current.map((item) => ({ ...item }));
  for (const imported of importedItems) {
    const existingIndex = next.findIndex(
      (item) => item.typeId === imported.typeId && !item.fromCompression,
    );
    const item =
      existingIndex >= 0
        ? {
            ...next[existingIndex],
            quantity: next[existingIndex].quantity + (imported.quantity ?? 1),
          }
        : {
            name: imported.name,
            categoryName: imported.category ?? "Unknown",
            typeId: imported.typeId,
            quantity: imported.quantity ?? 1,
            me: 0,
            te: 0,
            fromCompression: false,
          };
    next.splice(existingIndex >= 0 ? existingIndex : next.length, 1);
    next.unshift(item);
  }
  return next;
}

function BucketEditorContent({
  draft,
  language,
  activityLocations,
  stockLocations,
  excludedStockLocationIds,
  error,
  onError,
  onChange,
}: {
  draft: ClientPlanBucket;
  language: SdeLanguage;
  activityLocations: ActivityLocationOption[];
  stockLocations: StockLocationOption[];
  excludedStockLocationIds: number[];
  error: string;
  onError: (message: string) => void;
  onChange: (bucket: ClientPlanBucket) => void;
}) {
  const [isPasteOpen, setIsPasteOpen] = useState(false);
  const stockLocationName =
    stockLocations.find((location) => location.locationId === draft.locations.stock)?.name
    ?? draft.stockLocationName
    ?? String(draft.locations.stock);

  function updateItems(items: ClientBuildItem[]) {
    onChange({ ...draft, items });
  }

  function selectStation(station: StationSearchResult) {
    onChange({
      ...draft,
      stockLocationName: station.name,
      locations: { ...draft.locations, stock: station.stationId },
    });
  }

  async function copyList() {
    try {
      await navigator.clipboard.writeText(
        draft.items.map((item) => `${item.name}\t${item.quantity}`).join("\n"),
      );
    }
    catch {
      onError("Could not copy this build list.");
    }
  }

  function removeCompressionItems() {
    updateItems(draft.items.filter((item) => !item.fromCompression));
  }

  function submitTypeSearch(item: { name: string; typeId: number; category?: string }) {
    updateItems(addItems(draft.items, [item]));
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="flex min-w-0 flex-col gap-2">
          <span className="text-xs font-medium uppercase">Stockpile name</span>
          <Input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="e.g. Jita staging"
            aria-label="Stockpile name"
          />
        </label>
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-xs font-medium uppercase">Stock destination</span>
          <div className="flex min-h-9 items-center border px-3 text-sm">
            <span className="truncate">{stockLocationName}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{draft.locations.stock}</span>
          </div>
          <StationSearch
            language={language}
            excludedStationIds={excludedStockLocationIds.filter(
              (locationId) => locationId !== draft.locations.stock,
            )}
            onError={onError}
            onSelect={selectStation}
          />
          <p className="text-xs text-muted-foreground">
            Search any station or a known structure. Add new structures from the{" "}
            <Link href="/structures" className="underline underline-offset-2">
              Structures
            </Link>{" "}
            page.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activityLocationFields.map(({ key, label }) => {
          const selected = activityLocations.find(
            (location) => location.locationId === draft.locations[key],
          );
          return (
            <label className="flex min-w-0 flex-col gap-2" key={key}>
              <span className="text-xs font-medium uppercase">{label}</span>
              <ActivityLocationCombobox
                label={label}
                options={activityLocations}
                selected={selected}
                onSelect={(locationId) =>
                  onChange({
                    ...draft,
                    locations: { ...draft.locations, [key]: locationId },
                  })
                }
              />
            </label>
          );
        })}
      </div>

      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto min-w-0">
            <h3 className="text-sm font-medium">What you want to stock</h3>
            <p className="text-xs text-muted-foreground">
              This list is planned only for this destination.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setIsPasteOpen(true)}>
            <Clipboard data-icon="inline-start" aria-hidden="true" />
            Paste list
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyList()}
            disabled={draft.items.length === 0}
          >
            <Copy data-icon="inline-start" aria-hidden="true" />
            Copy list
          </Button>
          {draft.items.some((item) => item.fromCompression) && (
            <Button type="button" variant="outline" onClick={removeCompressionItems}>
              Remove compression
            </Button>
          )}
        </div>
        <TypeSearch
          language={language}
          placeholder="Search items by name or type ID"
          ariaLabel="Search stockpile items by name or type ID"
          onSelect={submitTypeSearch}
        />
        {draft.items.length === 0 ? (
          <Empty>
            <EmptyDescription>Search for an item above to start this stockpile.</EmptyDescription>
          </Empty>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {draft.items.map((item, index) => (
              <div
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_5rem_2rem] items-center gap-2"
                key={`${item.typeId}-${item.fromCompression}`}
              >
                <TypeIdentity
                  name={item.name}
                  typeId={item.typeId}
                  variation={
                    item.iconCategory === "bpo"
                      ? "bp"
                      : item.iconCategory === "bpc" || item.iconCategory === "reactionformula"
                        ? "bpc"
                        : "icon"
                  }
                  className="min-w-0"
                />
                <Input
                  className="text-right"
                  type="number"
                  min="1"
                  step="1"
                  value={item.quantity}
                  aria-label={`${item.name} quantity`}
                  onChange={(event) => {
                    const quantity = Math.max(1, Number(event.target.value) || 1);
                    updateItems(
                      draft.items.map((entry, itemIndex) =>
                        itemIndex === index ? { ...entry, quantity } : entry,
                      ),
                    );
                  }}
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  aria-label={`Remove ${item.name}`}
                  onClick={() =>
                    updateItems(draft.items.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {isPasteOpen && (
        <PasteListDialog
          language={language}
          currentItems={draft.items}
          onCancel={() => setIsPasteOpen(false)}
          onImport={(items) => {
            updateItems(addItems(draft.items, items));
            setIsPasteOpen(false);
          }}
        />
      )}
    </div>
  );
}

export default function PlannerBucketEditor({
  bucket,
  open,
  language,
  activityLocations,
  stockLocations,
  excludedStockLocationIds,
  onOpenChange,
  onSave,
}: PlannerBucketEditorProps) {
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState<ClientPlanBucket | null>(() => bucket);
  const [error, setError] = useState("");

  if (!open || !draft) return null;
  const currentDraft = draft;

  function saveDraft() {
    if (!currentDraft.name.trim()) {
      setError("Give this stock destination a name.");
      return;
    }
    setError("");
    if (onSave(currentDraft) !== false) onOpenChange(false);
  }

  const content = (
    <BucketEditorContent
      draft={draft}
      language={language}
      activityLocations={activityLocations}
      stockLocations={stockLocations}
      excludedStockLocationIds={excludedStockLocationIds}
      error={error}
      onError={setError}
      onChange={setDraft}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)]"
          style={{ marginInline: "0.5rem", width: "calc(100% - 1rem)" }}
        >
          <DrawerHeader>
            <DrawerTitle>{bucket ? "Edit stockpile" : "Add stockpile"}</DrawerTitle>
            <DrawerDescription>
              Set the destination and activity locations for this stockpile.
            </DrawerDescription>
          </DrawerHeader>
          <ScrollArea className="h-0 min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="p-4">{content}</div>
          </ScrollArea>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <X data-icon="inline-start" aria-hidden="true" />
              Cancel
            </Button>
            <Button type="button" onClick={saveDraft}>
              <Save data-icon="inline-start" aria-hidden="true" />
              Save stockpile
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(90vh,48rem)] max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-5xl"
        style={{ width: "calc(100% - 2rem)" }}
      >
        <DialogHeader>
          <DialogTitle>{bucket ? "Edit stockpile" : "Add stockpile"}</DialogTitle>
          <DialogDescription>
            Set the destination and activity locations for this stockpile.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 min-w-0 overflow-hidden">{content}</ScrollArea>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            <X data-icon="inline-start" aria-hidden="true" />
            Cancel
          </Button>
          <Button type="button" onClick={saveDraft}>
            <Save data-icon="inline-start" aria-hidden="true" />
            Save stockpile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { ActivityLocationOption, PlannerBucketEditorProps, StockLocationOption };
