"use client";

import type { PlanJobInput, PlanJobInputs, PlanJobInputStatus } from "@/lib/planning/types";
import type { ClientJobsResponse } from "@/lib/client/requestCache";
import {
  getIndustryJobMinutesUntil,
  getIndustryJobSummary,
  nextIndustryJobDetail,
} from "@/lib/client/industryJobs";
import ResultRow from "@/components/ResultRow";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import styles from "@/app/page.module.css";
import { ChartLine, ClipboardList, Factory } from "lucide-react";
import CopyableText from "./CopyableText";

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

function SourceIcon({
  source,
  label,
  Icon,
}: {
  source: "industry" | "market";
  label: string;
  Icon: typeof Factory;
}) {
  return (
    <span
      className={styles.availableSourceIcon}
      data-source={source}
      data-tooltip={label}
      aria-label={label}
      role="img"
      tabIndex={0}
    >
      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

/** Calculates the readiness percentage shown for an industry's inputs trigger. */
export function getJobInputsCompletionPercent(inputs: PlanJobInputs): number {
  return inputs.materials.length
    ? Math.min(...inputs.materials.map((input) => input.completionPercent))
    : 100;
}

function InputRow({
  input,
  locationId,
  jobs,
  marketBuyOrderQuantity,
}: {
  input: PlanJobInput;
  locationId?: number;
  jobs: ClientJobsResponse | null;
  marketBuyOrderQuantity: number;
}) {
  const isIncomplete = input.completionPercent < 100;
  const industrySummary = isIncomplete
    ? getIndustryJobSummary(input.typeId, jobs, locationId)
    : null;
  const industryQuantity = industrySummary?.quantity ?? 0;
  const readyIndustryQuantity = input.inBuildQuantity ?? 0;
  const minutesUntilNextJob = getIndustryJobMinutesUntil(industrySummary?.nextEndTime);
  const industryLabel = industryQuantity
    ? `${industryQuantity.toLocaleString()} in build${
        readyIndustryQuantity > 0
          ? `, ${readyIndustryQuantity.toLocaleString()} ready from industry output`
          : ""
      }${nextIndustryJobDetail(minutesUntilNextJob)}`
    : `${readyIndustryQuantity.toLocaleString()} available from ready industry output`;

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
        {isIncomplete && (industryQuantity > 0 || readyIndustryQuantity > 0) && (
          <SourceIcon source="industry" label={industryLabel} Icon={Factory} />
        )}
        {isIncomplete && marketBuyOrderQuantity > 0 && (
          <SourceIcon
            source="market"
            label={`${marketBuyOrderQuantity.toLocaleString()} currently in market buy orders`}
            Icon={ChartLine}
          />
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
  locationId,
  variation,
  installableRuns,
  totalRuns,
  jobs,
  marketBuyOrderQuantities,
}: {
  inputs: PlanJobInputs;
  name: string;
  typeId: number;
  locationId?: number;
  variation?: "icon" | "render" | "bp" | "bpc";
  installableRuns: number;
  totalRuns: number;
  jobs: ClientJobsResponse | null;
  marketBuyOrderQuantities?: Readonly<Record<string, number>>;
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
            <div className="grid shrink-0 grid-cols-2 gap-x-4 font-mono text-xs">
              <div className="flex flex-col items-end">
                <CopyableText
                  className="font-bold"
                  textToRender={installableRuns.toLocaleString()}
                  textToCopy={installableRuns.toString()}
                />
                <small className="text-[9px] text-muted-foreground uppercase">Installable</small>
              </div>
              <div className="flex flex-col items-end">
                <CopyableText
                  className="font-bold"
                  textToRender={totalRuns.toLocaleString()}
                  textToCopy={totalRuns.toString()}
                />
                <small className="text-[9px] text-muted-foreground uppercase">Total</small>
              </div>
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
          inputs.materials.map((input) => (
            <InputRow
              input={input}
              locationId={locationId}
              jobs={jobs}
              marketBuyOrderQuantity={marketBuyOrderQuantities?.[String(input.typeId)] ?? 0}
              key={input.typeId}
            />
          ))
        ) : (
          <p className="py-2 text-muted-foreground">No material inputs</p>
        )}
      </div>
    </ResponsiveDialogDrawer>
  );
}
