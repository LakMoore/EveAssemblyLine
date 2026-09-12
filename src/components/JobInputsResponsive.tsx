"use client";

import type { PlanJobInput, PlanJobInputs, PlanJobInputStatus } from "@/lib/planning/types";
import ResultRow from "@/components/ResultRow";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ClipboardList, Factory } from "lucide-react";

function statusLabel(status: PlanJobInputStatus) {
  return status === "ready" ? "Ready" : status === "partial" ? "Partial" : "Blocked";
}

function statusClassName(status: PlanJobInputStatus) {
  return status === "ready"
    ? "border-success/40 text-success"
    : status === "partial"
      ? "border-warning/40 text-warning"
      : "border-destructive/40 text-destructive";
}

/** Calculates the readiness percentage shown for an industry's inputs trigger. */
export function getJobInputsCompletionPercent(inputs: PlanJobInputs): number {
  return inputs.materials.length
    ? Math.min(...inputs.materials.map((input) => input.completionPercent))
    : 100;
}

function InputRow({ input }: { input: PlanJobInput }) {
  return (
    <ResultRow
      name={input.name}
      typeId={input.typeId}
      imageSize={28}
      subline={`•\t${input.availableQuantity.toLocaleString()} / ${input.requiredQuantity.toLocaleString()} available`}
      linkPath="planner"
      linkIcon={ClipboardList}
      linkSearchParams={{ tab: "Plan" }}
      linkHash="plan-breakdown"
      navigateInPlace
      className="min-h-0 border-t border-b-0 border-border/60 py-2 first:border-t-0"
      identityClassName="[&>span]:min-w-0"
    >
      <div className="flex shrink-0 items-center gap-2 self-center">
        {input.inBuildQuantity !== undefined && input.inBuildQuantity > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={
                    input.inBuildQuantity.toLocaleString() + " available from industry output"
                  }
                  className="text-muted-foreground"
                >
                  <Factory size={14} strokeWidth={1.8} aria-hidden="true" />
                </span>
              }
            />
            <TooltipContent>
              {input.inBuildQuantity.toLocaleString() + " available from ready industry output"}
            </TooltipContent>
          </Tooltip>
        )}
        <span className={cn("font-mono", statusClassName(input.status))}>
          {input.completionPercent}%
        </span>
        <span
          aria-label={`${input.name}: ${statusLabel(input.status)}`}
          className={cn(
            "size-1.5 rounded-full",
            input.status === "ready" && "bg-success",
            input.status === "partial" && "bg-warning",
            input.status === "blocked" && "bg-destructive",
          )}
        />
      </div>
    </ResultRow>
  );
}

/** Renders the authoritative inputs and readiness state for an industry job. */
export default function JobInputsResponsive({
  inputs,
  name,
  typeId,
  variation,
  installableRuns,
  totalRuns,
}: {
  inputs: PlanJobInputs;
  name: string;
  typeId: number;
  variation?: "icon" | "render" | "bp" | "bpc";
  installableRuns: number;
  totalRuns: number;
}) {
  const completionPercent = getJobInputsCompletionPercent(inputs);
  const status: PlanJobInputStatus =
    completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked";
  return (
    <ResponsiveDialogDrawer
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex h-6 items-center justify-center gap-1 border px-2 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors hover:brightness-125",
            statusClassName(status),
          )}
        >
          <span>{completionPercent}%</span>
          Inputs
        </button>
      }
      title="Job inputs"
      description="Material availability for this job."
      headerContent={
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TypeIdentity
              name={name}
              typeId={typeId}
              variation={variation}
              imageSize={40}
              linkPath="planner"
              linkIcon={ClipboardList}
              linkSearchParams={{ tab: "Plan" }}
              linkHash="plan-breakdown"
              navigateInPlace
              className="min-w-0 flex-1"
            />
            <div className="grid shrink-0 grid-cols-2 gap-x-4 text-right font-mono text-xs">
              <span>
                <strong className="block">{installableRuns.toLocaleString()}</strong>
                <small className="text-[9px] text-muted-foreground uppercase">Installable</small>
              </span>
              <span>
                <strong className="block">{totalRuns.toLocaleString()}</strong>
                <small className="text-[9px] text-muted-foreground uppercase">Total</small>
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="font-semibold">{completionPercent}% ready</p>
            <Badge variant="outline" className={statusClassName(status)}>
              {statusLabel(status)}
            </Badge>
          </div>
        </div>
      }
    >
      <div>
        <p className="pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Materials
        </p>
        {inputs.materials.length > 0 ? (
          inputs.materials.map((input) => <InputRow input={input} key={input.typeId} />)
        ) : (
          <p className="py-2 text-muted-foreground">No material inputs</p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}
