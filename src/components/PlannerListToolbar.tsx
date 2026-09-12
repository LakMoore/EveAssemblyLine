import type { ComponentProps } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlannerActivityControls } from "@/components/PlannerActivityControls";
import styles from "@/app/page.module.css";
import { Copy as CopyIcon, Minimize2 } from "lucide-react";

type ToolbarTab = "Plan" | "Buy" | "React" | "Manufacture" | "Copy" | "Reprocess" | "Invent";
type PlanViewMode = "all" | "build-location";
type ActivityControlsProps = Omit<ComponentProps<typeof PlannerActivityControls>, "activity">;

type PlannerListToolbarProps = {
  activeTab: ToolbarTab;
  materialBuyEntryCount: number;
  onSendToCompress: () => void;
  activityControls?: ActivityControlsProps;
  planTypeOptions: Array<{ id: number; name: string }>;
  selectedTypeName?: string;
  onSelectedTypeIdChange: (typeId: number | null) => void;
  planViewMode: PlanViewMode;
  onPlanViewModeChange: (mode: PlanViewMode) => void;
  copyStatus: string;
  onCopyList: () => void;
};

/** Renders the controls shared by the planner's non-haul result tabs. */
export default function PlannerListToolbar({
  activeTab,
  materialBuyEntryCount,
  onSendToCompress,
  activityControls,
  planTypeOptions,
  selectedTypeName,
  onSelectedTypeIdChange,
  planViewMode,
  onPlanViewModeChange,
  copyStatus,
  onCopyList,
}: PlannerListToolbarProps) {
  return (
    <div
      className={`flex flex-wrap gap-2.5 py-3.5 pb-2.5 max-[640px]:flex-col max-[640px]:items-stretch ${activeTab === "React" ? "justify-start gap-x-[18px]" : "justify-end"}`}
    >
      {activeTab === "Buy" && (
        <Button
          variant="outline"
          className="max-[640px]:w-full"
          onClick={onSendToCompress}
          disabled={materialBuyEntryCount === 0}
        >
          <Minimize2 aria-hidden="true" />
          <span>Send to Compress</span>
        </Button>
      )}
      {(activeTab === "React" || activeTab === "Manufacture") && activityControls && (
        <PlannerActivityControls activity={activeTab} {...activityControls} />
      )}
      {activeTab === "Plan" && (
        <div className="flex w-auto items-center gap-2.5 max-[640px]:w-full max-[640px]:flex-col max-[640px]:items-stretch">
          <Label className="max-[640px]:self-start" htmlFor="plan-type">
            TYPE
          </Label>
          <div className="min-w-0 max-[640px]:w-full max-[640px]:overflow-hidden">
            <Combobox
              items={planTypeOptions.map((option) => option.name)}
              value={selectedTypeName ?? null}
              onValueChange={(value) => {
                const nextTypeId =
                  planTypeOptions.find((option) => option.name === value)?.id ?? null;
                onSelectedTypeIdChange(nextTypeId);
              }}
            >
              <ComboboxInput
                id="plan-type"
                placeholder="Filter by type"
                aria-label="Filter plan by asset type"
                showClear
                className="max-[640px]:w-full [&>input]:text-xs!"
              />
              <ComboboxContent>
                <ComboboxEmpty>No matching asset types.</ComboboxEmpty>
                <ComboboxList>
                  <ComboboxCollection>
                    {(option) => (
                      <ComboboxItem key={option} value={option}>
                        {option}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <Label htmlFor="plan-view-mode">VIEW</Label>
          <Select
            value={planViewMode}
            onValueChange={(value) => onPlanViewModeChange(value as PlanViewMode)}
          >
            <SelectTrigger
              id="plan-view-mode"
              aria-label="Plan view mode"
              className="max-[640px]:w-full"
            >
              <SelectValue>
                {planViewMode === "build-location" ? "By Build Location" : "All Items"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Items</SelectItem>
              <SelectItem value="build-location">By Build Location</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {activeTab !== "React" && (
        <Button
          type="button"
          variant="outline"
          className="max-[640px]:w-full"
          onClick={onCopyList}
          disabled={activeTab === "Buy" && materialBuyEntryCount === 0}
        >
          <CopyIcon aria-hidden="true" />
          {copyStatus
            || (activeTab === "Plan"
              ? "Copy table"
              : activeTab === "Buy"
                ? "Multibuy Materials"
                : "Copy list")}
        </Button>
      )}
    </div>
  );
}

/** Renders the summary and column labels above the Copy result list. */
export function PlannerCopyHeader({
  maxBuildTime,
  formatDuration,
}: {
  maxBuildTime: number;
  formatDuration: (seconds: number) => string;
}) {
  return (
    <>
      <div className={styles.copySummary}>
        <strong>{formatDuration(maxBuildTime)}</strong>
        <span>MAX BUILD TIME</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(74px,auto)_minmax(74px,auto)_minmax(90px,auto)] items-center gap-[13px] py-2.5 pb-1.5 text-right font-mono text-[9px] leading-normal tracking-[0.3px] text-muted-foreground uppercase max-[640px]:hidden [&>span:first-child]:text-left">
        <span>Type</span>
        <span>BPOs in use</span>
        <span>BPOs owned</span>
        <span>BPC runs</span>
      </div>
    </>
  );
}
