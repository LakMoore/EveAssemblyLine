"use client";

import { useState, type ReactNode } from "react";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SimulationIndustryJob, SimulationJobInput } from "@/lib/planning/simulator/types";
import { ClipboardList } from "lucide-react";

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

/** Renders one material input and its immediate, future, and missing quantities. */
function SimulationInputRow({
  input,
  onNavigate,
}: {
  input: SimulationJobInput;
  onNavigate: () => void;
}) {
  const percent = inputCompletionPercent(input);
  const status = inputStatus(input);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
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
      <div className="flex flex-col items-end gap-1 font-mono text-xs">
        <span>
          {input.availableNow.toLocaleString()} / {input.requiredQuantity.toLocaleString()}
        </span>
        <Badge variant="outline" className={statusClassName(status)}>
          {percent}%
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {input.availableFromHauling.toLocaleString()} after hauling,{" "}
          {input.availableAfterUpstream.toLocaleString()} after upstream
        </span>
      </div>
    </div>
  );
}

/** Renders the immediate input percentage and its responsive detail drawer. */
export default function SimulationJobInputsResponsive({
  job,
  onOpenPlan,
  variation = "icon",
}: {
  job: SimulationIndustryJob;
  onOpenPlan: () => void;
  variation?: "icon" | "render" | "bp" | "bpc";
}) {
  const [open, setOpen] = useState(false);
  const navigateToPlan = () => {
    setOpen(false);
    onOpenPlan();
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
            <SimulationInputRow input={input} key={input.typeId} onNavigate={navigateToPlan} />
          ))
        ) : (
          <p className="py-2 text-muted-foreground">No material inputs</p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}
