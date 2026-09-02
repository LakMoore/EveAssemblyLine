"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clipboard, Copy, ListRestart, Save, Trash2, WandSparkles, X } from "lucide-react";
import type { ClientBuildItem, ClientPlanBucket, PlanBucketLocations } from "@/lib/planning/types";
import type { ProductionActivity, ProductionGroupKey } from "@/lib/planning/productionGroups";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DrawerFooter } from "@/components/ui/drawer";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import TypeSearch from "@/components/TypeSearch";
import PasteListDialog from "@/components/PasteListDialog";
import type { SdeLanguage } from "@/lib/reference/languages";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";

type ActivityLocationOption = {
  locationId: number;
  name: string;
  kind: "station" | "structure";
  baseYield: number;
  baseManufacturingMe: number;
  baseReactionMe: number;
};

type StockLocationOption = ActivityLocationOption;

type GroupFacilityOption = ActivityLocationOption & {
  sizeId: number;
  materialPercentage: number;
  timePercentage: number;
};

export type ProductionGroupOption = {
  key: ProductionGroupKey;
  label: string;
  activity: ProductionActivity;
  facilities: GroupFacilityOption[];
};

type LocationBonus = "manufacturing" | "reaction" | "reprocessing" | "none";

function locationBonus(option: ActivityLocationOption, bonus: LocationBonus) {
  if (bonus === "reprocessing") return option.baseYield;
  if (bonus === "reaction") return option.baseReactionMe;
  if (bonus === "manufacturing") return option.baseManufacturingMe;
  return 0;
}

function formatLocationBonus(option: ActivityLocationOption, bonus: LocationBonus) {
  if (bonus === "reprocessing") return `Yield ${option.baseYield.toFixed(1)}%`;
  if (bonus === "reaction") return `ME ${option.baseReactionMe.toFixed(1)}%`;
  if (bonus === "manufacturing") return `ME ${option.baseManufacturingMe.toFixed(1)}%`;
  return undefined;
}

function formatSelectedLocationModifier(
  option: ActivityLocationOption | undefined,
  bonus: LocationBonus,
) {
  if (!option || bonus === "none") return undefined;
  const value = locationBonus(option, bonus);
  if (bonus === "reprocessing") {
    return value === 0 ? undefined : `Yield ${value.toFixed(1)}%`;
  }
  return value === 0 ? undefined : `ME ${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function LocationCombobox({
  label,
  options,
  selected,
  bonus,
  onSelect,
}: {
  label: string;
  options: ActivityLocationOption[];
  selected: ActivityLocationOption | undefined;
  bonus: LocationBonus;
  onSelect: (locationId: number) => void;
}) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState(selected?.name ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const filteredOptions = options
    .filter((location) =>
      location.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (left, right) =>
        (bonus === "reprocessing"
          ? right.baseYield - left.baseYield
          : locationBonus(left, bonus) - locationBonus(right, bonus))
        || left.name.localeCompare(right.name),
    );
  const groupedOptions = [
    { kind: "structure" as const, label: "Structures" },
    { kind: "station" as const, label: "Stations" },
  ].map((group) => ({
    ...group,
    options: filteredOptions.filter((location) => location.kind === group.kind),
  }));

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
          placeholder={`Search ${label.toLocaleLowerCase()}`}
          aria-label={label}
          onFocus={() => {
            setQuery("");
            setIsOpen(true);
          }}
        />
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>No matching locations.</ComboboxEmpty>
          <ComboboxList>
            {groupedOptions.map((group) => (
              <ComboboxGroup key={group.kind}>
                <ComboboxLabel>{group.label}</ComboboxLabel>
                {group.options.map((location) => (
                  <ComboboxItem key={location.locationId} value={location}>
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span className="truncate">{location.name}</span>
                      {formatLocationBonus(location, bonus) && (
                        <span className="shrink-0 text-muted-foreground">
                          {formatLocationBonus(location, bonus)}
                        </span>
                      )}
                    </span>
                  </ComboboxItem>
                ))}
              </ComboboxGroup>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

type PlannerBucketDialogProps = {
  bucket: ClientPlanBucket | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (bucket: ClientPlanBucket) => boolean | void;
};

type PlannerBucketDetailsDialogProps = PlannerBucketDialogProps & {
  activityLocations: ActivityLocationOption[];
  stockLocations: StockLocationOption[];
  excludedStockLocationIds: number[];
  productionGroups: ProductionGroupOption[];
  onAutoAssign: (bucket: ClientPlanBucket) => Partial<Record<ProductionGroupKey, number>>;
};

type PlannerBucketItemsDialogProps = PlannerBucketDialogProps & {
  language: SdeLanguage;
};

const activityLocationFields: Array<{
  key: keyof Omit<PlanBucketLocations, "stock">;
  label: string;
  bonus: LocationBonus;
}> = [
  { key: "manufacturing", label: "Manufacturing location", bonus: "manufacturing" },
  { key: "reactions", label: "Reaction location", bonus: "reaction" },
  { key: "reprocessing", label: "Reprocessing location", bonus: "reprocessing" },
  { key: "copying", label: "Copying location", bonus: "manufacturing" },
  { key: "invention", label: "Invention location", bonus: "manufacturing" },
];

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

function useBucketDraft(bucket: ClientPlanBucket | null) {
  const [draft, setDraft] = useState<ClientPlanBucket | null>(() => bucket);

  return [draft, setDraft] as const;
}

function BucketDetailsContent({
  draft,
  activityLocations,
  stockLocations,
  excludedStockLocationIds,
  productionGroups,
  error,
  onChange,
}: {
  draft: ClientPlanBucket;
  activityLocations: ActivityLocationOption[];
  stockLocations: StockLocationOption[];
  excludedStockLocationIds: number[];
  productionGroups: ProductionGroupOption[];
  error: string;
  onChange: (bucket: ClientPlanBucket) => void;
}) {
  function selectStockLocation(locationId: number) {
    const location = stockLocations.find((candidate) => candidate.locationId === locationId);
    onChange({
      ...draft,
      stockLocationName: location?.name ?? draft.stockLocationName,
      locations: { ...draft.locations, stock: locationId },
    });
  }

  function selectGroupFacility(key: ProductionGroupKey, value: string | null) {
    const assignments = { ...(draft.groupAssignments ?? {}) };
    if (!value || value === "default") delete assignments[key];
    else assignments[key] = Number(value);
    onChange({
      ...draft,
      groupAssignments: Object.keys(assignments).length > 0 ? assignments : undefined,
    });
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
          <span className="text-xs font-medium uppercase">
            Stockpile location (end destination)
          </span>
          <LocationCombobox
            label="Stockpile location (end destination)"
            options={stockLocations.filter(
              (location) =>
                !excludedStockLocationIds.includes(location.locationId)
                || location.locationId === draft.locations.stock,
            )}
            selected={stockLocations.find(
              (location) => location.locationId === draft.locations.stock,
            )}
            bonus="none"
            onSelect={selectStockLocation}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activityLocationFields.map(({ key, label, bonus }) => {
          const selected = activityLocations.find(
            (location) => location.locationId === draft.locations[key],
          );
          return (
            <label className="flex min-w-0 flex-col gap-2" key={key}>
              <span className="flex items-center justify-between gap-2 text-xs font-medium uppercase">
                <span>{label}</span>
                {formatSelectedLocationModifier(selected, bonus) && (
                  <span className="shrink-0 text-muted-foreground">
                    {formatSelectedLocationModifier(selected, bonus)}
                  </span>
                )}
              </span>
              <LocationCombobox
                label={label}
                options={activityLocations}
                selected={selected}
                bonus={bonus}
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

      {productionGroups.length > 0 && (
        <section className="flex min-w-0 flex-col gap-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-medium">Production facilities</h3>
            <p className="text-xs text-muted-foreground">
              Optionally, assign specialized facilities by product group, or use the activity
              default. The buttons in the footer are a great place to start.
            </p>
          </div>
          <div className="grid min-w-0 gap-x-3 gap-y-8 sm:grid-cols-2">
            {productionGroups.map((group) => {
              const selectedId = draft.groupAssignments?.[group.key];
              const selected = group.facilities.find(
                (facility) => facility.locationId === selectedId,
              );
              const defaultFacility = activityLocations.find(
                (facility) =>
                  facility.locationId
                  === draft.locations[
                    group.activity === "manufacturing" ? "manufacturing" : "reactions"
                  ],
              );
              const materialPercentage =
                selected?.materialPercentage
                ?? (group.activity === "manufacturing"
                  ? defaultFacility?.baseManufacturingMe
                  : defaultFacility?.baseReactionMe)
                ?? 0;
              const sortedFacilities = [...group.facilities].sort(
                (left, right) =>
                  left.materialPercentage - right.materialPercentage
                  || left.name.localeCompare(right.name),
              );
              const groupedFacilities = [
                { kind: "structure" as const, label: "Structures" },
                { kind: "station" as const, label: "Stations" },
              ].map((facilityGroup) => ({
                ...facilityGroup,
                facilities: sortedFacilities.filter(
                  (facility) => facility.kind === facilityGroup.kind,
                ),
              }));
              return (
                <div className="flex min-w-0 flex-col gap-2" key={group.key}>
                  <span className="flex items-center justify-between gap-2 text-xs font-medium uppercase">
                    <span>{group.label}</span>
                    <span className="shrink-0 text-muted-foreground">
                      ME {materialPercentage > 0 ? "+" : ""}
                      {materialPercentage.toFixed(1)}%
                    </span>
                  </span>
                  <Select
                    value={selectedId === undefined ? "default" : String(selectedId)}
                    onValueChange={(value) => selectGroupFacility(group.key, value)}
                    disabled={group.facilities.length === 0}
                    items={[
                      { value: "default", label: "Use manufacturing default" },
                      ...sortedFacilities.map((facility) => ({
                        value: String(facility.locationId),
                        label: `${facility.name} (ME ${facility.materialPercentage > 0 ? "+" : ""}${facility.materialPercentage.toFixed(1)}%)`,
                      })),
                    ]}
                  >
                    <SelectTrigger className="w-full" aria-label={`${group.label} facility`}>
                      <SelectValue placeholder="Use manufacturing default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Use manufacturing default</SelectItem>
                      {groupedFacilities.map((facilityGroup) => (
                        <SelectGroup key={facilityGroup.kind}>
                          <SelectLabel>{facilityGroup.label}</SelectLabel>
                          {facilityGroup.facilities.map((facility) => (
                            <SelectItem
                              value={String(facility.locationId)}
                              key={`${group.key}-${facility.locationId}`}
                            >
                              {facility.name} (ME {facility.materialPercentage > 0 ? "+" : ""}
                              {facility.materialPercentage.toFixed(1)}%)
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function BucketItemsContent({
  draft,
  language,
  error,
  onError,
  onChange,
}: {
  draft: ClientPlanBucket;
  language: SdeLanguage;
  error: string;
  onError: (message: string) => void;
  onChange: (bucket: ClientPlanBucket) => void;
}) {
  const [isPasteOpen, setIsPasteOpen] = useState(false);

  function updateItems(items: ClientBuildItem[]) {
    onChange({ ...draft, items });
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
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_8rem_2rem] items-center gap-2"
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

function PlannerBucketDialogLayout({
  open,
  onOpenChange,
  title,
  description,
  content,
  onAuto,
  onDefaultAll,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  content: React.ReactNode;
  onAuto?: () => void;
  onDefaultAll?: () => void;
  onSave: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<"auto" | "defaultAll" | null>(null);

  function confirmAction() {
    if (pendingAction === "auto") onAuto?.();
    if (pendingAction === "defaultAll") onDefaultAll?.();
    setPendingAction(null);
  }

  if (!open) return null;

  const actionButtons = (
    <div className="flex gap-2">
      {onAuto && (
        <Button type="button" variant="outline" onClick={() => setPendingAction("auto")}>
          <WandSparkles data-icon="inline-start" aria-hidden="true" />
          Auto Assign
        </Button>
      )}
      {onDefaultAll && (
        <Button type="button" variant="outline" onClick={() => setPendingAction("defaultAll")}>
          <ListRestart data-icon="inline-start" aria-hidden="true" />
          Default All
        </Button>
      )}
    </div>
  );

  const standardFooterActions = (
    <div className="flex gap-2">
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        <X data-icon="inline-start" aria-hidden="true" />
        Cancel
      </Button>
      <Button type="button" onClick={onSave}>
        <Save data-icon="inline-start" aria-hidden="true" />
        Save changes
      </Button>
    </div>
  );

  const confirmationDialog = (
    <Dialog
      open={pendingAction !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setPendingAction(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
          <DialogDescription>
            {pendingAction === "auto"
              ? "Auto assignment will replace the current production facility overrides."
              : "Default All will clear every production facility override and use the activity defaults."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setPendingAction(null)}>
            Cancel
          </Button>
          <Button type="button" onClick={confirmAction}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      <ResponsiveDialogDrawer
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        drawerClassName="h-[80vh]"
        drawerBodyClassName="pr-5"
        drawerContentClassName="py-4"
        drawerFooterContent={
          <DrawerFooter className="flex-row justify-between sm:!justify-between">
            {actionButtons}
            {standardFooterActions}
          </DrawerFooter>
        }
        dialogClassName="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-4xl"
        dialogBodyClassName=""
        dialogFooterContent={
          <DialogFooter className="flex-row justify-between sm:!justify-between">
            {actionButtons}
            {standardFooterActions}
          </DialogFooter>
        }
      >
        {content}
      </ResponsiveDialogDrawer>
      {confirmationDialog}
    </>
  );
}

export function PlannerBucketDetailsDialog({
  bucket,
  open,
  activityLocations,
  stockLocations,
  excludedStockLocationIds,
  productionGroups,
  onAutoAssign,
  onOpenChange,
  onSave,
}: PlannerBucketDetailsDialogProps) {
  const [draft, setDraft] = useBucketDraft(bucket);
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
    <BucketDetailsContent
      draft={draft}
      activityLocations={activityLocations}
      stockLocations={stockLocations}
      excludedStockLocationIds={excludedStockLocationIds}
      productionGroups={productionGroups}
      error={error}
      onChange={setDraft}
    />
  );

  return (
    <PlannerBucketDialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={bucket ? "Edit stockpile details" : "Add stockpile details"}
      description="Set the name and stations for this stockpile."
      content={content}
      onAuto={() =>
        setDraft((current) =>
          current ? { ...current, groupAssignments: onAutoAssign(current) } : current,
        )
      }
      onDefaultAll={() =>
        setDraft((current) => (current ? { ...current, groupAssignments: undefined } : current))
      }
      onSave={saveDraft}
    />
  );
}

export function PlannerBucketItemsDialog({
  bucket,
  open,
  language,
  onOpenChange,
  onSave,
}: PlannerBucketItemsDialogProps) {
  const [draft, setDraft] = useBucketDraft(bucket);
  const [error, setError] = useState("");

  if (!open || !draft) return null;
  const currentDraft = draft;

  function saveDraft() {
    setError("");
    if (onSave(currentDraft) !== false) onOpenChange(false);
  }

  return (
    <PlannerBucketDialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Edit stockpile items"
      description="Set the items and quantities for this stockpile."
      content={
        <BucketItemsContent
          draft={draft}
          language={language}
          error={error}
          onError={setError}
          onChange={setDraft}
        />
      }
      onSave={saveDraft}
    />
  );
}

export type {
  ActivityLocationOption,
  PlannerBucketDetailsDialogProps,
  PlannerBucketItemsDialogProps,
  StockLocationOption,
};
