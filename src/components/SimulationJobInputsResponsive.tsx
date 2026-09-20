"use client";

import { useState, type ReactNode } from "react";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

type InputSupplySource = {
  key: string;
  label: string;
  quantity: number;
  Icon: LucideIcon;
};

/** Combines reservations from the same upstream activity and execution state for source tooltips. */
function reservationSources(
  reservations: readonly SimulationUpstreamReservation[],
): InputSupplySource[] {
  const quantitiesBySource = new Map<string, number>();
  for (const reservation of reservations) {
    const key = `${reservation.activity}:${reservation.state}`;
    quantitiesBySource.set(key, (quantitiesBySource.get(key) ?? 0) + reservation.quantity);
  }
  return (["manufacturing", "reaction"] as const).flatMap((activity) =>
    (["in-production", "paused", "planned"] as const).flatMap((state) => {
      const key = `${activity}:${state}`;
      const quantity = quantitiesBySource.get(key) ?? 0;
      if (quantity <= 0) return [];
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
          quantity,
          Icon: activity === "manufacturing" ? Factory : Atom,
        },
      ];
    }),
  );
}

/** Returns the upstream sources that supply an input's missing quantity. */
function inputSupplySources(input: SimulationJobInput): InputSupplySource[] {
  if (input.availableNow >= input.requiredQuantity) return [];
  return [
    ...(input.availableFromHauling > 0
      ? [{ key: "hauling", label: "Hauling", quantity: input.availableFromHauling, Icon: Truck }]
      : []),
    ...reservationSources(input.upstreamReservations ?? []),
    ...(input.purchaseQuantity && input.purchaseQuantity > 0
      ? [{ key: "buy", label: "Buy", quantity: input.purchaseQuantity, Icon: ShoppingCart }]
      : []),
  ];
}

/** Renders one material input and its immediate, future, and missing quantities. */
function SimulationInputRow({
  input,
  onNavigate,
  onOpenBuy,
}: {
  input: SimulationJobInput;
  onNavigate: () => void;
  onOpenBuy: () => void;
}) {
  const percent = inputCompletionPercent(input);
  const status = inputStatus(input);
  const supplySources = inputSupplySources(input);
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-2 border-t border-border/60 py-2 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <TypeIdentity
        name={input.typeName}
        typeId={input.typeId}
        linkPath="planner"
        linkIcon={ClipboardList}
        linkSearchParams={{ tab: "Plan" }}
        linkHash="plan-breakdown"
        navigateInPlace
        onNavigate={onNavigate}
        className="min-w-0"
      />
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 font-mono text-xs sm:w-auto sm:grid-cols-[5rem_5rem_minmax(5rem,max-content)] sm:gap-2">
        <span className="flex items-center justify-start gap-1 sm:w-20 sm:justify-end">
          {supplySources.map(({ key, label, quantity, Icon }) => (
            <Tooltip key={key}>
              <TooltipTrigger
                render={
                  label === "Buy" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${label}: ${quantityLabel(quantity)}. View buy list`}
                      className="size-5 p-0 text-muted-foreground"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenBuy();
                      }}
                    >
                      <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                    </Button>
                  ) : (
                    <span
                      aria-label={`${label}: ${quantityLabel(quantity)}`}
                      className="inline-flex size-5 items-center justify-center text-muted-foreground"
                      role="img"
                      tabIndex={0}
                    >
                      <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                    </span>
                  )
                }
              />
              <TooltipContent>
                {label}: {quantityLabel(quantity)}
              </TooltipContent>
            </Tooltip>
          ))}
        </span>
        <Badge variant="outline" className={cn("w-20 justify-center", statusClassName(status))}>
          {percent}%
        </Badge>
        <span className="justify-self-end text-right whitespace-nowrap sm:min-w-20">
          {input.availableNow.toLocaleString()} / {input.requiredQuantity.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

/** Renders the immediate input percentage and its responsive detail drawer. */
export default function SimulationJobInputsResponsive({
  job,
  onOpenPlan,
  onOpenBuy,
  variation = "icon",
}: {
  job: SimulationIndustryJob;
  onOpenPlan: () => void;
  onOpenBuy: () => void;
  variation?: "icon" | "render" | "bp" | "bpc";
}) {
  const [open, setOpen] = useState(false);
  const navigateToPlan = () => {
    setOpen(false);
    onOpenPlan();
  };
  const navigateToBuy = () => {
    setOpen(false);
    onOpenBuy();
  };
  const installableRuns = Math.min(job.requiredRuns, Math.max(0, job.readyNowRuns));
  const completionPercent =
    job.requiredRuns > 0
      ? Math.min(100, Math.round((installableRuns / job.requiredRuns) * 100))
      : 100;
  const status: InputStatus =
    completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked";
  const description: ReactNode = "Material availability for this simulation job.";

  return (
    <ResponsiveDialogDrawer
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          type="button"
          variant="outline"
          className={cn(
            "inline-flex h-6 items-center justify-center gap-1 border px-2 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors hover:brightness-125",
            statusClassName(status),
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <span>{completionPercent}%</span>
          Inputs
        </Button>
      }
      title="Job inputs"
      description={description}
      headerContent={
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TypeIdentity
              name={job.productName}
              typeId={job.productTypeId}
              variation={variation}
              imageSize={40}
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ tab: "Plan" }}
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
                <strong>{job.requiredRuns.toLocaleString()}</strong>
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
        {job.inputs.length > 0 ? (
          job.inputs.map((input) => (
            <SimulationInputRow
              input={input}
              key={input.typeId}
              onNavigate={navigateToPlan}
              onOpenBuy={navigateToBuy}
            />
          ))
        ) : (
          <p className="py-2 text-muted-foreground">No material inputs</p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}
