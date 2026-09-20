import type {
  SimulationDemandSource,
  SimulationMaterialBalance,
  SimulatorActivity,
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

/** Exact identity of one projected ledger account. */
export interface SimulationLedgerAccount {
  activity: SimulatorActivity;
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
      account: SimulationLedgerAccount;
      lotId: string;
      quantity: number;
      fromLocationId: number;
      toLocationId: number;
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
  return `${account.activity}:${account.locationId}:${account.typeId}`;
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
    required: 0,
    availableNow: 0,
    availableAfterHauling: 0,
    availableFromProduction: 0,
    availableFromCopying: 0,
    availableFromInvention: 0,
    availableFromReprocessing: 0,
    transferredOut: 0,
    reservedNow: 0,
    reservedAfterHauling: 0,
    unreserved: 0,
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
      else balance.availableAfterHauling += transaction.quantity;
    }
    else if (transaction.kind === "demand") {
      balance.required += transaction.quantity;
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
        balance.availableNow += transaction.quantity;
        balance.reservedNow += transaction.quantity;
      }
      else {
        balance.availableAfterHauling += transaction.quantity;
        balance.reservedAfterHauling += transaction.quantity;
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
    else {
      // These retain provenance; material supply is projected by the paired reservation.
      const provenanceOnly: Extract<
        SimulationTransaction,
        {
          kind: "purchase-requirement" | "blueprint-run-reservation" | "transfer-commitment";
        }
      > = transaction;
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
    const accountedQuantity =
      (reservedByLotId.get(lot.lotId) ?? 0) + (exposedByLotId.get(lot.lotId) ?? 0);
    if (accountedQuantity > lot.quantity) {
      invariantViolations.push(
        `Source lot ${lot.lotId} exposed or reserved ${accountedQuantity - lot.quantity} excess units.`,
      );
    }
  }

  const balances = new Map(
    [...mutableBalances].map(([key, balance]) => {
      const physicalAvailable = balance.availableNow + balance.availableAfterHauling;
      const nonPurchaseSupply =
        physicalAvailable
        + balance.availableFromProduction
        + balance.availableFromCopying
        + balance.availableFromInvention
        + balance.availableFromReprocessing;
      const finalized = Object.freeze({
        ...balance,
        demandSources: [...balance.demandSources],
        unreserved: Math.max(
          0,
          physicalAvailable - balance.reservedNow - balance.reservedAfterHauling,
        ),
        unsatisfied: Math.max(0, balance.required - nonPurchaseSupply),
        surplus: Math.max(0, nonPurchaseSupply - balance.required - balance.transferredOut),
      });
      if (finalized.reservedNow > finalized.availableNow) {
        invariantViolations.push(`Account ${key} reserved more local stock than was available.`);
      }
      if (
        finalized.reservedNow + finalized.reservedAfterHauling
        > finalized.availableNow + finalized.availableAfterHauling
      ) {
        invariantViolations.push(`Account ${key} reserved more physical stock than was available.`);
      }
      return [key, finalized] as const;
    }),
  );

  return Object.freeze({
    balances,
    reservedByLotId,
    invariantViolations: Object.freeze(invariantViolations),
  });
}
