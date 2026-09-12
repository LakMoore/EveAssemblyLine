import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import styles from "@/app/page.module.css";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";
import { ArrowDown, ArrowUp, Copy as CopyIcon, UsersRound } from "lucide-react";

export type ReactionSortKey = "type" | "inputs" | "suggestedRuns" | "totalNeeded";
export type ReactionSort = { key: ReactionSortKey; direction: "asc" | "desc" };
export type ManufacturingSort = { key: "type" | "inputs" | "runs"; direction: "asc" | "desc" };

type ActivitySlotCharacter = {
  characterId: number;
  name: string;
  availableSlots: number;
};

type ReactionSummary = {
  installs: number;
  maxTime: number;
};

type ReactionCoverage = {
  installable: number;
  total: number;
};

type ManufacturingSummary = {
  installs: number;
  maxTime: number;
  installableCoverage: string;
  totalCoverage: string;
};

function formatCoverage(coveredRuns: number, totalRuns: number): string {
  return totalRuns > 0 ? `${((coveredRuns / totalRuns) * 100).toFixed(1)}%` : "0.0%";
}

function formatDuration(totalSeconds: number): string {
  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push("0m");
  return parts.join(" ");
}

function ActivitySlotCharacters({
  characters,
  activity,
}: {
  characters: ActivitySlotCharacter[];
  activity: "reaction" | "manufacturing";
}) {
  return (
    <div className="flex flex-col gap-2">
      {characters.length > 0 ? (
        characters.map((character) => (
          <div
            className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 py-2 first:border-t-0"
            key={character.characterId}
          >
            <Image
              src={eveCharacterPortraitUrl(character.characterId, 64)}
              alt={`${character.name} portrait`}
              width={32}
              height={32}
              className="size-8 rounded-none"
            />
            <span className="min-w-0 truncate font-medium">{character.name}</span>
            <Badge variant="outline">
              {character.availableSlots.toLocaleString()} slot
              {character.availableSlots === 1 ? "" : "s"}
            </Badge>
          </div>
        ))
      ) : (
        <p className="py-4 text-muted-foreground">No characters have available {activity} slots.</p>
      )}
    </div>
  );
}

type PlannerActivityControlsProps = {
  activity: "React" | "Manufacture";
  reactionScheduleMode: "available-slots" | "max-job-length";
  onReactionScheduleModeChange: (mode: "available-slots" | "max-job-length") => void;
  maxJobHours: string;
  onMaxJobHoursChange: (hours: string) => void;
  showTotalRunCounts: boolean;
  onShowTotalRunCountsChange: (showTotal: boolean) => void;
  showTotalManufacturingRunCounts: boolean;
  onShowTotalManufacturingRunCountsChange: (showTotal: boolean) => void;
  availableReactionSlots: number;
  reactionSlotCharacters: ActivitySlotCharacter[];
  reactionSummary: ReactionSummary;
  reactionCoverage: ReactionCoverage;
  totalInstallableReactionRuns: number;
  totalReactionRuns: number;
  availableManufacturingSlots: number;
  manufacturingSlotCharacters: ActivitySlotCharacter[];
  manufacturingSummary: ManufacturingSummary;
  copyStatus: string;
  onCopyList: () => void;
};

/** Renders the controls and summary metrics for the React or Manufacture output. */
export function PlannerActivityControls({
  activity,
  reactionScheduleMode,
  onReactionScheduleModeChange,
  maxJobHours,
  onMaxJobHoursChange,
  showTotalRunCounts,
  onShowTotalRunCountsChange,
  showTotalManufacturingRunCounts,
  onShowTotalManufacturingRunCountsChange,
  availableReactionSlots,
  reactionSlotCharacters,
  reactionSummary,
  reactionCoverage,
  totalInstallableReactionRuns,
  totalReactionRuns,
  availableManufacturingSlots,
  manufacturingSlotCharacters,
  manufacturingSummary,
  copyStatus,
  onCopyList,
}: PlannerActivityControlsProps) {
  if (activity === "React") {
    return (
      <>
        <div className="flex w-auto flex-nowrap items-center gap-2.5 max-[640px]:flex-wrap">
          <Label className="shrink-0 whitespace-nowrap" htmlFor="reaction-schedule-mode">
            Plan Type:
          </Label>
          <Select
            value={reactionScheduleMode}
            onValueChange={(value) =>
              onReactionScheduleModeChange(value as "available-slots" | "max-job-length")
            }
          >
            <SelectTrigger
              id="reaction-schedule-mode"
              aria-label="Reaction scheduling mode"
              className="min-w-[170px] flex-[0_1_190px]"
            >
              <SelectValue>
                {reactionScheduleMode === "max-job-length"
                  ? "Max job length"
                  : "Solve for available slots"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="available-slots">Solve for available slots</SelectItem>
              <SelectItem value="max-job-length">Max job length</SelectItem>
            </SelectContent>
          </Select>
          {reactionScheduleMode === "max-job-length" && (
            <div className="flex flex-[0_0_150px] items-center gap-2">
              <Input
                id="max-reaction-job-hours"
                type="number"
                min="1"
                step="1"
                value={maxJobHours}
                onChange={(event) => onMaxJobHoursChange(event.target.value)}
                aria-label="Maximum reaction job length in hours"
                className="w-25"
              />
              <Label htmlFor="max-reaction-job-hours">Hours</Label>
            </div>
          )}
        </div>
        <div className="flex min-h-8 w-auto items-center gap-2.5">
          <Label htmlFor="reaction-run-count-mode">Show</Label>
          <Select
            value={showTotalRunCounts ? "total" : "installable"}
            onValueChange={(value) => onShowTotalRunCountsChange(value === "total")}
          >
            <SelectTrigger
              id="reaction-run-count-mode"
              aria-label="Reaction run count display"
              className="min-w-[125px] flex-[0_1_125px]"
            >
              <SelectValue>{showTotalRunCounts ? "Total" : "Installable"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="installable">Installable</SelectItem>
              <SelectItem value="total">Total</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={styles.reactionSummary}>
          <span>
            <strong className="flex items-center gap-1">
              {availableReactionSlots.toLocaleString()}
              <ResponsiveDialogDrawer
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="View characters with available reaction slots"
                    title="View characters with available reaction slots"
                  >
                    <UsersRound className="size-4" aria-hidden="true" />
                  </Button>
                }
                title="Reaction slots by character"
                description="Characters with available reaction slots."
              >
                <ActivitySlotCharacters characters={reactionSlotCharacters} activity="reaction" />
              </ResponsiveDialogDrawer>
            </strong>
            <small>AVAILABLE SLOTS</small>
          </span>
          <span>
            <strong>{reactionSummary.installs.toLocaleString()}</strong>
            <small>SUGGESTED INSTALLS</small>
          </span>
          <span>
            <strong>{formatDuration(reactionSummary.maxTime)}</strong>
            <small>MAX JOB LENGTH</small>
          </span>
          <span>
            <strong>
              {formatCoverage(reactionCoverage.installable, totalInstallableReactionRuns)}
            </strong>
            <small>INSTALLABLE COVERAGE</small>
          </span>
          <span>
            <strong>{formatCoverage(reactionCoverage.total, totalReactionRuns)}</strong>
            <small>TOTAL COVERAGE</small>
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="ml-auto max-[640px]:ml-0 max-[640px]:w-full"
          onClick={onCopyList}
        >
          <CopyIcon aria-hidden="true" />
          {copyStatus || "Copy list"}
        </Button>
      </>
    );
  }

  return (
    <>
      <div className="mr-auto flex min-h-8 w-auto items-center gap-2.5">
        <Label htmlFor="manufacturing-run-count-mode">Show</Label>
        <Select
          value={showTotalManufacturingRunCounts ? "total" : "installable"}
          onValueChange={(value) => onShowTotalManufacturingRunCountsChange(value === "total")}
        >
          <SelectTrigger
            id="manufacturing-run-count-mode"
            aria-label="Manufacturing run count display"
            className="min-w-[125px] flex-[0_1_125px]"
          >
            <SelectValue>{showTotalManufacturingRunCounts ? "Total" : "Installable"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="installable">Installable</SelectItem>
            <SelectItem value="total">Total</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className={styles.reactionSummary}>
        <span>
          <strong className="flex items-center gap-1">
            {availableManufacturingSlots.toLocaleString()}
            <ResponsiveDialogDrawer
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="View characters with available manufacturing slots"
                  title="View characters with available manufacturing slots"
                >
                  <UsersRound className="size-4" aria-hidden="true" />
                </Button>
              }
              title="Manufacturing slots by character"
              description="Characters with available manufacturing slots."
            >
              <ActivitySlotCharacters
                characters={manufacturingSlotCharacters}
                activity="manufacturing"
              />
            </ResponsiveDialogDrawer>
          </strong>
          <small>AVAILABLE SLOTS</small>
        </span>
        <span>
          <strong>{manufacturingSummary.installs.toLocaleString()}</strong>
          <small>SUGGESTED INSTALLS</small>
        </span>
        <span>
          <strong>{formatDuration(manufacturingSummary.maxTime)}</strong>
          <small>MAX JOB LENGTH</small>
        </span>
        <span>
          <strong>{manufacturingSummary.installableCoverage}</strong>
          <small>INSTALLABLE COVERAGE</small>
        </span>
        <span>
          <strong>{manufacturingSummary.totalCoverage}</strong>
          <small>TOTAL COVERAGE</small>
        </span>
      </div>
    </>
  );
}

type PlannerActivityTableHeaderProps = {
  activity: "React" | "Manufacture";
  reactionSort: ReactionSort;
  onReactionSortChange: (key: ReactionSortKey) => void;
  manufacturingSort: ManufacturingSort;
  onManufacturingSortChange: (key: ManufacturingSort["key"]) => void;
};

function SortIcon({ direction }: { direction: "asc" | "desc" }) {
  return direction === "asc" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />;
}

/** Renders the sortable column header for the React or Manufacture result list. */
export function PlannerActivityTableHeader({
  activity,
  reactionSort,
  onReactionSortChange,
  manufacturingSort,
  onManufacturingSortChange,
}: PlannerActivityTableHeaderProps) {
  if (activity === "React") {
    const sortButton = (key: ReactionSortKey, label: string) => (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.reactionSortButton} ${key === "inputs" ? styles.inputsSortHeader : ""} p-0`}
        aria-label={`Sort reactions by ${label}${reactionSort.key === key ? `, currently ${reactionSort.direction}ending` : ""}`}
        onClick={() => onReactionSortChange(key)}
      >
        {label}
        {reactionSort.key === key && <SortIcon direction={reactionSort.direction} />}
      </Button>
    );
    return (
      <div className={`${styles.reactionTableHeader} px-2`}>
        <span aria-hidden="true" />
        {sortButton("type", "Type")}
        {sortButton("inputs", "% inputs")}
        <span>BPs available</span>
        <span>Suggested installs</span>
        {sortButton("suggestedRuns", "Suggested runs")}
        {sortButton("totalNeeded", "Total needed")}
        <span aria-hidden="true" />
      </div>
    );
  }

  const sortButton = (key: ManufacturingSort["key"], label: string) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`${styles.reactionSortButton} ${key === "inputs" ? styles.inputsSortHeader : ""} p-0`}
      aria-label={`Sort manufacturing jobs by ${label}${manufacturingSort.key === key ? `, currently ${manufacturingSort.direction}ending` : ""}`}
      onClick={() => onManufacturingSortChange(key)}
    >
      {label}
      {manufacturingSort.key === key && <SortIcon direction={manufacturingSort.direction} />}
    </Button>
  );
  return (
    <div className={`${styles.manufacturingTableHeader} px-2`}>
      {sortButton("type", "Type")}
      {sortButton("inputs", "% inputs")}
      <span>BPO count</span>
      <span>BPC runs</span>
      {sortButton("runs", "Run count")}
      <span aria-hidden="true" />
    </div>
  );
}
