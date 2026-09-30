import type { PlanStockpile } from "@/lib/planning/types";
import type { SimulationLedgerAccount, SimulationTransaction } from "./ledger";
import type { SimulatorBlueprintLot, SimulatorInventory, SimulationItemLot } from "./sourceLots";
import type {
  SimulationAllocationPurpose,
  SimulationBlueprintAllocation,
  SimulationFacilityProfile,
  SimulationHaulTask,
  SimulationHaulExclusion,
  SimulationActivity,
  SimulationUpstreamReservation,
} from "./types";

/** Quantity visible at each physical/future supply horizon. */
export interface SupplyAvailability {
  local: number;
  remote: number;
  future: number;
}

/** Exact item quantities claimed for one demand. */
export interface ItemClaim {
  local: number;
  remote: number;
  future: number;
  futureReservations: SimulationUpstreamReservation[];
}

/** Existing future output claimed for one demand and its known provenance. */
export interface FutureClaim {
  quantity: number;
  reservations: SimulationUpstreamReservation[];
}

/** Blueprint allocation with the horizon at which the print becomes usable. */
export interface BlueprintClaim extends SimulationBlueprintAllocation {
  horizon: "now" | "after-hauling" | "after-upstream";
  lotId?: string;
  sourceActivity?: "copying" | "invention";
  sourceJobId?: number;
  sourceCompletionAt?: string;
}

interface PendingItemDemand {
  typeId: number;
  destinationLocationId: number;
  quantity: number;
}

function locationPairKey(firstLocationId: number, secondLocationId: number): string {
  return firstLocationId < secondLocationId
    ? `${firstLocationId}:${secondLocationId}`
    : `${secondLocationId}:${firstLocationId}`;
}

function stockpileRoutePolicy(stockpiles: readonly Pick<PlanStockpile, "locations">[]) {
  const stockpileLocationIds = new Set<number>();
  const sameStockpileLocationPairs = new Set<string>();
  for (const stockpile of stockpiles) {
    const locationIds = [
      ...new Set(
        Object
          .entries(stockpile.locations)
          .filter(([locationKind]) => locationKind !== "stock")
          .map(([, locationId]) => locationId),
      ),
    ];
    for (const locationId of locationIds) stockpileLocationIds.add(locationId);
    for (let firstIndex = 0; firstIndex < locationIds.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < locationIds.length; secondIndex += 1) {
        sameStockpileLocationPairs.add(
          locationPairKey(locationIds[firstIndex], locationIds[secondIndex]),
        );
      }
    }
  }
  return { stockpileLocationIds, sameStockpileLocationPairs };
}

/** Deterministically allocates ordinary lots and blueprint runs without duplicating stock. */
export class SimulationAllocator {
  private readonly itemLotsByTypeId: Map<number, SimulationItemLot[]>;
  private readonly remainingItemQuantityByLotId: Map<string, number>;
  private readonly remainingBlueprintRunsByLotId: Map<string, number>;
  private readonly stockpileLocationIds: ReadonlySet<number>;
  private readonly sameStockpileLocationPairs: ReadonlySet<string>;
  private readonly blockInterStockpileHauling: boolean;
  private readonly systemIdByLocationId: ReadonlyMap<number, number>;
  private readonly activityReservationsByLotId = new Map<string, Map<number, number>>();
  private readonly stockpileReservationsByLotId = new Map<string, Map<number, number>>();
  private readonly pendingRemoteActivityDemands = new Map<string, PendingItemDemand>();
  private readonly pendingRemoteStockpileDemands = new Map<string, PendingItemDemand>();
  private readonly transferredBlueprintLotIds = new Set<string>();
  private transactionSequence = 0;
  readonly transactions: SimulationTransaction[] = [];
  readonly haulingTasks: SimulationHaulTask[] = [];

  /** Creates an allocator over one immutable inventory snapshot. */
  constructor(
    private readonly inventory: SimulatorInventory,
    private readonly haulExclusions: readonly SimulationHaulExclusion[],
    stockpiles: readonly Pick<PlanStockpile, "locations">[] = [],
    blockInterStockpileHauling = false,
    facilityProfiles: readonly SimulationFacilityProfile[] = [],
  ) {
    const routePolicy = stockpileRoutePolicy(stockpiles);
    this.stockpileLocationIds = routePolicy.stockpileLocationIds;
    this.sameStockpileLocationPairs = routePolicy.sameStockpileLocationPairs;
    this.blockInterStockpileHauling = blockInterStockpileHauling;
    this.systemIdByLocationId = new Map(
      facilityProfiles.map((profile) => [profile.locationId, profile.systemId]),
    );
    this.itemLotsByTypeId = new Map();
    for (const lot of inventory.itemLots) {
      const lots = this.itemLotsByTypeId.get(lot.typeId) ?? [];
      lots.push(lot);
      this.itemLotsByTypeId.set(lot.typeId, lots);
    }
    for (const lots of this.itemLotsByTypeId.values()) {
      lots.sort((left, right) => left.lotId.localeCompare(right.lotId));
    }
    this.remainingItemQuantityByLotId = new Map(
      inventory.itemLots.map((lot) => [lot.lotId, lot.quantity]),
    );
    this.remainingBlueprintRunsByLotId = new Map(
      inventory.blueprintLots.map((lot) => [lot.lotId, lot.runs]),
    );
  }

  /** Returns unclaimed ordinary supply for a type at each horizon. */
  availability(typeId: number, destinationLocationId: number): SupplyAvailability {
    let local = 0;
    let remote = 0;
    let future = 0;
    for (const lot of this.itemLotsByTypeId.get(typeId) ?? []) {
      if (lot.source === "market-order") continue;
      const quantity = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      if (quantity <= 0) continue;
      if (lot.horizon === "after-upstream") {
        if (
          lot.locationId === destinationLocationId
          || (lot.locationId !== undefined && !this.isExcluded(lot, destinationLocationId))
        ) future += quantity;
        continue;
      }
      else if (lot.locationId === destinationLocationId) {
        local
          += Math.max(
            0,
            quantity
              - this.activityReservationsForOtherDestinations(lot.lotId, destinationLocationId),
          );
      }
      else if (lot.locationId !== undefined && !this.isExcluded(lot, destinationLocationId)) {
        remote
          += Math.max(
            0,
            quantity
              - this.activityReservationsForOtherDestinations(lot.lotId, destinationLocationId),
          );
      }
    }
    return { local, remote, future };
  }

  /** Claims up to the requested amount from local physical lots. */
  claimLocal(
    typeId: number,
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
    reservationHorizon: "now" | "after-hauling" = "now",
    stockpileId?: string,
    demandActivity?: Exclude<SimulationActivity, "surplus">,
    allocationPurpose: SimulationAllocationPurpose = "stockpile-demand",
  ): number {
    return this.claimItemLots(
      (this.itemLotsByTypeId.get(typeId) ?? []).filter(
        (lot) =>
          lot.typeId === typeId
          && lot.source !== "market-order"
          && lot.horizon === "now"
          && lot.locationId === destinationLocationId,
      ),
      quantity,
      destinationLocationId,
      account,
      demandingJobId,
      reservationHorizon,
      stockpileId,
      demandActivity,
      allocationPurpose,
    );
  }

  /** Claims up to the requested amount from permitted remote physical lots. */
  claimRemote(
    typeId: number,
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
    stockpileId?: string,
    demandActivity?: Exclude<SimulationActivity, "surplus">,
    allocationPurpose: SimulationAllocationPurpose = "stockpile-demand",
  ): number {
    return this.claimItemLots(
      (this.itemLotsByTypeId.get(typeId) ?? []).filter(
        (lot) =>
          lot.typeId === typeId
          && lot.source !== "market-order"
          && lot.horizon === "now"
          && lot.locationId !== destinationLocationId
          && !this.isExcluded(lot, destinationLocationId),
      ),
      quantity,
      destinationLocationId,
      account,
      demandingJobId,
      "after-hauling",
      stockpileId,
      demandActivity,
      allocationPurpose,
    );
  }

  /** Reserves local physical lots for activity inputs before remote allocation begins. */
  reserveActivityDemand(typeId: number, quantity: number, destinationLocationId: number): void {
    let remaining = quantity;
    const candidates = (this.itemLotsByTypeId.get(typeId) ?? [])
      .filter(
        (lot) =>
          lot.source !== "market-order"
          && lot.horizon === "now"
          && lot.locationId === destinationLocationId,
      )
      .slice()
      .sort((left, right) => left.lotId.localeCompare(right.lotId));
    for (const lot of candidates) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const reserved = this.totalProtectedReservation(lot.lotId);
      const next = Math.min(remaining, Math.max(0, available - reserved));
      if (next <= 0) continue;
      this.addActivityReservation(lot.lotId, destinationLocationId, next);
      remaining -= next;
    }
    this.addPendingDemand(
      this.pendingRemoteActivityDemands,
      typeId,
      destinationLocationId,
      remaining,
    );
  }

  /** Reserves remote physical supply for activity only after local stockpile demand is protected. */
  reserveRemoteActivityDemand(): void {
    for (const demand of this.sortedPendingDemands(this.pendingRemoteActivityDemands)) {
      let remaining = demand.quantity;
      const candidates = (this.itemLotsByTypeId.get(demand.typeId) ?? [])
        .filter(
          (lot) =>
            lot.source !== "market-order"
            && lot.horizon === "now"
            && lot.locationId !== demand.destinationLocationId
            && !this.isExcluded(lot, demand.destinationLocationId),
        )
        .slice()
        .sort((left, right) => left.lotId.localeCompare(right.lotId));
      for (const lot of candidates) {
        if (remaining <= 0) break;
        const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
        const next = Math.min(
          remaining,
          Math.max(0, available - this.totalProtectedReservation(lot.lotId)),
        );
        if (next <= 0) continue;
        this.addActivityReservation(lot.lotId, demand.destinationLocationId, next);
        remaining -= next;
      }
    }
    this.pendingRemoteActivityDemands.clear();
  }

  /** Reserves local physical stock for its own final stockpile demand before remote claims. */
  reserveLocalStockpileDemand(
    typeId: number,
    quantity: number,
    destinationLocationId: number,
  ): void {
    if (quantity <= 0) return;
    const marketOrderQuantity = (this.itemLotsByTypeId.get(typeId) ?? [])
      .filter(
        (lot) =>
          lot.source === "market-order"
          && lot.horizon === "now"
          && lot.locationId === destinationLocationId,
      )
      .reduce((total, lot) => total + (this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0), 0);
    let remaining = Math.max(0, quantity - marketOrderQuantity);
    const candidates = (this.itemLotsByTypeId.get(typeId) ?? [])
      .filter(
        (lot) =>
          lot.source !== "market-order"
          && lot.horizon === "now"
          && lot.locationId === destinationLocationId,
      )
      .slice()
      .sort((left, right) => left.lotId.localeCompare(right.lotId));
    for (const lot of candidates) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const reserved = this.totalProtectedReservation(lot.lotId);
      const next = Math.min(remaining, Math.max(0, available - reserved));
      if (next <= 0) continue;
      this.addStockpileReservation(lot.lotId, destinationLocationId, next);
      remaining -= next;
    }
    this.addPendingDemand(
      this.pendingRemoteStockpileDemands,
      typeId,
      destinationLocationId,
      remaining,
    );
  }

  /** Reserves remote physical supply for stockpiles after activity demand has been protected. */
  reserveRemoteStockpileDemand(): void {
    const demands = this.sortedPendingDemands(this.pendingRemoteStockpileDemands).sort(
      (left, right) =>
        Number(!this.hasSameSystemRemoteSupply(left.typeId, left.destinationLocationId))
          - Number(!this.hasSameSystemRemoteSupply(right.typeId, right.destinationLocationId))
        || left.typeId - right.typeId
        || left.destinationLocationId - right.destinationLocationId,
    );
    for (const demand of demands) {
      let remaining = demand.quantity;
      const candidates = (this.itemLotsByTypeId.get(demand.typeId) ?? [])
        .filter(
          (lot) =>
            lot.source !== "market-order"
            && lot.horizon === "now"
            && lot.locationId !== demand.destinationLocationId
            && !this.isExcluded(lot, demand.destinationLocationId),
        )
        .slice()
        .sort((left, right) => left.lotId.localeCompare(right.lotId));
      for (const lot of candidates) {
        if (remaining <= 0) break;
        const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
        const next = Math.min(
          remaining,
          Math.max(0, available - this.totalProtectedReservation(lot.lotId)),
        );
        if (next <= 0) continue;
        this.addStockpileReservation(lot.lotId, demand.destinationLocationId, next);
        remaining -= next;
      }
    }
    this.pendingRemoteStockpileDemands.clear();
  }

  /** Returns whether same-system remote stock can satisfy a stockpile demand. */
  hasSameSystemRemoteSupply(typeId: number, destinationLocationId: number): boolean {
    const destinationSystemId = this.systemIdByLocationId.get(destinationLocationId);
    if (destinationSystemId === undefined) return false;
    return (this.itemLotsByTypeId.get(typeId) ?? []).some((lot) => {
      if (
        lot.source === "market-order"
        || lot.horizon !== "now"
        || lot.locationId === undefined
        || lot.locationId === destinationLocationId
        || this.isExcluded(lot, destinationLocationId)
      ) return false;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      return (
        available > this.totalProtectedReservation(lot.lotId)
        && lot.systemId === destinationSystemId
      );
    });
  }

  /** Returns physical supply without subtracting provisional activity reservations. */
  physicalAvailability(typeId: number, destinationLocationId: number): SupplyAvailability {
    let local = 0;
    let remote = 0;
    let future = 0;
    for (const lot of this.itemLotsByTypeId.get(typeId) ?? []) {
      if (lot.source === "market-order") continue;
      const quantity = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      if (quantity <= 0) continue;
      if (lot.horizon === "after-upstream") {
        if (
          lot.locationId === destinationLocationId
          || (lot.locationId !== undefined && !this.isExcluded(lot, destinationLocationId))
        ) future += quantity;
      }
      else if (lot.locationId === destinationLocationId) local += quantity;
      else if (lot.locationId !== undefined && !this.isExcluded(lot, destinationLocationId)) {
        remote += quantity;
      }
    }
    return { local, remote, future };
  }

  /** Returns usable manufacturing blueprint runs, treating originals as reusable. */
  availableManufacturingBlueprintRuns(
    blueprintTypeId: number,
    destinationLocationId: number,
    maximumRuns: number,
  ): number {
    let availableRuns = 0;
    for (const lot of this.inventory.blueprintLots) {
      if (
        lot.typeId !== blueprintTypeId
        || lot.kind === "formula"
        || lot.inUse
        || (lot.locationId !== destinationLocationId && this.isExcluded(lot, destinationLocationId))
      ) continue;
      if (lot.kind === "bpo") return Number.MAX_SAFE_INTEGER;
      availableRuns += this.remainingBlueprintRunsByLotId.get(lot.lotId) ?? 0;
      if (availableRuns >= maximumRuns) return maximumRuns;
    }
    return Math.min(availableRuns, maximumRuns);
  }

  /** Returns usable BPC runs for invention up to the requested maximum. */
  availableBlueprintCopyRuns(
    blueprintTypeId: number,
    destinationLocationId: number,
    maximumRuns: number,
  ): number {
    let availableRuns = 0;
    for (const lot of this.inventory.blueprintLots) {
      if (
        lot.typeId !== blueprintTypeId
        || lot.kind !== "bpc"
        || lot.inUse
        || (lot.locationId !== destinationLocationId && this.isExcluded(lot, destinationLocationId))
      ) continue;
      availableRuns += this.remainingBlueprintRunsByLotId.get(lot.lotId) ?? 0;
      if (availableRuns >= maximumRuns) return maximumRuns;
    }
    return Math.min(availableRuns, maximumRuns);
  }

  /** Claims existing active-job output without treating it as physical stock. */
  claimFuture(
    typeId: number,
    quantity: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
    allocationPurpose: SimulationAllocationPurpose = "stockpile-demand",
  ): FutureClaim {
    let remaining = quantity;
    let claimed = 0;
    const reservations: SimulationUpstreamReservation[] = [];
    for (const lot of (this.itemLotsByTypeId.get(typeId) ?? [])
      .filter(
        (candidate) =>
          candidate.source !== "market-order"
          && candidate.horizon === "after-upstream"
          && (candidate.activity === "manufacturing" || candidate.activity === "reaction")
          && candidate.locationId !== undefined
          && (
            candidate.locationId === account.locationId
            || !this.isExcluded(candidate, account.locationId)
          ),
      )
      .slice()
      .sort(
        (left, right) =>
          Number(left.locationId !== account.locationId)
            - Number(right.locationId !== account.locationId)
          || left.lotId.localeCompare(right.lotId),
      )) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const next = Math.min(remaining, available);
      const sourceLocationId = lot.locationId;
      if (
        next <= 0
        || sourceLocationId === undefined
        || (lot.activity !== "manufacturing" && lot.activity !== "reaction")
      ) continue;
      const activity = lot.activity;
      this.remainingItemQuantityByLotId.set(lot.lotId, available - next);
      this.transactions.push({
        id: this.nextTransactionId("existing-output"),
        kind: "production-commitment",
        account: {
          locationId: sourceLocationId,
          typeId: lot.typeId,
        },
        destinationAccount: account,
        quantity: next,
        source: "production",
        activity,
        sourceLotId: lot.lotId,
        producingJobId:
          lot.industryJobId === undefined
            ? (demandingJobId ?? `existing:${lot.lotId}`)
            : String(lot.industryJobId),
      });
      remaining -= next;
      claimed += next;
      reservations.push({
        activity,
        quantity: next,
        state:
          lot.industryJobStatus === "active"
            ? "in-production"
            : lot.industryJobStatus === "paused"
              ? "paused"
              : "planned",
        ...(lot.industryJobId !== undefined ? { sourceJobId: lot.industryJobId } : {}),
        ...(lot.industryJobId !== undefined && lot.quantity > 0
          ? { sourceOutputQuantity: lot.quantity }
          : {}),
        ...(lot.industryJobStatus === "active" && lot.industryJobEndDate
          ? { sourceCompletionAt: lot.industryJobEndDate }
          : {}),
      });
    }
    return {
      quantity: claimed,
      reservations,
    };
  }

  /** Claims a target quantity across local, remote, then existing future output. */
  claimOrdinarySupply(
    typeId: number,
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
    stockpileId?: string,
    demandActivity?: Exclude<SimulationActivity, "surplus">,
    allocationPurpose: SimulationAllocationPurpose = "stockpile-demand",
  ): ItemClaim {
    const local = this.claimLocal(
      typeId,
      quantity,
      destinationLocationId,
      account,
      demandingJobId,
      "now",
      stockpileId,
      demandActivity,
      allocationPurpose,
    );
    const remote = this.claimRemote(
      typeId,
      quantity - local,
      destinationLocationId,
      account,
      demandingJobId,
      stockpileId,
      demandActivity,
      allocationPurpose,
    );
    const futureClaim = this.claimFuture(
      typeId,
      quantity - local - remote,
      account,
      demandingJobId,
      allocationPurpose,
    );
    return {
      local,
      remote,
      future: futureClaim.quantity,
      futureReservations: futureClaim.reservations,
    };
  }

  /** Claims sell-order lots only when direct final demand is at the order location. */
  claimSellOrderSupply(
    typeId: number,
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
    stockpileId?: string,
  ): number {
    return this.claimItemLots(
      (this.itemLotsByTypeId.get(typeId) ?? []).filter(
        (lot) =>
          lot.typeId === typeId
          && lot.source === "market-order"
          && lot.horizon === "now"
          && lot.locationId === destinationLocationId,
      ),
      quantity,
      destinationLocationId,
      account,
      demandingJobId,
      "now",
      stockpileId,
      "stock",
    );
  }

  /** Allocates manufacturing blueprint runs in stable locality/ME/TE order. */
  claimManufacturingBlueprints(
    blueprintTypeId: number,
    runs: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId: string,
    maxRunsPerAllocation: number,
  ): BlueprintClaim[] {
    let remainingRuns = runs;
    const allocations: BlueprintClaim[] = [];
    const candidates = this.inventory.blueprintLots
      .filter(
        (lot) =>
          lot.typeId === blueprintTypeId
          && lot.kind !== "formula"
          && !lot.inUse
          && (
            lot.locationId === destinationLocationId
            || !this.isExcluded(lot, destinationLocationId)
          ),
      )
      .slice()
      .sort((left, right) => {
        const leftLocationRank = left.locationId === destinationLocationId ? 0 : 1;
        const rightLocationRank = right.locationId === destinationLocationId ? 0 : 1;
        return (
          leftLocationRank - rightLocationRank
          || right.materialEfficiency - left.materialEfficiency
          || right.timeEfficiency - left.timeEfficiency
          || left.lotId.localeCompare(right.lotId)
        );
      });
    for (const lot of candidates) {
      if (remainingRuns <= 0) break;
      const remainingRunsBeforeLot = remainingRuns;
      const availableRuns =
        lot.kind === "bpo"
          ? remainingRuns
          : (this.remainingBlueprintRunsByLotId.get(lot.lotId) ?? 0);
      let allocatedRuns = Math.min(remainingRuns, availableRuns);
      while (allocatedRuns > 0) {
        const nextRuns = Math.min(allocatedRuns, maxRunsPerAllocation);
        const horizon = this.blueprintHorizon(lot, destinationLocationId);
        allocations.push({
          blueprintTypeId,
          blueprintItemId: lot.itemId,
          blueprintKind: lot.kind,
          sourceLocationId: lot.locationId,
          runs: nextRuns,
          materialEfficiency: lot.materialEfficiency,
          timeEfficiency: lot.timeEfficiency,
          horizon,
          lotId: lot.lotId,
          ...(lot.activity ? { sourceActivity: lot.activity } : {}),
          ...(lot.industryJobId !== undefined ? { sourceJobId: lot.industryJobId } : {}),
          ...(lot.industryJobEndDate ? { sourceCompletionAt: lot.industryJobEndDate } : {}),
        });
        this.transactions.push({
          id: this.nextTransactionId("blueprint"),
          kind: "blueprint-run-reservation",
          account,
          blueprintLotId: lot.lotId,
          quantity: nextRuns,
          demandingJobId,
          horizon,
        });
        allocatedRuns -= nextRuns;
        remainingRuns -= nextRuns;
      }
      if (lot.kind === "bpc") {
        const runsAllocatedFromLot = remainingRunsBeforeLot - remainingRuns;
        this.remainingBlueprintRunsByLotId.set(lot.lotId, availableRuns - runsAllocatedFromLot);
      }
      this.recordBlueprintHaul(lot, destinationLocationId, demandingJobId);
      this.recordBlueprintTransfer(
        lot,
        destinationLocationId,
        remainingRunsBeforeLot - remainingRuns,
        demandingJobId,
      );
    }
    return allocations;
  }

  /** Selects one reusable reaction formula for an activity location. */
  claimReactionFormula(
    formulaTypeId: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId: string,
  ): BlueprintClaim | undefined {
    const formula = this.inventory.blueprintLots
      .filter(
        (lot) =>
          lot.typeId === formulaTypeId
          && lot.kind === "formula"
          && !lot.inUse
          && (
            lot.locationId === destinationLocationId
            || !this.isExcluded(lot, destinationLocationId)
          ),
      )
      .slice()
      .sort((left, right) => {
        const leftRank = left.locationId === destinationLocationId ? 0 : 1;
        const rightRank = right.locationId === destinationLocationId ? 0 : 1;
        return leftRank - rightRank || left.lotId.localeCompare(right.lotId);
      })
      .at(0);
    if (!formula) return undefined;
    this.transactions.push({
      id: this.nextTransactionId("formula"),
      kind: "blueprint-run-reservation",
      account,
      blueprintLotId: formula.lotId,
      quantity: 1,
      demandingJobId,
    });
    this.recordBlueprintHaul(formula, destinationLocationId, demandingJobId);
    return {
      blueprintTypeId: formulaTypeId,
      blueprintItemId: formula.itemId,
      blueprintKind: "formula",
      sourceLocationId: formula.locationId,
      runs: Number.MAX_SAFE_INTEGER,
      materialEfficiency: 0,
      timeEfficiency: 0,
      horizon: this.blueprintHorizon(formula, destinationLocationId),
      lotId: formula.lotId,
    };
  }

  /** Returns whether an unused formula can be claimed for the destination location. */
  hasAvailableReactionFormula(formulaTypeId: number, destinationLocationId: number): boolean {
    return this.inventory.blueprintLots.some(
      (lot) =>
        lot.typeId === formulaTypeId
        && lot.kind === "formula"
        && !lot.inUse
        && (
          lot.locationId === destinationLocationId
          || !this.isExcluded(lot, destinationLocationId)
        ),
    );
  }

  /** Claims finite BPC runs for invention or another consuming science activity. */
  claimBlueprintCopyRuns(
    blueprintTypeId: number,
    runs: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId: string,
  ): BlueprintClaim[] {
    let remainingRuns = runs;
    const claims: BlueprintClaim[] = [];
    const copies = this.inventory.blueprintLots
      .filter(
        (lot) =>
          lot.typeId === blueprintTypeId
          && lot.kind === "bpc"
          && !lot.inUse
          && (
            lot.locationId === destinationLocationId
            || !this.isExcluded(lot, destinationLocationId)
          ),
      )
      .slice()
      .sort((left, right) => {
        const leftRank = left.locationId === destinationLocationId ? 0 : 1;
        const rightRank = right.locationId === destinationLocationId ? 0 : 1;
        return leftRank - rightRank || left.lotId.localeCompare(right.lotId);
      });
    for (const copy of copies) {
      if (remainingRuns <= 0) break;
      const available = this.remainingBlueprintRunsByLotId.get(copy.lotId) ?? 0;
      const claimedRuns = Math.min(remainingRuns, available);
      if (claimedRuns <= 0) continue;
      this.remainingBlueprintRunsByLotId.set(copy.lotId, available - claimedRuns);
      claims.push({
        blueprintTypeId,
        blueprintItemId: copy.itemId,
        blueprintKind: "bpc",
        sourceLocationId: copy.locationId,
        runs: claimedRuns,
        materialEfficiency: copy.materialEfficiency,
        timeEfficiency: copy.timeEfficiency,
        horizon: this.blueprintHorizon(copy, destinationLocationId),
        lotId: copy.lotId,
        ...(copy.activity ? { sourceActivity: copy.activity } : {}),
        ...(copy.industryJobId !== undefined ? { sourceJobId: copy.industryJobId } : {}),
        ...(copy.industryJobEndDate ? { sourceCompletionAt: copy.industryJobEndDate } : {}),
      });
      const horizon = this.blueprintHorizon(copy, destinationLocationId);
      this.transactions.push({
        id: this.nextTransactionId("blueprint-copy"),
        kind: "blueprint-run-reservation",
        account,
        blueprintLotId: copy.lotId,
        quantity: claimedRuns,
        demandingJobId,
        horizon,
      });
      this.recordBlueprintHaul(copy, destinationLocationId, demandingJobId);
      this.recordBlueprintTransfer(copy, destinationLocationId, claimedRuns, demandingJobId);
      remainingRuns -= claimedRuns;
    }
    return claims;
  }

  /** Selects one reusable BPO for copying without consuming production runs. */
  claimReusableBlueprintOriginal(
    blueprintTypeId: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId: string,
  ): BlueprintClaim | undefined {
    const original = this.inventory.blueprintLots
      .filter(
        (lot) =>
          lot.typeId === blueprintTypeId
          && lot.kind === "bpo"
          && !lot.inUse
          && (
            lot.locationId === destinationLocationId
            || !this.isExcluded(lot, destinationLocationId)
          ),
      )
      .slice()
      .sort((left, right) => {
        const leftRank = left.locationId === destinationLocationId ? 0 : 1;
        const rightRank = right.locationId === destinationLocationId ? 0 : 1;
        return leftRank - rightRank || left.lotId.localeCompare(right.lotId);
      })
      .at(0);
    if (!original) return undefined;
    this.transactions.push({
      id: this.nextTransactionId("blueprint-original"),
      kind: "blueprint-run-reservation",
      account,
      blueprintLotId: original.lotId,
      quantity: 1,
      demandingJobId,
    });
    this.recordBlueprintHaul(original, destinationLocationId, demandingJobId);
    return {
      blueprintTypeId,
      blueprintItemId: original.itemId,
      blueprintKind: "bpo",
      sourceLocationId: original.locationId,
      runs: Number.MAX_SAFE_INTEGER,
      materialEfficiency: original.materialEfficiency,
      timeEfficiency: original.timeEfficiency,
      horizon: this.blueprintHorizon(original, destinationLocationId),
      lotId: original.lotId,
    };
  }

  /** Returns remaining unreserved ordinary quantity for a lot. */
  remainingItemQuantity(lotId: string): number {
    return this.remainingItemQuantityByLotId.get(lotId) ?? 0;
  }

  /** Returns remaining finite BPC runs for a blueprint lot. */
  remainingBlueprintRuns(lotId: string): number {
    return this.remainingBlueprintRunsByLotId.get(lotId) ?? 0;
  }

  /** Claims an exact selected lot for late reprocessing and records any required transfer. */
  claimReprocessingLot(
    lotId: string,
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    reprocessingJobId: string,
  ): number {
    const lot = this.inventory.itemLots.find((candidate) => candidate.lotId === lotId);
    if (!lot || lot.source === "market-order" || !lot.eligibleForReprocessing || quantity <= 0) {
      return 0;
    }
    if (lot.locationId !== destinationLocationId && this.isExcluded(lot, destinationLocationId)) {
      return 0;
    }
    const available = this.remainingItemQuantityByLotId.get(lotId) ?? 0;
    const claimed = Math.min(quantity, available);
    if (claimed <= 0) return 0;
    this.remainingItemQuantityByLotId.set(lotId, available - claimed);
    const remote = lot.locationId !== destinationLocationId;
    this.transactions.push({
      id: this.nextTransactionId("reprocessing-reserve"),
      kind: "source-reservation",
      account,
      lotId,
      quantity: claimed,
      horizon: remote ? "after-hauling" : "now",
      demandingJobId: reprocessingJobId,
      demandActivity: "reprocessing",
    });
    if (remote && lot.locationId !== undefined) {
      this.transactions.push({
        id: this.nextTransactionId("reprocessing-transfer"),
        kind: "transfer-commitment",
        sourceAccount: { locationId: lot.locationId, typeId: lot.typeId },
        destinationAccount: account,
        lotId,
        quantity: claimed,
        demandingJobId: reprocessingJobId,
      });
      this.haulingTasks.push({
        transferId: `haul:${lotId}:${destinationLocationId}:${reprocessingJobId}`,
        lotId,
        typeId: lot.typeId,
        typeName: lot.name,
        quantity: claimed,
        unitVolume: lot.unitVolume,
        fromLocationId: lot.locationId,
        toLocationId: destinationLocationId,
        ownerType: lot.ownerType,
        ownerId: lot.ownerId,
        purpose: "reprocessing-input",
        demands: [{ jobId: reprocessingJobId, quantity: claimed }],
      });
    }
    return claimed;
  }

  private claimItemLots(
    lots: readonly SimulationItemLot[],
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId: string | undefined,
    reservationHorizon: "now" | "after-hauling",
    stockpileId?: string,
    demandActivity?: Exclude<SimulationActivity, "surplus">,
    allocationPurpose: SimulationAllocationPurpose = "stockpile-demand",
  ): number {
    let remaining = quantity;
    let claimed = 0;
    const orderedLots = [...lots].sort(
      (left, right) =>
        Number(this.activityReservation(right.lotId, destinationLocationId) > 0)
          - Number(this.activityReservation(left.lotId, destinationLocationId) > 0)
        || Number(this.stockpileReservation(right.lotId, destinationLocationId) > 0)
          - Number(this.stockpileReservation(left.lotId, destinationLocationId) > 0)
        || left.lotId.localeCompare(right.lotId),
    );
    for (const lot of orderedLots) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const activityReservation = this.activityReservation(lot.lotId);
      const ownActivityReservation = this.activityReservation(lot.lotId, destinationLocationId);
      const stockpileReservation = this.stockpileReservation(lot.lotId);
      const ownStockpileReservation = this.stockpileReservation(lot.lotId, destinationLocationId);
      const isLocal = lot.locationId === destinationLocationId;
      const protectedQuantity =
        allocationPurpose === "stockpile-demand"
          ? (isLocal ? this.activityReservation(lot.lotId, lot.locationId) : activityReservation)
            + (isLocal ? 0 : stockpileReservation - ownStockpileReservation)
          : activityReservation
            - ownActivityReservation
            + (isLocal ? 0 : this.stockpileReservation(lot.lotId, lot.locationId));
      const usable = Math.max(0, available - protectedQuantity);
      const next = Math.min(remaining, usable);
      if (next <= 0) continue;
      this.remainingItemQuantityByLotId.set(lot.lotId, available - next);
      if (allocationPurpose === "activity-input") {
        this.consumeActivityReservation(lot.lotId, destinationLocationId, next);
        const unreservedQuantity = Math.max(
          0,
          available - activityReservation - stockpileReservation,
        );
        this.consumeStockpileReservation(
          lot.lotId,
          Math.max(0, next - ownActivityReservation - unreservedQuantity),
          undefined,
          isLocal ? undefined : lot.locationId,
        );
      }
      else {
        this.consumeStockpileReservation(lot.lotId, next, destinationLocationId);
      }
      this.transactions.push({
        id: this.nextTransactionId("reserve"),
        kind: "source-reservation",
        account,
        lotId: lot.lotId,
        quantity: next,
        horizon: reservationHorizon,
        demandingJobId,
        stockpileId,
        demandActivity,
      });
      if (lot.locationId !== undefined && lot.locationId !== destinationLocationId) {
        this.transactions.push({
          id: this.nextTransactionId("transfer"),
          kind: "transfer-commitment",
          sourceAccount: { locationId: lot.locationId, typeId: lot.typeId },
          destinationAccount: account,
          lotId: lot.lotId,
          quantity: next,
          demandingJobId,
        });
        this.haulingTasks.push({
          transferId: `haul:${lot.lotId}:${destinationLocationId}:${demandingJobId ?? "stock"}`,
          lotId: lot.lotId,
          typeId: lot.typeId,
          typeName: lot.name,
          quantity: next,
          unitVolume: lot.unitVolume,
          fromLocationId: lot.locationId,
          toLocationId: destinationLocationId,
          ownerType: lot.ownerType,
          ownerId: lot.ownerId,
          purpose: allocationPurpose === "stockpile-demand" ? "stockpile-demand" : "industry-input",
          demands: [{ jobId: demandingJobId, quantity: next }],
        });
      }
      remaining -= next;
      claimed += next;
    }
    return claimed;
  }

  private isExcluded(
    lot: Pick<SimulationItemLot, "typeId" | "locationId" | "ownerType" | "ownerId">,
    destinationLocationId: number,
  ): boolean {
    if (lot.locationId === undefined) return true;
    if (
      this.haulExclusions.some(
        (exclusion) =>
          exclusion.typeId === lot.typeId
          && exclusion.fromLocationId === lot.locationId
          && exclusion.toLocationId === destinationLocationId,
      )
    ) {
      return true;
    }
    return (
      this.blockInterStockpileHauling
      && this.stockpileLocationIds.has(lot.locationId)
      && this.stockpileLocationIds.has(destinationLocationId)
      && !this.sameStockpileLocationPairs.has(
        locationPairKey(lot.locationId, destinationLocationId),
      )
    );
  }

  private activityReservation(lotId: string, destinationLocationId?: number): number {
    const reservations = this.activityReservationsByLotId.get(lotId);
    if (!reservations) return 0;
    if (destinationLocationId !== undefined) return reservations.get(destinationLocationId) ?? 0;
    return [...reservations.values()].reduce((total, quantity) => total + quantity, 0);
  }

  /** Returns activity reservations on a lot that belong to other destinations. */
  private activityReservationsForOtherDestinations(
    lotId: string,
    destinationLocationId: number,
  ): number {
    return this.activityReservation(lotId) - this.activityReservation(lotId, destinationLocationId);
  }

  private stockpileReservation(lotId: string, destinationLocationId?: number): number {
    const reservations = this.stockpileReservationsByLotId.get(lotId);
    if (!reservations) return 0;
    if (destinationLocationId !== undefined) {
      return reservations.get(destinationLocationId) ?? 0;
    }
    return [...reservations.values()].reduce((total, quantity) => total + quantity, 0);
  }

  private totalProtectedReservation(lotId: string): number {
    return this.activityReservation(lotId) + this.stockpileReservation(lotId);
  }

  private consumeActivityReservation(
    lotId: string,
    destinationLocationId: number,
    quantity: number,
  ): void {
    const reservations = this.activityReservationsByLotId.get(lotId);
    const reserved = reservations?.get(destinationLocationId) ?? 0;
    if (!reservations || reserved <= quantity) {
      reservations?.delete(destinationLocationId);
      if (reservations?.size === 0) this.activityReservationsByLotId.delete(lotId);
      return;
    }
    reservations.set(destinationLocationId, reserved - quantity);
  }

  private consumeStockpileReservation(
    lotId: string,
    quantity: number,
    destinationLocationId?: number,
    excludedDestinationLocationId?: number,
  ): void {
    if (destinationLocationId !== undefined) {
      this.consumeStockpileReservationEntry(lotId, destinationLocationId, quantity);
      return;
    }
    this.consumeStockpileReservationEntries(lotId, quantity, excludedDestinationLocationId);
  }

  private addActivityReservation(
    lotId: string,
    destinationLocationId: number,
    quantity: number,
  ): void {
    const reservations = this.activityReservationsByLotId.get(lotId) ?? new Map();
    reservations.set(
      destinationLocationId,
      (reservations.get(destinationLocationId) ?? 0) + quantity,
    );
    this.activityReservationsByLotId.set(lotId, reservations);
  }

  private addStockpileReservation(
    lotId: string,
    destinationLocationId: number,
    quantity: number,
  ): void {
    const reservations = this.stockpileReservationsByLotId.get(lotId) ?? new Map();
    reservations.set(
      destinationLocationId,
      (reservations.get(destinationLocationId) ?? 0) + quantity,
    );
    this.stockpileReservationsByLotId.set(lotId, reservations);
  }

  private addPendingDemand(
    demands: Map<string, PendingItemDemand>,
    typeId: number,
    destinationLocationId: number,
    quantity: number,
  ): void {
    if (quantity <= 0) return;
    const key = `${typeId}:${destinationLocationId}`;
    const demand = demands.get(key);
    demands.set(
      key,
      {
        typeId,
        destinationLocationId,
        quantity: (demand?.quantity ?? 0) + quantity,
      },
    );
  }

  private sortedPendingDemands(demands: Map<string, PendingItemDemand>): PendingItemDemand[] {
    return [...demands.values()].sort(
      (left, right) =>
        left.typeId - right.typeId || left.destinationLocationId - right.destinationLocationId,
    );
  }

  private consumeStockpileReservationEntry(
    lotId: string,
    destinationLocationId: number,
    quantity: number,
  ): void {
    const reservations = this.stockpileReservationsByLotId.get(lotId);
    const reserved = reservations?.get(destinationLocationId) ?? 0;
    if (!reservations || reserved <= quantity) {
      reservations?.delete(destinationLocationId);
      if (reservations?.size === 0) this.stockpileReservationsByLotId.delete(lotId);
      return;
    }
    reservations.set(destinationLocationId, reserved - quantity);
  }

  private consumeStockpileReservationEntries(
    lotId: string,
    quantity: number,
    excludedDestinationLocationId?: number,
  ): void {
    let remaining = quantity;
    const reservations = this.stockpileReservationsByLotId.get(lotId);
    if (!reservations) return;
    for (const [destinationLocationId] of [...reservations].sort(
      ([left], [right]) => left - right,
    )) {
      if (remaining <= 0) break;
      if (destinationLocationId === excludedDestinationLocationId) continue;
      const reserved = reservations.get(destinationLocationId) ?? 0;
      const consumed = Math.min(remaining, reserved);
      this.consumeStockpileReservationEntry(lotId, destinationLocationId, consumed);
      remaining -= consumed;
    }
  }

  private blueprintHorizon(
    lot: SimulatorBlueprintLot,
    destinationLocationId: number,
  ): "now" | "after-hauling" | "after-upstream" {
    if (lot.horizon === "after-upstream") return "after-upstream";
    return lot.locationId === destinationLocationId ? "now" : "after-hauling";
  }

  private recordBlueprintHaul(
    lot: SimulatorBlueprintLot,
    destinationLocationId: number,
    demandingJobId: string,
  ): void {
    if (
      lot.horizon !== "now"
      || lot.locationId === undefined
      || lot.locationId === destinationLocationId
      || this.transferredBlueprintLotIds.has(lot.lotId)
    ) return;
    const pseudoItem: SimulationItemLot = {
      lotId: lot.lotId,
      typeId: lot.typeId,
      locationId: lot.locationId,
      ownerType: lot.ownerType,
      ownerId: lot.ownerId,
      name: lot.name,
      quantity: 1,
      unitVolume: 0.01,
      horizon: "now",
      source: "asset",
      eligibleForReprocessing: false,
    };
    if (this.isExcluded(pseudoItem, destinationLocationId)) return;
    this.transferredBlueprintLotIds.add(lot.lotId);
    this.haulingTasks.push({
      transferId: `haul:${lot.lotId}:${destinationLocationId}:${demandingJobId}`,
      lotId: lot.lotId,
      typeId: lot.typeId,
      typeName: lot.name,
      blueprintKind: lot.kind,
      quantity: 1,
      unitVolume: 0.01,
      fromLocationId: lot.locationId,
      toLocationId: destinationLocationId,
      ownerType: lot.ownerType,
      ownerId: lot.ownerId,
      purpose: "industry-input",
      demands: [{ jobId: demandingJobId, quantity: 1 }],
    });
  }

  /** Posts a finite BPC transfer in licensed-run units, including future output. */
  private recordBlueprintTransfer(
    lot: SimulatorBlueprintLot,
    destinationLocationId: number,
    quantity: number,
    demandingJobId: string,
  ): void {
    if (
      lot.kind !== "bpc"
      || quantity <= 0
      || lot.locationId === undefined
      || lot.locationId === destinationLocationId
    ) return;
    if (lot.horizon === "after-upstream") {
      if (lot.activity !== "copying" && lot.activity !== "invention") return;
      this.transactions.push({
        id: this.nextTransactionId("blueprint-production-commitment"),
        kind: "production-commitment",
        account: { locationId: lot.locationId, typeId: lot.typeId },
        destinationAccount: { locationId: destinationLocationId, typeId: lot.typeId },
        quantity,
        quantityKind: "blueprint-run",
        source: lot.activity,
        sourceLotId: lot.lotId,
        producingJobId:
          lot.industryJobId === undefined ? demandingJobId : String(lot.industryJobId),
      });
      return;
    }
    this.transactions.push({
      id: this.nextTransactionId("blueprint-transfer"),
      kind: "transfer-commitment",
      sourceAccount: { locationId: lot.locationId, typeId: lot.typeId },
      destinationAccount: { locationId: destinationLocationId, typeId: lot.typeId },
      lotId: lot.lotId,
      quantity,
      quantityKind: "blueprint-run",
      demandingJobId,
    });
  }

  private nextTransactionId(prefix: string): string {
    this.transactionSequence += 1;
    return `${prefix}:${this.transactionSequence}`;
  }
}
