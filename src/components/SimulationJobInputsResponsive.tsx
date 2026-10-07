"use client";

import { useEffect, useState, type ReactNode } from "react";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import styles from "@/app/page.module.css";
import { aggregateSimulationInputs } from "@/lib/planning/simulator/presentation";
import { cn } from "@/lib/utils";
import type {
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationJobInput,
  SimulationQuantityKind,
  SimulationUpstreamReservation,
} from "@/lib/planning/simulator/types";
import {
  Atom,
  ClipboardList,
  Factory,
  FlaskConical,
  ShoppingCart,
  Truck,
  type LucideIcon,
} from "lucide-react";

type InputStatus = "ready" | "partial" | "blocked";

/** Returns the percentage of one simulator input that is available immediately. */
function inputCompletionPercent(input: SimulationJobInput): number {
  if (input.requiredQuantity <= 0) return 100;
  return Math.min(100, Math.round((input.availableNow / input.requiredQuantity) * 100));
}

/** Returns the presentation status for one simulator input. */
function inputStatus(input: SimulationJobInput): InputStatus {
  const percent = inputCompletionPercent(input);
  return percent >= 100 ? "ready" : percent > 0 ? "partial" : "blocked";
}

/** Returns the semantic classes used for simulator input readiness. */
function statusClassName(status: InputStatus): string {
  return status === "ready"
    ? "border-success/40 text-success"
    : status === "partial"
      ? "border-warning/40 text-warning"
      : "border-destructive/40 text-destructive";
}

/** Formats one quantity with the correct singular or plural unit label. */
function quantityLabel(quantity: number, quantityKind: SimulationQuantityKind = "item"): string {
  if (quantityKind === "blueprint-run") {
    return `${quantity.toLocaleString()} ${quantity === 1 ? "run" : "runs"}`;
  }
  return `${quantity.toLocaleString()} ${quantity === 1 ? "unit" : "units"}`;
}

/** Formats a source's full job output while preserving the quantity reserved here. */
function sourceQuantityLabel(
  quantity: number,
  claimedQuantity: number,
  showJobOutput: boolean,
  quantityKind: SimulationQuantityKind = "item",
): string {
  if (!showJobOutput) return quantityLabel(quantity, quantityKind);
  return `${quantityLabel(quantity, quantityKind)} (${quantityLabel(claimedQuantity, quantityKind)} reserved)`;
}

/** Converts a reservation completion timestamp or simulated offset into minutes remaining. */
function reservationMinutesUntil(
  reservation: SimulationUpstreamReservation,
  now = Date.now(),
): number | undefined {
  if (reservation.sourceCompletionAt) {
    const completionTime = Date.parse(reservation.sourceCompletionAt);
    if (Number.isFinite(completionTime)) {
      return Math.max(0, Math.ceil((completionTime - now) / 60_000));
    }
  }
  if (reservation.sourceCompletionOffsetSeconds !== undefined) {
    return Math.max(0, Math.ceil(reservation.sourceCompletionOffsetSeconds / 60));
  }
  return undefined;
}

/** Formats the remaining time before a producing industry job completes. */
function completionDetail(minutes: number | undefined): string {
  if (minutes === undefined) return "";
  if (minutes === 0) return "; next job ready for delivery";
  if (minutes < 60) {
    return `; next job completes in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `; next job completes in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(hours / 24);
  return `; next job completes in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Formats reaction run durations using the simulator's compact day/hour/minute style. */
function reactionRunDuration(totalSeconds: number): string {
  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "0m";
}

type InputSupplySource = {
  key: string;
  label: string;
  source: "industry" | "reaction" | "copying" | "invention" | "market" | "haul";
  sourceJobIds: readonly string[];
  inBuild: boolean;
  quantityKind: SimulationQuantityKind;
  quantity: number;
  claimedQuantity: number;
  showJobOutput: boolean;
  completion?: string;
  Icon: LucideIcon;
};

/** Combines reservations from the same upstream activity and execution state for source tooltips. */
function reservationSources(
  reservations: readonly SimulationUpstreamReservation[],
  now: number,
): InputSupplySource[] {
  const sourcesByKey = new Map<
    string,
    {
      quantity: number;
      claimedQuantity: number;
      hasJobOutput: boolean;
      hasIncompleteOutput: boolean;
      completionMinutes?: number;
      sourceJobIds: Set<string>;
    }
  >();
  for (const reservation of reservations) {
    const key = `${reservation.activity}:${reservation.state}`;
    const source = sourcesByKey.get(key) ?? {
      quantity: 0,
      claimedQuantity: 0,
      hasJobOutput: false,
      hasIncompleteOutput: false,
      sourceJobIds: new Set<string>(),
    };
    const sourceJobKey =
      reservation.sourceJobId === undefined ? undefined : String(reservation.sourceJobId);
    const isNewSourceJob = sourceJobKey === undefined || !source.sourceJobIds.has(sourceJobKey);
    if (sourceJobKey !== undefined) source.sourceJobIds.add(sourceJobKey);
    source.claimedQuantity += reservation.quantity;
    if (reservation.sourceOutputQuantity === undefined) {
      source.hasIncompleteOutput = true;
    }
    else {
      source.hasJobOutput = true;
    }
    if (isNewSourceJob) {
      source.quantity += reservation.sourceOutputQuantity ?? reservation.quantity;
    }
    const completionMinutes = reservationMinutesUntil(reservation, now);
    if (
      completionMinutes !== undefined
      && (source.completionMinutes === undefined || completionMinutes < source.completionMinutes)
    ) source.completionMinutes = completionMinutes;
    sourcesByKey.set(key, source);
  }
  return (["manufacturing", "reaction", "copying", "invention"] as const).flatMap((activity) =>
    (["in-production", "paused", "planned"] as const).flatMap((state) => {
      const key = `${activity}:${state}`;
      const source = sourcesByKey.get(key);
      if (!source || source.quantity <= 0) return [];
      const showJobOutput = source.hasJobOutput && !source.hasIncompleteOutput;
      const activityLabels = {
        manufacturing: "Manufacturing",
        reaction: "Reaction",
        copying: "Copying",
        invention: "Invention",
      } as const;
      const activityLabel = activityLabels[activity];
      const plannedLabels = {
        manufacturing: "To Be Manufactured",
        reaction: "To Be Reacted",
        copying: "To Be Copied",
        invention: "To Be Invented",
      } as const;
      return [
        {
          key,
          label:
            state === "in-production"
              ? `${activityLabel}: In Production`
              : state === "paused"
                ? `${activityLabel}: Paused`
                : plannedLabels[activity],
          quantity: showJobOutput ? source.quantity : source.claimedQuantity,
          claimedQuantity: source.claimedQuantity,
          showJobOutput,
          source: activity === "manufacturing" ? "industry" : activity,
          sourceJobIds: [...source.sourceJobIds],
          inBuild: state !== "planned",
          quantityKind:
            activity === "copying" || activity === "invention" ? "blueprint-run" : "item",
          completion: completionDetail(source.completionMinutes),
          Icon:
            activity === "manufacturing"
              ? Factory
              : activity === "reaction"
                ? Atom
                : activity === "copying"
                  ? ClipboardList
                  : FlaskConical,
        },
      ];
    }),
  );
}

/** Returns the upstream sources that supply an input's missing quantity. */
function inputSupplySources(input: SimulationJobInput, now: number): InputSupplySource[] {
  if (input.availableNow >= input.requiredQuantity) return [];
  return [
    ...(input.availableFromHauling > 0
      ? [
          {
            key: "hauling",
            label: "To Haul",
            source: "haul" as const,
            inBuild: false,
            quantity: input.availableFromHauling,
            claimedQuantity: input.availableFromHauling,
            showJobOutput: false,
            quantityKind: input.quantityKind ?? "item",
            sourceJobIds: [],
            Icon: Truck,
          },
        ]
      : []),
    ...reservationSources(input.upstreamReservations ?? [], now),
    ...(input.purchaseQuantity && input.purchaseQuantity > 0
      ? [
          {
            key: "buy",
            label: "Buy",
            source: "market" as const,
            inBuild: false,
            quantity: input.purchaseQuantity,
            claimedQuantity: input.purchaseQuantity,
            showJobOutput: false,
            quantityKind: input.quantityKind ?? "item",
            sourceJobIds: [],
            Icon: ShoppingCart,
          },
        ]
      : []),
  ];
}

/** Renders one material input and its immediate, future, and missing quantities. */
function SimulationInputRow({
  input,
  now,
  onNavigate,
  onOpenBuy,
  onOpenJobInputs,
  jobsById,
  blueprintVariation,
}: {
  input: SimulationJobInput;
  now: number;
  onNavigate: () => void;
  onOpenBuy: () => void;
  onOpenJobInputs: (jobs: readonly SimulationIndustryJob[]) => void;
  jobsById: ReadonlyMap<string, SimulationIndustryJob>;
  blueprintVariation?: "bpc" | "relic";
}) {
  const percent = inputCompletionPercent(input);
  const status = inputStatus(input);
  const supplySources = inputSupplySources(input, now);
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-2 border-t border-border/60 py-2 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <TypeIdentity
        name={input.typeName}
        typeId={input.typeId}
        variation={blueprintVariation ?? (input.quantityKind === "blueprint-run" ? "bpc" : "icon")}
        linkPath="planner"
        linkIcon={ClipboardList}
        linkSearchParams={{ simulationTab: "plan" }}
        linkHash="plan-breakdown"
        navigateInPlace
        onNavigate={onNavigate}
        className="min-w-0"
      />
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-3 font-mono text-xs sm:w-auto sm:grid-cols-[5rem_5rem_12rem] sm:gap-2">
        <span className="order-2 flex min-w-0 flex-wrap items-center justify-start gap-1 sm:order-1 sm:w-20 sm:justify-end">
          {supplySources.map(
            ({
              key,
              label,
              source,
              sourceJobIds,
              inBuild,
              quantity,
              claimedQuantity,
              showJobOutput,
              quantityKind,
              completion = "",
              Icon,
            }) => {
              const isColored = source === "market" || inBuild;
              const iconClassName = isColored
                ? styles.simulationSourceIcon
                : "text-muted-foreground";
              const sourceJobs = sourceJobIds.flatMap((sourceJobId) => {
                const sourceJob = jobsById.get(sourceJobId);
                return sourceJob ? [sourceJob] : [];
              });
              const opensJobInputs = label === "To Be Manufactured";
              const sourceDescription = `${label}: ${sourceQuantityLabel(quantity, claimedQuantity, showJobOutput, quantityKind)}${completion}`;
              return (
                <Tooltip key={key}>
                  <TooltipTrigger
                    render={
                      label === "Buy" || opensJobInputs ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${sourceDescription}. ${opensJobInputs ? "View job inputs" : "View buy list"}`}
                          className={cn("size-5 p-0", iconClassName)}
                          data-source={source}
                          disabled={opensJobInputs && sourceJobs.length === 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (opensJobInputs) onOpenJobInputs(sourceJobs);
                            else onOpenBuy();
                          }}
                        >
                          <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                        </Button>
                      ) : (
                        <span
                          aria-label={`${label}: ${sourceQuantityLabel(quantity, claimedQuantity, showJobOutput, quantityKind)}${completion}`}
                          className={cn(
                            "inline-flex size-5 items-center justify-center",
                            iconClassName,
                          )}
                          data-source={source}
                          role="img"
                          tabIndex={0}
                        >
                          <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                        </span>
                      )
                    }
                  />
                  <TooltipContent>
                    {sourceDescription}
                    {opensJobInputs && " View job inputs"}
                  </TooltipContent>
                </Tooltip>
              );
            },
          )}
        </span>
        <Badge
          variant="outline"
          className={cn("order-1 w-20 justify-center sm:order-2", statusClassName(status))}
        >
          {percent}%
        </Badge>
        <span className="order-3 justify-self-end text-right whitespace-normal sm:min-w-20">
          {quantityLabel(input.availableNow, input.quantityKind)} /{" "}
          {quantityLabel(input.requiredQuantity, input.quantityKind)}
        </span>
      </div>
    </div>
  );
}

/** Renders the immediate input percentage and its responsive detail drawer. */
export default function SimulationJobInputsResponsive({
  job,
  jobs,
  allJobs,
  onOpenPlan,
  onOpenBuy,
  variation = "icon",
  showLabel = true,
}: {
  job: SimulationIndustryJob;
  jobs?: readonly SimulationIndustryJob[];
  allJobs?: readonly SimulationIndustryJob[];
  onOpenPlan: () => void;
  onOpenBuy: () => void;
  variation?: "icon" | "render" | "bp" | "bpc";
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selectedJobs, setSelectedJobs] = useState<readonly SimulationIndustryJob[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const updateNow = () => setNow(Date.now());
    updateNow();
    const intervalId = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(intervalId);
  }, [open]);
  const navigateToPlan = () => {
    setOpen(false);
    onOpenPlan();
  };
  const navigateToBuy = () => {
    setOpen(false);
    onOpenBuy();
  };
  const inputJobs = jobs && jobs.length > 0 ? jobs : [job];
  const jobsById = new Map((allJobs ?? inputJobs).map((inputJob) => [inputJob.jobId, inputJob]));
  const displayedJobs = selectedJobs ?? inputJobs;
  const installableRuns = displayedJobs.reduce(
    (total, inputJob) =>
      total + Math.min(inputJob.requiredRuns, Math.max(0, inputJob.readyNowRuns)),
    0,
  );
  const totalRuns = displayedJobs.reduce((total, inputJob) => total + inputJob.requiredRuns, 0);
  const isReaction = displayedJobs.every((inputJob) => inputJob.activity === "reaction");
  const installableRuntimeSeconds = displayedJobs.reduce(
    (total, inputJob) =>
      total
      + Math.min(inputJob.requiredRuns, Math.max(0, inputJob.readyNowRuns))
        * inputJob.durationPerRunSeconds,
    0,
  );
  const totalRuntimeSeconds = displayedJobs.reduce(
    (total, inputJob) => total + inputJob.requiredRuns * inputJob.durationPerRunSeconds,
    0,
  );
  const inputs = aggregateSimulationInputs(displayedJobs.flatMap((job) => job.inputs));
  const completionPercent =
    totalRuns > 0 ? Math.min(100, Math.round((installableRuns / totalRuns) * 100)) : 100;
  const status: InputStatus =
    completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked";
  const description: ReactNode = "Material availability for this simulation job.";
  const displayedJob = displayedJobs[0] ?? job;
  const openJobInputs = (sourceJobs: readonly SimulationIndustryJob[]) => {
    if (sourceJobs.length === 0) return;
    setSelectedJobs(sourceJobs);
    setOpen(true);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setSelectedJobs(null);
  };

  return (
    <ResponsiveDialogDrawer
      open={open}
      onOpenChange={handleOpenChange}
      trigger={
        <Button
          type="button"
          variant="outline"
          aria-label={showLabel ? undefined : `${completionPercent}% inputs`}
          className={cn(
            "inline-flex h-6 items-center justify-center gap-1 border px-2 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors hover:brightness-125",
            statusClassName(status),
          )}
          onClick={(event) => {
            event.stopPropagation();
            setSelectedJobs(null);
          }}
        >
          <span>{completionPercent}%</span>
          {showLabel ? "Inputs" : null}
        </Button>
      }
      title={displayedJobs.length > 1 ? "Grouped job inputs" : "Job inputs"}
      description={
        displayedJobs.length > 1
          ? "Material availability for the grouped simulation jobs."
          : description
      }
      headerContent={
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TypeIdentity
              name={displayedJob.productName}
              typeId={displayedJob.productTypeId}
              variation={variation}
              imageSize={40}
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ simulationTab: "plan" }}
              linkHash="plan-breakdown"
              navigateInPlace
              onNavigate={navigateToPlan}
              className="min-w-0 flex-1"
            />
            <div className="grid shrink-0 grid-cols-2 gap-x-4 font-mono text-xs">
              <div className="flex flex-col items-end">
                <strong>{installableRuns.toLocaleString()}</strong>
                <small className="text-[9px] text-muted-foreground uppercase">
                  Installable
                  {isReaction ? ` · ${reactionRunDuration(installableRuntimeSeconds)}` : ""}
                </small>
              </div>
              <div className="flex flex-col items-end">
                <strong>{totalRuns.toLocaleString()}</strong>
                <small className="text-[9px] text-muted-foreground uppercase">
                  Total{isReaction ? ` · ${reactionRunDuration(totalRuntimeSeconds)}` : ""}
                </small>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="font-semibold">{completionPercent}% ready now</p>
            <Badge variant="outline" className={statusClassName(status)}>
              {status}
            </Badge>
          </div>
        </div>
      }
    >
      <div>
        <p className="pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Materials
        </p>
        {inputs.length > 0 ? (
          inputs.map((input) => (
            <SimulationInputRow
              input={input}
              key={input.typeId}
              now={now}
              onNavigate={navigateToPlan}
              onOpenBuy={navigateToBuy}
              onOpenJobInputs={openJobInputs}
              jobsById={jobsById}
            />
          ))
        ) : (
          <p className="py-2 text-muted-foreground">No material inputs</p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}

/** Renders invention material readiness and the responsive input detail drawer. */
export function SimulationInventionInputsResponsive({
  job,
  outputBlueprintName,
  sourceBlueprintVariation,
  onOpenPlan,
  onOpenBuy,
}: {
  job: SimulationInventionJob;
  outputBlueprintName: string;
  sourceBlueprintVariation: "bpc" | "relic";
  onOpenPlan: () => void;
  onOpenBuy: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const updateNow = () => setNow(Date.now());
    updateNow();
    const intervalId = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(intervalId);
  }, [open]);

  const inputs = aggregateSimulationInputs(job.inputs);
  const completionPercent =
    inputs.length > 0 ? Math.min(...inputs.map(inputCompletionPercent)) : 100;
  const status: InputStatus =
    completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked";
  const jobsById = new Map<string, SimulationIndustryJob>();
  const navigateToPlan = () => {
    setOpen(false);
    onOpenPlan();
  };
  const navigateToBuy = () => {
    setOpen(false);
    onOpenBuy();
  };

  return (
    <ResponsiveDialogDrawer
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          type="button"
          variant="outline"
          aria-label={`${completionPercent}% inputs`}
          className={cn(
            "inline-flex h-6 items-center justify-center gap-1 border px-2 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors hover:brightness-125",
            statusClassName(status),
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <span>{completionPercent}%</span>
        </Button>
      }
      title="Invention inputs"
      description={`Material availability for the invention that produces ${outputBlueprintName}.`}
      headerContent={
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <TypeIdentity
              name={outputBlueprintName}
              typeId={job.outputBlueprintTypeId}
              variation="bpc"
              imageSize={40}
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ simulationTab: "plan" }}
              linkHash="plan-breakdown"
              navigateInPlace
              onNavigate={navigateToPlan}
              className="w-full min-w-0 sm:flex-1"
            />
            <div className="grid w-full grid-cols-2 gap-x-4 font-mono text-xs sm:w-auto sm:shrink-0 sm:grid-cols-3">
              <div className="flex flex-col items-end">
                <strong>{job.requiredOutputRuns.toLocaleString()}</strong>
                <small className="text-[10px] text-muted-foreground uppercase">Required runs</small>
              </div>
              <div className="flex flex-col items-end">
                <strong>{job.runsPerSuccess.toLocaleString()}</strong>
                <small className="text-[10px] text-muted-foreground uppercase">Runs per BPC</small>
              </div>
              <div className="col-span-2 flex flex-col items-center sm:col-span-1 sm:items-end">
                <strong>{job.attempts.toLocaleString()}</strong>
                <small className="text-[10px] text-muted-foreground uppercase">Attempts</small>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="font-semibold">{completionPercent}% inputs ready now</p>
            <Badge variant="outline" className={statusClassName(status)}>
              {status}
            </Badge>
          </div>
        </div>
      }
    >
      <div>
        <p className="pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Materials
        </p>
        {inputs.length > 0 ? (
          inputs.map((input) => (
            <SimulationInputRow
              input={input}
              key={input.typeId}
              now={now}
              onNavigate={navigateToPlan}
              onOpenBuy={navigateToBuy}
              onOpenJobInputs={() => {}}
              jobsById={jobsById}
              blueprintVariation={
                input.typeId === job.sourceBlueprintTypeId ? sourceBlueprintVariation : undefined
              }
            />
          ))
        ) : (
          <p className="py-2 text-muted-foreground">No material inputs</p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}
