import type { SimulationIndustryJob, SimulationJobInput } from "./types";

/** Aggregated quantities and material inputs for one presentation job group. */
export interface SimulationIndustryJobQuantities {
  installableRuns: number;
  totalRuns: number;
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

/** Identifies completion state for a product type at one activity location. */
export function simulationCompletionKey(locationId: number, typeId: number): string {
  return `${locationId}:${typeId}`;
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

/** Applies the Buy-tab over-order percentage and optional three-significant-figure ceiling. */
export function adjustSimulationPurchaseQuantity(
  quantity: number,
  overOrderPercent: number,
  roundUp: boolean,
): number {
  const validPercent = Number.isFinite(overOrderPercent) ? Math.max(0, overOrderPercent) : 0;
  const proportionalIncrease = quantity * (validPercent / 100);
  const increasedQuantity = quantity + proportionalIncrease;
  if (!Number.isFinite(increasedQuantity)) return Number.MAX_SAFE_INTEGER;
  const positiveIncreaseWasLost =
    validPercent > 0 && quantity > 0 && Number.isInteger(quantity) && increasedQuantity <= quantity;
  const percentageAdjustedQuantity = Math.min(
    Number.MAX_SAFE_INTEGER,
    positiveIncreaseWasLost ? quantity + 1 : Math.ceil(increasedQuantity),
  );
  if (!roundUp || percentageAdjustedQuantity <= 0) return percentageAdjustedQuantity;
  if (percentageAdjustedQuantity < 10) return 10;

  const significantFigures =
    percentageAdjustedQuantity < 100 ? 1 : percentageAdjustedQuantity < 1000 ? 2 : 3;
  const roundingStep =
    10 ** (Math.floor(Math.log10(percentageAdjustedQuantity)) - significantFigures + 1);
  const scaledQuantity = percentageAdjustedQuantity / roundingStep;
  const roundedQuantity = Math.ceil(scaledQuantity) * roundingStep;
  return Number.isFinite(roundedQuantity)
    ? Math.min(Number.MAX_SAFE_INTEGER, roundedQuantity)
    : Number.MAX_SAFE_INTEGER;
}

/** Returns whether a purchase row is eligible for Buy-tab quantity adjustments. */
export function shouldAdjustSimulationPurchaseQuantity(
  typeId: number,
  isMaterial: boolean,
  excludedTypeIds: ReadonlySet<number>,
): boolean {
  return isMaterial && !excludedTypeIds.has(typeId);
}

/** Groups activity jobs and sums installable runs and input quantities for presentation. */
export function groupSimulationActivityJobs(
  jobs: readonly SimulationIndustryJob[],
): SimulationIndustryJobGroup[] {
  const groups = new Map<string, SimulationIndustryJobGroup>();
  for (const job of jobs) {
    const groupKey = `${job.activity}:${job.locationId}:${job.productTypeId}`;
    const group = groups.get(groupKey);
    if (group) {
      group.jobs.push(job);
      group.quantities.installableRuns += job.readyNowRuns;
      group.quantities.totalRuns += job.requiredRuns;
      group.quantities.inputs = aggregateSimulationInputs(group.jobs.flatMap((job) => job.inputs));
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
          installableRuns: job.readyNowRuns,
          totalRuns: job.requiredRuns,
          inputs: aggregateSimulationInputs(job.inputs),
        },
      },
    );
  }
  return [...groups.values()];
}

/** Sums scheduled runs across jobs that begin at exactly T+0. */
export function simulationRunsStartingAtT0(jobs: readonly SimulationIndustryJob[]): number {
  return jobs.reduce(
    (total, job) =>
      total
      + job.installs.reduce(
        (jobTotal, install) => jobTotal + (install.startOffsetSeconds === 0 ? install.runs : 0),
        0,
      ),
    0,
  );
}
