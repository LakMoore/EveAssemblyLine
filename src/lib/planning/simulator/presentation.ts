import type { SimulationIndustryJob, SimulationJobInput } from "./types";

/** Aggregated quantities and material inputs for one presentation job group. */
export interface SimulationIndustryJobQuantities {
  availableNow: number;
  required: number;
  inputs: SimulationJobInput[];
}

/** Presentation group for jobs sharing an activity, location, and product type. */
export interface SimulationIndustryJobGroup {
  groupKey: string;
  locationId: number;
  productTypeId: number;
  productName: string;
  jobs: SimulationIndustryJob[];
  quantities: SimulationIndustryJobQuantities;
}

/** Merges repeated simulator inputs while preserving aggregate availability and demand. */
export function aggregateSimulationInputs(
  inputs: readonly SimulationJobInput[],
): SimulationJobInput[] {
  const inputsByType = new Map<number, SimulationJobInput>();
  for (const input of inputs) {
    const existing = inputsByType.get(input.typeId);
    if (!existing) {
      inputsByType.set(
        input.typeId,
        {
          ...input,
          upstreamReservations: [...(input.upstreamReservations ?? [])],
        },
      );
      continue;
    }
    existing.requiredQuantity += input.requiredQuantity;
    existing.availableNow += input.availableNow;
    existing.availableFromHauling += input.availableFromHauling;
    existing.availableAfterUpstream += input.availableAfterUpstream;
    existing.unsatisfiedQuantity += input.unsatisfiedQuantity;
    existing.upstreamReservations = [
      ...(existing.upstreamReservations ?? []),
      ...(input.upstreamReservations ?? []),
    ];
    const purchaseQuantity = (existing.purchaseQuantity ?? 0) + (input.purchaseQuantity ?? 0);
    if (purchaseQuantity > 0) existing.purchaseQuantity = purchaseQuantity;
    if (existing.quantityPerRun !== input.quantityPerRun) existing.quantityPerRun = undefined;
  }
  return [...inputsByType.values()].sort(
    (left, right) => left.typeName.localeCompare(right.typeName) || left.typeId - right.typeId,
  );
}

/** Groups activity jobs and sums final-item and input quantities for presentation. */
export function groupSimulationActivityJobs(
  jobs: readonly SimulationIndustryJob[],
): SimulationIndustryJobGroup[] {
  const groups = new Map<string, SimulationIndustryJobGroup>();
  for (const job of jobs) {
    const groupKey = `${job.activity}:${job.locationId}:${job.productTypeId}`;
    const group = groups.get(groupKey);
    if (group) {
      group.jobs.push(job);
      group.quantities.availableNow += job.readyNowRuns * job.outputPerRun;
      group.quantities.required += job.requiredRuns * job.outputPerRun;
      group.quantities.inputs = aggregateSimulationInputs(
        group.jobs.flatMap((groupJob) => groupJob.inputs),
      );
      continue;
    }
    groups.set(
      groupKey,
      {
        groupKey,
        locationId: job.locationId,
        productTypeId: job.productTypeId,
        productName: job.productName,
        jobs: [job],
        quantities: {
          availableNow: job.readyNowRuns * job.outputPerRun,
          required: job.requiredRuns * job.outputPerRun,
          inputs: aggregateSimulationInputs(job.inputs),
        },
      },
    );
  }
  return [...groups.values()];
}
