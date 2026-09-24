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
  SimulationJobInput,
  SimulationUpstreamReservation,
} from "@/lib/planning/simulator/types";
import { Atom, ClipboardList, Factory, ShoppingCart, Truck, type LucideIcon } from "lucide-react";

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
function quantityLabel(quantity: number): string {
  return `${quantity.toLocaleString()} ${quantity === 1 ? "unit" : "units"}`;
}

/** Formats a source's full job output while preserving the quantity reserved here. */
function sourceQuantityLabel(
  quantity: number,
  claimedQuantity: number,
  showJobOutput: boolean,
): string {
  if (!showJobOutput) return quantityLabel(quantity);
  return `${quantityLabel(quantity)} (${quantityLabel(claimedQuantity)} reserved)`;
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

type InputSupplySource = {
  key: string;
  label: string;
  source: "industry" | "reaction" | "market" | "haul";
  sourceJobIds: readonly string[];
  inBuild: boolean;
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
  return (["manufacturing", "reaction"] as const).flatMap((activity) =>
    (["in-production", "paused", "planned"] as const).flatMap((state) => {
      const key = `${activity}:${state}`;
      const source = sourcesByKey.get(key);
      if (!source || source.quantity <= 0) return [];
      const showJobOutput = source.hasJobOutput && !source.hasIncompleteOutput;
      const activityLabel = activity === "manufacturing" ? "Manufacturing" : "Reaction";
      return [
        {
          key,
          label:
            state === "in-production"
              ? `${activityLabel}: In Production`
              : state === "paused"
                ? `${activityLabel}: Paused Production`
                : activity === "manufacturing"
                  ? "To Be Manufactured"
                  : "To Be Reacted",
          quantity: showJobOutput ? source.quantity : source.claimedQuantity,
          claimedQuantity: source.claimedQuantity,
          showJobOutput,
          source: activity === "manufacturing" ? ("industry" as const) : ("reaction" as const),
          sourceJobIds: [...source.sourceJobIds],
          inBuild: state !== "planned",
          completion: completionDetail(source.completionMinutes),
          Icon: activity === "manufacturing" ? Factory : Atom,
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
}: {
  input: SimulationJobInput;
  now: number;
  onNavigate: () => void;
  onOpenBuy: () => void;
  onOpenJobInputs: (jobs: readonly SimulationIndustryJob[]) => void;
  jobsById: ReadonlyMap<string, SimulationIndustryJob>;
}) {
  const percent = inputCompletionPercent(input);
  const status = inputStatus(input);
  const supplySources = inputSupplySources(input, now);
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-2 border-t border-border/60 py-2 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <TypeIdentity
        name={input.typeName}
        typeId={input.typeId}
        linkPath="planner"
        linkIcon={ClipboardList}
        linkSearchParams={{ simulationTab: "plan" }}
        linkHash="plan-breakdown"
        navigateInPlace
        onNavigate={onNavigate}
        className="min-w-0"
      />
      <div className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 font-mono text-xs sm:w-auto sm:grid-cols-[5rem_5rem_12rem] sm:gap-2">
        <span className="order-2 flex items-center justify-start gap-1 sm:order-1 sm:w-20 sm:justify-end">
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
              const sourceDescription = `${label}: ${sourceQuantityLabel(quantity, claimedQuantity, showJobOutput)}${completion}`;
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
                          aria-label={`${label}: ${sourceQuantityLabel(quantity, claimedQuantity, showJobOutput)}${completion}`}
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
        <span className="order-3 justify-self-end text-right whitespace-nowrap sm:min-w-20">
          {input.availableNow.toLocaleString()} / {input.requiredQuantity.toLocaleString()}
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
}: {
  job: SimulationIndustryJob;
  jobs?: readonly SimulationIndustryJob[];
  allJobs?: readonly SimulationIndustryJob[];
  onOpenPlan: () => void;
  onOpenBuy: () => void;
  variation?: "icon" | "render" | "bp" | "bpc";
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
  const inputs = aggregateSimulationInputs(displayedJobs.flatMap((inputJob) => inputJob.inputs));
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
          Inputs
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
                <small className="text-[9px] text-muted-foreground uppercase">Installable</small>
              </div>
              <div className="flex flex-col items-end">
                <strong>{totalRuns.toLocaleString()}</strong>
                <small className="text-[9px] text-muted-foreground uppercase">Total</small>
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
