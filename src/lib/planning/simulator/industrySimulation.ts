import { createHash } from "node:crypto";
import type { BlueprintsRecord } from "@/lib/sde/generated";
import { getInventionDecryptorModifiers, getNoDecryptorInventionOutput } from "@/lib/sde/invention";
import { requiredMaterialQuantity } from "@/lib/planning/materialQuantities";
import { productionGroupForType } from "@/lib/planning/productionGroups";
import type { PlanStockpile } from "@/lib/planning/types";
import { SimulationAllocator, type BlueprintClaim } from "./allocator";
import type { SimulationContext } from "./context";
import type { DependencyGraph } from "./dependencyGraph";
import type { SimulationLedgerAccount, SimulationTransaction } from "./ledger";
import { isSimulatorReprocessingType, type SimulatorInventory } from "./sourceLots";
import type { RequestProfiler } from "@/lib/server/profiling";
import type {
  SimulationBlueprintAllocation,
  SimulationCopyJob,
  SimulationDemandSource,
  SimulationIndustryJob,
  SimulationInventionJob,
  SimulationJobInput,
  SimulationPurchaseDestination,
  SimulationSkillRequirement,
  SimulationWarning,
  SimulationActivity,
  SimulationRequestV1,
  SimulationUpstreamReservation,
} from "./types";

type ProductionActivity = "manufacturing" | "reaction";
type ProductionRecord = NonNullable<
  SimulationContext["blueprints"]["byBuildProductTypeId"] extends Map<number, infer Value>
    ? Value
    : never
>;

/** Residual demand intentionally deferred to reprocessing and buying. */
export interface SimulationUnmetDemand {
  account: SimulationLedgerAccount;
  quantity: number;
  source: SimulationDemandSource;
  blockedByBuyBlacklist: boolean;
  purpose: "material" | "reprocessing-input";
}

/** Blueprint-original or formula purchase required by a planned activity. */
export interface SimulationBlueprintPurchase {
  typeId: number;
  quantity: number;
  destination: SimulationPurchaseDestination;
}

/** Complete output of manufacturing/reaction/invention/copying declaration. */
export interface IndustrySimulationResult {
  transactions: SimulationTransaction[];
  manufacturingJobs: SimulationIndustryJob[];
  reactionJobs: SimulationIndustryJob[];
  inventionJobs: SimulationInventionJob[];
  copyJobs: SimulationCopyJob[];
  unmetDemands: SimulationUnmetDemand[];
  blueprintPurchases: SimulationBlueprintPurchase[];
  skillsRequired: SimulationSkillRequirement[];
  warnings: SimulationWarning[];
  allocator: SimulationAllocator;
}

interface BlueprintShortage {
  stockpile: PlanStockpile;
  outputBlueprintTypeId: number;
  requiredRuns: number;
  manufacturingLocationId: number;
  jobIds: string[];
}

interface MaterialSpecification {
  typeId: number;
  quantityPerRun: number;
  requiredQuantity: number;
  account: SimulationLedgerAccount;
  source: SimulationDemandSource;
}

interface ProductionSupply {
  plannedQuantity: number;
  readyQuantity: number;
  reservations: SimulationUpstreamReservation[];
  jobs: SimulationIndustryJob[];
}

interface ProductionDemandRequest {
  quantity: number;
  demandSource: SimulationDemandSource;
  supply: ProductionSupply;
  aggregateSupply?: ProductionSupply;
  allocationOffset: number;
}

interface ProductionDemandBucket {
  productTypeId: number;
  stockpile: PlanStockpile;
  destinationAccount: SimulationLedgerAccount;
  stack: ReadonlySet<number>;
  quantity: number;
  requests: ProductionDemandRequest[];
}

interface DeferredProductionSupply {
  input: SimulationJobInput;
  supply: ProductionSupply;
  localQuantity: number;
  remoteQuantity: number;
  futureQuantity: number;
  activity: ProductionActivity;
  blueprint: BlueprintClaim;
  profile: ActivityProfile;
  materials: readonly MaterialSpecification[];
  job?: SimulationIndustryJob;
}

interface ActivityProfile {
  locationId: number;
  materialMultiplier: number;
  timeMultiplier: number;
}

function typeName(context: SimulationContext, typeId: number, language = "en"): string {
  const name = context.types.get(typeId)?.name;
  return name?.[language as keyof typeof name] ?? name?.en ?? `Type ${typeId}`;
}

function typeVolume(context: SimulationContext, typeId: number): number {
  const type = context.types.get(typeId);
  return type?.packagedVolume ?? type?.volume ?? 0;
}

function productionDetails(production: ProductionRecord, productTypeId: number) {
  const activity =
    production.activity === "manufacturing"
      ? production.blueprint.activities.manufacturing
      : production.blueprint.activities.reaction;
  const product = activity?.products?.find((candidate) => candidate.typeID === productTypeId);
  return product && activity ? { activity, product } : undefined;
}

function horizonRunLimit(claim: BlueprintClaim, requiredRuns: number) {
  const allocatedRuns = Math.min(requiredRuns, claim.runs);
  return {
    now: claim.horizon === "now" ? allocatedRuns : 0,
    afterHauling: claim.horizon === "after-upstream" ? 0 : allocatedRuns,
    afterUpstream: allocatedRuns,
  };
}

/** Measures a synchronous demand-simulation phase when development profiling is enabled. */
function measureSyncProfiled<T>(
  profiler: RequestProfiler | undefined,
  section: string,
  operation: () => T,
): T {
  profiler?.start(section);
  try {
    return operation();
  }
  finally {
    profiler?.end(section);
  }
}

/** Declares industry work and reserves only complete physical run kits. */
export function simulateIndustryDemand(
  request: SimulationRequestV1,
  context: SimulationContext,
  inventory: SimulatorInventory,
  dependencyGraph: DependencyGraph,
  profiler?: RequestProfiler,
): IndustrySimulationResult {
  const simulation = new IndustryDemandSimulation(
    request,
    context,
    inventory,
    dependencyGraph,
    profiler,
  );
  return simulation.run();
}

class IndustryDemandSimulation {
  private readonly allocator: SimulationAllocator;
  private readonly transactions: SimulationTransaction[] = [];
  private readonly declaredDemandSources = new Map<
    string,
    {
      account: SimulationLedgerAccount;
      source: SimulationDemandSource;
    }
  >();
  private readonly manufacturingJobs: SimulationIndustryJob[] = [];
  private readonly reactionJobs: SimulationIndustryJob[] = [];
  private readonly inventionJobs: SimulationInventionJob[] = [];
  private readonly copyJobs: SimulationCopyJob[] = [];
  private readonly unmetDemands: SimulationUnmetDemand[] = [];
  private readonly blueprintPurchases: SimulationBlueprintPurchase[] = [];
  private readonly reusableBlueprintShortages = new Set<string>();
  private readonly warnings: SimulationWarning[];
  private readonly blueprintShortages: BlueprintShortage[] = [];
  private readonly skillRequirements = new Map<
    number,
    { requiredLevel: number; jobIds: Set<string> }
  >();
  private pendingProductionDemands = new Map<string, ProductionDemandBucket>();
  private readonly deferredProductionSupplies: DeferredProductionSupply[] = [];
  private readonly productionDemandRequests: ProductionDemandRequest[] = [];
  private readonly productionSupplies = new Set<ProductionSupply>();
  private readonly reservedPrepassCopyRuns = new Map<string, number>();
  private sequence = 0;

  /** Creates one isolated deterministic simulation state. */
  constructor(
    private readonly request: SimulationRequestV1,
    private readonly context: SimulationContext,
    inventory: SimulatorInventory,
    dependencyGraph: DependencyGraph,
    private readonly profiler?: RequestProfiler,
  ) {
    this.allocator = new SimulationAllocator(
      inventory,
      request.haulExclusions ?? [],
      request.stockpiles,
      request.simulation.blockInterStockpileHauling,
      request.facilityProfiles ?? [],
    );
    this.warnings = [...dependencyGraph.warnings];
    if (inventory.unresolvedLotCount > 0) {
      this.warnings.push({
        code: "unresolved-asset",
        message: `${inventory.unresolvedLotCount} asset lots have no resolved root location.`,
      });
    }
  }

  /** Runs demand expansion followed by invention/copying derivation. */
  run(): IndustrySimulationResult {
    measureSyncProfiled(
      this.profiler,
      "reserve-activity-demand",
      () => this.reserveRecursiveActivityDemand(),
    );
    measureSyncProfiled(
      this.profiler,
      "reserve-local-stockpile-demand",
      () => this.reserveLocalStockpileDemand(),
    );
    this.allocator.reserveRemoteActivityDemand();
    this.allocator.reserveRemoteStockpileDemand();
    measureSyncProfiled(
      this.profiler,
      "expand-stockpile-demand",
      () => {
        const stockpiles = [...this.request.stockpiles].sort(
          (left, right) =>
            Number(!this.stockpileHasSameSystemRemoteSupply(left))
              - Number(!this.stockpileHasSameSystemRemoteSupply(right))
            || left.id.localeCompare(right.id),
        );
        for (const stockpile of stockpiles) {
          const items = [...stockpile.items].sort((left, right) => {
            const leftLocationId = isSimulatorReprocessingType(this.context, left.typeId)
              ? stockpile.locations.reprocessing
              : stockpile.locations.stock;
            const rightLocationId = isSimulatorReprocessingType(this.context, right.typeId)
              ? stockpile.locations.reprocessing
              : stockpile.locations.stock;
            return (
              Number(!this.allocator.hasSameSystemRemoteSupply(left.typeId, leftLocationId))
                - Number(!this.allocator.hasSameSystemRemoteSupply(right.typeId, rightLocationId))
              || left.typeId - right.typeId
              || left.quantity - right.quantity
              || left.me - right.me
              || left.te - right.te
            );
          });
          for (const item of items) {
            const isReprocessingInput = isSimulatorReprocessingType(this.context, item.typeId);
            const requiredQuantity = isReprocessingInput
              ? this.reprocessingSourceQuantity(item.typeId, item.quantity)
              : item.quantity;
            const account: SimulationLedgerAccount = {
              locationId: isReprocessingInput
                ? stockpile.locations.reprocessing
                : stockpile.locations.stock,
              typeId: item.typeId,
            };
            const source = this.demandSource(
              stockpile,
              item.typeId,
              item.quantity,
              item.typeId,
              requiredQuantity,
              account.locationId,
              isReprocessingInput ? "reprocessing" : "stock",
            );
            this.declareDemand(account, requiredQuantity, source);
            const sellOrderQuantity = isReprocessingInput
              ? 0
              : this.allocator.claimSellOrderSupply(
                  item.typeId,
                  requiredQuantity,
                  account.locationId,
                  account,
                  undefined,
                  stockpile.id,
                );
            const existing = measureSyncProfiled(
              this.profiler,
              "claim-stockpile-supply",
              () =>
                this.allocator.claimOrdinarySupply(
                  item.typeId,
                  requiredQuantity - sellOrderQuantity,
                  account.locationId,
                  account,
                  undefined,
                  stockpile.id,
                  isReprocessingInput ? "reprocessing" : "stock",
                  "stockpile-demand",
                ),
            );
            this.setDemandReadiness(source, existing.local + sellOrderQuantity);
            const remaining =
              requiredQuantity
              - existing.local
              - existing.remote
              - existing.future
              - sellOrderQuantity;
            if (remaining > 0) {
              if (isReprocessingInput) {
                this.recordUnmet(account, remaining, source, "reprocessing-input");
              }
              else {
                this.planProduction(item.typeId, remaining, stockpile, account, source, new Set());
              }
            }
          }
        }
      },
    );
    this.drainProductionDemands();
    measureSyncProfiled(
      this.profiler,
      "finalize-deferred-production-supplies",
      () => this.finalizeDeferredProductionSupplies(),
    );

    measureSyncProfiled(
      this.profiler,
      "plan-invention-and-copying",
      () => {
        for (let index = 0; index < this.blueprintShortages.length; index += 1) {
          this.planInventionAndCopying(this.blueprintShortages[index]);
        }
      },
    );
    this.drainProductionDemands();
    measureSyncProfiled(
      this.profiler,
      "finalize-deferred-production-supplies",
      () => this.finalizeDeferredProductionSupplies(),
    );
    this.reconcileUnmetDemands();
    this.finalizeDeferredProductionSupplies();
    this.postDemandReadiness();
    measureSyncProfiled(
      this.profiler,
      "expand-skill-prerequisites",
      () => {
        this.expandSkillPrerequisites();
      },
    );
    return {
      transactions: [...this.transactions, ...this.allocator.transactions],
      manufacturingJobs: this.manufacturingJobs,
      reactionJobs: this.reactionJobs,
      inventionJobs: this.inventionJobs,
      copyJobs: this.copyJobs,
      unmetDemands: this.unmetDemands.filter((demand) => demand.quantity > 0),
      blueprintPurchases: this.blueprintPurchases,
      skillsRequired: [...this.skillRequirements]
        .map(([skillId, requirement]) => ({
          skillId,
          name: typeName(this.context, skillId, this.request.language),
          requiredLevel: requirement.requiredLevel,
          jobIds: [...requirement.jobIds].sort(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.skillId - right.skillId),
      warnings: this.warnings,
      allocator: this.allocator,
    };
  }

  private planProduction(
    productTypeId: number,
    quantity: number,
    stockpile: PlanStockpile,
    destinationAccount: SimulationLedgerAccount,
    demandSource: SimulationDemandSource,
    stack: ReadonlySet<number>,
  ): ProductionSupply {
    if (quantity <= 0) return this.emptyProductionSupply();
    if (stack.has(productTypeId)) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      this.warnings.push({
        code: "cycle-detected",
        typeId: productTypeId,
        message: `Quantity expansion stopped at cyclic type ${productTypeId}.`,
      });
      return this.emptyProductionSupply();
    }
    if (this.request.settings.buildBlacklist.includes(productTypeId)) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      return this.emptyProductionSupply();
    }
    const production = this.context.blueprints.byBuildProductTypeId.get(productTypeId);
    const details = production ? productionDetails(production, productTypeId) : undefined;
    if (!production || !details) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      if (this.request.settings.buyBlacklist.includes(productTypeId)) {
        this.warnings.push({
          code: "blocked-by-policy",
          typeId: productTypeId,
          message: `Type ${productTypeId} cannot be built and is prohibited from purchase.`,
        });
      }
      return this.emptyProductionSupply();
    }
    const profile = this.activityProfile(stockpile, productTypeId, production.activity);
    const key = [
      this.productionLocationScope(stockpile),
      productTypeId,
      production.activity,
      profile.locationId,
      destinationAccount.locationId,
      destinationAccount.typeId,
    ].join(":");
    let bucket = this.pendingProductionDemands.get(key);
    if (!bucket) {
      bucket = {
        productTypeId,
        stockpile,
        destinationAccount,
        stack,
        quantity: 0,
        requests: [],
      };
      this.pendingProductionDemands.set(key, bucket);
    }
    else {
      bucket.stack = new Set([...bucket.stack, ...stack]);
    }
    const supply = this.emptyProductionSupply();
    const request: ProductionDemandRequest = {
      quantity,
      demandSource,
      supply,
      allocationOffset: bucket.quantity,
    };
    bucket.quantity += quantity;
    bucket.requests.push(request);
    this.productionDemandRequests.push(request);
    return supply;
  }

  /** Identifies stockpiles whose dependent activities share the same production locations. */
  private productionLocationScope(stockpile: PlanStockpile): string {
    const locations = stockpile.locations;
    const assignments = Object
      .entries(stockpile.groupAssignments ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, locationId]) => `${group}:${locationId}`);
    return [
      locations.manufacturing,
      locations.reactions,
      locations.reprocessing,
      locations.copying,
      locations.invention,
      ...assignments,
    ].join(":");
  }

  private emptyProductionSupply(): ProductionSupply {
    return { plannedQuantity: 0, readyQuantity: 0, reservations: [], jobs: [] };
  }

  /** Defers shared material buckets until their parent paths can contribute demand. */
  private drainProductionDemands(): void {
    while (this.pendingProductionDemands.size > 0) {
      let [key, bucket] = this.pendingProductionDemands.entries().next().value as [
        string,
        ProductionDemandBucket,
      ];
      for (const [candidateKey, candidate] of this.pendingProductionDemands) {
        if (candidate.stack.size >= bucket.stack.size) continue;
        key = candidateKey;
        bucket = candidate;
      }
      this.pendingProductionDemands.delete(key);
      const aggregate = measureSyncProfiled(
        this.profiler,
        "plan-production",
        () =>
          this.planProductionCore(
            bucket.productTypeId,
            bucket.quantity,
            bucket.stockpile,
            bucket.destinationAccount,
            bucket.requests[0].demandSource,
            bucket.stack,
          ),
      );
      for (const job of aggregate.jobs) {
        job.demandSources = bucket.requests.map((request) => request.demandSource);
      }
      for (const request of bucket.requests) {
        request.aggregateSupply = aggregate;
      }
      this.syncProductionDemandRequests(bucket.requests);
    }
  }

  private syncProductionDemandRequests(
    requests: readonly ProductionDemandRequest[] = this.productionDemandRequests,
  ): boolean {
    let readinessChanged = false;
    for (const request of requests) {
      const aggregate = request.aggregateSupply;
      if (!aggregate) continue;
      request.supply.plannedQuantity = Math.min(
        request.quantity,
        Math.max(0, aggregate.plannedQuantity - request.allocationOffset),
      );
      const readyQuantity = Math.min(
        request.quantity,
        Math.max(0, aggregate.readyQuantity - request.allocationOffset),
      );
      if (request.supply.readyQuantity !== readyQuantity) readinessChanged = true;
      request.supply.readyQuantity = readyQuantity;
      request.supply.reservations = this.reservationRange(
        aggregate.reservations,
        request.allocationOffset,
        request.quantity,
      );
      request.supply.jobs = aggregate.jobs;
    }
    return readinessChanged;
  }

  private reservationRange(
    reservations: readonly SimulationUpstreamReservation[],
    offset: number,
    quantity: number,
  ): SimulationUpstreamReservation[] {
    const selected: SimulationUpstreamReservation[] = [];
    let skipped = offset;
    let remaining = quantity;
    for (const reservation of reservations) {
      if (remaining <= 0) break;
      if (skipped >= reservation.quantity) {
        skipped -= reservation.quantity;
        continue;
      }
      const available = reservation.quantity - skipped;
      const selectedQuantity = Math.min(remaining, available);
      selected.push({ ...reservation, quantity: selectedQuantity });
      remaining -= selectedQuantity;
      skipped = 0;
    }
    return selected;
  }

  private finalizeDeferredProductionSupplies(): void {
    const deferredSupplies = [...this.deferredProductionSupplies].reverse();
    for (let pass = 0; pass <= deferredSupplies.length; pass += 1) {
      const readinessChanged = measureSyncProfiled(
        this.profiler,
        "finalize-deferred-pass",
        () => {
          let changed = measureSyncProfiled(
            this.profiler,
            "sync-production-supplies",
            () => this.syncProductionSupplies(),
          );
          changed =
            measureSyncProfiled(
              this.profiler,
              "sync-production-demand-requests",
              () => this.syncProductionDemandRequests(),
            ) || changed;
          for (const deferred of deferredSupplies) {
            const input = deferred.input;
            const availableAfterUpstream =
              deferred.localQuantity
              + deferred.remoteQuantity
              + deferred.futureQuantity
              + deferred.supply.readyQuantity;
            input.availableAfterUpstream = availableAfterUpstream;
            input.unsatisfiedQuantity = Math.max(
              0,
              input.requiredQuantity
                - deferred.localQuantity
                - deferred.remoteQuantity
                - deferred.futureQuantity
                - deferred.supply.plannedQuantity,
            );
            input.upstreamReservations = this.reservationRange(
              deferred.supply.reservations,
              0,
              deferred.supply.reservations.reduce(
                (total, reservation) => total + reservation.quantity,
                0,
              ),
            );
            if (deferred.job) {
              deferred.job.readyNowRuns = Math.min(
                horizonRunLimit(deferred.blueprint, deferred.blueprint.runs).now,
                this.installableRuns(
                  deferred.activity,
                  deferred.blueprint,
                  deferred.profile.materialMultiplier,
                  deferred.materials,
                  (material) =>
                    deferred.job?.inputs.find((candidate) => candidate.typeId === material.typeId)
                      ?.availableNow ?? 0,
                ),
              );
              deferred.job.readyAfterHaulingRuns = Math.min(
                horizonRunLimit(deferred.blueprint, deferred.blueprint.runs).afterHauling,
                this.installableRuns(
                  deferred.activity,
                  deferred.blueprint,
                  deferred.profile.materialMultiplier,
                  deferred.materials,
                  (material) => {
                    const jobInput = deferred.job?.inputs.find(
                      (candidate) => candidate.typeId === material.typeId,
                    );
                    return (jobInput?.availableNow ?? 0) + (jobInput?.availableFromHauling ?? 0);
                  },
                ),
              );
              const readyAfterUpstreamRuns = Math.min(
                horizonRunLimit(deferred.blueprint, deferred.blueprint.runs).afterUpstream,
                this.installableRuns(
                  deferred.activity,
                  deferred.blueprint,
                  deferred.profile.materialMultiplier,
                  deferred.materials,
                  (material) =>
                    deferred.job?.inputs.find((candidate) => candidate.typeId === material.typeId)
                      ?.availableAfterUpstream ?? 0,
                ),
              );
              if (deferred.job.readyAfterUpstreamRuns !== readyAfterUpstreamRuns) changed = true;
              deferred.job.readyAfterUpstreamRuns = readyAfterUpstreamRuns;
              deferred.job.blockedRuns = Math.max(
                0,
                deferred.blueprint.runs - readyAfterUpstreamRuns,
              );
            }
          }
          return changed;
        },
      );
      if (!readinessChanged) break;
    }
    measureSyncProfiled(
      this.profiler,
      "sync-production-supplies",
      () => this.syncProductionSupplies(),
    );
    measureSyncProfiled(
      this.profiler,
      "sync-production-demand-requests",
      () => this.syncProductionDemandRequests(),
    );
  }

  private reconcileUnmetDemands(): void {
    this.allocator.releaseUnusedReservations();
    const jobs = [...this.manufacturingJobs, ...this.reactionJobs];
    for (const demand of [...this.unmetDemands].sort(
      (left, right) =>
        Number(left.source.activity === "stock" || left.source.activity === "reprocessing")
          - Number(right.source.activity === "stock" || right.source.activity === "reprocessing")
        || left.source.demandId.localeCompare(right.source.demandId),
    )) {
      const activityInput =
        demand.source.activity !== "stock" && demand.source.activity !== "reprocessing";
      const claimed = this.allocator.claimOrdinarySupply(
        demand.account.typeId,
        demand.quantity,
        demand.account.locationId,
        demand.account,
        demand.source.demandingJobId,
        demand.source.stockpileId,
        demand.source.activity,
        activityInput ? "activity-input" : "stockpile-demand",
      );
      const supplied = claimed.local + claimed.remote + claimed.future;
      demand.quantity -= supplied;
      this.setDemandReadiness(demand.source, demand.source.requiredNow + claimed.local);
      const job = jobs.find((candidate) => candidate.jobId === demand.source.demandingJobId);
      const input =
        job?.inputs.find((candidate) => candidate.typeId === demand.account.typeId)
        ?? this.inventionJobs
          .find((candidate) => candidate.jobId === demand.source.demandingJobId)
          ?.inputs.find((candidate) => candidate.typeId === demand.account.typeId)
        ?? this.copyJobs
          .find((candidate) => candidate.jobId === demand.source.demandingJobId)
          ?.inputs.find((candidate) => candidate.typeId === demand.account.typeId);
      if (!input) continue;
      input.availableNow += claimed.local;
      input.availableFromHauling += claimed.remote;
      input.availableAfterUpstream += supplied;
      input.unsatisfiedQuantity = Math.max(0, input.unsatisfiedQuantity - supplied);
      input.upstreamReservations = [
        ...(input.upstreamReservations ?? []),
        ...claimed.futureReservations,
      ];
      const deferred = this.deferredProductionSupplies.find(
        (candidate) => candidate.input === input,
      );
      if (deferred) {
        deferred.localQuantity += claimed.local;
        deferred.remoteQuantity += claimed.remote;
        deferred.futureQuantity += claimed.future;
      }
    }
  }

  private syncProductionSupplies(): boolean {
    let readinessChanged = false;
    for (const supply of this.productionSupplies) {
      const readyQuantity = Math.min(
        supply.plannedQuantity,
        supply.jobs.reduce(
          (total, job) => total + job.readyAfterUpstreamRuns * job.outputPerRun,
          0,
        ),
      );
      if (supply.readyQuantity !== readyQuantity) readinessChanged = true;
      supply.readyQuantity = readyQuantity;
    }
    return readinessChanged;
  }

  private reserveRecursiveActivityDemand(): void {
    const stockpiles = [...this.request.stockpiles].sort(
      (left, right) =>
        Number(!this.stockpileHasSameSystemRemoteSupply(left))
          - Number(!this.stockpileHasSameSystemRemoteSupply(right))
        || left.id.localeCompare(right.id),
    );
    for (const stockpile of stockpiles) {
      const items = [...stockpile.items].sort(
        (left, right) => left.typeId - right.typeId || left.quantity - right.quantity,
      );
      for (const item of items) {
        if (isSimulatorReprocessingType(this.context, item.typeId)) continue;
        const coveredByExistingSupply = this.allocator.previewOrdinarySupply(
          item.typeId,
          item.quantity,
          stockpile.locations.stock,
        );
        const quantityToBuild = item.quantity - coveredByExistingSupply;
        this.reserveProductionInputs(item.typeId, quantityToBuild, stockpile, new Set());
      }
    }
  }

  private reserveLocalStockpileDemand(): void {
    const stockpiles = [...this.request.stockpiles].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const stockpile of stockpiles) {
      for (const item of [...stockpile.items].sort(
        (left, right) => left.typeId - right.typeId || left.quantity - right.quantity,
      )) {
        const reprocessingInput = isSimulatorReprocessingType(this.context, item.typeId);
        const destinationLocationId = reprocessingInput
          ? stockpile.locations.reprocessing
          : stockpile.locations.stock;
        this.allocator.reserveLocalStockpileDemand(
          item.typeId,
          reprocessingInput
            ? this.reprocessingSourceQuantity(item.typeId, item.quantity)
            : item.quantity,
          destinationLocationId,
        );
      }
    }
  }

  private reprocessingSourceQuantity(typeId: number, quantity: number): number {
    const portionSize = Math.max(1, this.context.types.get(typeId)?.portionSize ?? 1);
    return Math.ceil(quantity / portionSize) * portionSize;
  }

  private commitPlannedOutputTransfer(
    sourceAccount: SimulationLedgerAccount,
    destinationAccount: SimulationLedgerAccount,
    quantity: number,
    jobId: string,
    outputSource: ProductionActivity | "copying" | "invention",
    quantityKind: "item" | "blueprint-run" = "item",
    haulQuantity = quantity,
  ): void {
    if (quantity <= 0 || sourceAccount.locationId === destinationAccount.locationId) return;
    const lotId = `planned-output:${jobId}:${sourceAccount.typeId}`;
    this.transactions.push({
      id: this.nextId("completion-transfer"),
      kind: "transfer-commitment",
      sourceAccount,
      destinationAccount,
      lotId,
      quantity,
      quantityKind,
      horizon: "after-upstream",
      outputSource:
        outputSource === "manufacturing" || outputSource === "reaction"
          ? "production"
          : outputSource,
      ...(outputSource === "manufacturing" || outputSource === "reaction"
        ? { activity: outputSource }
        : {}),
      demandingJobId: jobId,
    });
    this.allocator.haulingTasks.push({
      transferId: `completion:${jobId}:${destinationAccount.locationId}`,
      lotId,
      typeId: sourceAccount.typeId,
      typeName: typeName(this.context, sourceAccount.typeId, this.request.language),
      ...(quantityKind === "blueprint-run" ? { blueprintKind: "bpc" as const } : {}),
      quantity: haulQuantity,
      unitVolume: typeVolume(this.context, sourceAccount.typeId),
      fromLocationId: sourceAccount.locationId,
      toLocationId: destinationAccount.locationId,
      purpose: "completion",
      demands: [{ jobId, quantity: haulQuantity }],
    });
  }

  /** Prioritizes stockpiles that can receive eligible remote stock from their own system. */
  private stockpileHasSameSystemRemoteSupply(stockpile: PlanStockpile): boolean {
    return stockpile.items.some((item) => {
      const destinationLocationId = isSimulatorReprocessingType(this.context, item.typeId)
        ? stockpile.locations.reprocessing
        : stockpile.locations.stock;
      return this.allocator.hasSameSystemRemoteSupply(item.typeId, destinationLocationId);
    });
  }

  private reserveProductionInputs(
    productTypeId: number,
    quantity: number,
    stockpile: PlanStockpile,
    stack: ReadonlySet<number>,
  ): void {
    if (quantity <= 0 || stack.has(productTypeId)) return;
    if (this.request.settings.buildBlacklist.includes(productTypeId)) return;
    const production = this.context.blueprints.byBuildProductTypeId.get(productTypeId);
    const details = production ? productionDetails(production, productTypeId) : undefined;
    if (!production || !details) return;

    const profile = this.activityProfile(stockpile, productTypeId, production.activity);
    const requiredRuns = Math.ceil(quantity / details.product.quantity);
    const nextStack = new Set(stack);
    nextStack.add(productTypeId);
    const allocations =
      production.activity === "manufacturing"
        ? this.allocator.previewManufacturingBlueprints(
            production.blueprint._key,
            requiredRuns,
            profile.locationId,
            Math.max(1, production.blueprint.maxProductionLimit),
          )
        : [{ runs: requiredRuns, materialEfficiency: 0 }];
    const missingRuns =
      requiredRuns - allocations.reduce((total, allocation) => total + allocation.runs, 0);
    if (missingRuns > 0) {
      const fallback = this.fallbackBlueprint(
        production.blueprint._key,
        missingRuns,
        "fallback",
        productTypeId,
      );
      allocations.push({ runs: missingRuns, materialEfficiency: fallback.materialEfficiency });
    }
    for (const allocation of allocations) {
      for (const material of details.activity.materials ?? []) {
        const requiredQuantity = requiredMaterialQuantity(
          production.activity,
          material.quantity,
          allocation.runs,
          { me: allocation.materialEfficiency },
          profile.materialMultiplier,
        );
        this.reserveActivityInput(
          material.typeID,
          requiredQuantity,
          stockpile,
          profile.locationId,
          nextStack,
        );
      }
    }
    if (production.activity === "manufacturing") {
      this.reserveBlueprintScienceInputs(
        production.blueprint._key,
        missingRuns,
        stockpile,
        profile.locationId,
        nextStack,
      );
    }
  }

  private reserveActivityInput(
    typeId: number,
    quantity: number,
    stockpile: PlanStockpile,
    locationId: number,
    stack: ReadonlySet<number>,
  ): void {
    const coveredByExistingSupply = this.allocator.previewOrdinarySupply(
      typeId,
      quantity,
      locationId,
    );
    const quantityToBuild = quantity - coveredByExistingSupply;
    this.allocator.reserveActivityDemand(typeId, quantity, locationId);
    this.reserveProductionInputs(typeId, quantityToBuild, stockpile, stack);
  }

  private reserveBlueprintScienceInputs(
    outputBlueprintTypeId: number,
    inventionRuns: number,
    stockpile: PlanStockpile,
    manufacturingLocationId: number,
    stack: ReadonlySet<number>,
  ): void {
    if (inventionRuns <= 0) return;

    const sourceBlueprint = this.inventionSourceBlueprint(outputBlueprintTypeId);
    if (!sourceBlueprint) return;
    const inventionPlan = this.inventionAttemptPlan(
      sourceBlueprint,
      outputBlueprintTypeId,
      inventionRuns,
    );
    if (!inventionPlan) return;

    const inventionLocationId = stockpile.locations.invention;
    const scienceProfile = this.request.simulation.scienceProfiles.find(
      (profile) => profile.locationId === inventionLocationId,
    );
    for (const material of sourceBlueprint.activities.invention?.materials ?? []) {
      this.reserveActivityInput(
        material.typeID,
        Math.ceil(
          material.quantity
            * inventionPlan.attempts
            * (scienceProfile?.inventionMaterialMultiplier ?? 1),
        ),
        stockpile,
        inventionLocationId,
        stack,
      );
    }
    if (inventionPlan.decryptorTypeId !== undefined) {
      this.reserveActivityInput(
        inventionPlan.decryptorTypeId,
        inventionPlan.attempts,
        stockpile,
        inventionLocationId,
        stack,
      );
    }

    const copyKey = `${sourceBlueprint._key}:${inventionLocationId}`;
    const availableCopyRuns = this.allocator.availableBlueprintCopyRuns(
      sourceBlueprint._key,
      inventionLocationId,
      inventionPlan.attempts,
    );
    const previouslyReservedCopyRuns = this.reservedPrepassCopyRuns.get(copyKey) ?? 0;
    const coveredCopyRuns = Math.min(
      inventionPlan.attempts,
      Math.max(0, availableCopyRuns - previouslyReservedCopyRuns),
    );
    this.reservedPrepassCopyRuns.set(copyKey, previouslyReservedCopyRuns + coveredCopyRuns);
    const copyRuns = inventionPlan.attempts - coveredCopyRuns;
    if (copyRuns <= 0) return;

    const copyingLocationId = stockpile.locations.copying;
    const copyingProfile = this.request.simulation.scienceProfiles.find(
      (profile) => profile.locationId === copyingLocationId,
    );
    const copies = Math.ceil(copyRuns / Math.max(1, sourceBlueprint.maxProductionLimit));
    for (const material of sourceBlueprint.activities.copying?.materials ?? []) {
      this.reserveActivityInput(
        material.typeID,
        Math.ceil(material.quantity * copies * (copyingProfile?.copyingMaterialMultiplier ?? 1)),
        stockpile,
        copyingLocationId,
        stack,
      );
    }
  }

  private inventionSourceBlueprint(outputBlueprintTypeId: number) {
    return (this.context.blueprints.byInventionProductId.get(outputBlueprintTypeId) ?? [])
      .slice()
      .sort((left, right) => left._key - right._key)
      .at(0);
  }

  private inventionAttemptPlan(
    sourceBlueprint: BlueprintsRecord,
    outputBlueprintTypeId: number,
    requiredRuns: number,
  ) {
    const baseOutcome = getNoDecryptorInventionOutput(sourceBlueprint, outputBlueprintTypeId);
    if (!baseOutcome) return undefined;
    const decryptorTypeId = Object
      .entries(this.request.simulation.policy.decryptorTypeIdByProductBlueprintTypeId)
      .find(
        ([productBlueprintTypeId]) => productBlueprintTypeId === String(outputBlueprintTypeId),
      )?.[1];
    const decryptor =
      decryptorTypeId === undefined
        ? undefined
        : getInventionDecryptorModifiers(
            decryptorTypeId,
            this.context.typeDogma.get(decryptorTypeId),
          );
    const skillPlan = this.inventionSkillPlan(sourceBlueprint);
    const probability = Math.min(
      1,
      baseOutcome.probability * skillPlan.multiplier * (decryptor?.probabilityMultiplier ?? 1),
    );
    const runsPerSuccess = Math.max(1, baseOutcome.runs + (decryptor?.maxRunModifier ?? 0));
    const targetExpectedRuns =
      requiredRuns * this.request.simulation.policy.inventionExpectedOutputFactor;
    const attempts = Math.ceil(
      targetExpectedRuns / Math.max(Number.EPSILON, probability * runsPerSuccess),
    );
    return {
      attempts,
      baseOutcome,
      decryptor,
      decryptorTypeId,
      probability,
      runsPerSuccess,
      skillPlan,
      targetExpectedRuns,
    };
  }

  private planProductionCore(
    productTypeId: number,
    quantity: number,
    stockpile: PlanStockpile,
    destinationAccount: SimulationLedgerAccount,
    demandSource: SimulationDemandSource,
    stack: ReadonlySet<number>,
  ): ProductionSupply {
    if (quantity <= 0) return this.emptyProductionSupply();
    if (stack.has(productTypeId)) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      this.warnings.push({
        code: "cycle-detected",
        typeId: productTypeId,
        message: `Quantity expansion stopped at cyclic type ${productTypeId}.`,
      });
      return this.emptyProductionSupply();
    }
    if (this.request.settings.buildBlacklist.includes(productTypeId)) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      return this.emptyProductionSupply();
    }
    const production = this.context.blueprints.byBuildProductTypeId.get(productTypeId);
    const details = production ? productionDetails(production, productTypeId) : undefined;
    if (!production || !details) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      if (this.request.settings.buyBlacklist.includes(productTypeId)) {
        this.warnings.push({
          code: "blocked-by-policy",
          typeId: productTypeId,
          message: `Type ${productTypeId} cannot be built and is prohibited from purchase.`,
        });
      }
      return this.emptyProductionSupply();
    }

    const profile = this.activityProfile(stockpile, productTypeId, production.activity);
    const requiredRuns = Math.ceil(quantity / details.product.quantity);
    const outputAccount: SimulationLedgerAccount = {
      locationId: profile.locationId,
      typeId: productTypeId,
    };
    const blueprintAccount: SimulationLedgerAccount = {
      locationId: profile.locationId,
      typeId: production.blueprint._key,
    };
    const baseJobId = this.stableId(
      production.activity,
      stockpile.id,
      productTypeId,
      profile.locationId,
      this.sequence,
    );
    let allocations: BlueprintClaim[];
    if (production.activity === "reaction") {
      const formula = this.allocator.claimReactionFormula(
        production.blueprint._key,
        profile.locationId,
        blueprintAccount,
        baseJobId,
      );
      allocations = formula
        ? [{ ...formula, runs: requiredRuns }]
        : [this.fallbackBlueprint(production.blueprint._key, requiredRuns, "formula")];
    }
    else {
      allocations = this.allocator.claimManufacturingBlueprints(
        production.blueprint._key,
        requiredRuns,
        profile.locationId,
        blueprintAccount,
        baseJobId,
        Math.max(1, production.blueprint.maxProductionLimit),
      );
      const allocatedRuns = allocations.reduce((total, allocation) => total + allocation.runs, 0);
      if (allocatedRuns < requiredRuns) {
        allocations.push(
          this.fallbackBlueprint(
            production.blueprint._key,
            requiredRuns - allocatedRuns,
            "fallback",
            productTypeId,
          ),
        );
      }
    }

    const nextStack = new Set(stack);
    nextStack.add(productTypeId);
    if (production.activity === "manufacturing") {
      const blueprintDemand = this.demandSource(
        stockpile,
        productTypeId,
        quantity,
        production.blueprint._key,
        requiredRuns,
        profile.locationId,
        production.activity,
        baseJobId,
        "blueprint-run",
      );
      this.declareDemand(blueprintAccount, requiredRuns, blueprintDemand);
      this.setDemandReadiness(
        blueprintDemand,
        allocations.reduce(
          (total, allocation) => total + (allocation.horizon === "now" ? allocation.runs : 0),
          0,
        ),
      );
    }
    const supply: ProductionSupply = {
      plannedQuantity: 0,
      readyQuantity: 0,
      reservations: [],
      jobs: [],
    };
    this.productionSupplies.add(supply);
    let plannedOutput = 0;
    let readyOutput = 0;
    for (const [allocationIndex, allocation] of allocations.entries()) {
      const jobId = `${baseJobId}:${allocationIndex}`;
      const job = measureSyncProfiled(
        this.profiler,
        "plan-industry-job",
        () =>
          this.planIndustryJob(
            jobId,
            production,
            productTypeId,
            details.product.quantity,
            allocation,
            profile,
            stockpile,
            demandSource,
            nextStack,
          ),
      );
      const outputQuantity = allocation.runs * details.product.quantity;
      const reservedQuantity = Math.min(outputQuantity, Math.max(0, quantity - plannedOutput));
      this.transactions.push({
        id: this.nextId("production"),
        kind: "production-commitment",
        account: outputAccount,
        destinationAccount: outputAccount,
        quantity: outputQuantity,
        quantityKind: "item",
        source: "production",
        activity: production.activity,
        producingJobId: jobId,
      });
      this.commitPlannedOutputTransfer(
        outputAccount,
        destinationAccount,
        reservedQuantity,
        jobId,
        production.activity,
      );
      if (production.activity === "manufacturing") this.manufacturingJobs.push(job);
      else this.reactionJobs.push(job);
      supply.jobs.push(job);
      plannedOutput += outputQuantity;
      readyOutput += job.readyAfterUpstreamRuns * details.product.quantity;
      supply.reservations.push({
        activity: production.activity,
        quantity: reservedQuantity,
        state: "planned",
        sourceJobId: jobId,
        sourceOutputQuantity: outputQuantity,
      });
      this.addActivitySkills(details.activity.skills, jobId);
      if (
        allocation.blueprintKind === "fallback"
        || (allocation.blueprintKind === "formula" && allocation.lotId === undefined)
      ) {
        const formulaIsAvailable =
          production.activity === "reaction"
          && this.allocator.hasAvailableReactionFormula(
            production.blueprint._key,
            profile.locationId,
          );
        if (!formulaIsAvailable) {
          this.recordBlueprintShortage(
            stockpile,
            production,
            allocation.runs,
            profile.locationId,
            jobId,
          );
        }
      }
    }
    supply.plannedQuantity = Math.min(quantity, plannedOutput);
    supply.readyQuantity = Math.min(quantity, readyOutput);
    return supply;
  }

  private planIndustryJob(
    jobId: string,
    production: ProductionRecord,
    productTypeId: number,
    outputPerRun: number,
    blueprint: BlueprintClaim,
    profile: ActivityProfile,
    stockpile: PlanStockpile,
    parentDemandSource: SimulationDemandSource,
    stack: ReadonlySet<number>,
  ): SimulationIndustryJob {
    const details = productionDetails(production, productTypeId);
    if (!details) {
      throw new Error(`Production ${production.blueprint._key} has no product ${productTypeId}.`);
    }
    const activity = production.activity;
    const materialSpecifications: MaterialSpecification[] = (details.activity.materials ?? []).map(
      (material) => {
        const account: SimulationLedgerAccount = {
          locationId: profile.locationId,
          typeId: material.typeID,
        };
        const requiredQuantity = requiredMaterialQuantity(
          activity,
          material.quantity,
          blueprint.runs,
          { me: blueprint.materialEfficiency },
          profile.materialMultiplier,
        );
        const source = this.demandSource(
          stockpile,
          productTypeId,
          outputPerRun * blueprint.runs,
          material.typeID,
          requiredQuantity,
          profile.locationId,
          activity,
          jobId,
        );
        this.declareDemand(account, requiredQuantity, source);
        return {
          typeId: material.typeID,
          quantityPerRun: material.quantity,
          requiredQuantity,
          account,
          source,
        };
      },
    );

    const availabilityByTypeId = measureSyncProfiled(
      this.profiler,
      "lookup-material-availability",
      () =>
        new Map(
          materialSpecifications.map((material) => [
            material.typeId,
            this.allocator.availability(material.typeId, profile.locationId),
          ]),
        ),
    );
    const blueprintLimits = horizonRunLimit(blueprint, blueprint.runs);
    const readyNowRuns = Math.min(
      blueprintLimits.now,
      this.installableRuns(
        activity,
        blueprint,
        profile.materialMultiplier,
        materialSpecifications,
        (material) => availabilityByTypeId.get(material.typeId)?.local ?? 0,
      ),
    );
    const readyAfterHaulingRuns = Math.min(
      blueprintLimits.afterHauling,
      this.installableRuns(
        activity,
        blueprint,
        profile.materialMultiplier,
        materialSpecifications,
        (material) => {
          const available = availabilityByTypeId.get(material.typeId);
          return (available?.local ?? 0) + (available?.remote ?? 0);
        },
      ),
    );
    const readyFromExistingSupplyRuns = Math.min(
      blueprintLimits.afterUpstream,
      this.installableRuns(
        activity,
        blueprint,
        profile.materialMultiplier,
        materialSpecifications,
        (material) => {
          const available = availabilityByTypeId.get(material.typeId);
          return (available?.local ?? 0) + (available?.remote ?? 0) + (available?.future ?? 0);
        },
      ),
    );

    const inputs: SimulationJobInput[] = [];
    const deferredInputs: DeferredProductionSupply[] = [];
    for (const material of materialSpecifications) {
      const physicalClaim = this.allocator.claimOrdinarySupply(
        material.typeId,
        material.requiredQuantity,
        profile.locationId,
        material.account,
        jobId,
        undefined,
        activity,
        "activity-input",
      );
      const physicalClaimed = physicalClaim.local + physicalClaim.remote;
      const claimedFuture = physicalClaim.future;
      const remaining = Math.max(0, material.requiredQuantity - physicalClaimed - claimedFuture);
      const productionSupply = this.planProduction(
        material.typeId,
        remaining,
        stockpile,
        material.account,
        material.source,
        stack,
      );
      const availableAfterUpstream =
        physicalClaimed + claimedFuture + productionSupply.readyQuantity;
      this.setDemandReadiness(material.source, physicalClaim.local);
      const input: SimulationJobInput = {
        typeId: material.typeId,
        typeName: typeName(this.context, material.typeId, this.request.language),
        quantityPerRun: material.quantityPerRun,
        requiredQuantity: material.requiredQuantity,
        availableNow: physicalClaim.local,
        availableFromHauling: physicalClaim.remote,
        availableAfterUpstream,
        unsatisfiedQuantity: Math.max(
          0,
          material.requiredQuantity
            - physicalClaimed
            - claimedFuture
            - productionSupply.plannedQuantity,
        ),
        upstreamReservations: [
          ...physicalClaim.futureReservations,
          ...productionSupply.reservations,
        ],
      };
      inputs.push(input);
      deferredInputs.push({
        input,
        supply: productionSupply,
        localQuantity: physicalClaim.local,
        remoteQuantity: physicalClaim.remote,
        futureQuantity: physicalClaim.future,
        activity,
        blueprint,
        profile,
        materials: materialSpecifications,
      });
    }

    const readyAfterUpstreamRuns = Math.min(
      blueprintLimits.afterUpstream,
      this.installableRuns(
        activity,
        blueprint,
        profile.materialMultiplier,
        materialSpecifications,
        (material) =>
          inputs.find((input) => input.typeId === material.typeId)?.availableAfterUpstream ?? 0,
      ),
    );
    const durationPerRunSeconds = Math.max(
      1,
      Math.ceil(
        details.activity.time
          * profile.timeMultiplier
          * (activity === "manufacturing" ? 1 - blueprint.timeEfficiency / 100 : 1),
      ),
    );
    const job: SimulationIndustryJob = {
      jobId,
      activity,
      stockpileId: stockpile.id,
      locationId: profile.locationId,
      productTypeId,
      productName: typeName(this.context, productTypeId, this.request.language),
      blueprint,
      outputPerRun,
      requiredRuns: blueprint.runs,
      readyNowRuns,
      readyAfterHaulingRuns,
      readyAfterUpstreamRuns,
      blockedRuns: Math.max(0, blueprint.runs - readyAfterUpstreamRuns),
      unscheduledRuns: blueprint.runs,
      materialMultiplier: profile.materialMultiplier,
      timeMultiplier: profile.timeMultiplier,
      durationPerRunSeconds,
      inputs,
      installs: [],
      demandSources: [parentDemandSource],
    };
    for (const deferred of deferredInputs) deferred.job = job;
    this.deferredProductionSupplies.push(...deferredInputs);
    return job;
  }

  private planInventionAndCopying(shortage: BlueprintShortage): void {
    const sourceBlueprint = this.inventionSourceBlueprint(shortage.outputBlueprintTypeId);
    if (!sourceBlueprint) return;
    const attemptPlan = this.inventionAttemptPlan(
      sourceBlueprint,
      shortage.outputBlueprintTypeId,
      shortage.requiredRuns,
    );
    if (!attemptPlan) return;
    const {
      attempts,
      baseOutcome,
      decryptor,
      decryptorTypeId,
      probability,
      runsPerSuccess,
      skillPlan,
      targetExpectedRuns,
    } = attemptPlan;
    const inventionLocationId = shortage.stockpile.locations.invention;
    const inventionJobId = this.stableId(
      "invention",
      shortage.stockpile.id,
      shortage.outputBlueprintTypeId,
      inventionLocationId,
      this.sequence,
    );
    const sourceBlueprintAccount: SimulationLedgerAccount = {
      locationId: inventionLocationId,
      typeId: sourceBlueprint._key,
    };
    const sourceBlueprintDemand = this.demandSource(
      shortage.stockpile,
      shortage.outputBlueprintTypeId,
      shortage.requiredRuns,
      sourceBlueprint._key,
      attempts,
      inventionLocationId,
      "invention",
      inventionJobId,
      "blueprint-run",
    );
    this.declareDemand(sourceBlueprintAccount, attempts, sourceBlueprintDemand);
    const scienceProfile = this.request.simulation.scienceProfiles.find(
      (profile) => profile.locationId === inventionLocationId,
    );
    const inventionInputs = [
      ...(sourceBlueprint.activities.invention?.materials ?? []).map((material) => ({
        typeId: material.typeID,
        quantity: Math.ceil(
          material.quantity * attempts * (scienceProfile?.inventionMaterialMultiplier ?? 1),
        ),
      })),
      ...(decryptorTypeId === undefined ? [] : [{ typeId: decryptorTypeId, quantity: attempts }]),
    ].map((material) =>
      this.planSimpleInput(
        material.typeId,
        material.quantity,
        shortage.stockpile,
        "invention",
        inventionLocationId,
        inventionJobId,
        sourceBlueprint._key,
        attempts,
      ),
    );

    const sourceCopyClaims = this.allocator.claimBlueprintCopyRuns(
      sourceBlueprint._key,
      attempts,
      inventionLocationId,
      sourceBlueprintAccount,
      inventionJobId,
    );
    const claimedSourceRuns = sourceCopyClaims.reduce((total, claim) => total + claim.runs, 0);
    const sourceRunsMissing = Math.max(0, attempts - claimedSourceRuns);
    const copyingJob =
      sourceRunsMissing > 0
        ? this.planCopying(shortage, sourceBlueprint, sourceRunsMissing, sourceBlueprintAccount)
        : undefined;
    const claimedSourceRunsNow = sourceCopyClaims
      .filter((claim) => claim.horizon === "now")
      .reduce((total, claim) => total + claim.runs, 0);
    const claimedSourceRunsAfterHauling = sourceCopyClaims
      .filter((claim) => claim.horizon === "after-hauling")
      .reduce((total, claim) => total + claim.runs, 0);
    const sourceInputReservations: SimulationUpstreamReservation[] = sourceCopyClaims
      .filter((claim) => claim.horizon === "after-upstream")
      .map((claim) => ({
        activity: claim.sourceActivity ?? "copying",
        quantity: claim.runs,
        state: claim.sourceActivity ? "in-production" : "planned",
        ...(claim.sourceJobId !== undefined ? { sourceJobId: claim.sourceJobId } : {}),
        ...(claim.sourceCompletionAt ? { sourceCompletionAt: claim.sourceCompletionAt } : {}),
      }));
    if (copyingJob) {
      sourceInputReservations.push({
        activity: "copying",
        quantity: sourceRunsMissing,
        state: "planned",
        sourceJobId: copyingJob.jobId,
        sourceOutputQuantity: copyingJob.totalLicensedRuns,
      });
    }
    this.setDemandReadiness(sourceBlueprintDemand, claimedSourceRunsNow);
    const sourceInput: SimulationJobInput = {
      typeId: sourceBlueprint._key,
      typeName: typeName(this.context, sourceBlueprint._key, this.request.language),
      quantityKind: "blueprint-run",
      requiredQuantity: attempts,
      availableNow: claimedSourceRunsNow,
      availableFromHauling: claimedSourceRunsAfterHauling,
      availableAfterUpstream: claimedSourceRuns + sourceRunsMissing,
      unsatisfiedQuantity: Math.max(0, attempts - claimedSourceRuns - sourceRunsMissing),
      upstreamReservations: sourceInputReservations,
    };

    const expectedOutputCopies = Math.floor(attempts * probability);
    const expectedOutputRuns = expectedOutputCopies * runsPerSuccess;
    this.inventionJobs.push({
      jobId: inventionJobId,
      stockpileId: shortage.stockpile.id,
      locationId: inventionLocationId,
      sourceBlueprintTypeId: sourceBlueprint._key,
      outputBlueprintTypeId: shortage.outputBlueprintTypeId,
      attempts,
      successProbability: probability,
      runsPerSuccess,
      requiredOutputRuns: shortage.requiredRuns,
      targetExpectedRuns,
      expectedOutputCopies,
      expectedOutputRuns,
      materialEfficiency:
        baseOutcome.materialEfficiency + (decryptor?.materialEfficiencyModifier ?? 0),
      timeEfficiency: baseOutcome.timeEfficiency + (decryptor?.timeEfficiencyModifier ?? 0),
      decryptorTypeId,
      skillSource: skillPlan.source,
      durationSeconds: Math.ceil(
        (sourceBlueprint.activities.invention?.time ?? 0)
          * attempts
          * (scienceProfile?.inventionDurationMultiplier ?? 1),
      ),
      inputs: [sourceInput, ...inventionInputs],
      assignments: [],
      unscheduledAttempts: attempts,
    });
    this.transactions.push({
      id: this.nextId("invention-output"),
      kind: "production-commitment",
      account: {
        locationId: inventionLocationId,
        typeId: shortage.outputBlueprintTypeId,
      },
      destinationAccount: {
        locationId: inventionLocationId,
        typeId: shortage.outputBlueprintTypeId,
      },
      quantity: expectedOutputRuns,
      quantityKind: "blueprint-run",
      source: "invention",
      producingJobId: inventionJobId,
    });
    this.commitPlannedOutputTransfer(
      { locationId: inventionLocationId, typeId: shortage.outputBlueprintTypeId },
      { locationId: shortage.manufacturingLocationId, typeId: shortage.outputBlueprintTypeId },
      expectedOutputRuns,
      inventionJobId,
      "invention",
      "blueprint-run",
      expectedOutputCopies,
    );
    this.addActivitySkills(sourceBlueprint.activities.invention?.skills, inventionJobId);
    if (skillPlan.source === "fallback-level-3") {
      this.warnings.push({
        code: "fallback-invention-skills",
        typeId: shortage.outputBlueprintTypeId,
        locationId: inventionLocationId,
        jobId: inventionJobId,
        message: "Invention probability uses the configured level-3 fallback skills.",
      });
    }
  }

  private planCopying(
    shortage: BlueprintShortage,
    sourceBlueprint: BlueprintsRecord,
    requiredRuns: number,
    outputAccount: SimulationLedgerAccount,
  ): SimulationCopyJob {
    const locationId = shortage.stockpile.locations.copying;
    const jobId = this.stableId(
      "copying",
      shortage.stockpile.id,
      sourceBlueprint._key,
      locationId,
      this.sequence,
    );
    const blueprintAccount: SimulationLedgerAccount = {
      locationId,
      typeId: sourceBlueprint._key,
    };
    const original = this.allocator.claimReusableBlueprintOriginal(
      sourceBlueprint._key,
      locationId,
      blueprintAccount,
      jobId,
    );
    if (!original) {
      this.blueprintPurchases.push({
        typeId: sourceBlueprint._key,
        quantity: 1,
        destination: {
          stockpileId: shortage.stockpile.id,
          locationId,
          quantity: 1,
          demandingJobId: jobId,
          purpose: "blueprint",
        },
      });
    }
    const maxRunsPerCopy = Math.max(1, sourceBlueprint.maxProductionLimit);
    const copies = Math.ceil(requiredRuns / maxRunsPerCopy);
    const licensedRunsPerCopy = Math.ceil(requiredRuns / copies);
    const totalLicensedRuns = copies * licensedRunsPerCopy;
    const scienceProfile = this.request.simulation.scienceProfiles.find(
      (profile) => profile.locationId === locationId,
    );
    const inputs = (sourceBlueprint.activities.copying?.materials ?? []).map((material) =>
      this.planSimpleInput(
        material.typeID,
        Math.ceil(material.quantity * copies * (scienceProfile?.copyingMaterialMultiplier ?? 1)),
        shortage.stockpile,
        "copying",
        locationId,
        jobId,
        sourceBlueprint._key,
        copies,
      ),
    );
    const copyJob: SimulationCopyJob = {
      jobId,
      stockpileId: shortage.stockpile.id,
      locationId,
      blueprintTypeId: sourceBlueprint._key,
      sourceBlueprintItemId: original?.blueprintItemId,
      sourceBlueprintLocationId: original?.sourceLocationId,
      copies,
      licensedRunsPerCopy,
      totalLicensedRuns,
      durationSeconds: Math.ceil(
        (sourceBlueprint.activities.copying?.time ?? 0)
          * totalLicensedRuns
          * (scienceProfile?.copyingDurationMultiplier ?? 1),
      ),
      inputs,
      assignments: [],
      unscheduledCopies: copies,
    };
    this.copyJobs.push(copyJob);
    this.transactions.push({
      id: this.nextId("copy-output"),
      kind: "production-commitment",
      account: blueprintAccount,
      destinationAccount: blueprintAccount,
      quantity: totalLicensedRuns,
      quantityKind: "blueprint-run",
      source: "copying",
      producingJobId: jobId,
    });
    this.commitPlannedOutputTransfer(
      blueprintAccount,
      outputAccount,
      totalLicensedRuns,
      jobId,
      "copying",
      "blueprint-run",
      copies,
    );
    this.addActivitySkills(sourceBlueprint.activities.copying?.skills, jobId);
    return copyJob;
  }

  private planSimpleInput(
    typeId: number,
    quantity: number,
    stockpile: PlanStockpile,
    activity: "copying" | "invention",
    locationId: number,
    jobId: string,
    demandingTypeId: number,
    demandingQuantity: number,
  ): SimulationJobInput {
    const account: SimulationLedgerAccount = {
      locationId,
      typeId,
    };
    const source = this.demandSource(
      stockpile,
      demandingTypeId,
      demandingQuantity,
      typeId,
      quantity,
      locationId,
      activity,
      jobId,
    );
    this.declareDemand(account, quantity, source);
    const claim = this.allocator.claimOrdinarySupply(
      typeId,
      quantity,
      locationId,
      account,
      jobId,
      undefined,
      activity,
      "activity-input",
    );
    this.setDemandReadiness(source, claim.local);
    const existing = claim.local + claim.remote + claim.future;
    const production = this.planProduction(
      typeId,
      Math.max(0, quantity - existing),
      stockpile,
      account,
      source,
      new Set(),
    );
    const upstreamReservations = [...claim.futureReservations, ...production.reservations];
    return {
      typeId,
      typeName: typeName(this.context, typeId, this.request.language),
      requiredQuantity: quantity,
      availableNow: claim.local,
      availableFromHauling: claim.remote,
      availableAfterUpstream: existing + production.readyQuantity,
      unsatisfiedQuantity: Math.max(0, quantity - existing - production.plannedQuantity),
      upstreamReservations,
    };
  }

  private activityProfile(
    stockpile: PlanStockpile,
    productTypeId: number,
    activity: ProductionActivity,
  ): ActivityProfile {
    const group = productionGroupForType(
      this.context.types.get(productTypeId),
      this.context.groups,
      this.context.productionGroups,
    );
    const fallbackLocationId =
      activity === "manufacturing"
        ? stockpile.locations.manufacturing
        : stockpile.locations.reactions;
    const locationId =
      (group ? stockpile.groupAssignments?.[group.key] : undefined) ?? fallbackLocationId;
    const facility = this.request.facilityProfiles?.find(
      (candidate) => candidate.locationId === locationId,
    );
    const bonus = group ? facility?.buildTypeGroups[group.key] : undefined;
    const facilityTimeMultiplier =
      activity === "manufacturing"
        ? (this.request.facilityTimeMultipliers?.manufacturing ?? 1)
        : (this.request.facilityTimeMultipliers?.reactions ?? 1);
    const skillTimeMultiplier =
      activity === "manufacturing"
        ? (this.request.skillTimeMultipliers?.manufacturing ?? 1)
        : (this.request.skillTimeMultipliers?.reactions ?? 1);
    return {
      locationId,
      materialMultiplier:
        activity === "manufacturing"
          ? (bonus?.manufacturingMaterialMultiplier ?? 1)
          : (bonus?.reactionMaterialMultiplier ?? 1),
      timeMultiplier:
        (activity === "manufacturing"
          ? (bonus?.manufacturingTimeMultiplier ?? facilityTimeMultiplier)
          : (bonus?.reactionTimeMultiplier ?? facilityTimeMultiplier)) * skillTimeMultiplier,
    };
  }

  private installableRuns(
    activity: ProductionActivity,
    blueprint: SimulationBlueprintAllocation,
    materialMultiplier: number,
    materials: readonly MaterialSpecification[],
    availableFor: (material: MaterialSpecification) => number,
  ): number {
    if (materials.length === 0) return blueprint.runs;
    let lower = 0;
    let upper = blueprint.runs;
    while (lower < upper) {
      const candidate = Math.ceil((lower + upper) / 2);
      const fits = materials.every(
        (material) =>
          requiredMaterialQuantity(
            activity,
            material.quantityPerRun,
            candidate,
            { me: blueprint.materialEfficiency },
            materialMultiplier,
          ) <= availableFor(material),
      );
      if (fits) lower = candidate;
      else upper = candidate - 1;
    }
    return lower;
  }

  private fallbackBlueprint(
    blueprintTypeId: number,
    runs: number,
    kind: "fallback" | "formula",
    productTypeId?: number,
  ): BlueprintClaim {
    const techLevel =
      productTypeId === undefined ? undefined : this.context.types.get(productTypeId)?.techLevel;
    const advanced = techLevel === 2 || techLevel === 3;
    return {
      blueprintTypeId,
      blueprintKind: kind,
      runs,
      materialEfficiency:
        kind === "formula"
          ? 0
          : advanced
            ? (this.request.settings.fallbackT2OrT3Me ?? 0)
            : (this.request.settings.fallbackT1Me ?? 0),
      timeEfficiency:
        kind === "formula"
          ? 0
          : advanced
            ? (this.request.settings.fallbackT2OrT3Te ?? 0)
            : (this.request.settings.fallbackT1Te ?? 0),
      horizon: "after-upstream",
    };
  }

  private recordBlueprintShortage(
    stockpile: PlanStockpile,
    production: ProductionRecord,
    runs: number,
    manufacturingLocationId: number,
    jobId: string,
  ): void {
    const shortageKey = `${production.blueprint._key}:${manufacturingLocationId}`;
    if (production.activity === "reaction") {
      if (this.reusableBlueprintShortages.has(shortageKey)) return;
      this.reusableBlueprintShortages.add(shortageKey);
      this.blueprintPurchases.push({
        typeId: production.blueprint._key,
        quantity: 1,
        destination: {
          stockpileId: stockpile.id,
          locationId: manufacturingLocationId,
          quantity: 1,
          demandingJobId: jobId,
          purpose: "blueprint",
        },
      });
      return;
    }
    if (
      (this.context.blueprints.byInventionProductId.get(production.blueprint._key) ?? []).length > 0
    ) {
      this.blueprintShortages.push({
        stockpile,
        outputBlueprintTypeId: production.blueprint._key,
        requiredRuns: runs,
        manufacturingLocationId,
        jobIds: [jobId],
      });
      return;
    }
    if (this.reusableBlueprintShortages.has(shortageKey)) return;
    this.reusableBlueprintShortages.add(shortageKey);
    this.blueprintPurchases.push({
      typeId: production.blueprint._key,
      quantity: 1,
      destination: {
        stockpileId: stockpile.id,
        locationId: manufacturingLocationId,
        quantity: 1,
        demandingJobId: jobId,
        purpose: "blueprint",
      },
    });
    this.warnings.push({
      code: "fallback-blueprint",
      typeId: production.blueprint._key,
      locationId: manufacturingLocationId,
      jobId,
      message: `No usable blueprint was found for type ${production.blueprint._key}.`,
    });
  }

  private inventionSkillPlan(blueprint: BlueprintsRecord): {
    multiplier: number;
    source: "request" | "fallback-level-3";
  } {
    const skills = blueprint.activities.invention?.skills ?? [];
    if (this.request.simulation.characters.length === 0) {
      const fallbackLevel = this.request.simulation.policy.fallbackInventionSkillLevel;
      const scienceLevels =
        skills.filter((skill) => !this.isEncryptionSkill(skill.typeID)).length * fallbackLevel;
      const encryptionLevel = skills.some((skill) => this.isEncryptionSkill(skill.typeID))
        ? fallbackLevel
        : 0;
      return {
        multiplier: 1 + scienceLevels / 30 + encryptionLevel / 40,
        source: "fallback-level-3",
      };
    }
    const candidates = this.request.simulation.characters.map((character) => {
      let scienceLevels = 0;
      let encryptionLevel = 0;
      for (const skill of skills) {
        const level = character.skillLevels[String(skill.typeID)] ?? 0;
        if (this.isEncryptionSkill(skill.typeID)) encryptionLevel = level;
        else scienceLevels += level;
      }
      return 1 + scienceLevels / 30 + encryptionLevel / 40;
    });
    return { multiplier: Math.max(...candidates), source: "request" };
  }

  private isEncryptionSkill(skillId: number): boolean {
    return /encryption/i.test(typeName(this.context, skillId));
  }

  private addActivitySkills(
    skills: Array<{ typeID: number; level: number }> | undefined,
    jobId: string,
  ): void {
    for (const skill of skills ?? []) {
      const requirement = this.skillRequirements.get(skill.typeID) ?? {
        requiredLevel: 0,
        jobIds: new Set<string>(),
      };
      requirement.requiredLevel = Math.max(requirement.requiredLevel, skill.level);
      requirement.jobIds.add(jobId);
      this.skillRequirements.set(skill.typeID, requirement);
    }
  }

  private expandSkillPrerequisites(): void {
    const pending = [...this.skillRequirements.keys()];
    const expanded = new Set<number>();
    while (pending.length > 0) {
      const skillId = pending.pop();
      if (skillId === undefined || expanded.has(skillId)) continue;
      expanded.add(skillId);
      const parent = this.skillRequirements.get(skillId) ?? {
        requiredLevel: 0,
        jobIds: new Set<string>(),
      };
      for (const prerequisite of this.context.skillPrerequisites.get(skillId) ?? []) {
        const requirement = this.skillRequirements.get(prerequisite.skillId) ?? {
          requiredLevel: 0,
          jobIds: new Set<string>(),
        };
        requirement.requiredLevel = Math.max(requirement.requiredLevel, prerequisite.level);
        for (const jobId of parent.jobIds) requirement.jobIds.add(jobId);
        this.skillRequirements.set(prerequisite.skillId, requirement);
        pending.push(prerequisite.skillId);
      }
    }
  }

  private declareDemand(
    account: SimulationLedgerAccount,
    quantity: number,
    source: SimulationDemandSource,
  ): void {
    this.transactions.push({
      id: this.nextId("demand"),
      kind: "demand",
      account,
      quantity,
      source: { ...source },
    });
    this.declaredDemandSources.set(source.demandId, { account, source });
  }

  /** Posts settled local availability without changing demand declarations in the journal. */
  private postDemandReadiness(): void {
    for (const { account, source } of this.declaredDemandSources.values()) {
      if (source.requiredNow <= 0) continue;
      this.transactions.push({
        id: this.nextId("readiness"),
        kind: "demand-readiness",
        account,
        demandId: source.demandId,
        quantity: source.requiredNow,
      });
    }
  }

  private recordUnmet(
    account: SimulationLedgerAccount,
    quantity: number,
    source: SimulationDemandSource,
    purpose: "material" | "reprocessing-input" = "material",
  ): void {
    if (quantity <= 0) return;
    this.unmetDemands.push({
      account,
      quantity,
      source,
      blockedByBuyBlacklist: this.request.settings.buyBlacklist.includes(account.typeId),
      purpose,
    });
  }

  private demandSource(
    stockpile: PlanStockpile,
    productTypeId: number,
    productQuantity: number,
    materialTypeId: number,
    plannedQuantity: number,
    destinationLocationId: number,
    activity: Exclude<SimulationActivity, "surplus">,
    demandingJobId?: string,
    quantityKind?: "item" | "blueprint-run",
  ): SimulationDemandSource {
    return {
      demandId: this.nextId("source"),
      stockpileId: stockpile.id,
      materialTypeId,
      productTypeId,
      productQuantity,
      plannedQuantity,
      requiredNow: 0,
      reserved: plannedQuantity,
      destinationLocationId,
      activity,
      ...(quantityKind ? { quantityKind } : {}),
      demandingJobId,
    };
  }

  /** Splits one material demand into locally allocated and future quantities. */
  private setDemandReadiness(source: SimulationDemandSource, requiredNow: number): void {
    source.requiredNow = Math.min(source.plannedQuantity, Math.max(0, requiredNow));
    source.reserved = source.plannedQuantity - source.requiredNow;
  }

  private stableId(...parts: Array<string | number>): string {
    this.sequence += 1;
    return createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 16);
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}:${this.sequence}`;
  }
}
