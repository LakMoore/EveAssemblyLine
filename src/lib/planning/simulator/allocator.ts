import type { PlanHaulExclusion } from "@/lib/planning/types";
import type { SimulationLedgerAccount, SimulationTransaction } from "./ledger";
import type { SimulatorBlueprintLot, SimulatorInventory, SimulatorItemLot } from "./sourceLots";
import type { SimulationBlueprintAllocation, SimulationHaulTask, SimulatorActivity } from "./types";

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
}

/** Blueprint allocation with the horizon at which the print becomes usable. */
export interface BlueprintClaim extends SimulationBlueprintAllocation {
  horizon: "now" | "after-hauling" | "after-upstream";
  lotId?: string;
}

function excluded(
  exclusions: readonly PlanHaulExclusion[],
  lot: Pick<SimulatorItemLot, "typeId" | "locationId" | "ownerType" | "ownerId">,
  destinationLocationId: number,
): boolean {
  if (lot.locationId === undefined) return true;
  return exclusions.some(
    (exclusion) =>
      exclusion.typeId === lot.typeId
      && exclusion.fromLocationId === lot.locationId
      && exclusion.toLocationId === destinationLocationId
      && (
        exclusion.ownerType === undefined
        || (exclusion.ownerType === lot.ownerType && exclusion.ownerId === lot.ownerId)
      ),
  );
}

/** Deterministically allocates ordinary lots and blueprint runs without duplicating stock. */
export class SimulationAllocator {
  private readonly remainingItemQuantityByLotId: Map<string, number>;
  private readonly remainingBlueprintRunsByLotId: Map<string, number>;
  private readonly transferredBlueprintLotIds = new Set<string>();
  private transactionSequence = 0;
  readonly transactions: SimulationTransaction[] = [];
  readonly haulingTasks: SimulationHaulTask[] = [];

  /** Creates an allocator over one immutable inventory snapshot. */
  constructor(
    private readonly inventory: SimulatorInventory,
    private readonly haulExclusions: readonly PlanHaulExclusion[],
  ) {
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
    for (const lot of this.inventory.itemLots) {
      if (lot.typeId !== typeId) continue;
      const quantity = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      if (quantity <= 0) continue;
      if (lot.horizon === "after-upstream") future += quantity;
      else if (lot.locationId === destinationLocationId) local += quantity;
      else if (!excluded(this.haulExclusions, lot, destinationLocationId)) remote += quantity;
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
    demandActivity?: Exclude<SimulatorActivity, "surplus">,
  ): number {
    return this.claimItemLots(
      this.inventory.itemLots.filter(
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
    demandActivity?: Exclude<SimulatorActivity, "surplus">,
  ): number {
    return this.claimItemLots(
      this.inventory.itemLots.filter(
        (lot) =>
          lot.typeId === typeId
          && lot.horizon === "now"
          && lot.locationId !== destinationLocationId
          && !excluded(this.haulExclusions, lot, destinationLocationId),
      ),
      quantity,
      destinationLocationId,
      account,
      demandingJobId,
      "after-hauling",
      stockpileId,
      demandActivity,
    );
  }

  /** Claims existing active-job output without treating it as physical stock. */
  claimFuture(
    typeId: number,
    quantity: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
  ): number {
    let remaining = quantity;
    let claimed = 0;
    for (const lot of this.sortedItemLots(
      this.inventory.itemLots.filter(
        (candidate) => candidate.typeId === typeId && candidate.horizon === "after-upstream",
      ),
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
        producingJobId: demandingJobId ?? `existing:${lot.lotId}`,
      });
      remaining -= next;
      claimed += next;
    }
    return claimed;
  }

  /** Claims a target quantity across local, remote, then existing future output. */
  claimOrdinarySupply(
    typeId: number,
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId?: string,
    stockpileId?: string,
    demandActivity?: Exclude<SimulatorActivity, "surplus">,
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
    );
    const remote = this.claimRemote(
      typeId,
      quantity - local,
      destinationLocationId,
      account,
      demandingJobId,
      stockpileId,
      demandActivity,
    );
    const future = this.claimFuture(typeId, quantity - local - remote, account, demandingJobId);
    return { local, remote, future };
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
      .filter((lot) => lot.typeId === blueprintTypeId && lot.kind !== "formula" && !lot.inUse)
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
      .filter((lot) => lot.typeId === formulaTypeId && lot.kind === "formula" && !lot.inUse)
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
      .filter((lot) => lot.typeId === blueprintTypeId && lot.kind === "bpc" && !lot.inUse)
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
      .filter((lot) => lot.typeId === blueprintTypeId && lot.kind === "bpo" && !lot.inUse)
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
    if (
      lot.locationId !== destinationLocationId
      && excluded(this.haulExclusions, lot, destinationLocationId)
    ) return 0;
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
      });
    }
    return claimed;
  }

  private claimItemLots(
    lots: readonly SimulatorItemLot[],
    quantity: number,
    destinationLocationId: number,
    account: SimulationLedgerAccount,
    demandingJobId: string | undefined,
    reservationHorizon: "now" | "after-hauling",
    stockpileId?: string,
    demandActivity?: Exclude<SimulatorActivity, "surplus">,
  ): number {
    let remaining = quantity;
    let claimed = 0;
    for (const lot of this.sortedItemLots(lots)) {
      if (remaining <= 0) break;
      const available = this.remainingItemQuantityByLotId.get(lot.lotId) ?? 0;
      const next = Math.min(remaining, available);
      if (next <= 0) continue;
      this.remainingItemQuantityByLotId.set(lot.lotId, available - next);
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
        });
      }
      remaining -= next;
      claimed += next;
    }
    return claimed;
  }

  private sortedItemLots(lots: readonly SimulatorItemLot[]): SimulatorItemLot[] {
    return lots.slice().sort((left, right) => left.lotId.localeCompare(right.lotId));
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
    const pseudoItem: SimulatorItemLot = {
      ...lot,
      name: lot.name,
      quantity: 1,
      unitVolume: 0.01,
      source: "asset",
      eligibleForReprocessing: false,
    };
    if (excluded(this.haulExclusions, pseudoItem, destinationLocationId)) return;
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
    });
  }

  private nextTransactionId(prefix: string): string {
    this.transactionSequence += 1;
    return `${prefix}:${this.transactionSequence}`;
  }
}
