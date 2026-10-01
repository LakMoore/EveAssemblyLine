import type {
  SimulationDemandSource,
  SimulationMaterialBalance,
  SimulationActivity,
  SimulationQuantityKind,
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
  quantityKind?: SimulationQuantityKind;
  activity?: "manufacturing" | "reaction" | "copying" | "invention";
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
      source?: "asset" | "market-order";
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
      kind: "demand-readiness";
      account: SimulationLedgerAccount;
      demandId: string;
      quantity: number;
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
  | (
      | {
          id: string;
          kind: "production-commitment";
          account: SimulationLedgerAccount;
          destinationAccount: SimulationLedgerAccount;
          quantity: number;
          quantityKind?: "item";
          source: "production";
          activity: "manufacturing" | "reaction";
          sourceLotId?: string;
          producingJobId: string;
        }
      | {
          id: string;
          kind: "production-commitment";
          account: SimulationLedgerAccount;
          destinationAccount: SimulationLedgerAccount;
          quantity: number;
          quantityKind: "blueprint-run";
          source: "copying" | "invention";
          sourceLotId?: string;
          producingJobId: string;
        }
    )
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
      horizon?: Extract<SupplyHorizon, "now" | "after-hauling" | "after-upstream">;
    }
  | {
      id: string;
      kind: "transfer-commitment";
      sourceAccount: SimulationLedgerAccount;
      destinationAccount: SimulationLedgerAccount;
      lotId: string;
      quantity: number;
      quantityKind?: SimulationQuantityKind;
      horizon?: "after-upstream";
      outputSource?: "production" | "copying" | "invention" | "reprocessing";
      activity?: "manufacturing" | "reaction";
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

/** Produces a ledger key that keeps physical items separate from licensed blueprint runs. */
function quantityLedgerKey(account: SimulationLedgerAccount, quantityKind: SimulationQuantityKind) {
  return quantityKind === "item"
    ? simulationAccountKey(account)
    : `${simulationAccountKey(account)}:${quantityKind}`;
}

function emptyBalance(
  account: SimulationLedgerAccount,
  typeName: string,
  unitVolume: number,
  quantityKind: SimulationQuantityKind = "item",
): SimulationMaterialBalance {
  return {
    typeId: account.typeId,
    typeName,
    unitVolume,
    locationId: account.locationId,
    quantityKind,
    requiredNow: 0,
    reserved: 0,
    futureDemand: 0,
    futureSupply: 0,
    availableNow: 0,
    availableFromSellOrders: 0,
    availableFromHauling: 0,
    inFlightQuantity: 0,
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

function setProductionActivity(
  balance: SimulationMaterialBalance,
  activity: "manufacturing" | "reaction" | "copying" | "invention",
  invariantViolations: string[],
  sourceDescription: string,
): void {
  if (balance.activityType === undefined) {
    balance.activityType = activity;
    return;
  }
  if (balance.activityType !== activity) {
    invariantViolations.push(
      `Production row ${balance.locationId}:${balance.typeId} has mixed activity types at ${sourceDescription}.`,
    );
  }
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
  const claimedOutputByLotId = new Map<string, number>();
  const committedFutureOutputBySourceKey = new Map<string, number>();
  const exposedByLotId = new Map<string, number>();
  const mutableBalances = new Map<string, SimulationMaterialBalance>();
  const demandEntries = new Map<
    string,
    {
      account: SimulationLedgerAccount;
      source: SimulationDemandSource;
      balance: SimulationMaterialBalance;
    }
  >();
  const invariantViolations: string[] = [];

  for (const lot of sourceLots) {
    if (lot.locationId === undefined || lot.activity === undefined) continue;
    const account = { locationId: lot.locationId, typeId: lot.typeId };
    const key = quantityLedgerKey(account, lot.quantityKind ?? "item");
    const balance =
      mutableBalances.get(key)
      ?? emptyBalance(
        account,
        names.get(account.typeId) ?? `Type ${account.typeId}`,
        volumes.get(account.typeId) ?? 0,
        lot.quantityKind,
      );
    if (balance.quantityKind !== (lot.quantityKind ?? "item")) {
      invariantViolations.push(
        `Ledger row ${balance.locationId}:${balance.typeId} mixes item and blueprint-run quantities.`,
      );
      continue;
    }
    balance.inFlightQuantity += lot.quantity;
    setProductionActivity(balance, lot.activity, invariantViolations, `source lot ${lot.lotId}`);
    mutableBalances.set(key, balance);
  }

  for (const transaction of transactions) {
    if (!Number.isSafeInteger(transaction.quantity) || transaction.quantity < 0) {
      invariantViolations.push(`Transaction ${transaction.id} has an invalid quantity.`);
      continue;
    }
    if (transaction.kind === "transfer-commitment") {
      const sourceLot = sourceLotsById.get(transaction.lotId);
      const quantityKind = transaction.quantityKind ?? sourceLot?.quantityKind ?? "item";
      const sourceKey = quantityLedgerKey(transaction.sourceAccount, quantityKind);
      const source =
        mutableBalances.get(sourceKey)
        ?? emptyBalance(
          transaction.sourceAccount,
          names.get(transaction.sourceAccount.typeId) ?? `Type ${transaction.sourceAccount.typeId}`,
          volumes.get(transaction.sourceAccount.typeId) ?? 0,
          quantityKind,
        );
      const destinationKey = quantityLedgerKey(transaction.destinationAccount, quantityKind);
      const destination =
        mutableBalances.get(destinationKey)
        ?? emptyBalance(
          transaction.destinationAccount,
          names.get(transaction.destinationAccount.typeId)
            ?? `Type ${transaction.destinationAccount.typeId}`,
          volumes.get(transaction.destinationAccount.typeId) ?? 0,
          quantityKind,
        );
      if (source.quantityKind !== quantityKind || destination.quantityKind !== quantityKind) {
        invariantViolations.push(
          `Transfer ${transaction.id} mixes item and blueprint-run quantities.`,
        );
        continue;
      }
      if (transaction.horizon === "after-upstream") {
        if (sourceLot?.activity) {
          committedFutureOutputBySourceKey.set(
            sourceKey,
            (committedFutureOutputBySourceKey.get(sourceKey) ?? 0) + transaction.quantity,
          );
        }
        else source.transferredOut += transaction.quantity;
        if (transaction.outputSource === "production") {
          destination.availableFromProduction += transaction.quantity;
          if (transaction.activity) {
            setProductionActivity(
              destination,
              transaction.activity,
              invariantViolations,
              transaction.id,
            );
          }
        }
        else if (transaction.outputSource === "copying") {
          destination.availableFromCopying += transaction.quantity;
        }
        else if (transaction.outputSource === "invention") {
          destination.availableFromInvention += transaction.quantity;
        }
        else if (transaction.outputSource === "reprocessing") {
          destination.availableFromReprocessing += transaction.quantity;
        }
      }
      else {
        source.transferredOut += transaction.quantity;
        destination.availableFromHauling += transaction.quantity;
      }
      mutableBalances.set(sourceKey, source);
      mutableBalances.set(destinationKey, destination);
      continue;
    }
    if (transaction.kind === "demand-readiness") {
      const entry = demandEntries.get(transaction.demandId);
      if (
        !entry
        || entry.account.locationId !== transaction.account.locationId
        || entry.account.typeId !== transaction.account.typeId
        || transaction.quantity > entry.source.reserved
      ) {
        invariantViolations.push(
          `Readiness ${transaction.id} references an invalid demand or quantity.`,
        );
        continue;
      }
      entry.source.requiredNow += transaction.quantity;
      entry.source.reserved -= transaction.quantity;
      entry.balance.requiredNow += transaction.quantity;
      entry.balance.reserved -= transaction.quantity;
      continue;
    }
    const transactionQuantityKind =
      transaction.kind === "demand"
        ? (transaction.source.quantityKind ?? "item")
        : transaction.kind === "source-availability" || transaction.kind === "source-reservation"
          ? (sourceLotsById.get(transaction.lotId)?.quantityKind ?? "item")
          : transaction.kind === "production-commitment"
            ? (transaction.quantityKind ?? "item")
            : transaction.kind === "blueprint-run-reservation"
              ? "blueprint-run"
              : "item";
    const key = quantityLedgerKey(transaction.account, transactionQuantityKind);
    const hadBalance = mutableBalances.has(key);
    const balance =
      mutableBalances.get(key)
      ?? emptyBalance(
        transaction.account,
        names.get(transaction.account.typeId) ?? `Type ${transaction.account.typeId}`,
        volumes.get(transaction.account.typeId) ?? 0,
        transactionQuantityKind,
      );
    if (transaction.kind === "source-availability") {
      const lot = sourceLotsById.get(transaction.lotId);
      if (!lot || lot.typeId !== transaction.account.typeId) {
        invariantViolations.push(
          `Availability ${transaction.id} references an invalid source lot.`,
        );
        continue;
      }
      if (balance.quantityKind !== (lot.quantityKind ?? "item")) {
        invariantViolations.push(
          `Availability ${transaction.id} mixes item and blueprint-run quantities.`,
        );
        continue;
      }
      exposedByLotId.set(
        transaction.lotId,
        (exposedByLotId.get(transaction.lotId) ?? 0) + transaction.quantity,
      );
      if (transaction.horizon === "now" && transaction.source === "market-order") {
        balance.availableFromSellOrders += transaction.quantity;
      }
      else if (transaction.horizon === "now") balance.availableNow += transaction.quantity;
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
      if (balance.quantityKind !== (transaction.source.quantityKind ?? "item")) {
        invariantViolations.push(
          `Demand ${transaction.id} mixes item and blueprint-run quantities.`,
        );
        continue;
      }
      balance.requiredNow += transaction.source.requiredNow;
      balance.reserved += transaction.source.reserved;
      const projectedSource = { ...transaction.source };
      balance.demandSources.push(projectedSource);
      if (demandEntries.has(projectedSource.demandId)) {
        invariantViolations.push(`Demand ${transaction.id} reuses a demand identifier.`);
      }
      else {
        demandEntries.set(
          projectedSource.demandId,
          {
            account: transaction.account,
            source: projectedSource,
            balance,
          },
        );
      }
    }
    else if (transaction.kind === "source-reservation") {
      const lot = sourceLotsById.get(transaction.lotId);
      if (!lot || lot.typeId !== transaction.account.typeId) {
        invariantViolations.push(`Reservation ${transaction.id} references an invalid source lot.`);
        continue;
      }
      if (balance.quantityKind !== (lot.quantityKind ?? "item")) {
        invariantViolations.push(
          `Reservation ${transaction.id} mixes item and blueprint-run quantities.`,
        );
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
      const quantityKind = transaction.quantityKind ?? "item";
      if (transaction.sourceLotId !== undefined) {
        const sourceLot = sourceLotsById.get(transaction.sourceLotId);
        const sourceActivity =
          transaction.source === "production" ? transaction.activity : transaction.source;
        if (
          !sourceLot
          || sourceLot.typeId !== transaction.account.typeId
          || sourceLot.locationId !== transaction.account.locationId
          || sourceLot.activity !== sourceActivity
          || (sourceLot.quantityKind ?? "item") !== quantityKind
        ) {
          invariantViolations.push(
            `Future-output claim ${transaction.id} references an invalid source lot.`,
          );
          continue;
        }
        claimedOutputByLotId.set(
          transaction.sourceLotId,
          (claimedOutputByLotId.get(transaction.sourceLotId) ?? 0) + transaction.quantity,
        );
      }
      const destinationKey = quantityLedgerKey(transaction.destinationAccount, quantityKind);
      const destination =
        mutableBalances.get(destinationKey)
        ?? emptyBalance(
          transaction.destinationAccount,
          names.get(transaction.destinationAccount.typeId)
            ?? `Type ${transaction.destinationAccount.typeId}`,
          volumes.get(transaction.destinationAccount.typeId) ?? 0,
          quantityKind,
        );
      const isRemoteOutput = destinationKey !== key;
      if ((!isRemoteOutput || hadBalance) && balance.quantityKind !== quantityKind) {
        invariantViolations.push(
          `Production commitment ${transaction.id} mixes item and blueprint-run quantities.`,
        );
        continue;
      }
      if (destination.quantityKind !== quantityKind) {
        invariantViolations.push(
          `Production commitment ${transaction.id} mixes item and blueprint-run quantities.`,
        );
        continue;
      }
      const persistSourceBalance = !isRemoteOutput || hadBalance;
      if (transaction.sourceLotId !== undefined && isRemoteOutput) {
        committedFutureOutputBySourceKey.set(
          key,
          (committedFutureOutputBySourceKey.get(key) ?? 0) + transaction.quantity,
        );
      }
      if (
        transaction.source === "production"
        && (transaction.sourceLotId === undefined || isRemoteOutput)
      ) {
        const productionBalance = isRemoteOutput ? destination : balance;
        productionBalance.availableFromProduction += transaction.quantity;
        setProductionActivity(
          productionBalance,
          transaction.activity,
          invariantViolations,
          `production commitment ${transaction.id}`,
        );
      }
      else if (
        transaction.source === "copying"
        && (transaction.sourceLotId === undefined || isRemoteOutput)
      ) {
        if (isRemoteOutput) destination.availableFromCopying += transaction.quantity;
        else balance.availableFromCopying += transaction.quantity;
      }
      else if (
        transaction.source === "invention"
        && (transaction.sourceLotId === undefined || isRemoteOutput)
      ) {
        if (isRemoteOutput) destination.availableFromInvention += transaction.quantity;
        else balance.availableFromInvention += transaction.quantity;
      }
      mutableBalances.set(destinationKey, destination);
      if (!persistSourceBalance) continue;
    }
    else if (transaction.kind === "reprocessing-output") {
      const destinationKey = transaction.destinationAccount
        ? quantityLedgerKey(transaction.destinationAccount, "item")
        : key;
      if (destinationKey === key) {
        balance.availableFromReprocessing += transaction.quantity;
      }
      else if (transaction.destinationAccount) {
        const destination =
          mutableBalances.get(destinationKey)
          ?? emptyBalance(
            transaction.destinationAccount,
            names.get(transaction.destinationAccount.typeId)
              ?? `Type ${transaction.destinationAccount.typeId}`,
            volumes.get(transaction.destinationAccount.typeId) ?? 0,
          );
        destination.availableFromReprocessing += transaction.quantity;
        mutableBalances.set(destinationKey, destination);
        if (!hadBalance) continue;
      }
    }
    else if (transaction.kind === "purchase-requirement") {
      balance.availableFromMarket += transaction.quantity;
    }
    else {
      const blueprintLot = sourceLotsById.get(transaction.blueprintLotId);
      if (blueprintLot?.quantityKind === "blueprint-run") {
        if (blueprintLot.typeId !== transaction.account.typeId) {
          invariantViolations.push(
            `Blueprint reservation ${transaction.id} references the wrong blueprint type.`,
          );
          continue;
        }
        reservedByLotId.set(
          transaction.blueprintLotId,
          (reservedByLotId.get(transaction.blueprintLotId) ?? 0) + transaction.quantity,
        );
      }
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
  for (const [lotId, claimedQuantity] of claimedOutputByLotId) {
    const lot = sourceLotsById.get(lotId);
    if (lot && claimedQuantity > lot.quantity) {
      invariantViolations.push(
        `Source lot ${lotId} was claimed ${claimedQuantity - lot.quantity} excess units.`,
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
      const uncommittedInFlight = Math.max(
        0,
        balance.inFlightQuantity - (committedFutureOutputBySourceKey.get(key) ?? 0),
      );
      const futureSupply =
        balance.availableFromHauling
        + uncommittedInFlight
        + balance.availableFromProduction
        + balance.availableFromCopying
        + balance.availableFromInvention
        + balance.availableFromReprocessing
        + balance.availableFromMarket;
      const plannedSupply =
        physicalAvailable
        + balance.availableFromSellOrders
        + uncommittedInFlight
        + balance.availableFromProduction
        + balance.availableFromCopying
        + balance.availableFromInvention
        + balance.availableFromReprocessing
        + balance.availableFromMarket;
      const finalized = Object.freeze({
        ...balance,
        // Demand horizons are additive ledger facts. Supply must not reduce the demand total.
        futureDemand: balance.reserved,
        futureSupply,
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
