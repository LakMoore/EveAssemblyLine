import Image from "next/image";
import CopyableText from "@/components/CopyableText";
import ResultRow from "@/components/ResultRow";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { HaulPatch, ResponseHaulTask } from "@/lib/planning/types";
import { createHaulItemExclusionKey, type HaulItemExclusion } from "@/lib/planning/planView";
import { isHaulTaskPatched } from "@/lib/planning/haulPatches";
import {
  eveCharacterPortraitUrl,
  eveCorporationLogoUrl,
  eveTypeImageUrl,
} from "@/lib/eve/imageServer";
import styles from "@/app/page.module.css";
import { ClipboardList, Factory, SquareX } from "lucide-react";

export type DisplayHaulTask = ResponseHaulTask & {
  completed?: boolean;
  exclusionKey?: string;
};

export type PlannerHaulGroup = {
  fromLocationId: number;
  toLocationId: number;
  ownerType?: "character" | "corporation";
  ownerId?: number;
  tasks: DisplayHaulTask[];
};

export function haulTaskKey(task: DisplayHaulTask): string {
  if ("exclusionKey" in task && typeof task.exclusionKey === "string") {
    return task.exclusionKey;
  }
  return createHaulItemExclusionKey(
    task.fromLocationId,
    task.typeId,
    task.toLocationId,
    task.ownerType,
    task.ownerId,
  );
}

function haulTaskRenderKey(task: DisplayHaulTask): string {
  return `${task.fromLocationId}:${task.toLocationId}:${task.typeId}:${task.ownerType ?? "unassigned"}:${task.ownerId ?? 0}:${task.completed ? "completed" : "pending"}`;
}

function getHaulGroupVolume(tasks: DisplayHaulTask[]): number {
  return Math.ceil(tasks.reduce((total, task) => total + task.neededQuantity * task.unitVolume, 0));
}

type PlannerHaulTabProps = {
  groups: PlannerHaulGroup[];
  locationNamesById: Map<number, string>;
  stockpileLocations: ReadonlySet<number>;
  characterNamesById: Map<number, string>;
  corporationNamesById: Map<number, string>;
  haulItemExclusion: HaulItemExclusion;
  haulPatches: ReadonlyMap<string, HaulPatch>;
  excludingHaulFromLocationId: number | null;
  togglingHaulItemKey: string | null;
  togglingHaulPatchKey: string | null;
  togglingHaulPatchGroupKey: string | null;
  onExcludingHaulFromLocationIdChange: (locationId: number | null) => void;
  onTogglingHaulItemKeyChange: (key: string | null) => void;
  onTogglingHaulPatchKeyChange: (key: string | null) => void;
  onTogglingHaulPatchGroupKeyChange: (key: string | null) => void;
  selectedResultRowKey: string | null;
  onSelectedResultRowChange: (rowKey: string) => void;
  onExcludeHaulStockpile: (fromLocationId: number) => Promise<void>;
  onToggleHaulItemExclusion: (key: string, excluded: boolean) => Promise<void>;
  onToggleHaulPatches: (tasks: ResponseHaulTask[], patched: boolean) => Promise<void>;
};

/** Renders grouped hauling tasks and owns haul-specific progress state. */
export default function PlannerHaulTab({
  groups,
  locationNamesById,
  stockpileLocations,
  characterNamesById,
  corporationNamesById,
  haulItemExclusion,
  haulPatches,
  excludingHaulFromLocationId,
  togglingHaulItemKey,
  togglingHaulPatchKey,
  togglingHaulPatchGroupKey,
  onExcludingHaulFromLocationIdChange,
  onTogglingHaulItemKeyChange,
  onTogglingHaulPatchKeyChange,
  onTogglingHaulPatchGroupKeyChange,
  selectedResultRowKey,
  onSelectedResultRowChange,
  onExcludeHaulStockpile,
  onToggleHaulItemExclusion,
  onToggleHaulPatches,
}: PlannerHaulTabProps) {
  return (
    <div className={styles.haulGroups}>
      {groups.map((group) => (
        <section
          className={`${styles.haulGroup} w-full min-w-0`}
          key={`${group.fromLocationId}:${group.toLocationId}:${group.ownerType ?? "unassigned"}:${group.ownerId ?? 0}`}
        >
          <header className="flex min-h-14 w-full min-w-0 flex-col justify-between py-3 md:grid md:grid-cols-[auto_minmax(0,1fr)_auto_auto] md:items-center md:gap-y-0">
            <strong className="min-w-14 shrink-0 whitespace-nowrap">
              {getHaulGroupVolume(group.tasks).toLocaleString()} m<sup>3</sup>
            </strong>
            <div className="flex min-w-0 flex-col gap-1 md:ml-2 md:gap-0">
              <span className="flex min-w-0 items-baseline gap-2 truncate text-xs uppercase">
                <span className="shrink-0">From</span>
                <strong className="min-w-0 truncate normal-case">
                  {locationNamesById.get(group.fromLocationId) ?? group.fromLocationId}
                </strong>
              </span>
              <span className="flex min-w-0 items-baseline gap-2 truncate text-xs uppercase">
                <span className="shrink-0">To</span>
                <strong className="min-w-0 truncate normal-case">
                  {locationNamesById.get(group.toLocationId) ?? group.toLocationId}
                </strong>
              </span>
            </div>
            {!stockpileLocations.has(group.fromLocationId) && (
              <Button
                className="w-full md:w-auto"
                variant="outline"
                disabled={excludingHaulFromLocationId !== null}
                onClick={() => {
                  onExcludingHaulFromLocationIdChange(group.fromLocationId);
                  void onExcludeHaulStockpile(group.fromLocationId).finally(() => {
                    onExcludingHaulFromLocationIdChange(null);
                  });
                }}
              >
                {excludingHaulFromLocationId === group.fromLocationId ? (
                  <Spinner aria-hidden="true" />
                ) : (
                  <SquareX aria-hidden="true" />
                )}
                <span>
                  {excludingHaulFromLocationId === group.fromLocationId
                    ? "Recalculating..."
                    : "Exclude Location"}
                </span>
              </Button>
            )}
            <span className="flex min-w-0 items-center justify-between gap-2 md:justify-end">
              {group.ownerType !== undefined && group.ownerId !== undefined && (
                <strong className="ml-4 flex min-w-0 items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        group.ownerType === "corporation" ? (
                          <Image
                            src={eveCorporationLogoUrl(group.ownerId, 64)}
                            alt={`${corporationNamesById.get(group.ownerId) ?? `Corporation ${group.ownerId}`} logo`}
                            width={24}
                            height={24}
                            className="size-6 rounded-none"
                          />
                        ) : (
                          <Image
                            src={eveCharacterPortraitUrl(group.ownerId, 64)}
                            alt={`${characterNamesById.get(group.ownerId) ?? `Character ${group.ownerId}`} portrait`}
                            width={24}
                            height={24}
                            className="size-6 rounded-none"
                          />
                        )
                      }
                    />
                    <TooltipContent>
                      Owner:&nbsp;
                      {group.ownerType === "corporation"
                        ? (
                            corporationNamesById.get(group.ownerId)
                            ?? `Corporation ${group.ownerId}`
                          )
                        : (characterNamesById.get(group.ownerId) ?? `Character ${group.ownerId}`)}
                    </TooltipContent>
                  </Tooltip>
                  <span className="min-w-20 truncate">
                    {group.ownerType === "corporation"
                      ? (corporationNamesById.get(group.ownerId) ?? `Corporation ${group.ownerId}`)
                      : (characterNamesById.get(group.ownerId) ?? `Character ${group.ownerId}`)}
                  </span>
                </strong>
              )}
              {(() => {
                const eligibleTasks = group.tasks.filter(
                  (task) => !haulItemExclusion.has(haulTaskKey(task)),
                );
                const patchedCount = eligibleTasks.filter((task) =>
                  isHaulTaskPatched(task, haulPatches),
                ).length;
                const groupChecked =
                  eligibleTasks.length > 0 && patchedCount === eligibleTasks.length;
                const groupIndeterminate = patchedCount > 0 && !groupChecked;
                const groupKey = `${group.fromLocationId}:${group.toLocationId}:${group.ownerType ?? "unassigned"}:${group.ownerId ?? 0}`;
                return (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Checkbox
                          aria-label="Mark all eligible items as moved"
                          className="ml-2 shrink-0"
                          checked={groupChecked}
                          indeterminate={groupIndeterminate}
                          disabled={
                            eligibleTasks.length === 0
                            || togglingHaulPatchGroupKey !== null
                            || togglingHaulPatchKey !== null
                          }
                          onCheckedChange={(checked) => {
                            onTogglingHaulPatchGroupKeyChange(groupKey);
                            void onToggleHaulPatches(eligibleTasks, checked).finally(() => {
                              onTogglingHaulPatchGroupKeyChange(null);
                            });
                          }}
                        />
                      }
                    />
                    <TooltipContent>Haul completed?</TooltipContent>
                  </Tooltip>
                );
              })()}
            </span>
          </header>
          <div className={styles.haulGroupRows}>
            {group.tasks.map((task) => {
              const key = haulTaskKey(task);
              const rowKey = `Haul:${key}`;
              const isExcluded = haulItemExclusion.has(key);
              const isPatched = isHaulTaskPatched(task, haulPatches);
              return (
                <ResultRow
                  key={haulTaskRenderKey(task)}
                  name={task.typeName}
                  typeId={task.typeId}
                  imageSize={40}
                  linkPath="planner"
                  linkIcon={ClipboardList}
                  linkSearchParams={{ tab: "Plan" }}
                  linkHash="plan-breakdown"
                  navigateInPlace
                  selected={selectedResultRowKey === rowKey}
                  onClick={() => onSelectedResultRowChange(rowKey)}
                  showSwitch
                  switchChecked={!isExcluded}
                  switchPending={togglingHaulItemKey === key}
                  switchDisabled={isPatched || togglingHaulItemKey !== null}
                  switchTooltip="Include in haul plan?"
                  onSwitchChange={(checked) => {
                    onTogglingHaulItemKeyChange(key);
                    void onToggleHaulItemExclusion(key, !checked).finally(() => {
                      onTogglingHaulItemKeyChange(null);
                    });
                  }}
                  showCheckbox
                  checkboxChecked={isPatched}
                  checkboxPending={togglingHaulPatchKey === key}
                  checkboxDisabled={
                    isExcluded
                    || togglingHaulPatchGroupKey !== null
                    || togglingHaulPatchKey !== null
                  }
                  checkboxTooltip="Mark as moved"
                  onCheckboxChange={(checked) => {
                    onTogglingHaulPatchKeyChange(key);
                    void onToggleHaulPatches([task], checked).finally(() => {
                      onTogglingHaulPatchKeyChange(null);
                    });
                  }}
                  className={`${isExcluded || isPatched ? "opacity-50" : ""} max-[640px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[640px]:items-start max-[640px]:gap-y-2`}
                  switchClassName="max-[640px]:col-start-1 max-[640px]:row-start-2"
                  identityClassName="max-[640px]:col-span-2 max-[640px]:row-start-1 max-[640px]:w-full"
                  checkboxClassName="max-[640px]:col-start-3 max-[640px]:row-start-1"
                >
                  <span className="col-start-3 grid justify-items-end text-right font-mono text-xs whitespace-nowrap max-[640px]:col-start-2 max-[640px]:-col-end-1 max-[640px]:row-start-2">
                    <span className="flex items-center justify-end gap-2">
                      {task.inBuildQuantity !== undefined && task.inBuildQuantity > 0 && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                aria-label={
                                  task.inBuildQuantity.toLocaleString() + " ready industry output"
                                }
                                className="inline-flex items-center text-[#72d3b1]"
                              >
                                <Factory size={14} strokeWidth={1.8} aria-hidden="true" />
                              </span>
                            }
                          />
                          <TooltipContent>
                            {task.inBuildQuantity.toLocaleString() + " ready industry output"}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <CopyableText
                        textToRender={`${task.neededQuantity.toLocaleString()} units`}
                        textToCopy={String(task.neededQuantity)}
                        copyLabel="Quantity"
                      />
                    </span>
                    <small className="mt-1 text-[10px] text-muted-foreground">
                      {Math.ceil(task.neededQuantity * task.unitVolume).toLocaleString()} m
                      <sup>3</sup>
                    </small>
                  </span>
                </ResultRow>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
