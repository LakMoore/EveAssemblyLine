"use client";

import Image from "next/image";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import SimulationResultsTab from "@/components/SimulatorResultsTab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTrigger,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Maximize2, ShoppingCart, Truck } from "lucide-react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import type {
  SimulationIndustryJob,
  SimulationJobInput,
  SimulationResultV2,
  SimulationScienceAssignment,
  SupplyHorizon,
} from "@/lib/planning/simulator/types";
import {
  createInFlightTimelineEvents,
  timelineDependencyJobIds,
  type SimulationTimelineActivity,
  type SimulationTimelinePool,
} from "@/lib/planning/simulator/timeline";
import type { ClientJobsResponse } from "@/lib/client/requestCache";

type TimelineActivity = SimulationTimelineActivity;
type TimelineFilter = "all" | TimelineActivity;
type TimelinePool = SimulationTimelinePool;
type TimelineScale = "overview" | "standard" | "detail";

interface TimelineEvent {
  eventId: string;
  jobId: string;
  activity: TimelineActivity;
  pool: TimelinePool;
  slotKey: string;
  typeId?: number;
  characterId: number;
  slotIndex: number;
  locationId: number;
  label: string;
  quantityLabel: string;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  durationSeconds: number;
  isInFlight: boolean;
  readiness?: SupplyHorizon;
  dependencyJobIds: string[];
}

interface UnscheduledActivity {
  jobId: string;
  activity: TimelineActivity;
  label: string;
  quantityLabel: string;
  reason: string;
}

interface TimelineLane {
  key: string;
  characterId: number;
  characterName: string;
  pool: TimelinePool;
  slotIndex: number;
  events: TimelineEvent[];
}

interface TimelineConnection {
  key: string;
  path: string;
}

const activityLabels: Record<TimelineActivity, string> = {
  manufacturing: "Manufacturing",
  reaction: "Reaction",
  copying: "Copying",
  invention: "Invention",
  "time-research": "Time research",
  "material-research": "Material research",
};

const activityBarClasses: Record<TimelineActivity, string> = {
  manufacturing: "border-primary bg-primary/10 text-primary",
  reaction: "border-accent bg-accent text-accent-foreground",
  copying: "border-secondary bg-secondary text-secondary-foreground",
  invention: "border-muted-foreground/40 bg-muted text-foreground",
  "time-research": "border-muted-foreground/40 bg-muted text-foreground",
  "material-research": "border-muted-foreground/40 bg-muted text-foreground",
};

const inFlightBarClass = "border-dashed border-foreground/60 bg-background text-foreground";

const scalePixelsPerHour: Record<TimelineScale, number> = {
  overview: 18,
  standard: 42,
  detail: 84,
};

const laneHeight = 52;
const axisHeight = 44;
const labelColumnWidth = "12rem";
const maximumChartWidth = 80_000;

/** Converts scheduled manufacturing and reaction installs into timeline events. */
function industryTimelineEvents(jobs: readonly SimulationIndustryJob[]): TimelineEvent[] {
  return jobs.flatMap((job) =>
    job.installs.map((install) => ({
      eventId: install.installId,
      jobId: job.jobId,
      activity: job.activity,
      pool: job.activity,
      slotKey: install.slotKey,
      typeId: job.productTypeId,
      characterId: install.characterId,
      slotIndex: install.slotIndex,
      locationId: job.locationId,
      label: job.productName,
      quantityLabel: `${install.runs.toLocaleString()} runs`,
      startOffsetSeconds: install.startOffsetSeconds,
      endOffsetSeconds: install.endOffsetSeconds,
      durationSeconds: install.durationSeconds,
      isInFlight: false,
      readiness: install.readiness,
      dependencyJobIds: timelineDependencyJobIds(job.inputs),
    })),
  );
}

/** Converts scheduled copying and invention science assignments into timeline events. */
function scienceTimelineEvents(result: SimulationResultV2): TimelineEvent[] {
  const copying = result.lists.bpcToCopy.flatMap((job) =>
    job.assignments.map((assignment) =>
      scienceTimelineEvent(
        job.jobId,
        job.locationId,
        "copying",
        `Copy blueprint ${job.blueprintTypeId}`,
        job.blueprintTypeId,
        assignment,
        `${assignment.units.toLocaleString()} ${assignment.units === 1 ? "copy" : "copies"}`,
        job.inputs,
      ),
    ),
  );
  const invention = result.lists.inventionJobs.flatMap((job) =>
    job.assignments.map((assignment) =>
      scienceTimelineEvent(
        job.jobId,
        job.locationId,
        "invention",
        `Invent blueprint ${job.outputBlueprintTypeId}`,
        job.outputBlueprintTypeId,
        assignment,
        `${assignment.units.toLocaleString()} ${assignment.units === 1 ? "attempt" : "attempts"}`,
        job.inputs,
      ),
    ),
  );
  return [...copying, ...invention];
}

/** Creates one science-slot timeline event from a scheduled assignment. */
function scienceTimelineEvent(
  jobId: string,
  locationId: number,
  activity: "copying" | "invention",
  label: string,
  typeId: number,
  assignment: SimulationScienceAssignment,
  quantityLabel: string,
  inputs: readonly SimulationJobInput[],
): TimelineEvent {
  return {
    eventId: assignment.assignmentId,
    jobId,
    activity,
    pool: "science",
    slotKey: assignment.slotKey,
    typeId,
    characterId: assignment.characterId,
    slotIndex: assignment.slotIndex,
    locationId,
    label,
    quantityLabel,
    startOffsetSeconds: assignment.startOffsetSeconds,
    endOffsetSeconds: assignment.endOffsetSeconds,
    durationSeconds: assignment.durationSeconds,
    isInFlight: false,
    readiness: assignment.readiness,
    dependencyJobIds: timelineDependencyJobIds(inputs),
  };
}

/** Collects all scheduled activities from the canonical simulator response. */
function scheduledTimelineEvents(result: SimulationResultV2): TimelineEvent[] {
  return [
    ...industryTimelineEvents([...result.lists.manufacturingJobs, ...result.lists.reactionJobs]),
    ...scienceTimelineEvents(result),
  ].sort(
    (left, right) =>
      left.startOffsetSeconds - right.startOffsetSeconds
      || left.eventId.localeCompare(right.eventId),
  );
}

/** Returns activities that the scheduler could not place into a timed slot. */
function unscheduledTimelineActivities(result: SimulationResultV2): UnscheduledActivity[] {
  const warningByJobId = new Map(
    result.lists.warnings.flatMap((warning) =>
      warning.jobId ? [[warning.jobId, warning.message] as const] : [],
    ),
  );
  const unscheduledIndustry = [
    ...result.lists.manufacturingJobs,
    ...result.lists.reactionJobs,
  ].flatMap((job) =>
    job.unscheduledRuns > 0
      ? [
          {
            jobId: job.jobId,
            activity: job.activity,
            label: job.productName,
            quantityLabel: `${job.unscheduledRuns.toLocaleString()} runs`,
            reason:
              job.noTimingReason
              ?? warningByJobId.get(job.jobId)
              ?? "No timing reason is available.",
          },
        ]
      : [],
  );
  const unscheduledCopying = result.lists.bpcToCopy.flatMap((job) =>
    job.unscheduledCopies > 0
      ? [
          {
            jobId: job.jobId,
            activity: "copying" as const,
            label: `Copy blueprint ${job.blueprintTypeId}`,
            quantityLabel: `${job.unscheduledCopies.toLocaleString()} copies`,
            reason:
              job.noTimingReason
              ?? warningByJobId.get(job.jobId)
              ?? "No timing reason is available.",
          },
        ]
      : [],
  );
  const unscheduledInvention = result.lists.inventionJobs.flatMap((job) =>
    job.unscheduledAttempts > 0
      ? [
          {
            jobId: job.jobId,
            activity: "invention" as const,
            label: `Invent blueprint ${job.outputBlueprintTypeId}`,
            quantityLabel: `${job.unscheduledAttempts.toLocaleString()} attempts`,
            reason:
              job.noTimingReason
              ?? warningByJobId.get(job.jobId)
              ?? "No timing reason is available.",
          },
        ]
      : [],
  );
  return [...unscheduledIndustry, ...unscheduledCopying, ...unscheduledInvention];
}

/** Groups events into independent character activity-slot lanes. */
function groupTimelineLanes(
  events: readonly TimelineEvent[],
  characterNamesById: ReadonlyMap<number, string>,
): TimelineLane[] {
  const lanes = new Map<string, TimelineLane>();
  for (const event of events) {
    const key = event.slotKey;
    const lane = lanes.get(key);
    if (lane) {
      lane.events.push(event);
      continue;
    }
    lanes.set(
      key,
      {
        key,
        characterId: event.characterId,
        characterName:
          characterNamesById.get(event.characterId) ?? `Character ${event.characterId}`,
        pool: event.pool,
        slotIndex: event.slotIndex,
        events: [event],
      },
    );
  }
  const poolOrder: Record<TimelinePool, number> = {
    manufacturing: 0,
    reaction: 1,
    science: 2,
  };
  return [...lanes.values()].sort(
    (left, right) =>
      left.characterName.localeCompare(right.characterName)
      || poolOrder[left.pool] - poolOrder[right.pool]
      || left.slotIndex - right.slotIndex,
  );
}

/** Formats a non-negative simulated offset for chart labels and details. */
function formatOffset(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `T+${days}d ${hours}h`;
  if (hours > 0) return `T+${hours}h ${minutes}m`;
  return `T+${minutes}m`;
}

/** Formats an axis tick while keeping the timeline's origin explicit. */
function formatTick(hours: number): string {
  if (hours === 0) return "T+0";
  if (hours % 24 === 0) return `T+${hours / 24}d`;
  return `T+${hours}h`;
}

/** Chooses readable tick spacing for short and long simulation schedules. */
function timelineTicks(maxHours: number): number[] {
  const baseInterval = maxHours <= 36 ? 6 : maxHours <= 336 ? 24 : 168;
  const interval = baseInterval * Math.max(1, Math.ceil(maxHours / baseInterval / 40));
  const ticks: number[] = [];
  for (let hour = 0; hour <= maxHours; hour += interval) ticks.push(hour);
  return ticks;
}

/** Creates SVG dependency paths between scheduled upstream and downstream work. */
function timelineConnections(
  lanes: readonly TimelineLane[],
  chartWidth: number,
  pixelsPerHour: number,
): TimelineConnection[] {
  const laneByEventId = new Map<string, number>();
  const eventsByJobId = new Map<string, TimelineEvent[]>();
  lanes.forEach((lane, laneIndex) => {
    for (const event of lane.events) {
      laneByEventId.set(event.eventId, laneIndex);
      const jobEvents = eventsByJobId.get(event.jobId) ?? [];
      jobEvents.push(event);
      eventsByJobId.set(event.jobId, jobEvents);
    }
  });
  const connections = new Map<string, TimelineConnection>();
  for (const lane of lanes) {
    for (const target of lane.events) {
      for (const sourceJobId of target.dependencyJobIds) {
        const source = eventsByJobId
          .get(sourceJobId)
          ?.slice()
          .sort((left, right) => right.endOffsetSeconds - left.endOffsetSeconds)[0];
        const sourceLaneIndex = source ? laneByEventId.get(source.eventId) : undefined;
        const targetLaneIndex = laneByEventId.get(target.eventId);
        if (!source || sourceLaneIndex === undefined || targetLaneIndex === undefined) continue;
        const sourceX = Math.min(chartWidth, (source.endOffsetSeconds / 3600) * pixelsPerHour);
        const targetX = Math.min(chartWidth, (target.startOffsetSeconds / 3600) * pixelsPerHour);
        const sourceY = sourceLaneIndex * laneHeight + laneHeight / 2;
        const targetY = targetLaneIndex * laneHeight + laneHeight / 2;
        const middleX = (sourceX + targetX) / 2;
        const key = `${source.eventId}:${target.eventId}`;
        connections.set(
          key,
          {
            key,
            path: `M ${sourceX} ${sourceY} C ${middleX} ${sourceY}, ${middleX} ${targetY}, ${targetX} ${targetY}`,
          },
        );
      }
    }
  }
  return [...connections.values()];
}

/** Returns the display label for an activity's slot pool. */
function poolLabel(pool: TimelinePool): string {
  if (pool === "science") return "Science";
  return pool === "reaction" ? "Reaction" : "Manufacturing";
}

/** Returns a readable generated-at value for the schedule's T+0 reference. */
function generatedAtLabel(generatedAt: string): string {
  const date = new Date(generatedAt);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : generatedAt;
}

/** Owns the schedule trigger and dialog state while scheduled work is available. */
function SimulationScheduleDialog({
  generatedAt,
  scheduledCount,
  inFlightCount,
  unassignedCount,
  children,
}: {
  generatedAt: string;
  scheduledCount: number;
  inFlightCount: number;
  unassignedCount: number;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger
        render={
          <Button className="max-[640px]:w-full" type="button" variant="outline" size="sm">
            <Maximize2 data-icon="inline-start" aria-hidden="true" />
            Open schedule
          </Button>
        }
      />
      <DialogContent className="fixed inset-0 flex h-dvh max-h-dvh w-screen max-w-none translate-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle className="text-base">Simulation schedule</DialogTitle>
          <DialogDescription>
            T+0: {generatedAtLabel(generatedAt)} · {scheduledCount} scheduled · {inFlightCount} in
            flight · {unassignedCount} unassigned
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Displays canonical scheduled activities as a character-slot Gantt timeline. */
export default function SimulationTimeline({
  result,
  industryJobs,
  characterNamesById,
  locationNamesById,
}: {
  result: SimulationResultV2;
  industryJobs?: ClientJobsResponse["jobs"];
  characterNamesById: ReadonlyMap<number, string>;
  locationNamesById: ReadonlyMap<number, string>;
}) {
  const id = useId();
  const headerAxisRef = useRef<HTMLDivElement>(null);
  const [activityFilter, setActivityFilter] = useState<TimelineFilter>("all");
  const [scale, setScale] = useState<TimelineScale>("overview");
  const collectionCharacterIds = useMemo(
    () => new Set(characterNamesById.keys()),
    [characterNamesById],
  );
  const scheduledEvents = useMemo(
    () =>
      scheduledTimelineEvents(result).filter((event) =>
        collectionCharacterIds.has(event.characterId),
      ),
    [collectionCharacterIds, result],
  );
  const inFlightEvents = useMemo(
    () =>
      createInFlightTimelineEvents(
        industryJobs,
        result.metadata.generatedAt,
        collectionCharacterIds,
        result.scheduleSlots,
      ),
    [collectionCharacterIds, industryJobs, result.metadata.generatedAt, result.scheduleSlots],
  );
  const allEvents = useMemo(
    () =>
      [...scheduledEvents, ...inFlightEvents].sort(
        (left, right) =>
          left.startOffsetSeconds - right.startOffsetSeconds
          || left.eventId.localeCompare(right.eventId),
      ),
    [inFlightEvents, scheduledEvents],
  );
  const allUnscheduled = useMemo(() => unscheduledTimelineActivities(result), [result]);
  const events = allEvents.filter(
    (event) => activityFilter === "all" || event.activity === activityFilter,
  );
  const unscheduled = allUnscheduled.filter(
    (item) => activityFilter === "all" || item.activity === activityFilter,
  );
  const lanes = groupTimelineLanes(events, characterNamesById);
  const maxEndSeconds = Math.max(0, ...events.map((event) => event.endOffsetSeconds));
  const maxHours = Math.max(1, maxEndSeconds / 3600);
  const pixelsPerHour = Math.min(scalePixelsPerHour[scale], maximumChartWidth / maxHours);
  const chartWidth = Math.max(900, Math.ceil(maxHours * pixelsPerHour));
  const ticks = timelineTicks(maxHours);
  const connections = timelineConnections(lanes, chartWidth, pixelsPerHour);
  const scheduledCount = scheduledEvents.length;
  const inFlightCount = inFlightEvents.length;
  const hasAnyActivities = allEvents.length + allUnscheduled.length > 0;

  return (
    <>
      {hasAnyActivities ? (
        <SimulationScheduleDialog
          generatedAt={result.metadata.generatedAt}
          scheduledCount={scheduledCount}
          inFlightCount={inFlightCount}
          unassignedCount={allUnscheduled.length}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <SimulationResultsTab
              hasResults={hasAnyActivities}
              settings={
                <div className="flex flex-wrap items-end gap-3 border-b pb-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`${id}-activity`}>Activity</Label>
                    <Select
                      value={activityFilter}
                      onValueChange={(value) => {
                        if (
                          value === "all"
                          || value === "manufacturing"
                          || value === "reaction"
                          || value === "copying"
                          || value === "invention"
                          || value === "time-research"
                          || value === "material-research"
                        ) setActivityFilter(value);
                      }}
                    >
                      <SelectTrigger id={`${id}-activity`} aria-label="Filter schedule by activity">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All activities</SelectItem>
                        <SelectItem value="manufacturing">Manufacturing</SelectItem>
                        <SelectItem value="reaction">Reaction</SelectItem>
                        <SelectItem value="copying">Copying</SelectItem>
                        <SelectItem value="invention">Invention</SelectItem>
                        <SelectItem value="time-research">Time research</SelectItem>
                        <SelectItem value="material-research">Material research</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`${id}-scale`}>Scale</Label>
                    <Select
                      value={scale}
                      onValueChange={(value) => {
                        if (value === "overview" || value === "standard" || value === "detail") {
                          setScale(value);
                        }
                      }}
                    >
                      <SelectTrigger id={`${id}-scale`} aria-label="Schedule timeline scale">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="overview">Overview</SelectItem>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="detail">Detail</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              }
            >
              <div className="flex min-w-0 flex-col gap-4">
                {events.length > 0 ? (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                      {Object
                        .entries(activityLabels)
                        .map(([activity, label]) => (
                          <span key={activity} className="flex items-center gap-1.5">
                            <span
                              aria-hidden="true"
                              className={`size-2 border ${activityBarClasses[activity as TimelineActivity]}`}
                            />
                            {label}
                          </span>
                        ))}
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={`size-2 border ${inFlightBarClass}`} />
                        In flight
                      </span>
                      <span>{connections.length} upstream links</span>
                    </div>
                    <div className="flex h-[calc(100dvh-15rem)] min-h-48 w-full flex-col overflow-hidden border">
                      <div
                        className="grid shrink-0"
                        style={{ gridTemplateColumns: `${labelColumnWidth} minmax(0, 1fr)` }}
                      >
                        <div className="flex items-center border-b bg-background px-3 text-xs font-medium">
                          Character / slot
                        </div>
                        <div
                          className="relative min-w-0 overflow-hidden border-b bg-background"
                          style={{ height: axisHeight }}
                        >
                          <div
                            ref={headerAxisRef}
                            className="absolute inset-y-0 left-0"
                            style={{ width: chartWidth }}
                          >
                            {ticks.map((hour) => (
                              <div
                                key={hour}
                                className="absolute inset-y-0 border-l border-border"
                                style={{ left: hour * pixelsPerHour }}
                              >
                                <span className="absolute top-1 left-1 text-[10px] whitespace-nowrap text-muted-foreground">
                                  {formatTick(hour)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <ScrollArea
                        className="min-h-0 flex-1"
                        onScrollCapture={(event) => {
                          const viewport = event.target;
                          if (viewport instanceof HTMLElement && headerAxisRef.current) {
                            headerAxisRef.current.style.transform = `translateX(-${viewport.scrollLeft}px)`;
                          }
                        }}
                      >
                        <div
                          className="relative grid"
                          style={{ gridTemplateColumns: `${labelColumnWidth} ${chartWidth}px` }}
                        >
                          {connections.length > 0 && (
                            <svg
                              aria-hidden="true"
                              className="pointer-events-none absolute z-0 text-muted-foreground/50"
                              height={lanes.length * laneHeight}
                              style={{ left: labelColumnWidth, top: 0 }}
                              viewBox={`0 0 ${chartWidth} ${lanes.length * laneHeight}`}
                              width={chartWidth}
                            >
                              {connections.map((connection) => (
                                <path
                                  key={connection.key}
                                  d={connection.path}
                                  fill="none"
                                  stroke="currentColor"
                                  strokeDasharray="4 4"
                                  strokeWidth="1.5"
                                />
                              ))}
                            </svg>
                          )}
                          {lanes.map((lane) => (
                            <TimelineLaneRow
                              key={lane.key}
                              lane={lane}
                              chartWidth={chartWidth}
                              pixelsPerHour={pixelsPerHour}
                              ticks={ticks}
                              characterNamesById={characterNamesById}
                              locationNamesById={locationNamesById}
                            />
                          ))}
                        </div>
                        <ScrollBar orientation="horizontal" />
                      </ScrollArea>
                    </div>
                  </>
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No timed assignments for this activity</EmptyTitle>
                      <EmptyDescription>
                        Change the activity filter or review the unassigned work below.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {unscheduled.length > 0 && (
                  <section className="flex flex-col gap-2 border-t pt-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-sm font-medium">Unassigned work</h3>
                      <span className="text-xs text-muted-foreground">
                        No simulated start or end time
                      </span>
                    </div>
                    <div className="divide-y">
                      {unscheduled.map((item) => (
                        <div
                          key={item.jobId}
                          className="grid gap-x-3 gap-y-1 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge variant="outline">{activityLabels[item.activity]}</Badge>
                            <span className="truncate font-medium">{item.label}</span>
                            <span className="text-muted-foreground">{item.quantityLabel}</span>
                          </div>
                          <p className="min-w-0 text-muted-foreground sm:max-w-xl sm:text-right">
                            {item.reason}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </SimulationResultsTab>
          </div>
        </SimulationScheduleDialog>
      ) : (
        <span className="text-xs text-muted-foreground">No scheduled activities</span>
      )}
    </>
  );
}

/** Renders one character's activity slot lane and its scheduled job bars. */
function TimelineLaneRow({
  lane,
  chartWidth,
  pixelsPerHour,
  ticks,
  characterNamesById,
  locationNamesById,
}: {
  lane: TimelineLane;
  chartWidth: number;
  pixelsPerHour: number;
  ticks: readonly number[];
  characterNamesById: ReadonlyMap<number, string>;
  locationNamesById: ReadonlyMap<number, string>;
}) {
  return (
    <>
      <div className="sticky left-0 z-10 flex flex-col justify-center border-b bg-background px-3">
        <span className="truncate text-xs font-medium">
          {characterNamesById.get(lane.characterId) ?? `Character ${lane.characterId}`}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {poolLabel(lane.pool)} slot {lane.slotIndex + 1}
        </span>
      </div>
      <div className="relative border-b" style={{ height: laneHeight, width: chartWidth }}>
        {ticks.map((hour) => (
          <div
            key={hour}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 border-l border-border/60"
            style={{ left: hour * pixelsPerHour }}
          />
        ))}
        {lane.events.map((event) => {
          const left = (event.startOffsetSeconds / 3600) * pixelsPerHour;
          const durationWidth = Math.max(
            3,
            ((event.endOffsetSeconds - event.startOffsetSeconds) / 3600) * pixelsPerHour,
          );
          const AvailabilityIcon =
            event.readiness === "after-purchase"
              ? ShoppingCart
              : event.readiness === "after-hauling"
                ? Truck
                : undefined;
          const minWidth = event.typeId ? (AvailabilityIcon ? 48 : 28) : AvailabilityIcon ? 20 : 3;
          const width = Math.max(durationWidth, minWidth);
          const locationName =
            locationNamesById.get(event.locationId) ?? `Location ${event.locationId}`;
          const availabilityLabel =
            event.readiness === "after-purchase"
              ? "After purchase"
              : event.readiness === "after-hauling"
                ? "After hauling"
                : undefined;
          const eventLabel = `${event.isInFlight ? "In flight · " : ""}${availabilityLabel ? `${availabilityLabel} · ` : ""}${activityLabels[event.activity]}: ${event.label}, ${event.quantityLabel}`;
          return (
            <Tooltip key={event.eventId}>
              <TooltipTrigger
                render={
                  <span
                    aria-label={eventLabel}
                    className={`absolute top-2 z-10 flex h-8 min-w-[3px] items-center gap-1 overflow-hidden border px-1 text-left text-[10px] ${event.isInFlight ? inFlightBarClass : activityBarClasses[event.activity]}`}
                    role="group"
                    style={{ left, width }}
                    tabIndex={0}
                  >
                    {AvailabilityIcon && (
                      <AvailabilityIcon aria-hidden="true" className="size-3 shrink-0" />
                    )}
                    {event.typeId && (
                      <Image
                        alt=""
                        aria-hidden="true"
                        className="size-4 shrink-0 object-contain"
                        height={16}
                        src={eveTypeImageUrl(event.typeId, "icon", 32)}
                        width={16}
                      />
                    )}
                    {width >= 112 && (
                      <span className="truncate">
                        {event.label} · {event.quantityLabel}
                      </span>
                    )}
                  </span>
                }
              />
              <TooltipContent>
                <div className="flex max-w-xs flex-col items-start gap-1">
                  <strong>{event.label}</strong>
                  <span>
                    {event.isInFlight ? "In flight · " : ""}
                    {activityLabels[event.activity]} · {event.quantityLabel}
                  </span>
                  <span>{locationName}</span>
                  <span>
                    {formatOffset(event.startOffsetSeconds)} to{" "}
                    {formatOffset(event.endOffsetSeconds)}
                    {event.readiness ? ` · ${event.readiness.replaceAll("-", " ")}` : ""}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
}
