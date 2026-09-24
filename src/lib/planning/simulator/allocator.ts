import type { PlanStockpile } from "@/lib/planning/types";
import type { SimulationLedgerAccount, SimulationTransaction } from "./ledger";
import type { SimulatorBlueprintLot, SimulatorInventory, SimulationItemLot } from "./sourceLots";
import type {
  HaulingAllocationMode,
  SimulationBlueprintAllocation,
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
  private readonly haulingAllocationMode: HaulingAllocationMode;
  private readonly localDemandReservations = new Map<string, number>();
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
    haulingAllocationMode: HaulingAllocationMode = "local-first",
  ) {
    const routePolicy = stockpileRoutePolicy(stockpiles);
    this.stockpileLocationIds = routePolicy.stockpileLocationIds;
    this.sameStockpileLocationPairs = routePolicy.sameStockpileLocationPairs;
    this.blockInterStockpileHauling = blockInterStockpileHauling;
    this.haulingAllocationMode = haulingAllocationMode;
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
      const quantity = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      if (quantity <= 0) continue;
      if (lot.horizon === "after-upstream") {
        if (lot.locationId === destinationLocationId) future += quantity;
        continue;
      }
      else if (lot.locationId === destinationLocationId) local += quantity;
      else if (lot.locationId !== undefined && !this.isExcluded(lot, destinationLocationId)) {
        const protectedQuantity =
          this.localDemandReservations.get(this.localDemandKey(lot.typeId, lot.locationId)) ?? 0;
        remote += Math.max(0, quantity - protectedQuantity);
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
  ): number {
    return this.claimItemLots(
      (this.itemLotsByTypeId.get(typeId) ?? []).filter(
        (lot) =>
          lot.typeId === typeId
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
  ): number {
    return this.claimItemLots(
      (this.itemLotsByTypeId.get(typeId) ?? []).filter(
        (lot) =>
          lot.typeId === typeId
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
      true,
    );
  }

  /** Reserves local source quantity for demand discovered during recursive expansion. */
  reserveLocalDemand(typeId: number, quantity: number, locationId: number): void {
    if (this.haulingAllocationMode !== "local-first" || quantity <= 0) return;
    const key = this.localDemandKey(typeId, locationId);
    this.localDemandReservations.set(key, (this.localDemandReservations.get(key) ?? 0) + quantity);
  }

  /** Claims existing active-job output without treating it as physical stock. */
  claimFuture(
    typeId: number,
    quantity: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
  ): FutureClaim {
    let remaining = quantity;
    let claimed = 0;
    const reservations: SimulationUpstreamReservation[] = [];
    for (const lot of (this.itemLotsByTypeId.get(typeId) ?? []).filter(
      (candidate) =>
        candidate.horizon === "after-upstream" && candidate.locationId === account.locationId,
    )) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const next = Math.min(remaining, available);
      if (next <= 0) continue;
      this.remainingItemQuantityByLotId.set(lot.lotId, available - next);
      this.transactions.push({
        id: this.nextTransactionId("existing-output"),
        kind: "production-commitment",
        account,
        destinationAccount: account,
        quantity: next,
        source: "production",
        producingJobId:
          lot.industryJobId === undefined
            ? (demandingJobId ?? `existing:${lot.lotId}`)
            : String(lot.industryJobId),
      });
      remaining -= next;
      claimed += next;
      if (lot.activity) {
        reservations.push({
          activity: lot.activity,
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
  ): ItemClaim {
    let local: number;
    let remote: number;
    if (this.haulingAllocationMode === "greedy") {
      remote = this.claimRemote(
        typeId,
        quantity,
        destinationLocationId,
        account,
        demandingJobId,
        stockpileId,
        demandActivity,
      );
      local = this.claimLocal(
        typeId,
        quantity - remote,
        destinationLocationId,
        account,
        demandingJobId,
        "now",
        stockpileId,
        demandActivity,
      );
    }
    else {
      local = this.claimLocal(
        typeId,
        quantity,
        destinationLocationId,
        account,
        demandingJobId,
        "now",
        stockpileId,
        demandActivity,
      );
      remote = this.claimRemote(
        typeId,
        quantity - local,
        destinationLocationId,
        account,
        demandingJobId,
        stockpileId,
        demandActivity,
      );
    }
    const futureClaim = this.claimFuture(
      typeId,
      quantity - local - remote,
      account,
      demandingJobId,
    );
    return {
      local,
      remote,
      future: futureClaim.quantity,
      futureReservations: futureClaim.reservations,
    };
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
        });
        this.transactions.push({
          id: this.nextTransactionId("blueprint"),
          kind: "blueprint-run-reservation",
          account,
          blueprintLotId: lot.lotId,
          quantity: nextRuns,
          demandingJobId,
        });
        allocatedRuns -= nextRuns;
        remainingRuns -= nextRuns;
      }
      if (lot.kind === "bpc") {
        const runsAllocatedFromLot = remainingRunsBeforeLot - remainingRuns;
        this.remainingBlueprintRunsByLotId.set(lot.lotId, availableRuns - runsAllocatedFromLot);
      }
      this.recordBlueprintHaul(lot, destinationLocationId, demandingJobId);
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
      });
      this.transactions.push({
        id: this.nextTransactionId("blueprint-copy"),
        kind: "blueprint-run-reservation",
        account,
        blueprintLotId: copy.lotId,
        quantity: claimedRuns,
        demandingJobId,
      });
      this.recordBlueprintHaul(copy, destinationLocationId, demandingJobId);
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
    if (!lot || !lot.eligibleForReprocessing || quantity <= 0) return 0;
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
    protectLocalDemand = false,
  ): number {
    let remaining = quantity;
    let claimed = 0;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const protectedQuantity =
        protectLocalDemand && lot.locationId !== undefined
          ? (this.localDemandReservations.get(this.localDemandKey(lot.typeId, lot.locationId)) ?? 0)
          : 0;
      const usable = Math.max(0, available - protectedQuantity);
      const next = Math.min(remaining, usable);
      if (next <= 0) continue;
      this.remainingItemQuantityByLotId.set(lot.lotId, available - next);
      if (!protectLocalDemand && lot.locationId !== undefined) {
        this.consumeLocalDemandReservation(lot.typeId, lot.locationId, next);
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
          purpose: "industry-input",
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

  private localDemandKey(typeId: number, locationId: number): string {
    return `${typeId}:${locationId}`;
  }

  private consumeLocalDemandReservation(
    typeId: number,
    locationId: number,
    quantity: number,
  ): void {
    if (this.haulingAllocationMode !== "local-first") return;
    const key = this.localDemandKey(typeId, locationId);
    const remaining = this.localDemandReservations.get(key) ?? 0;
    if (remaining <= quantity) this.localDemandReservations.delete(key);
    else this.localDemandReservations.set(key, remaining - quantity);
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
      ...lot,
      name: lot.name,
      quantity: 1,
      unitVolume: 0.01,
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

  private nextTransactionId(prefix: string): string {
    this.transactionSequence += 1;
    return `${prefix}:${this.transactionSequence}`;
  }
}
