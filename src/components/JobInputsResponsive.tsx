"use client";

import type { PlanJobInput, PlanJobInputs, PlanJobInputStatus } from "@/lib/planning/types";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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

function statusForCompletionPercent(completionPercent: number): PlanJobInputStatus {
  return completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked";
}

/** Calculates the readiness percentage shown for an industry's inputs trigger. */
export function getJobInputsCompletionPercent(
  inputs: PlanJobInputs,
  reactionFormulaCount?: number,
): number {
  if (reactionFormulaCount === undefined) {
    return inputs.completionPercent;
  }

  const blueprintCompletionPercent = reactionFormulaCount > 0 ? 100 : 0;
  return Math.min(
    blueprintCompletionPercent,
    ...inputs.materials.map((input) => input.completionPercent),
  );
}

function InputRow({ input }: { input: PlanJobInput }) {
  return (
    <div className="grid grid-cols-[37px_minmax(0,1fr)_auto] items-center gap-x-2 border-t border-border/60 py-2 first:border-t-0">
      <TypeIdentity
        name={input.name}
        typeId={input.typeId}
        imageSize={28}
        subline={`•\t${input.availableQuantity.toLocaleString()} / ${input.requiredQuantity.toLocaleString()} available`}
        className="col-span-2 min-w-0 [&>span]:min-w-0"
      />
      <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2 self-center">
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
    </div>
  );
}

/** Renders the authoritative inputs and readiness state for an industry job. */
export default function JobInputsResponsive({
  inputs,
  reactionFormulaCount,
}: {
  inputs: PlanJobInputs;
  reactionFormulaCount?: number;
}) {
  const isReactionFormula = reactionFormulaCount !== undefined;
  const blueprint = isReactionFormula
    ? {
        ...inputs.blueprint,
        availableQuantity: reactionFormulaCount,
        completionPercent: reactionFormulaCount > 0 ? 100 : 0,
        status: reactionFormulaCount > 0 ? ("ready" as const) : ("blocked" as const),
      }
    : inputs.blueprint;
  const completionPercent = getJobInputsCompletionPercent(inputs, reactionFormulaCount);
  const status = statusForCompletionPercent(completionPercent);
  return (
    <ResponsiveDialogDrawer
      trigger={
        <button
          type="button"
          className={cn(
            "inline-flex h-6 items-center gap-1 border px-2 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors hover:brightness-125",
            statusClassName(status),
          )}
        >
          <span>{completionPercent}%</span>
          Inputs
        </button>
      }
      title="Job inputs"
      description="Blueprint and material availability for this job."
      headerContent={
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <p className="font-semibold">{completionPercent}% ready</p>
          <Badge variant="outline" className={statusClassName(status)}>
            {statusLabel(status)}
          </Badge>
        </div>
      }
    >
      <div className="grid grid-cols-[37px_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-border py-2">
        <TypeIdentity
          name={inputs.blueprint.name}
          typeId={inputs.blueprint.typeId}
          imageSize={28}
          variation="bpc"
          subline={
            isReactionFormula
              ? `•\t${blueprint.availableQuantity.toLocaleString()} available`
              : `•\t${blueprint.availableQuantity.toLocaleString()} / ${blueprint.requiredQuantity.toLocaleString()} available`
          }
          className="col-span-2 min-w-0 [&>span]:min-w-0"
        />
        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2 self-center">
          <span className={cn("font-mono", statusClassName(blueprint.status))}>
            {blueprint.completionPercent}%
          </span>
          <span
            aria-label={`Blueprint: ${statusLabel(blueprint.status)}`}
            className={cn(
              "size-1.5 rounded-full",
              blueprint.status === "ready" && "bg-success",
              blueprint.status === "partial" && "bg-warning",
              blueprint.status === "blocked" && "bg-destructive",
            )}
          />
        </div>
      </div>
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
