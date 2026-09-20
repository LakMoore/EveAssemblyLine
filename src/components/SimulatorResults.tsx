"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Atom,
  Boxes,
  Brain,
  Factory,
  FlaskConical,
  ShoppingCart,
  Truck,
} from "lucide-react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SimulationMaterialBalance, SimulationResultV1 } from "@/lib/planning/simulator/types";

type SimulatorTab =
  | "plan"
  | "buy"
  | "reprocess"
  | "copy"
  | "invent"
  | "react"
  | "manufacture"
  | "haul"
  | "skills"
  | "warnings";

const tabs: Array<{ value: SimulatorTab; label: string; icon: typeof Boxes }> = [
  { value: "plan", label: "Plan", icon: Boxes },
  { value: "buy", label: "Buy", icon: ShoppingCart },
  { value: "reprocess", label: "Reprocess", icon: FlaskConical },
  { value: "copy", label: "Copy", icon: Boxes },
  { value: "invent", label: "Invent", icon: Atom },
  { value: "react", label: "React", icon: Atom },
  { value: "manufacture", label: "Manufacture", icon: Factory },
  { value: "haul", label: "Haul", icon: Truck },
  { value: "skills", label: "Skills", icon: Brain },
  { value: "warnings", label: "Warnings", icon: AlertTriangle },
];

/** Formats simulator quantities for compact operational rows. */
function quantity(value: number): string {
  return value.toLocaleString();
}

/** Resolves a readable location label from current planner reference data. */
function locationName(locationNamesById: ReadonlyMap<number, string>, locationId: number): string {
  return locationNamesById.get(locationId) ?? `Location ${locationId}`;
}

/** Groups direct simulator material balances by their activity location. */
function balancesByLocation(
  balances: readonly SimulationMaterialBalance[],
): Array<[number, SimulationMaterialBalance[]]> {
  const grouped = new Map<number, SimulationMaterialBalance[]>();
  for (const balance of balances) {
    const current = grouped.get(balance.locationId) ?? [];
    current.push(balance);
    grouped.set(balance.locationId, current);
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right);
}

/** Renders one native row with its type identity and simulator-owned operational facts. */
function NativeRow({
  typeId,
  name,
  subline,
  summary,
  variation = "icon",
}: {
  typeId: number;
  name: string;
  subline: string;
  summary: ReactNode;
  variation?: "icon" | "bp" | "bpc";
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <TypeIdentity
        name={name}
        typeId={typeId}
        subline={subline}
        variation={variation}
        linkPath="planner"
        navigateInPlace
      />
      <div className="shrink-0 text-right font-mono text-xs">{summary}</div>
    </div>
  );
}

/** Groups native rows by a physical activity location. */
function LocationGroup({
  locationId,
  locationNamesById,
  children,
}: {
  locationId: number;
  locationNamesById: ReadonlyMap<number, string>;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="border-b border-border py-3 text-sm font-medium uppercase">
        {locationName(locationNamesById, locationId)}
      </h3>
      {children}
    </section>
  );
}

/** Renders the native simulator response without a legacy PlanResponse conversion. */
export default function SimulatorResults({
  result,
  status,
  locationNamesById,
}: {
  result: SimulationResultV1 | null;
  status: string;
  locationNamesById: ReadonlyMap<number, string>;
}) {
  const [activeTab, setActiveTab] = useState<SimulatorTab>("plan");
  const balancesByActivityLocation = useMemo(
    () => (result ? balancesByLocation(result.lists.planItems) : []),
    [result],
  );
  const statusIsError = status.startsWith("Error:");

  if (!result) {
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <p aria-live="polite" className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
        {statusIsError ? (
          <Alert variant="destructive">
            <AlertTitle>Simulation failed</AlertTitle>
            <AlertDescription>{status.slice("Error: ".length)}</AlertDescription>
          </Alert>
        ) : (
          <Empty>
            <strong>Your simulator output will appear here</strong>
            <EmptyDescription>
              Simulate the active stockpiles to calculate the required work.
            </EmptyDescription>
          </Empty>
        )}
      </section>
    );
  }

  const warnings = result.lists.warnings;
  const purchases = [...result.lists.materialsToBuy, ...result.lists.bpoToBuy];
  const currentRows =
    activeTab === "plan"
      ? result.lists.planItems
      : activeTab === "buy"
        ? purchases
        : activeTab === "reprocess"
          ? result.lists.reprocessingJobs
          : activeTab === "copy"
            ? result.lists.bpcToCopy
            : activeTab === "invent"
              ? result.lists.inventionJobs
              : activeTab === "react"
                ? result.lists.reactionJobs
                : activeTab === "manufacture"
                  ? result.lists.manufacturingJobs
                  : activeTab === "haul"
                    ? result.lists.haulingTasks
                    : activeTab === "skills"
                      ? result.lists.skillsRequired
                      : warnings;

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">SIMULATOR OUTPUT</p>
          <h2 className="text-lg font-medium">Plan breakdown</h2>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline">v{result.metadata.simulatorVersion}</Badge>
          <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
            {status}
          </span>
        </div>
      </div>
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SimulatorTab)}>
        <TabsList className="w-full max-w-full justify-start overflow-x-auto" variant="line">
          {tabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon data-icon="inline-start" aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={activeTab} className="pt-3">
          {currentRows.length === 0 ? (
            <Empty>
              <strong>
                Nothing to {tabs.find((tab) => tab.value === activeTab)?.label.toLowerCase()}
              </strong>
            </Empty>
          ) : activeTab === "plan" ? (
            <div className="flex flex-col gap-4">
              {balancesByActivityLocation.map(([locationId, balances]) => (
                <LocationGroup
                  key={locationId}
                  locationId={locationId}
                  locationNamesById={locationNamesById}
                >
                  {balances.map((balance) => (
                    <NativeRow
                      key={`${balance.stockpileId}:${balance.typeId}`}
                      typeId={balance.typeId}
                      name={balance.typeName}
                      subline={`Stockpile ${balance.stockpileId}`}
                      summary={
                        <div className="flex gap-3">
                          <span>
                            <span className="mr-1 text-muted-foreground">Avail</span>
                            {quantity(balance.availableNow)}
                          </span>
                          <span>
                            <span className="mr-1 text-muted-foreground">Need</span>
                            {quantity(balance.required)}
                          </span>
                          <span>
                            <span className="mr-1 text-muted-foreground">Buy</span>
                            {quantity(balance.unsatisfied)}
                          </span>
                        </div>
                      }
                    />
                  ))}
                </LocationGroup>
              ))}
            </div>
          ) : activeTab === "buy" ? (
            <div>
              {purchases.map((purchase) => (
                <NativeRow
                  key={`${purchase.typeId}:${purchase.destinations.map((entry) => entry.locationId).join(":")}`}
                  typeId={purchase.typeId}
                  name={purchase.typeName}
                  subline={`${purchase.destinations.length} destination${purchase.destinations.length === 1 ? "" : "s"}`}
                  summary={quantity(purchase.quantity)}
                  variation={result.lists.bpoToBuy.includes(purchase) ? "bp" : "icon"}
                />
              ))}
            </div>
          ) : activeTab === "reprocess" ? (
            <div>
              {result.lists.reprocessingJobs.map((job) => (
                <NativeRow
                  key={job.jobId}
                  typeId={job.sourceTypeId}
                  name={job.sourceTypeName}
                  subline={`${locationName(locationNamesById, job.locationId)} | ${job.state}`}
                  summary={quantity(job.sourceQuantity)}
                />
              ))}
            </div>
          ) : activeTab === "copy" ? (
            <div>
              {result.lists.bpcToCopy.map((job) => (
                <NativeRow
                  key={job.jobId}
                  typeId={job.blueprintTypeId}
                  name={`Blueprint ${job.blueprintTypeId}`}
                  subline={locationName(locationNamesById, job.locationId)}
                  summary={`${quantity(job.copies)} copies`}
                  variation="bp"
                />
              ))}
            </div>
          ) : activeTab === "invent" ? (
            <div>
              {result.lists.inventionJobs.map((job) => (
                <NativeRow
                  key={job.jobId}
                  typeId={job.outputBlueprintTypeId}
                  name={`Blueprint ${job.outputBlueprintTypeId}`}
                  subline={locationName(locationNamesById, job.locationId)}
                  summary={`${quantity(job.attempts)} attempts`}
                  variation="bpc"
                />
              ))}
            </div>
          ) : activeTab === "react" || activeTab === "manufacture" ? (
            <div>
              {(activeTab === "react"
                ? result.lists.reactionJobs
                : result.lists.manufacturingJobs
              ).map((job) => (
                <NativeRow
                  key={job.jobId}
                  typeId={job.productTypeId}
                  name={job.productName}
                  subline={`${locationName(locationNamesById, job.locationId)} | ${quantity(job.inputs.length)} inputs`}
                  summary={`${quantity(job.readyNowRuns)} / ${quantity(job.requiredRuns)} runs`}
                />
              ))}
            </div>
          ) : activeTab === "haul" ? (
            <div>
              {result.lists.haulingTasks.map((task) => (
                <NativeRow
                  key={task.transferId}
                  typeId={task.typeId}
                  name={task.typeName}
                  subline={`${locationName(locationNamesById, task.fromLocationId)} to ${locationName(locationNamesById, task.toLocationId)}`}
                  summary={quantity(task.quantity)}
                />
              ))}
            </div>
          ) : activeTab === "skills" ? (
            <div>
              {result.lists.skillsRequired.map((skill) => (
                <NativeRow
                  key={skill.skillId}
                  typeId={skill.skillId}
                  name={skill.name}
                  subline={`${quantity(skill.jobIds.length)} jobs`}
                  summary={`Level ${skill.requiredLevel}`}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {warnings.map((warning, index) => (
                <div
                  className="border border-border p-3"
                  key={`${warning.code}:${warning.jobId ?? index}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <Badge variant="outline">{warning.code}</Badge>
                    {warning.locationId !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {locationName(locationNamesById, warning.locationId)}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm">{warning.message}</p>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
