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

/** Declares industry work and reserves only complete physical run kits. */
export function simulateIndustryDemand(
  request: SimulationRequestV1,
  context: SimulationContext,
  inventory: SimulatorInventory,
  dependencyGraph: DependencyGraph,
): IndustrySimulationResult {
  const simulation = new IndustryDemandSimulation(request, context, inventory, dependencyGraph);
  return simulation.run();
}

class IndustryDemandSimulation {
  private readonly allocator: SimulationAllocator;
  private readonly transactions: SimulationTransaction[] = [];
  private readonly manufacturingJobs: SimulationIndustryJob[] = [];
  private readonly reactionJobs: SimulationIndustryJob[] = [];
  private readonly inventionJobs: SimulationInventionJob[] = [];
  private readonly copyJobs: SimulationCopyJob[] = [];
  private readonly unmetDemands: SimulationUnmetDemand[] = [];
  private readonly blueprintPurchases: SimulationBlueprintPurchase[] = [];
  private readonly warnings: SimulationWarning[];
  private readonly blueprintShortages: BlueprintShortage[] = [];
  private readonly skillRequirements = new Map<
    number,
    { requiredLevel: number; jobIds: Set<string> }
  >();
  private sequence = 0;

  /** Creates one isolated deterministic simulation state. */
  constructor(
    private readonly request: SimulationRequestV1,
    private readonly context: SimulationContext,
    inventory: SimulatorInventory,
    dependencyGraph: DependencyGraph,
  ) {
    this.allocator = new SimulationAllocator(inventory, request.haulExclusions ?? []);
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
    const stockpiles = [...this.request.stockpiles].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const stockpile of stockpiles) {
      const items = [...stockpile.items].sort(
        (left, right) =>
          left.typeId - right.typeId
          || left.quantity - right.quantity
          || left.me - right.me
          || left.te - right.te,
      );
      for (const item of items) {
        const isReprocessingInput = isSimulatorReprocessingType(this.context, item.typeId);
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
          item.quantity,
          account.locationId,
          isReprocessingInput ? "reprocessing" : "stock",
        );
        this.declareDemand(account, item.quantity, source);
        const existing = this.allocator.claimOrdinarySupply(
          item.typeId,
          item.quantity,
          account.locationId,
          account,
          undefined,
          stockpile.id,
          isReprocessingInput ? "reprocessing" : "stock",
        );
        this.setDemandReadiness(source, existing.local);
        const remaining = item.quantity - existing.local - existing.remote - existing.future;
        if (remaining > 0) {
          if (isReprocessingInput) {
            this.recordUnmet(account, remaining, source, "reprocessing-input");
          }
          else this.planProduction(item.typeId, remaining, stockpile, account, source, new Set());
        }
      }
    }

    for (let index = 0; index < this.blueprintShortages.length; index += 1) {
      this.planInventionAndCopying(this.blueprintShortages[index]);
    }
    this.expandSkillPrerequisites();
    return {
      transactions: [...this.transactions, ...this.allocator.transactions],
      manufacturingJobs: this.manufacturingJobs,
      reactionJobs: this.reactionJobs,
      inventionJobs: this.inventionJobs,
      copyJobs: this.copyJobs,
      unmetDemands: this.unmetDemands,
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
    if (quantity <= 0) return { plannedQuantity: 0, readyQuantity: 0, reservations: [] };
    if (stack.has(productTypeId)) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      this.warnings.push({
        code: "cycle-detected",
        typeId: productTypeId,
        message: `Quantity expansion stopped at cyclic type ${productTypeId}.`,
      });
      return { plannedQuantity: 0, readyQuantity: 0, reservations: [] };
    }
    if (this.request.settings.buildBlacklist.includes(productTypeId)) {
      this.recordUnmet(destinationAccount, quantity, demandSource);
      return { plannedQuantity: 0, readyQuantity: 0, reservations: [] };
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
      return { plannedQuantity: 0, readyQuantity: 0, reservations: [] };
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
    let plannedOutput = 0;
    let readyOutput = 0;
    const reservations: SimulationUpstreamReservation[] = [];
    for (const [allocationIndex, allocation] of allocations.entries()) {
      const jobId = `${baseJobId}:${allocationIndex}`;
      const job = this.planIndustryJob(
        jobId,
        production,
        productTypeId,
        details.product.quantity,
        allocation,
        profile,
        stockpile,
        demandSource,
        nextStack,
      );
      const outputQuantity = allocation.runs * details.product.quantity;
      const reservedQuantity = Math.min(outputQuantity, Math.max(0, quantity - plannedOutput));
      this.transactions.push({
        id: this.nextId("production"),
        kind: "production-commitment",
        account: outputAccount,
        destinationAccount,
        quantity: outputQuantity,
        source: "production",
        producingJobId: jobId,
      });
      if (production.activity === "manufacturing") this.manufacturingJobs.push(job);
      else this.reactionJobs.push(job);
      plannedOutput += outputQuantity;
      readyOutput += job.readyAfterUpstreamRuns * details.product.quantity;
      reservations.push({
        activity: production.activity,
        quantity: reservedQuantity,
        state: "planned",
        sourceJobId: jobId,
        sourceOutputQuantity: outputQuantity,
      });
      this.addActivitySkills(details.activity.skills, jobId);
      if (allocation.blueprintKind === "fallback") {
        this.recordBlueprintShortage(
          stockpile,
          production,
          allocation.runs,
          profile.locationId,
          jobId,
        );
      }
    }
    return {
      plannedQuantity: Math.min(quantity, plannedOutput),
      readyQuantity: Math.min(quantity, readyOutput),
      reservations,
    };
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

    const availabilityByTypeId = new Map(
      materialSpecifications.map((material) => [
        material.typeId,
        this.allocator.availability(material.typeId, profile.locationId),
      ]),
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
    for (const material of materialSpecifications) {
      const nowQuantity = this.materialQuantityForRuns(
        activity,
        material,
        readyNowRuns,
        blueprint,
        profile.materialMultiplier,
      );
      const claimedNow = this.allocator.claimLocal(
        material.typeId,
        material.requiredQuantity,
        profile.locationId,
        material.account,
        jobId,
        "now",
        undefined,
        activity,
      );
      const claimedRemote = this.allocator.claimRemote(
        material.typeId,
        material.requiredQuantity - claimedNow,
        profile.locationId,
        material.account,
        jobId,
        undefined,
        activity,
      );
      const physicalClaimed = claimedNow + claimedRemote;
      const futureClaim = this.allocator.claimFuture(
        material.typeId,
        material.requiredQuantity - physicalClaimed,
        material.account,
        jobId,
      );
      const claimedFuture = futureClaim.quantity;
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
      this.setDemandReadiness(material.source, nowQuantity);
      inputs.push({
        typeId: material.typeId,
        typeName: typeName(this.context, material.typeId, this.request.language),
        quantityPerRun: material.quantityPerRun,
        requiredQuantity: material.requiredQuantity,
        availableNow: claimedNow,
        availableFromHauling: physicalClaimed - claimedNow,
        availableAfterUpstream,
        unsatisfiedQuantity: Math.max(
          0,
          material.requiredQuantity
            - physicalClaimed
            - claimedFuture
            - productionSupply.plannedQuantity,
        ),
        upstreamReservations: [...futureClaim.reservations, ...productionSupply.reservations],
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
    return {
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
  }

  private planInventionAndCopying(shortage: BlueprintShortage): void {
    const sourceBlueprint = (
      this.context.blueprints.byInventionProductId.get(shortage.outputBlueprintTypeId) ?? []
    )
      .slice()
      .sort((left, right) => left._key - right._key)
      .at(0);
    if (!sourceBlueprint) return;
    const baseOutcome = getNoDecryptorInventionOutput(
      sourceBlueprint,
      shortage.outputBlueprintTypeId,
    );
    if (!baseOutcome) return;
    const inventionLocationId = shortage.stockpile.locations.invention;
    const inventionJobId = this.stableId(
      "invention",
      shortage.stockpile.id,
      shortage.outputBlueprintTypeId,
      inventionLocationId,
      this.sequence,
    );
    const decryptorTypeId = Object
      .entries(this.request.simulation.policy.decryptorTypeIdByProductBlueprintTypeId)
      .find(
        ([productBlueprintTypeId]) =>
          productBlueprintTypeId === String(shortage.outputBlueprintTypeId),
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
      shortage.requiredRuns * this.request.simulation.policy.inventionExpectedOutputFactor;
    const attempts = Math.ceil(
      targetExpectedRuns / Math.max(Number.EPSILON, probability * runsPerSuccess),
    );
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

    const sourceBlueprintAccount: SimulationLedgerAccount = {
      locationId: inventionLocationId,
      typeId: sourceBlueprint._key,
    };
    const sourceCopyClaims = this.allocator.claimBlueprintCopyRuns(
      sourceBlueprint._key,
      attempts,
      inventionLocationId,
      sourceBlueprintAccount,
      inventionJobId,
    );
    const claimedSourceRuns = sourceCopyClaims.reduce((total, claim) => total + claim.runs, 0);
    const sourceRunsMissing = Math.max(0, attempts - claimedSourceRuns);
    if (sourceRunsMissing > 0) {
      this.planCopying(shortage, sourceBlueprint, sourceRunsMissing, sourceBlueprintAccount);
    }

    const expectedOutputRuns = attempts * probability * runsPerSuccess;
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
      inputs: inventionInputs,
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
        locationId: shortage.manufacturingLocationId,
        typeId: shortage.outputBlueprintTypeId,
      },
      quantity: Math.floor(expectedOutputRuns),
      source: "invention",
      producingJobId: inventionJobId,
    });
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
  ): void {
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
    this.copyJobs.push({
      jobId,
      stockpileId: shortage.stockpile.id,
      locationId,
      blueprintTypeId: sourceBlueprint._key,
      sourceBlueprintItemId: original?.blueprintItemId,
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
    });
    this.transactions.push({
      id: this.nextId("copy-output"),
      kind: "production-commitment",
      account: blueprintAccount,
      destinationAccount: outputAccount,
      quantity: totalLicensedRuns,
      source: "copying",
      producingJobId: jobId,
    });
    this.addActivitySkills(sourceBlueprint.activities.copying?.skills, jobId);
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

  private materialQuantityForRuns(
    activity: ProductionActivity,
    material: MaterialSpecification,
    runs: number,
    blueprint: SimulationBlueprintAllocation,
    materialMultiplier: number,
  ): number {
    return requiredMaterialQuantity(
      activity,
      material.quantityPerRun,
      runs,
      { me: blueprint.materialEfficiency },
      materialMultiplier,
    );
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
    if (production.activity === "reaction") {
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
      source,
    });
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
      demandingJobId,
    };
  }

  /** Splits one material demand into immediately installable and deferred quantities. */
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
