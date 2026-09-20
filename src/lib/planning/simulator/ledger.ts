import type {
  SimulationDemandSource,
  SimulationMaterialBalance,
  SimulationActivity,
  SupplyHorizon,
} from "./types";

/** Immutable physical source lot from which reservations may be made. */
export interface SimulationSourceLot {
  lotId: string;
  typeId: number;
  quantity: number;
  locationId?: number;
  ownerType?: "character" | "corporation";
  ownerId?: number;
}

/** Exact identity of one physical material ledger account. */
export interface SimulationLedgerAccount {
  locationId: number;
  typeId: number;
}

/** Append-only facts from which all simulator balances are projected. */
export type SimulationTransaction =
  | {
      id: string;
      kind: "source-availability";
      account: SimulationLedgerAccount;
      lotId: string;
      quantity: number;
      horizon: Extract<SupplyHorizon, "now" | "after-hauling">;
    }
  | {
      id: string;
      kind: "demand";
      account: SimulationLedgerAccount;
      quantity: number;
      source: SimulationDemandSource;
    }
  | {
      id: string;
      kind: "source-reservation";
      account: SimulationLedgerAccount;
      lotId: string;
      quantity: number;
      horizon: Extract<SupplyHorizon, "now" | "after-hauling">;
      demandingJobId?: string;
      stockpileId?: string;
      demandActivity?: Exclude<SimulationActivity, "surplus">;
    }
  | {
      id: string;
      kind: "production-commitment";
      account: SimulationLedgerAccount;
      destinationAccount: SimulationLedgerAccount;
      quantity: number;
      source: "production" | "copying" | "invention";
      producingJobId: string;
    }
  | {
      id: string;
      kind: "reprocessing-output";
      account: SimulationLedgerAccount;
      destinationAccount?: SimulationLedgerAccount;
      quantity: number;
      reprocessingJobId: string;
    }
  | {
      id: string;
      kind: "purchase-requirement";
      account: SimulationLedgerAccount;
      quantity: number;
      demandingJobId?: string;
    }
  | {
      id: string;
      kind: "blueprint-run-reservation";
      account: SimulationLedgerAccount;
      blueprintLotId: string;
      quantity: number;
      demandingJobId: string;
    }
  | {
      id: string;
      kind: "transfer-commitment";
      sourceAccount: SimulationLedgerAccount;
      destinationAccount: SimulationLedgerAccount;
      lotId: string;
      quantity: number;
      demandingJobId?: string;
    };

/** Reduced ledger data together with source-conservation diagnostics. */
export interface SimulationLedgerProjection {
  balances: ReadonlyMap<string, SimulationMaterialBalance>;
  reservedByLotId: ReadonlyMap<string, number>;
  invariantViolations: readonly string[];
}

/** Produces the stable string identity for a simulator ledger account. */
export function simulationAccountKey(account: SimulationLedgerAccount): string {
  return `${account.locationId}:${account.typeId}`;
}

function emptyBalance(
  account: SimulationLedgerAccount,
  typeName: string,
  unitVolume: number,
): SimulationMaterialBalance {
  return {
    typeId: account.typeId,
    typeName,
    unitVolume,
    locationId: account.locationId,
    requiredNow: 0,
    reserved: 0,
    availableNow: 0,
    availableFromHauling: 0,
    availableFromProduction: 0,
    availableFromCopying: 0,
    availableFromInvention: 0,
    availableFromReprocessing: 0,
    availableFromMarket: 0,
    transferredOut: 0,
    unsatisfied: 0,
    surplus: 0,
    demandSources: [],
  };
}

/** Reduces transactions into balances and verifies source-lot conservation. */
export function projectSimulationLedger(
  sourceLots: readonly SimulationSourceLot[],
  transactions: readonly SimulationTransaction[],
  names: ReadonlyMap<number, string> = new Map(),
  volumes: ReadonlyMap<number, number> = new Map(),
): SimulationLedgerProjection {
  const sourceLotsById = new Map(sourceLots.map((lot) => [lot.lotId, lot]));
  const reservedByLotId = new Map<string, number>();
  const exposedByLotId = new Map<string, number>();
  const mutableBalances = new Map<string, SimulationMaterialBalance>();
  const invariantViolations: string[] = [];

  for (const transaction of transactions) {
    if (!Number.isSafeInteger(transaction.quantity) || transaction.quantity < 0) {
      invariantViolations.push(`Transaction ${transaction.id} has an invalid quantity.`);
      continue;
    }
    if (transaction.kind === "transfer-commitment") {
      const sourceKey = simulationAccountKey(transaction.sourceAccount);
      const source =
        mutableBalances.get(sourceKey)
        ?? emptyBalance(
          transaction.sourceAccount,
          names.get(transaction.sourceAccount.typeId) ?? `Type ${transaction.sourceAccount.typeId}`,
          volumes.get(transaction.sourceAccount.typeId) ?? 0,
        );
      const destinationKey = simulationAccountKey(transaction.destinationAccount);
      const destination =
        mutableBalances.get(destinationKey)
        ?? emptyBalance(
          transaction.destinationAccount,
          names.get(transaction.destinationAccount.typeId)
            ?? `Type ${transaction.destinationAccount.typeId}`,
          volumes.get(transaction.destinationAccount.typeId) ?? 0,
        );
      source.transferredOut += transaction.quantity;
      destination.availableFromHauling += transaction.quantity;
      mutableBalances.set(sourceKey, source);
      mutableBalances.set(destinationKey, destination);
      continue;
    }
    const key = simulationAccountKey(transaction.account);
    const balance =
      mutableBalances.get(key)
      ?? emptyBalance(
        transaction.account,
        names.get(transaction.account.typeId) ?? `Type ${transaction.account.typeId}`,
        volumes.get(transaction.account.typeId) ?? 0,
      );
    if (transaction.kind === "source-availability") {
      const lot = sourceLotsById.get(transaction.lotId);
      if (!lot || lot.typeId !== transaction.account.typeId) {
        invariantViolations.push(
          `Availability ${transaction.id} references an invalid source lot.`,
        );
        continue;
      }
      exposedByLotId.set(
        transaction.lotId,
        (exposedByLotId.get(transaction.lotId) ?? 0) + transaction.quantity,
      );
      if (transaction.horizon === "now") balance.availableNow += transaction.quantity;
      else balance.availableFromHauling += transaction.quantity;
    }
    else if (transaction.kind === "demand") {
      if (
        transaction.quantity !== transaction.source.plannedQuantity
        || transaction.account.typeId !== transaction.source.materialTypeId
        || transaction.source.requiredNow + transaction.source.reserved
          !== transaction.source.plannedQuantity
      ) {
        invariantViolations.push(`Demand ${transaction.id} has inconsistent readiness quantities.`);
        continue;
      }
      balance.requiredNow += transaction.source.requiredNow;
      balance.reserved += transaction.source.reserved;
      balance.demandSources.push(transaction.source);
    }
    else if (transaction.kind === "source-reservation") {
      const lot = sourceLotsById.get(transaction.lotId);
      if (!lot || lot.typeId !== transaction.account.typeId) {
        invariantViolations.push(`Reservation ${transaction.id} references an invalid source lot.`);
        continue;
      }
      reservedByLotId.set(
        transaction.lotId,
        (reservedByLotId.get(transaction.lotId) ?? 0) + transaction.quantity,
      );
      if (transaction.horizon === "now") {
        // Local reservations consume availability already posted from the source lot.
      }
      else {
        // The paired transfer commitment posts the inbound hauled quantity.
      }
    }
    else if (transaction.kind === "production-commitment") {
      const destinationKey = simulationAccountKey(transaction.destinationAccount);
      const destination =
        mutableBalances.get(destinationKey)
        ?? emptyBalance(
          transaction.destinationAccount,
          names.get(transaction.destinationAccount.typeId)
            ?? `Type ${transaction.destinationAccount.typeId}`,
          volumes.get(transaction.destinationAccount.typeId) ?? 0,
        );
      switch (transaction.source) {
      case "production":
        balance.availableFromProduction += transaction.quantity;
        if (destinationKey !== key) destination.availableFromProduction += transaction.quantity;
        break;
      case "copying":
        balance.availableFromCopying += transaction.quantity;
        if (destinationKey !== key) destination.availableFromCopying += transaction.quantity;
        break;
      case "invention":
        balance.availableFromInvention += transaction.quantity;
        if (destinationKey !== key) destination.availableFromInvention += transaction.quantity;
        break;
      }
      if (destinationKey !== key) balance.transferredOut += transaction.quantity;
      mutableBalances.set(destinationKey, destination);
    }
    else if (transaction.kind === "reprocessing-output") {
      balance.availableFromReprocessing += transaction.quantity;
      if (transaction.destinationAccount) {
        const destinationKey = simulationAccountKey(transaction.destinationAccount);
        if (destinationKey !== key) {
          const destination =
            mutableBalances.get(destinationKey)
            ?? emptyBalance(
              transaction.destinationAccount,
              names.get(transaction.destinationAccount.typeId)
                ?? `Type ${transaction.destinationAccount.typeId}`,
              volumes.get(transaction.destinationAccount.typeId) ?? 0,
            );
          destination.availableFromReprocessing += transaction.quantity;
          balance.transferredOut += transaction.quantity;
          mutableBalances.set(destinationKey, destination);
        }
      }
    }
    else if (transaction.kind === "purchase-requirement") {
      balance.availableFromMarket += transaction.quantity;
    }
    else {
      // Blueprint reservations retain provenance but do not add material supply.
      const provenanceOnly: Extract<SimulationTransaction, { kind: "blueprint-run-reservation" }> =
        transaction;
      void provenanceOnly;
    }
    mutableBalances.set(key, balance);
  }

  for (const [lotId, reservedQuantity] of reservedByLotId) {
    const lot = sourceLotsById.get(lotId);
    if (lot && reservedQuantity > lot.quantity) {
      invariantViolations.push(
        `Source lot ${lotId} was over-reserved by ${reservedQuantity - lot.quantity}.`,
      );
    }
  }
  for (const lot of sourceLots) {
    const exposedQuantity = exposedByLotId.get(lot.lotId) ?? 0;
    if (exposedQuantity > lot.quantity) {
      invariantViolations.push(
        `Source lot ${lot.lotId} exposed ${exposedQuantity - lot.quantity} excess units.`,
      );
    }
  }

  const balances = new Map(
    [...mutableBalances].map(([key, balance]) => {
      const plannedRequirement = balance.requiredNow + balance.reserved;
      const physicalAvailable = balance.availableNow + balance.availableFromHauling;
      const plannedSupply =
        physicalAvailable
        + balance.availableFromProduction
        + balance.availableFromCopying
        + balance.availableFromInvention
        + balance.availableFromReprocessing
        + balance.availableFromMarket;
      const finalized = Object.freeze({
        ...balance,
        demandSources: [...balance.demandSources],
        unsatisfied: Math.max(0, plannedRequirement - plannedSupply),
        surplus: Math.max(0, plannedSupply - plannedRequirement - balance.transferredOut),
      });
      return [key, finalized] as const;
    }),
  );

  return Object.freeze({
    balances,
    reservedByLotId,
    invariantViolations: Object.freeze(invariantViolations),
  });
}
