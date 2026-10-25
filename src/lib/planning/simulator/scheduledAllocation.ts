import { requiredMaterialQuantity } from "@/lib/planning/materialQuantities";
import type { IndustrySimulationResult } from "./industrySimulation";
import type { SimulationTransaction } from "./ledger";
import { scheduleSimulationJobs } from "./scheduler";
import type { SimulatorInventory } from "./sourceLots";
import type {
  SimulationDemandSource,
  SimulationIndustryJob,
  SimulationJobInput,
  SimulationRequestV1,
  SimulationUpstreamReservation,
} from "./types";

/** One conserved input credit, with its original provenance and new consumers. */
interface InputCredit {
  originJobId: string;
  horizon: "now" | "hauling" | "upstream";
  remaining: number;
  reservation?: SimulationUpstreamReservation;
  allocations: Array<{ jobId: string; quantity: number }>;
}

/** Supply already committed to industry at one physical location and type. */
interface InputPool {
  credits: InputCredit[];
  local: number;
}

/** Identifies input stock without mixing locations or blueprint-run licenses. */
function inputKey(locationId: number, typeId: number): string {
  return `${locationId}:${typeId}`;
}

/** Collects declaration-time credits without changing production quantities or physical routes. */
function collectInputPools(jobs: readonly SimulationIndustryJob[]): Map<string, InputPool> {
  const pools = new Map<string, InputPool>();
  for (const job of jobs) {
    for (const input of job.inputs) {
      const key = inputKey(job.locationId, input.typeId);
      const pool = pools.get(key) ?? { credits: [], local: 0 };
      const credits: Array<Pick<InputCredit, "horizon" | "reservation"> & { quantity: number }> = [
        { horizon: "now", quantity: input.availableNow },
        { horizon: "hauling", quantity: input.availableFromHauling },
        ...(input.upstreamReservations ?? []).map((reservation) => ({
          horizon: "upstream" as const,
          quantity: reservation.quantity,
          reservation,
        })),
      ];
      for (const credit of credits) {
        if (credit.quantity <= 0) continue;
        pool.credits.push({
          ...credit,
          originJobId: job.jobId,
          remaining: credit.quantity,
          allocations: [],
        });
      }
      pool.local += input.availableNow;
      pools.set(key, pool);
    }
  }
  return pools;
}

/** Uses the same integer material rounding as declaration and installation. */
function inputQuantity(
  job: SimulationIndustryJob,
  input: SimulationJobInput,
  runs: number,
): number {
  if (input.quantityPerRun === undefined) {
    throw new Error(`Industry input ${job.jobId}:${input.typeId} has no SDE run quantity.`);
  }
  return requiredMaterialQuantity(
    job.activity,
    input.quantityPerRun,
    runs,
    { me: job.blueprint.materialEfficiency },
    job.materialMultiplier,
  );
}

/** Finds the largest complete integer run kit available at one supply horizon. */
function availableRuns(
  job: SimulationIndustryJob,
  quantityFor: (input: SimulationJobInput) => number,
): number {
  let lower = 0;
  let upper = job.requiredRuns;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (job.inputs.every((input) => inputQuantity(job, input, candidate) <= quantityFor(input))) {
      lower = candidate;
    }
    else upper = candidate - 1;
  }
  return lower;
}

/** Previews shared local stock so scheduling priority is not inherited from declaration order. */
function previewJob(
  job: SimulationIndustryJob,
  pools: ReadonlyMap<string, InputPool>,
): SimulationIndustryJob {
  const localRuns =
    job.blueprint.horizon === "now"
      ? availableRuns(job, (input) => pools.get(inputKey(job.locationId, input.typeId))?.local ?? 0)
      : 0;
  return {
    ...job,
    readyNowRuns: localRuns,
    inputs: job.inputs.map((input) => ({
      ...input,
      availableNow: Math.min(
        input.requiredQuantity,
        pools.get(inputKey(job.locationId, input.typeId))?.local ?? 0,
      ),
    })),
  };
}

/** Claims a credit once and records its exact new job ownership. */
function claimCredits(
  pool: InputPool,
  job: SimulationIndustryJob,
  input: SimulationJobInput,
  quantity: number,
  horizon: InputCredit["horizon"],
): void {
  let remaining = quantity;
  for (const credit of pool.credits) {
    if (remaining <= 0) break;
    if (credit.horizon !== horizon || credit.remaining <= 0) continue;
    const claimed = Math.min(remaining, credit.remaining);
    credit.remaining -= claimed;
    credit.allocations.push({ jobId: job.jobId, quantity: claimed });
    remaining -= claimed;
    if (horizon === "now") {
      input.availableNow += claimed;
      pool.local -= claimed;
    }
    else if (horizon === "hauling") input.availableFromHauling += claimed;
    else if (credit.reservation) {
      input.upstreamReservations = [
        ...(input.upstreamReservations ?? []),
        { ...credit.reservation, quantity: claimed },
      ];
    }
  }
}

/** Recomputes readiness from conserved credits, including bounded upstream propagation. */
function updateReadiness(jobs: readonly SimulationIndustryJob[]): void {
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  for (const job of jobs) {
    const blueprintNow = job.blueprint.horizon === "now";
    const blueprintHauled = blueprintNow || job.blueprint.horizon === "after-hauling";
    job.readyNowRuns = blueprintNow ? availableRuns(job, (input) => input.availableNow) : 0;
    job.readyAfterHaulingRuns = blueprintHauled
      ? availableRuns(job, (input) => input.availableNow + input.availableFromHauling)
      : 0;
    job.readyAfterUpstreamRuns = 0;
  }
  for (let pass = 0; pass <= jobs.length; pass += 1) {
    const readyOutputByJob = new Map(
      jobs.map((job) => [job.jobId, job.readyAfterUpstreamRuns * job.outputPerRun]),
    );
    let changed = false;
    for (const job of jobs) {
      for (const input of job.inputs) {
        let upstream = 0;
        for (const reservation of input.upstreamReservations ?? []) {
          const sourceId = String(reservation.sourceJobId);
          if (reservation.state === "planned" && jobsById.has(sourceId)) {
            const available = readyOutputByJob.get(sourceId) ?? 0;
            const claimed = Math.min(available, reservation.quantity);
            upstream += claimed;
            readyOutputByJob.set(sourceId, available - claimed);
          }
          else if (reservation.state === "in-production") upstream += reservation.quantity;
        }
        input.availableAfterUpstream = input.availableNow + input.availableFromHauling + upstream;
      }
      const ready = availableRuns(job, (input) => input.availableAfterUpstream);
      if (ready !== job.readyAfterUpstreamRuns) changed = true;
      job.readyAfterUpstreamRuns = ready;
      job.blockedRuns = job.requiredRuns - ready;
    }
    if (!changed) break;
  }
}

/** Returns exact reassigned quantities for one original source stream. */
function creditAllocations(
  pools: ReadonlyMap<string, InputPool>,
  locationId: number,
  typeId: number,
  originJobId: string,
  horizon: InputCredit["horizon"],
  sourceJobId?: string,
): Array<{ jobId: string; quantity: number }> {
  return (pools.get(inputKey(locationId, typeId))?.credits ?? [])
    .filter(
      (credit) =>
        credit.originJobId === originJobId
        && credit.horizon === horizon
        && (sourceJobId === undefined || String(credit.reservation?.sourceJobId) === sourceJobId),
    )
    .flatMap((credit) => credit.allocations);
}

/** Splits a quantity across a conserved stream without changing any physical source totals. */
function allocationRange(
  allocations: readonly { jobId: string; quantity: number }[],
  offset: number,
  quantity: number,
): Array<{ jobId: string; quantity: number }> {
  const selected: Array<{ jobId: string; quantity: number }> = [];
  let skipped = offset;
  let remaining = quantity;
  for (const allocation of allocations) {
    if (remaining <= 0) break;
    if (skipped >= allocation.quantity) {
      skipped -= allocation.quantity;
      continue;
    }
    const claimed = Math.min(remaining, allocation.quantity - skipped);
    selected.push({ jobId: allocation.jobId, quantity: claimed });
    remaining -= claimed;
    skipped = 0;
  }
  if (remaining !== 0) {
    throw new Error("Scheduled input allocation did not conserve a source stream.");
  }
  return selected;
}

/** Reattributes journal facts and haul provenance while preserving every lot and route quantity. */
function updateProvenance(
  industry: IndustrySimulationResult,
  pools: ReadonlyMap<string, InputPool>,
  jobs: readonly SimulationIndustryJob[],
  inventory: SimulatorInventory,
): void {
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const lotsById = new Map(inventory.itemLots.map((lot) => [lot.lotId, lot]));
  const offsets = new Map<string, number>();
  const transactions: SimulationTransaction[] = [];
  for (const transaction of industry.transactions) {
    if (
      (transaction.kind !== "source-reservation" && transaction.kind !== "transfer-commitment")
      || !transaction.demandingJobId
      || !jobsById.has(transaction.demandingJobId)
    ) {
      transactions.push(transaction);
      continue;
    }
    const account =
      transaction.kind === "source-reservation"
        ? transaction.account
        : transaction.destinationAccount;
    const horizon =
      transaction.horizon === "after-upstream"
        ? "upstream"
        : transaction.kind === "source-reservation" && transaction.horizon === "now"
          ? "now"
          : "hauling";
    const sourceId =
      horizon === "upstream" ? lotsById.get(transaction.lotId)?.industryJobId : undefined;
    const allocations = creditAllocations(
      pools,
      account.locationId,
      account.typeId,
      transaction.demandingJobId,
      horizon,
      sourceId === undefined ? undefined : String(sourceId),
    );
    if (allocations.length === 0) {
      transactions.push(transaction);
      continue;
    }
    const key = `${transaction.kind}:${inputKey(account.locationId, account.typeId)}:${transaction.demandingJobId}:${horizon}:${sourceId ?? ""}`;
    const offset = offsets.get(key) ?? 0;
    for (const [index, allocation] of allocationRange(
      allocations,
      offset,
      transaction.quantity,
    ).entries()) {
      transactions.push({
        ...transaction,
        id: `${transaction.id}:scheduled:${index}`,
        demandingJobId: allocation.jobId,
        quantity: allocation.quantity,
      });
    }
    offsets.set(key, offset + transaction.quantity);
  }
  const allocatorIds = new Set(
    industry.allocator.transactions.map((transaction) => transaction.id),
  );
  industry.allocator.transactions.splice(
    0,
    industry.allocator.transactions.length,
    ...transactions.filter((transaction) =>
      allocatorIds.has(transaction.id.split(":scheduled:")[0]),
    ),
  );
  industry.transactions = transactions;
  offsets.clear();
  for (const task of industry.allocator.haulingTasks) {
    if (task.blueprintKind) continue;
    task.demands = task.demands.flatMap((demand) => {
      if (!demand.jobId || !jobsById.has(demand.jobId)) return [demand];
      const horizon = task.purpose === "completion" ? "upstream" : "hauling";
      const sourceId = task.lotId ? lotsById.get(task.lotId)?.industryJobId : undefined;
      const allocations = creditAllocations(
        pools,
        task.toLocationId,
        task.typeId,
        demand.jobId,
        horizon,
        sourceId === undefined ? undefined : String(sourceId),
      );
      if (allocations.length === 0) return [demand];
      const key = `${inputKey(task.toLocationId, task.typeId)}:${demand.jobId}:${horizon}:${sourceId ?? ""}`;
      const offset = offsets.get(key) ?? 0;
      offsets.set(key, offset + demand.quantity);
      return allocationRange(allocations, offset, demand.quantity);
    });
  }
}

/** Aligns local demand readiness and residual purchase ownership with the scheduled allocation. */
function updateDemandSources(
  request: SimulationRequestV1,
  industry: IndustrySimulationResult,
  jobs: readonly SimulationIndustryJob[],
): void {
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const sources = new Map<string, SimulationDemandSource>();
  for (const transaction of industry.transactions) {
    if (transaction.kind !== "demand" || !transaction.source.demandingJobId) continue;
    const job = jobsById.get(transaction.source.demandingJobId);
    const input = job?.inputs.find((candidate) => candidate.typeId === transaction.account.typeId);
    if (!job || !input || transaction.source.quantityKind === "blueprint-run") continue;
    sources.set(`${job.jobId}:${input.typeId}`, transaction.source);
  }
  const demandIds = new Set([...sources.values()].map((source) => source.demandId));
  industry.transactions = industry.transactions.filter(
    (transaction) =>
      transaction.kind !== "demand-readiness" || !demandIds.has(transaction.demandId),
  );
  industry.unmetDemands = industry.unmetDemands.filter(
    (demand) => !demand.source.demandingJobId || !jobsById.has(demand.source.demandingJobId),
  );
  for (const job of jobs) {
    for (const input of job.inputs) {
      const source = sources.get(`${job.jobId}:${input.typeId}`);
      if (!source) continue;
      const settled = {
        ...source,
        requiredNow: input.availableNow,
        reserved: input.requiredQuantity - input.availableNow,
      };
      if (input.availableNow > 0) {
        industry.transactions.push({
          id: `scheduled-readiness:${source.demandId}`,
          kind: "demand-readiness",
          account: { locationId: job.locationId, typeId: input.typeId },
          demandId: source.demandId,
          quantity: input.availableNow,
        });
      }
      if (input.unsatisfiedQuantity > 0) {
        industry.unmetDemands.push({
          account: { locationId: job.locationId, typeId: input.typeId },
          quantity: input.unsatisfiedQuantity,
          source: settled,
          blockedByBuyBlacklist: request.settings.buyBlacklist.includes(input.typeId),
          purpose: "material",
        });
      }
    }
  }
}

/** Rebuilds producer-to-consumer edges after future output changes its consuming job. */
function updateProductionDemands(
  industry: IndustrySimulationResult,
  jobs: readonly SimulationIndustryJob[],
): void {
  const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const sourcesByDemandId = new Map<string, SimulationDemandSource>();
  const sourcesByInput = new Map<string, SimulationDemandSource>();
  for (const transaction of industry.transactions) {
    if (transaction.kind !== "demand") continue;
    sourcesByDemandId.set(transaction.source.demandId, transaction.source);
    if (transaction.source.demandingJobId && transaction.source.quantityKind !== "blueprint-run") {
      sourcesByInput.set(
        `${transaction.source.demandingJobId}:${transaction.account.typeId}`,
        transaction.source,
      );
    }
  }
  for (const job of jobs) {
    job.demandContributions = job.demandContributions.filter((contribution) => {
      const consumerId = sourcesByDemandId.get(contribution.demandId)?.demandingJobId;
      return consumerId === undefined || !jobsById.has(consumerId);
    });
    job.demandSources = job.demandSources.filter(
      (source) => source.demandingJobId === undefined || !jobsById.has(source.demandingJobId),
    );
  }
  for (const consumer of jobs) {
    for (const input of consumer.inputs) {
      const source = sourcesByInput.get(`${consumer.jobId}:${input.typeId}`);
      if (!source) continue;
      for (const reservation of input.upstreamReservations ?? []) {
        if (reservation.state !== "planned") continue;
        const producer = jobsById.get(String(reservation.sourceJobId));
        if (!producer) continue;
        const existing = producer.demandContributions.find(
          (contribution) => contribution.demandId === source.demandId,
        );
        if (existing) existing.quantity += reservation.quantity;
        else {
          producer.demandContributions.push({
            demandId: source.demandId,
            stockpileId: source.stockpileId,
            destinationLocationId: consumer.locationId,
            quantity: reservation.quantity,
          });
          producer.demandSources.push(source);
        }
      }
    }
  }
}

/** Allocates declared industry inputs in previewed schedule order, reserving complete local kits first. */
export function allocateScheduledIndustryInputs(
  request: SimulationRequestV1,
  industry: IndustrySimulationResult,
  inventory: SimulatorInventory,
): void {
  const jobs = [...industry.manufacturingJobs, ...industry.reactionJobs];
  const pools = collectInputPools(jobs);
  const previews = jobs.map((job) => previewJob(job, pools));
  const schedule = scheduleSimulationJobs(
    previews.filter((job) => job.activity === "manufacturing"),
    previews.filter((job) => job.activity === "reaction"),
    industry.inventionJobs,
    industry.copyJobs,
    request.simulation.characters,
    new Map(
      (request.facilityProfiles ?? []).map((profile) => [profile.locationId, profile.systemId]),
    ),
    {
      manufacturing: request.skillTimeMultipliers?.manufacturing ?? 1,
      reactions: request.skillTimeMultipliers?.reactions ?? 1,
    },
    industry.jobSkillRequirements,
    request.simulation.maxReactionJobDurationHours,
    request.simulation.slots,
  );
  const priorities = new Map(
    [...schedule.manufacturingJobs, ...schedule.reactionJobs].map((job) => [job.jobId, job]),
  );
  jobs.sort((left, right) => {
    const leftPreview = priorities.get(left.jobId);
    const rightPreview = priorities.get(right.jobId);
    const leftStart =
      leftPreview?.installs[0]?.startOffsetSeconds
      ?? (request.simulation.slots.length === 0 && leftPreview?.readyNowRuns === left.requiredRuns
        ? 0
        : Number.MAX_SAFE_INTEGER);
    const rightStart =
      rightPreview?.installs[0]?.startOffsetSeconds
      ?? (request.simulation.slots.length === 0 && rightPreview?.readyNowRuns === right.requiredRuns
        ? 0
        : Number.MAX_SAFE_INTEGER);
    return (
      leftStart - rightStart
      || (rightPreview?.depth ?? 1) - (leftPreview?.depth ?? 1)
      || right.requiredRuns * right.durationPerRunSeconds
        - left.requiredRuns * left.durationPerRunSeconds
      || left.jobId.localeCompare(right.jobId)
    );
  });
  for (const job of jobs) {
    for (const input of job.inputs) {
      input.availableNow = 0;
      input.availableFromHauling = 0;
      input.upstreamReservations = [];
    }
  }
  for (const job of jobs) {
    const runs =
      job.blueprint.horizon === "now"
        ? availableRuns(
            job,
            (input) => pools.get(inputKey(job.locationId, input.typeId))?.local ?? 0,
          )
        : 0;
    for (const input of job.inputs) {
      const pool = pools.get(inputKey(job.locationId, input.typeId));
      if (pool) claimCredits(pool, job, input, inputQuantity(job, input, runs), "now");
    }
  }
  for (const job of jobs) {
    for (const input of job.inputs) {
      const pool = pools.get(inputKey(job.locationId, input.typeId));
      if (!pool) continue;
      for (const horizon of ["now", "hauling", "upstream"] as const) {
        const claimed =
          input.availableNow
          + input.availableFromHauling
          + (input.upstreamReservations ?? []).reduce(
            (total, reservation) => total + reservation.quantity,
            0,
          );
        claimCredits(pool, job, input, input.requiredQuantity - claimed, horizon);
      }
      input.unsatisfiedQuantity = Math.max(
        0,
        input.requiredQuantity
          - input.availableNow
          - input.availableFromHauling
          - (input.upstreamReservations ?? []).reduce(
            (total, reservation) => total + reservation.quantity,
            0,
          ),
      );
    }
  }
  updateReadiness(jobs);
  updateProvenance(industry, pools, jobs, inventory);
  updateDemandSources(request, industry, jobs);
  updateProductionDemands(industry, jobs);
}
