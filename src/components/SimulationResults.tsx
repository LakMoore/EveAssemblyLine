"use client";

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AlertTriangle,
  Atom,
  Boxes,
  Brain,
  Factory,
  FlaskConical,
  ShoppingCart,
  TriangleAlert,
  Truck,
  ClipboardList,
  Copy as CopyIcon,
  type LucideIcon,
  Minimize2,
  TestTubes,
} from "lucide-react";
import SimpleResultRow from "@/components/SimpleResultRow";
import SimulationResultGroup from "@/components/SimulationResultGroup";
import SimulationResultsTab from "@/components/SimulatorResultsTab";
import SwitchedResultRow from "@/components/SwitchedResultRow";
import CopyableText from "@/components/CopyableText";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { eveCharacterPortraitUrl, eveCorporationLogoUrl } from "@/lib/eve/imageServer";
import { AssemblyLineGroups } from "@/lib/reference/assemblyLineGroups";
import type {
  SimulationCopyJob,
  SimulationHaulTask,
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationMaterialBalance,
  SimulationMaterialLocationBucket,
  SimulationPurchase,
  SimulationReprocessingJob,
  SimulationResultV1,
} from "@/lib/planning/simulator/types";

type SimulationTab =
  | "warnings"
  | "plan"
  | "reprocess"
  | "copy"
  | "invent"
  | "react"
  | "manufacture"
  | "skills"
  | "haul"
  | "buy"
  | "surplus";

const tabs: Array<{ value: SimulationTab; label: string; icon: LucideIcon }> = [
  { value: "warnings", label: "Warnings", icon: AlertTriangle },
  { value: "plan", label: "Plan", icon: ClipboardList },
  { value: "haul", label: "Haul", icon: Truck },
  { value: "buy", label: "Buy", icon: ShoppingCart },
  { value: "reprocess", label: "Reprocess", icon: Minimize2 },
  { value: "copy", label: "Copy", icon: TestTubes },
  { value: "invent", label: "Invent", icon: FlaskConical },
  { value: "react", label: "React", icon: Atom },
  { value: "manufacture", label: "Manufacture", icon: Factory },
  { value: "skills", label: "Skills", icon: Brain },
  { value: "surplus", label: "Surplus", icon: Boxes },
];

const materialBalanceColumns = [
  "Available",
  "Immediate Demand",
  "Future Supply",
  "Future Demand",
  "Transferred Out",
  "Surplus",
] as const;
const typeIdChangedEvent = "assembly-line-planner-type-id-changed";

/** Parses a positive type ID from the planner URL query string. */
function parseTypeId(value: string | null): number | null {
  const typeId = Number(value);
  return Number.isSafeInteger(typeId) && typeId > 0 ? typeId : null;
}

/** Reads the shared planner type filter from the current URL. */
function readTypeIdFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  return parseTypeId(new URLSearchParams(window.location.search).get("typeId"));
}

/** Subscribes a simulator filter to browser URL and history changes. */
function subscribeToTypeId(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener(typeIdChangedEvent, onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener(typeIdChangedEvent, onStoreChange);
  };
}

/** Provides the server snapshot for the browser-only planner type filter. */
function getServerTypeIdSnapshot(): number | null {
  return null;
}

/** Updates the shared planner type filter without navigating away from the result view. */
function updateTypeIdInUrl(typeId: number | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (typeId === null) url.searchParams.delete("typeId");
  else url.searchParams.set("typeId", String(typeId));
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(typeIdChangedEvent));
}

type SimulationRowControls = {
  selectedRowKey: string | null;
  onSelectRow: (rowKey: string) => void;
  isIncluded: (rowKey: string) => boolean;
  onIncludedChange: (rowKey: string, included: boolean) => void;
  isCompleted: (rowKey: string) => boolean;
  onCompletedChange: (rowKey: string, completed: boolean) => void;
  onOpenPlan: () => void;
};

type SimulationGroupAvatar = {
  typeId: number;
  name: string;
  imageVariation?: "icon" | "bp" | "bpc";
};

/** Formats simulator quantities for compact operational rows. */
function quantity(value: number): string {
  return value.toLocaleString();
}

/** Returns the rounded total volume represented by a group of simulation haul tasks. */
function simulationHaulVolume(tasks: readonly SimulationHaulTask[]): number {
  return Math.ceil(tasks.reduce((total, task) => total + task.quantity * task.unitVolume, 0));
}

/** Renders a simulator number with its raw value available for copying. */
function CopyableNumber({
  value,
  suffix = "",
  copyLabel = "Number",
}: {
  value: number;
  suffix?: string;
  copyLabel?: string;
}) {
  return (
    <CopyableText
      aria-label={`${copyLabel}: ${quantity(value)}${suffix}. Copy to clipboard.`}
      className="font-[inherit] text-inherit"
      textToRender={`${quantity(value)}${suffix}`}
      textToCopy={String(value)}
      copyLabel={copyLabel}
    />
  );
}

/** Resolves a readable location label from current planner reference data. */
function locationName(locationNamesById: ReadonlyMap<number, string>, locationId: number): string {
  return locationNamesById.get(locationId) ?? `Location ${locationId}`;
}

/** Returns named stockpiles that contributed demand to an aggregate ledger balance. */
function demandStockpiles(
  balance: SimulationMaterialBalance,
  stockpileNamesById: ReadonlyMap<string, string>,
): string {
  const stockpiles = [...new Set(balance.demandSources.map((source) => source.stockpileId))];
  return stockpiles.length > 0
    ? `Stockpiles: ${stockpiles
        .map((stockpileId) => stockpileNamesById.get(stockpileId) ?? stockpileId)
        .join(", ")}`
    : "Ledger balance";
}

/** Creates a compact preview sequence for a collapsible simulation result group. */
function createGroupAvatars<T>(items: readonly T[], getAvatar: (item: T) => SimulationGroupAvatar) {
  return items
    .slice(0, 5)
    .map((item) => {
      const avatar = getAvatar(item);
      return { ...avatar, imageVariation: avatar.imageVariation ?? "icon" };
    });
}

/** Calculates the total future material supply shown in a simulator balance row. */
function futureSupply(item: SimulationMaterialBalance): number {
  return (
    item.availableFromHauling
    + item.availableFromProduction
    + item.availableFromCopying
    + item.availableFromInvention
    + item.availableFromReprocessing
    + item.availableFromMarket
  );
}

/** Maps simulator blueprint kinds to the corresponding EVE image variation. */
function haulImageVariation(kind: SimulationHaulTask["blueprintKind"]): "icon" | "bp" | "bpc" {
  if (kind === "bpc") return "bpc";
  return kind === undefined ? "icon" : "bp";
}

/** Selects blueprint artwork for blueprint-named balances in the plan ledger. */
function materialImageVariation(typeName: string): "icon" | "bp" {
  return /\bblueprint$/i.test(typeName) ? "bp" : "icon";
}

/** Renders location-scoped rows inside collapsible result groups. */
function SimulationLocationResultGroups<T extends { locationId: number }>({
  tab,
  items,
  locationNamesById,
  openGroups,
  onOpenGroupChange,
  getRowKey,
  getAvatar,
  groupHeader,
  renderRow,
}: {
  tab: SimulationTab;
  items: readonly T[];
  locationNamesById: ReadonlyMap<number, string>;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
  getRowKey: (item: T) => string;
  getAvatar: (item: T) => SimulationGroupAvatar;
  groupHeader?: ReactNode;
  renderRow: (item: T) => ReactNode;
}) {
  const itemsByLocation = new Map<number, T[]>();
  for (const item of items) {
    const groupItems = itemsByLocation.get(item.locationId) ?? [];
    groupItems.push(item);
    itemsByLocation.set(item.locationId, groupItems);
  }
  const sortedGroups = [...itemsByLocation.entries()].sort(([leftId], [rightId]) =>
    locationName(locationNamesById, leftId).localeCompare(locationName(locationNamesById, rightId)),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {sortedGroups.map(([locationId, groupItems]) => {
        const groupKey = `${tab}:${locationId}`;
        const avatars = createGroupAvatars(groupItems, getAvatar);
        return (
          <SimulationResultGroup
            groupKey={groupKey}
            key={groupKey}
            label={locationName(locationNamesById, locationId)}
            isOpen={openGroups[groupKey] ?? true}
            onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
            avatarRows={avatars}
            remainingCount={groupItems.length - avatars.length}
          >
            <div className="flex min-w-0 flex-col">
              {groupHeader}
              {groupItems.map((item) => (
                <div key={getRowKey(item)}>{renderRow(item)}</div>
              ))}
            </div>
          </SimulationResultGroup>
        );
      })}
    </div>
  );
}

/** Renders the grouped material ledger for Plan or Surplus. */
function SimulationMaterialsTab({
  tab,
  buckets,
  locationNamesById,
  stockpileNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  tab: "plan" | "surplus";
  buckets: SimulationMaterialLocationBucket[];
  locationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const items = buckets.flatMap((bucket) => bucket.items);
  const selectedTypeId = useSyncExternalStore(
    subscribeToTypeId,
    readTypeIdFromUrl,
    getServerTypeIdSnapshot,
  );
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    const rawTypeId = new URLSearchParams(window.location.search).get("typeId");
    if (rawTypeId !== null && selectedTypeId === null) updateTypeIdInUrl(null);
  }, [selectedTypeId]);
  const typeOptions = [...new Map(items.map((item) => [item.typeId, item.typeName])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  useEffect(() => {
    if (selectedTypeId === null || typeOptions.some((option) => option.id === selectedTypeId)) {
      return;
    }
    if (readTypeIdFromUrl() === selectedTypeId) updateTypeIdInUrl(null);
  }, [selectedTypeId, typeOptions]);
  const effectiveSelectedTypeId = typeOptions.some((option) => option.id === selectedTypeId)
    ? selectedTypeId
    : null;
  const filteredItems =
    effectiveSelectedTypeId === null
      ? items
      : items.filter((item) => item.typeId === effectiveSelectedTypeId);
  const selectedType = typeOptions.find((option) => option.id === effectiveSelectedTypeId) ?? null;

  async function copyTable() {
    const lines = [
      ["Type", ...materialBalanceColumns].join("\t"),
      ...filteredItems.map((item) =>
        [
          item.typeName,
          item.availableNow.toLocaleString(),
          item.requiredNow.toLocaleString(),
          futureSupply(item).toLocaleString(),
          item.reserved.toLocaleString(),
          item.transferredOut.toLocaleString(),
          item.surplus.toLocaleString(),
        ].join("\t"),
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("Copied");
      toast.add({ description: "Material table copied to clipboard" });
      window.setTimeout(() => setCopyStatus(""), 1600);
    }
    catch {
      setCopyStatus("Copy failed");
      toast.add({ description: "Could not copy material table", type: "error" });
    }
  }

  return (
    <SimulationResultsTab
      hasResults={items.length > 0}
      settings={
        items.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2.5 py-3.5 pb-2.5 max-[640px]:flex-col max-[640px]:items-stretch">
            <div className="flex w-auto items-center gap-2.5 max-[640px]:w-full max-[640px]:flex-col max-[640px]:items-stretch">
              <Label className="max-[640px]:self-start" htmlFor={`simulation-${tab}-type`}>
                TYPE
              </Label>
              <div className="w-full min-w-0 max-[640px]:overflow-hidden sm:w-72 lg:w-96">
                <Combobox
                  items={typeOptions}
                  itemToStringLabel={(option) => option.name}
                  value={selectedType}
                  onValueChange={(value) => {
                    const nextTypeId = value?.id ?? null;
                    updateTypeIdInUrl(nextTypeId);
                  }}
                >
                  <ComboboxInput
                    id={`simulation-${tab}-type`}
                    placeholder="Filter by type"
                    aria-label="Filter simulation by material type"
                    showClear
                    className="w-full [&>input]:text-xs!"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>No matching material types.</ComboboxEmpty>
                    <ComboboxList>
                      <ComboboxCollection>
                        {(option) => (
                          <ComboboxItem key={option.id} value={option}>
                            {option.name}
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="max-[640px]:w-full"
              onClick={() => void copyTable()}
              disabled={filteredItems.length === 0}
            >
              <CopyIcon aria-hidden="true" />
              {copyStatus || "Copy table"}
            </Button>
          </div>
        ) : undefined
      }
    >
      {filteredItems.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No matching materials</EmptyTitle>
            <EmptyDescription>Clear the type filter to show all materials.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SimulationLocationResultGroups
          tab={tab}
          items={filteredItems}
          locationNamesById={locationNamesById}
          openGroups={openGroups}
          onOpenGroupChange={onOpenGroupChange}
          getRowKey={(item) => `${tab}:${item.locationId}:${item.typeId}`}
          getAvatar={(item) => ({ typeId: item.typeId, name: item.typeName })}
          groupHeader={<MaterialBalanceHeader />}
          renderRow={(item) => {
            const rowKey = `${tab}:${item.locationId}:${item.typeId}`;
            return (
              <SimpleResultRow
                name={item.typeName}
                typeId={item.typeId}
                subline={demandStockpiles(item, stockpileNamesById)}
                linkPath="planner"
                navigateInPlace
                selected={controls.selectedRowKey === rowKey}
                onClick={() => controls.onSelectRow(rowKey)}
                variation={materialImageVariation(item.typeName)}
                wideBreakpoint="md"
                contentClassName="self-end text-right font-mono text-xs md:w-full md:self-auto"
              >
                <MaterialBalanceSummary item={item} />
              </SimpleResultRow>
            );
          }}
        />
      )}
    </SimulationResultsTab>
  );
}

/** Renders the detail columns for a simulator material balance. */
function MaterialBalanceSummary({ item }: { item: SimulationMaterialBalance }) {
  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-right md:grid-cols-6 md:gap-x-3">
      <span className="text-muted-foreground md:hidden">Available</span>
      <span>
        <CopyableNumber value={item.availableNow} copyLabel="Available quantity" />
      </span>
      <span className="text-muted-foreground md:hidden">Immediate Demand</span>
      <span>
        <CopyableNumber value={item.requiredNow} copyLabel="Immediate demand" />
      </span>
      <span className="text-muted-foreground md:hidden">Future Supply</span>
      <span>
        <CopyableNumber value={futureSupply(item)} copyLabel="Future supply" />
      </span>
      <span className="text-muted-foreground md:hidden">Future Demand</span>
      <span>
        <CopyableNumber value={item.reserved} copyLabel="Future demand" />
      </span>
      <span className="text-muted-foreground md:hidden">Transferred Out</span>
      <span>
        <CopyableNumber value={item.transferredOut} copyLabel="Transferred quantity" />
      </span>
      <span className="text-muted-foreground md:hidden">Surplus</span>
      <span>
        <CopyableNumber value={item.surplus} copyLabel="Surplus quantity" />
      </span>
    </div>
  );
}

/** Renders the desktop labels for the Plan and Surplus material columns. */
function MaterialBalanceHeader() {
  return (
    <div className="hidden min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-[13px] p-2 md:grid">
      <span aria-hidden="true" />
      <div className="grid grid-cols-6 gap-x-3 text-right font-mono text-[10px] text-muted-foreground uppercase">
        {materialBalanceColumns.map((column) => (
          <span key={column}>{column}</span>
        ))}
      </div>
    </div>
  );
}

/** Renders simulator reprocessing jobs grouped by their working location. */
function SimulationReprocessingTab({
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  jobs: SimulationReprocessingJob[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="reprocess"
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({ typeId: job.sourceTypeId, name: job.sourceTypeName })}
        renderRow={(job) => (
          <SimulationSimpleJobRow
            rowKey={`reprocess:${job.jobId}`}
            typeId={job.sourceTypeId}
            name={job.sourceTypeName}
            subline={job.state}
            summary={<CopyableNumber value={job.sourceQuantity} copyLabel="Source quantity" />}
            controls={controls}
          />
        )}
      />
    </SimulationResultsTab>
  );
}

/** Renders simulator copy jobs grouped by their working location. */
function SimulationCopyTab({
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  jobs: SimulationCopyJob[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="copy"
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({
          typeId: job.blueprintTypeId,
          name: `Blueprint ${job.blueprintTypeId}`,
          imageVariation: "bp",
        })}
        renderRow={(job) => (
          <SimulationSimpleJobRow
            rowKey={`copy:${job.jobId}`}
            typeId={job.blueprintTypeId}
            name={`Blueprint ${job.blueprintTypeId}`}
            subline={
              <CopyableNumber
                value={job.totalLicensedRuns}
                suffix=" licensed runs"
                copyLabel="Licensed runs"
              />
            }
            summary={<CopyableNumber value={job.copies} suffix=" copies" copyLabel="Copies" />}
            variation="bp"
            controls={controls}
          />
        )}
      />
    </SimulationResultsTab>
  );
}

/** Renders simulator invention jobs grouped by their working location. */
function SimulationInventionTab({
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  jobs: SimulationInventionJob[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab="invent"
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({
          typeId: job.outputBlueprintTypeId,
          name: `Blueprint ${job.outputBlueprintTypeId}`,
          imageVariation: "bpc",
        })}
        renderRow={(job) => (
          <SimulationSimpleJobRow
            rowKey={`invent:${job.jobId}`}
            typeId={job.outputBlueprintTypeId}
            name={`Blueprint ${job.outputBlueprintTypeId}`}
            subline={
              <CopyableNumber
                value={Math.round(job.successProbability * 100)}
                suffix="% success probability"
                copyLabel="Success probability"
              />
            }
            summary={
              <CopyableNumber value={job.attempts} suffix=" attempts" copyLabel="Attempts" />
            }
            variation="bpc"
            controls={controls}
          />
        )}
      />
    </SimulationResultsTab>
  );
}

/** Renders a simple selectable operational job row. */
function SimulationSimpleJobRow({
  rowKey,
  typeId,
  name,
  subline,
  summary,
  variation = "icon",
  controls,
}: {
  rowKey: string;
  typeId: number;
  name: string;
  subline: ReactNode;
  summary: ReactNode;
  variation?: "icon" | "bp" | "bpc";
  controls: SimulationRowControls;
}) {
  return (
    <SimpleResultRow
      name={name}
      typeId={typeId}
      subline={subline}
      variation={variation}
      linkPath="planner"
      linkIcon={ClipboardList}
      linkSearchParams={{ tab: "Plan" }}
      linkHash="plan-breakdown"
      navigateInPlace
      onNavigate={controls.onOpenPlan}
      selected={controls.selectedRowKey === rowKey}
      onClick={() => controls.onSelectRow(rowKey)}
      contentClassName="self-end text-right font-mono text-xs sm:self-auto"
    >
      {summary}
    </SimpleResultRow>
  );
}

type SimulationBuyEntry = {
  purchase: SimulationPurchase;
  isMaterial: boolean;
};

/** Serializes material purchases in the format accepted by EVE Multibuy. */
function multibuyText(entries: readonly SimulationBuyEntry[]): string {
  return entries
    .filter((entry) => entry.isMaterial)
    .map(({ purchase }) => `${purchase.typeName}\t${purchase.quantity}`)
    .join("\n");
}

/** Renders reaction or manufacturing jobs grouped by their working location. */
function SimulationActivityTab({
  tab,
  jobs,
  locationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  tab: "react" | "manufacture";
  jobs: SimulationIndustryJob[];
  locationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const activityLabel = tab === "react" ? "reaction" : "manufacturing";
  return (
    <SimulationResultsTab hasResults={jobs.length > 0}>
      <SimulationLocationResultGroups
        tab={tab}
        items={jobs}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
        getRowKey={(job) => job.jobId}
        getAvatar={(job) => ({
          typeId: job.productTypeId,
          name: job.productName,
          imageVariation: "icon",
        })}
        renderRow={(job) => {
          const rowKey = `${tab}:${job.jobId}`;
          const included = controls.isIncluded(rowKey);
          const completed = controls.isCompleted(rowKey);
          return (
            <SwitchedResultRow
              name={job.productName}
              typeId={job.productTypeId}
              subline={` | ${job.inputs.length} inputs`}
              variation="icon"
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ tab: "Plan" }}
              linkHash="plan-breakdown"
              navigateInPlace
              onNavigate={controls.onOpenPlan}
              selected={!completed && controls.selectedRowKey === rowKey}
              installed={completed}
              onClick={completed ? undefined : () => controls.onSelectRow(rowKey)}
              switchChecked={included}
              switchTooltip={`Include in ${activityLabel} schedule`}
              onSwitchChange={(checked) => controls.onIncludedChange(rowKey, checked)}
              checkboxChecked={completed}
              checkboxDisabled={!included}
              checkboxTooltip={
                tab === "react" ? "Mark reaction installed" : "Mark manufacturing job installed"
              }
              onCheckboxChange={(checked) => controls.onCompletedChange(rowKey, checked)}
              contentClassName="self-end text-right font-mono text-xs sm:self-auto"
            >
              <CopyableNumber value={job.readyNowRuns} suffix=" / " copyLabel="Ready runs" />
              <CopyableNumber value={job.requiredRuns} suffix=" runs" copyLabel="Required runs" />
            </SwitchedResultRow>
          );
        }}
      />
    </SimulationResultsTab>
  );
}

/** Renders haul tasks grouped first by source and then by destination location. */
function SimulationHaulTab({
  tasks,
  locationNamesById,
  characterNamesById,
  corporationNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  tasks: SimulationHaulTask[];
  locationNamesById: ReadonlyMap<number, string>;
  characterNamesById: ReadonlyMap<number, string>;
  corporationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const tasksBySource = new Map<number, Map<number, SimulationHaulTask[]>>();
  for (const task of tasks) {
    const destinations =
      tasksBySource.get(task.fromLocationId) ?? new Map<number, SimulationHaulTask[]>();
    const destinationTasks = destinations.get(task.toLocationId) ?? [];
    destinationTasks.push(task);
    destinations.set(task.toLocationId, destinationTasks);
    tasksBySource.set(task.fromLocationId, destinations);
  }
  const sourceGroups = [...tasksBySource.entries()].sort(([leftId], [rightId]) =>
    locationName(locationNamesById, leftId).localeCompare(locationName(locationNamesById, rightId)),
  );

  return (
    <SimulationResultsTab hasResults={tasks.length > 0}>
      <div className="flex min-w-0 flex-col gap-4">
        {sourceGroups.map(([fromLocationId, destinations]) => {
          const sourceTasks = [...destinations.values()].flat();
          const sourceKey = `haul:from:${fromLocationId}`;
          const sourceAvatars = createGroupAvatars(
            sourceTasks,
            (task) => ({
              typeId: task.typeId,
              name: task.typeName,
              imageVariation: haulImageVariation(task.blueprintKind),
            }),
          );
          return (
            <SimulationResultGroup
              groupKey={sourceKey}
              key={sourceKey}
              label={
                <>
                  <span className="text-(--theme-info)">From:&nbsp;</span>
                  {locationName(locationNamesById, fromLocationId)}
                </>
              }
              ariaLabel={`From: ${locationName(locationNamesById, fromLocationId)}`}
              isOpen={openGroups[sourceKey] ?? true}
              onOpenChange={(open) => onOpenGroupChange(sourceKey, open)}
              avatarRows={sourceAvatars}
              remainingCount={sourceTasks.length - sourceAvatars.length}
            >
              <div className="flex min-w-0 flex-col gap-3 pb-3">
                {[...destinations.entries()]
                  .sort(([leftId], [rightId]) =>
                    locationName(locationNamesById, leftId).localeCompare(
                      locationName(locationNamesById, rightId),
                    ),
                  )
                  .map(([toLocationId, destinationTasks]) => {
                    const destinationKey = `${sourceKey}:to:${toLocationId}`;
                    const destinationVolume = simulationHaulVolume(destinationTasks);
                    const destinationVolumeLabel = `${quantity(destinationVolume)} cubic meters`;
                    const destinationAvatars = createGroupAvatars(
                      destinationTasks,
                      (task) => ({
                        typeId: task.typeId,
                        name: task.typeName,
                        imageVariation: haulImageVariation(task.blueprintKind),
                      }),
                    );
                    return (
                      <SimulationResultGroup
                        groupKey={destinationKey}
                        key={destinationKey}
                        label={
                          <>
                            <span className="text-(--theme-info)">To:&nbsp;</span>
                            {locationName(locationNamesById, toLocationId)}
                          </>
                        }
                        trailingContent={
                          <strong className="shrink-0 text-lg whitespace-nowrap text-(--theme-info) lowercase">
                            {quantity(destinationVolume)} m<sup>3</sup>
                          </strong>
                        }
                        ariaLabel={`To: ${locationName(locationNamesById, toLocationId)}, ${destinationVolumeLabel}`}
                        variant="nested"
                        isOpen={openGroups[destinationKey] ?? true}
                        onOpenChange={(open) => onOpenGroupChange(destinationKey, open)}
                        avatarRows={destinationAvatars}
                        remainingCount={destinationTasks.length - destinationAvatars.length}
                      >
                        <div className="flex min-w-0 flex-col">
                          {destinationTasks.map((task) => (
                            <SimulationHaulRow
                              key={task.transferId}
                              task={task}
                              characterNamesById={characterNamesById}
                              corporationNamesById={corporationNamesById}
                              controls={controls}
                            />
                          ))}
                        </div>
                      </SimulationResultGroup>
                    );
                  })}
              </div>
            </SimulationResultGroup>
          );
        })}
      </div>
    </SimulationResultsTab>
  );
}

/** Renders a selectable, completion-trackable haul task. */
function SimulationHaulRow({
  task,
  characterNamesById,
  corporationNamesById,
  controls,
}: {
  task: SimulationHaulTask;
  characterNamesById: ReadonlyMap<number, string>;
  corporationNamesById: ReadonlyMap<number, string>;
  controls: SimulationRowControls;
}) {
  const rowKey = `haul:${task.transferId}`;
  const included = controls.isIncluded(rowKey);
  const completed = controls.isCompleted(rowKey);
  const owner =
    task.ownerType !== undefined && task.ownerId !== undefined
      ? { type: task.ownerType, id: task.ownerId }
      : null;
  return (
    <SwitchedResultRow
      name={task.typeName}
      typeId={task.typeId}
      variation={haulImageVariation(task.blueprintKind)}
      subline={
        <CopyableNumber
          value={Math.ceil(task.quantity * task.unitVolume)}
          suffix={` m3 | ${task.purpose}`}
          copyLabel="Haul volume"
        />
      }
      linkPath="planner"
      linkIcon={ClipboardList}
      linkSearchParams={{ tab: "Plan" }}
      linkHash="plan-breakdown"
      navigateInPlace
      onNavigate={controls.onOpenPlan}
      selected={!completed && controls.selectedRowKey === rowKey}
      installed={completed}
      onClick={completed ? undefined : () => controls.onSelectRow(rowKey)}
      switchChecked={included}
      switchTooltip="Include in haul plan"
      onSwitchChange={(checked) => controls.onIncludedChange(rowKey, checked)}
      checkboxChecked={completed}
      checkboxDisabled={!included}
      checkboxTooltip="Mark as moved"
      onCheckboxChange={(checked) => controls.onCompletedChange(rowKey, checked)}
      contentClassName="self-end text-right font-mono text-xs sm:self-auto"
    >
      <span
        className={
          owner !== null
            ? "flex w-full items-center justify-between gap-2 sm:grid sm:w-auto sm:grid-cols-[auto_128px] sm:justify-normal"
            : "flex items-center"
        }
      >
        {owner !== null && (
          <Tooltip>
            <TooltipTrigger
              render={
                owner.type === "corporation" ? (
                  <Image
                    src={eveCorporationLogoUrl(owner.id, 64)}
                    alt={`${corporationNamesById.get(owner.id) ?? `Corporation ${owner.id}`} logo`}
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded-none"
                  />
                ) : (
                  <Image
                    src={eveCharacterPortraitUrl(owner.id, 64)}
                    alt={`${characterNamesById.get(owner.id) ?? `Character ${owner.id}`} portrait`}
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded-none"
                  />
                )
              }
            />
            <TooltipContent>
              Owner:&nbsp;
              {owner.type === "corporation"
                ? (corporationNamesById.get(owner.id) ?? `Corporation ${owner.id}`)
                : (characterNamesById.get(owner.id) ?? `Character ${owner.id}`)}
            </TooltipContent>
          </Tooltip>
        )}
        <span className={owner !== null ? "justify-self-end" : undefined}>
          <CopyableNumber value={task.quantity} suffix=" units" copyLabel="Haul quantity" />
        </span>
      </span>
    </SwitchedResultRow>
  );
}

/** Renders simulator purchases grouped by AssemblyLineGroup with multibuy actions. */
function SimulationBuyTab({
  result,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  result: SimulationResultV1;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const entries: SimulationBuyEntry[] = [
    ...result.lists.materialsToBuy.map((purchase) => ({ purchase, isMaterial: true })),
    ...result.lists.bpoToBuy.map((purchase) => ({ purchase, isMaterial: false })),
  ];
  const groups = AssemblyLineGroups
    .groupBy(entries, (entry) => entry.purchase.assemblyLineGroup)
    .sort((left, right) => left.assemblyLineGroup.localeCompare(right.assemblyLineGroup));
  const materialEntries = entries.filter((entry) => entry.isMaterial);
  const [copyStatus, setCopyStatus] = useState<{ scope: string; label: string } | null>(null);

  async function copyGroupMultibuy(scope: string, groupEntries: readonly SimulationBuyEntry[]) {
    try {
      await navigator.clipboard.writeText(multibuyText(groupEntries));
      setCopyStatus({ scope, label: "Copied" });
      toast.add({ description: `All ${scope} copied to clipboard` });
      window.setTimeout(
        () => {
          setCopyStatus((current) => (current?.scope === scope ? null : current));
        },
        1600,
      );
    }
    catch {
      setCopyStatus({ scope, label: "Copy failed" });
      toast.add({ description: "Could not copy multibuy group", type: "error" });
    }
  }

  return (
    <SimulationResultsTab
      hasResults={entries.length > 0}
      settings={
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={materialEntries.length === 0}
            onClick={() => void copyGroupMultibuy("all materials", materialEntries)}
          >
            <CopyIcon aria-hidden="true" />
            {copyStatus?.scope === "all materials" ? copyStatus.label : "Multibuy Materials"}
          </Button>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        {groups.map((group) => {
          const groupKey = `buy:${group.assemblyLineGroup}`;
          const materialGroupEntries = group.items.filter((entry) => entry.isMaterial);
          const groupAvatars = createGroupAvatars(
            group.items,
            (entry) => ({
              typeId: entry.purchase.typeId,
              name: entry.purchase.typeName,
              imageVariation: entry.isMaterial ? "icon" : "bp",
            }),
          );
          return (
            <SimulationResultGroup
              key={groupKey}
              groupKey={groupKey}
              label={group.assemblyLineGroup}
              ariaLabel={group.assemblyLineGroup}
              isOpen={openGroups[groupKey] ?? true}
              onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
              avatarRows={groupAvatars}
              remainingCount={group.items.length - groupAvatars.length}
              onCopyGroup={
                materialGroupEntries.length > 0
                  ? () => void copyGroupMultibuy(group.assemblyLineGroup, materialGroupEntries)
                  : undefined
              }
              copyLabel={
                copyStatus?.scope === group.assemblyLineGroup
                  ? copyStatus.label
                  : "Copy Group Multibuy"
              }
            >
              <div className="flex min-w-0 flex-col">
                {group.items.map(({ purchase, isMaterial }) => {
                  const rowKey = `buy:${isMaterial ? "material" : "blueprint"}:${purchase.typeId}:${purchase.destinations
                    .map((destination) => destination.locationId)
                    .join(":")}`;
                  return (
                    <SimulationSimpleJobRow
                      key={rowKey}
                      rowKey={rowKey}
                      typeId={purchase.typeId}
                      name={purchase.typeName}
                      subline={
                        <CopyableNumber
                          value={purchase.destinations.length}
                          suffix={` destination${purchase.destinations.length === 1 ? "" : "s"}`}
                          copyLabel="Destinations"
                        />
                      }
                      summary={
                        <CopyableNumber value={purchase.quantity} copyLabel="Purchase quantity" />
                      }
                      variation={isMaterial ? "icon" : "bp"}
                      controls={controls}
                    />
                  );
                })}
              </div>
            </SimulationResultGroup>
          );
        })}
      </div>
    </SimulationResultsTab>
  );
}

/** Renders simulator skill requirements as a simple result list. */
function SimulationSkillsTab({
  result,
  controls,
}: {
  result: SimulationResultV1;
  controls: SimulationRowControls;
}) {
  return (
    <SimulationResultsTab hasResults={result.lists.skillsRequired.length > 0}>
      <div className="flex min-w-0 flex-col">
        {result.lists.skillsRequired.map((skill) => (
          <SimulationSimpleJobRow
            key={skill.skillId}
            rowKey={`skills:${skill.skillId}`}
            typeId={skill.skillId}
            name={skill.name}
            subline={<CopyableNumber value={skill.jobIds.length} suffix=" jobs" copyLabel="Jobs" />}
            summary={
              <CopyableNumber
                value={skill.requiredLevel}
                suffix=" required level"
                copyLabel="Required skill level"
              />
            }
            controls={controls}
          />
        ))}
      </div>
    </SimulationResultsTab>
  );
}

/** Renders simulator warnings as the first output tab. */
function SimulationWarningsTab({
  result,
  locationNamesById,
  openGroups,
  onOpenGroupChange,
}: {
  result: SimulationResultV1;
  locationNamesById: ReadonlyMap<number, string>;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  const warningsByLocation = new Map<number | undefined, SimulationResultV1["lists"]["warnings"]>();
  for (const warning of result.lists.warnings) {
    const group = warningsByLocation.get(warning.locationId) ?? [];
    group.push(warning);
    warningsByLocation.set(warning.locationId, group);
  }
  const sortedGroups = [...warningsByLocation.entries()].sort(([leftId], [rightId]) =>
    (leftId === undefined ? "Unlocated" : locationName(locationNamesById, leftId)).localeCompare(
      rightId === undefined ? "Unlocated" : locationName(locationNamesById, rightId),
    ),
  );

  return (
    <SimulationResultsTab
      hasResults={result.lists.warnings.length > 0}
      emptyTitle="No warnings"
      emptyDescription="This simulation has no calculation warnings."
    >
      <div className="flex min-w-0 flex-col gap-4">
        {sortedGroups.map(([locationId, warnings]) => {
          const groupKey = `warnings:${locationId ?? "unlocated"}`;
          const label =
            locationId === undefined ? "Unlocated" : locationName(locationNamesById, locationId);
          return (
            <SimulationResultGroup
              key={groupKey}
              groupKey={groupKey}
              label={label}
              isOpen={openGroups[groupKey] ?? true}
              onOpenChange={(open) => onOpenGroupChange(groupKey, open)}
              avatarRows={[]}
              remainingCount={0}
            >
              <div className="flex min-w-0 flex-col gap-2">
                {warnings.map((warning, index) => (
                  <Alert key={`${warning.code}:${warning.jobId ?? index}`}>
                    <TriangleAlert />
                    <AlertTitle>{warning.code}</AlertTitle>
                    <AlertDescription>{warning.message}</AlertDescription>
                  </Alert>
                ))}
              </div>
            </SimulationResultGroup>
          );
        })}
      </div>
    </SimulationResultsTab>
  );
}

/** Renders the native simulator response without converting it to legacy planner result shapes. */
export default function SimulationResults({
  result,
  status,
  locationNamesById,
  characterNamesById,
  corporationNamesById,
  stockpileNamesById,
  onOpenPlan,
}: {
  result: SimulationResultV1 | null;
  status: string;
  locationNamesById: ReadonlyMap<number, string>;
  characterNamesById: ReadonlyMap<number, string>;
  corporationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  onOpenPlan: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SimulationTab>("warnings");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [includedRows, setIncludedRows] = useState<Record<string, boolean>>({});
  const [completedRows, setCompletedRows] = useState<Record<string, boolean>>({});
  const statusIsError = status.startsWith("Error:");
  const controls: SimulationRowControls = {
    selectedRowKey,
    onSelectRow: (rowKey) => setSelectedRowKey((current) => (current === rowKey ? null : rowKey)),
    isIncluded: (rowKey) => includedRows[rowKey] ?? true,
    onIncludedChange: (rowKey, included) =>
      setIncludedRows((current) => ({ ...current, [rowKey]: included })),
    isCompleted: (rowKey) => completedRows[rowKey] ?? false,
    onCompletedChange: (rowKey, completed) =>
      setCompletedRows((current) => ({ ...current, [rowKey]: completed })),
    onOpenPlan: () => {
      setActiveTab("plan");
      onOpenPlan();
    },
  };
  const onOpenGroupChange = (groupKey: string, open: boolean) =>
    setOpenGroups((current) => ({ ...current, [groupKey]: open }));

  if (!result) {
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <p aria-live="polite" className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
        {statusIsError ? (
          <Alert variant="destructive">
            <AlertTitle>Simulation failed</AlertTitle>
            <AlertDescription>{status.slice("Error: ".length)}</AlertDescription>
          </Alert>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Simulation output is ready when you are</EmptyTitle>
              <EmptyDescription>
                Simulate the active stockpiles to calculate the required work.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">SIMULATOR OUTPUT</p>
          <h2 className="text-lg font-medium">Plan breakdown</h2>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline">v{result.metadata.simulatorVersion}</Badge>
          <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
            {status}
          </span>
        </div>
      </div>
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SimulationTab)}>
        <TabsList className="w-full max-w-full justify-start overflow-x-auto" variant="line">
          {tabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon data-icon="inline-start" aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={activeTab} className="pt-3">
          <SimulationTabContent
            activeTab={activeTab}
            result={result}
            locationNamesById={locationNamesById}
            characterNamesById={characterNamesById}
            corporationNamesById={corporationNamesById}
            stockpileNamesById={stockpileNamesById}
            controls={controls}
            openGroups={openGroups}
            onOpenGroupChange={onOpenGroupChange}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}

/** Selects the focused presentation component for the active simulation output tab. */
function SimulationTabContent({
  activeTab,
  result,
  locationNamesById,
  characterNamesById,
  corporationNamesById,
  stockpileNamesById,
  controls,
  openGroups,
  onOpenGroupChange,
}: {
  activeTab: SimulationTab;
  result: SimulationResultV1;
  locationNamesById: ReadonlyMap<number, string>;
  characterNamesById: ReadonlyMap<number, string>;
  corporationNamesById: ReadonlyMap<number, string>;
  stockpileNamesById: ReadonlyMap<string, string>;
  controls: SimulationRowControls;
  openGroups: Record<string, boolean>;
  onOpenGroupChange: (groupKey: string, open: boolean) => void;
}) {
  if (activeTab === "warnings") {
    return (
      <SimulationWarningsTab
        result={result}
        locationNamesById={locationNamesById}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "plan" || activeTab === "surplus") {
    return (
      <SimulationMaterialsTab
        tab={activeTab}
        buckets={activeTab === "plan" ? result.lists.planItems : result.lists.surplusItems}
        locationNamesById={locationNamesById}
        stockpileNamesById={stockpileNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "reprocess") {
    return (
      <SimulationReprocessingTab
        jobs={result.lists.reprocessingJobs}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "copy") {
    return (
      <SimulationCopyTab
        jobs={result.lists.bpcToCopy}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "invent") {
    return (
      <SimulationInventionTab
        jobs={result.lists.inventionJobs}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "react" || activeTab === "manufacture") {
    return (
      <SimulationActivityTab
        tab={activeTab}
        jobs={activeTab === "react" ? result.lists.reactionJobs : result.lists.manufacturingJobs}
        locationNamesById={locationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "haul") {
    return (
      <SimulationHaulTab
        tasks={result.lists.haulingTasks}
        locationNamesById={locationNamesById}
        characterNamesById={characterNamesById}
        corporationNamesById={corporationNamesById}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  if (activeTab === "buy") {
    return (
      <SimulationBuyTab
        result={result}
        controls={controls}
        openGroups={openGroups}
        onOpenGroupChange={onOpenGroupChange}
      />
    );
  }
  return <SimulationSkillsTab result={result} controls={controls} />;
}
