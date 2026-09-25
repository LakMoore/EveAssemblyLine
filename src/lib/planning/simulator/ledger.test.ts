import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSimulationLedger,
  type SimulationLedgerAccount,
  type SimulationTransaction,
} from "./ledger";

const account: SimulationLedgerAccount = {
  locationId: 20,
  typeId: 34,
};

void test("projects source availability before demand reservations and hauling", () => {
  const transactions: SimulationTransaction[] = [
    {
      id: "demand-1",
      kind: "demand",
      account,
      quantity: 10,
      source: {
        demandId: "demand-1",
        stockpileId: "main",
        materialTypeId: 34,
        productTypeId: 34,
        productQuantity: 10,
        plannedQuantity: 10,
        requiredNow: 4,
        reserved: 6,
        destinationLocationId: 20,
        activity: "manufacturing",
      },
    },
    {
      id: "local-availability",
      kind: "source-availability",
      account,
      lotId: "local",
      quantity: 4,
      horizon: "now",
    },
    {
      id: "remote-availability",
      kind: "source-availability",
      account: { locationId: 30, typeId: 34 },
      lotId: "remote",
      quantity: 3,
      horizon: "now",
    },
    {
      id: "remote-transfer",
      kind: "transfer-commitment",
      sourceAccount: { locationId: 30, typeId: 34 },
      destinationAccount: account,
      lotId: "remote",
      quantity: 3,
    },
    {
      id: "reserve-local",
      kind: "source-reservation",
      account,
      lotId: "local",
      quantity: 4,
      horizon: "now",
    },
    {
      id: "reserve-remote",
      kind: "source-reservation",
      account,
      lotId: "remote",
      quantity: 3,
      horizon: "after-hauling",
    },
  ];
  const projection = projectSimulationLedger(
    [
      {
        lotId: "local",
        typeId: 34,
        quantity: 4,
        locationId: 20,
      },
      { lotId: "remote", typeId: 34, quantity: 3, locationId: 30 },
    ],
    transactions,
  );
  const balance = projection.balances.get("20:34");
  assert.ok(balance);
  assert.equal(balance.requiredNow, 4);
  assert.equal(balance.reserved, 6);
  assert.equal(balance.availableNow, 4);
  assert.equal(balance.availableFromHauling, 3);
  assert.equal(balance.unsatisfied, 3);
  assert.equal(projection.balances.get("30:34")?.transferredOut, 3);
  assert.deepEqual(projection.invariantViolations, []);
});

void test("detects reservations shared across ledgers that exceed one physical lot", () => {
  const projection = projectSimulationLedger(
    [{ lotId: "shared", typeId: 34, quantity: 5, locationId: 20 }],
    [
      {
        id: "first",
        kind: "source-reservation",
        account,
        lotId: "shared",
        quantity: 4,
        horizon: "now",
      },
      {
        id: "second",
        kind: "source-reservation",
        account: { ...account, locationId: 30 },
        lotId: "shared",
        quantity: 4,
        horizon: "now",
      },
    ],
  );
  assert.equal(
    projection.invariantViolations.some((message) => /over-reserved/.test(message)),
    true,
  );
});

void test("combines stockpile demand sources in one activity and location account", () => {
  const projection = projectSimulationLedger(
    [],
    [
      {
        id: "main-demand",
        kind: "demand",
        account,
        quantity: 4,
        source: {
          demandId: "main-demand",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 4,
          plannedQuantity: 4,
          requiredNow: 4,
          reserved: 0,
          destinationLocationId: 20,
          activity: "manufacturing",
        },
      },
      {
        id: "other-demand",
        kind: "demand",
        account,
        quantity: 6,
        source: {
          demandId: "other-demand",
          stockpileId: "other",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 6,
          plannedQuantity: 6,
          requiredNow: 0,
          reserved: 6,
          destinationLocationId: 20,
          activity: "reaction",
        },
      },
    ],
  );
  const balances = [...projection.balances.values()];
  assert.equal(balances.length, 1);
  assert.equal(balances[0].requiredNow, 4);
  assert.equal(balances[0].reserved, 6);
  assert.deepEqual(
    balances[0].demandSources.map((source) => source.stockpileId),
    ["main", "other"],
  );
});

void test("posts remote production directly at its destination ledger", () => {
  const destinationAccount: SimulationLedgerAccount = {
    locationId: 10,
    typeId: 34,
  };
  const projection = projectSimulationLedger(
    [
      {
        lotId: "in-flight-output",
        typeId: 34,
        quantity: 8,
        locationId: 10,
        activity: "manufacturing",
      },
    ],
    [
      {
        id: "target-demand",
        kind: "demand",
        account: destinationAccount,
        quantity: 8,
        source: {
          demandId: "target-demand",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 8,
          plannedQuantity: 8,
          requiredNow: 8,
          reserved: 0,
          destinationLocationId: 10,
          activity: "stock",
        },
      },
      {
        id: "manufacture",
        kind: "production-commitment",
        account,
        destinationAccount,
        quantity: 8,
        source: "production",
        activity: "manufacturing",
        sourceLotId: "in-flight-output",
        producingJobId: "job-1",
      },
    ],
  );
  const sourceBalance = projection.balances.get("20:34");
  const destinationBalance = projection.balances.get("10:34");
  assert.equal(sourceBalance, undefined);
  assert.ok(destinationBalance);
  assert.equal(destinationBalance.inFlightQuantity, 8);
  assert.equal(destinationBalance.availableFromProduction, 0);
  assert.equal(destinationBalance.activityType, "manufacturing");
  assert.equal(destinationBalance.futureDemand, 0);
  assert.equal(destinationBalance.unsatisfied, 0);
  assert.equal(projection.balances.get("20:34"), undefined);
});

void test("retains total in-flight output after claiming only the required quantity", () => {
  const projection = projectSimulationLedger(
    [
      {
        lotId: "carbon-fiber-output",
        typeId: 34,
        quantity: 154_200,
        locationId: 10,
        activity: "reaction",
      },
      {
        lotId: "current-stock",
        typeId: 34,
        quantity: 3_533,
        locationId: 10,
      },
    ],
    [
      {
        id: "current-stock-availability",
        kind: "source-availability",
        account: { locationId: 10, typeId: 34 },
        lotId: "current-stock",
        quantity: 3_533,
        horizon: "now",
        source: "asset",
      },
      {
        id: "future-demand",
        kind: "demand",
        account: { locationId: 10, typeId: 34 },
        quantity: 48_528,
        source: {
          demandId: "future-demand",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 48_528,
          plannedQuantity: 48_528,
          requiredNow: 3_523,
          reserved: 45_005,
          destinationLocationId: 10,
          activity: "stock",
        },
      },
      {
        id: "claimed-in-flight-output",
        kind: "production-commitment",
        account: { locationId: 10, typeId: 34 },
        destinationAccount: { locationId: 10, typeId: 34 },
        quantity: 44_995,
        source: "production",
        activity: "manufacturing",
        sourceLotId: "carbon-fiber-output",
        producingJobId: "job-1",
      },
    ],
  );
  const balance = projection.balances.get("10:34");
  assert.ok(balance);
  assert.equal(balance.inFlightQuantity, 154_200);
  assert.equal(balance.availableFromProduction, 0);
  assert.equal(balance.activityType, "reaction");
  assert.equal(balance.futureSupply, 154_200);
  assert.equal(balance.futureDemand, 44_995);
  assert.equal(balance.surplus, 109_205);
  assert.equal(balance.unsatisfied, 0);
});

void test("adds planned production to gross in-flight output", () => {
  const projection = projectSimulationLedger(
    [
      {
        lotId: "in-flight-output",
        typeId: 34,
        quantity: 100,
        locationId: 10,
        activity: "manufacturing",
      },
    ],
    [
      {
        id: "planned-production",
        kind: "production-commitment",
        account: { locationId: 10, typeId: 34 },
        destinationAccount: { locationId: 10, typeId: 34 },
        quantity: 50,
        source: "production",
        activity: "manufacturing",
        producingJobId: "planned-job",
      },
    ],
  );
  const balance = projection.balances.get("10:34");
  assert.ok(balance);
  assert.equal(balance.inFlightQuantity, 100);
  assert.equal(balance.availableFromProduction, 50);
  assert.equal(balance.activityType, "manufacturing");
  assert.equal(balance.futureSupply, 150);
});

void test("separates existing reaction output from newly planned reaction output", () => {
  const projection = projectSimulationLedger(
    [
      {
        lotId: "existing-reaction-output",
        typeId: 34,
        quantity: 154_200,
        locationId: 10,
        activity: "reaction",
      },
    ],
    [
      {
        id: "planned-reaction",
        kind: "production-commitment",
        account: { locationId: 10, typeId: 34 },
        destinationAccount: { locationId: 10, typeId: 34 },
        quantity: 36_000,
        source: "production",
        activity: "reaction",
        producingJobId: "planned-reaction-job",
      },
    ],
  );
  const balance = projection.balances.get("10:34");
  assert.ok(balance);
  assert.equal(balance.inFlightQuantity, 154_200);
  assert.equal(balance.availableFromProduction, 36_000);
  assert.equal(balance.activityType, "reaction");
  assert.equal(balance.futureSupply, 190_200);
  assert.deepEqual(projection.invariantViolations, []);
});

void test("flags mixed production activity types in one material row", () => {
  const projection = projectSimulationLedger(
    [
      {
        lotId: "manufacturing-output",
        typeId: 34,
        quantity: 10,
        locationId: 10,
        activity: "manufacturing",
      },
    ],
    [
      {
        id: "planned-reaction",
        kind: "production-commitment",
        account: { locationId: 10, typeId: 34 },
        destinationAccount: { locationId: 10, typeId: 34 },
        quantity: 5,
        source: "production",
        activity: "reaction",
        producingJobId: "planned-reaction-job",
      },
    ],
  );
  const balance = projection.balances.get("10:34");
  assert.ok(balance);
  assert.equal(balance.activityType, "manufacturing");
  assert.equal(balance.inFlightQuantity, 10);
  assert.equal(balance.availableFromProduction, 5);
  assert.equal(
    projection.invariantViolations.some((message) => /mixed activity types/.test(message)),
    true,
  );
});

void test("rejects source-lot claims that exceed gross output", () => {
  const projection = projectSimulationLedger(
    [
      {
        lotId: "existing-output",
        typeId: 34,
        quantity: 10,
        locationId: 10,
        activity: "manufacturing",
      },
    ],
    [
      {
        id: "overclaim",
        kind: "production-commitment",
        account: { locationId: 10, typeId: 34 },
        destinationAccount: { locationId: 10, typeId: 34 },
        quantity: 11,
        source: "production",
        activity: "manufacturing",
        sourceLotId: "existing-output",
        producingJobId: "existing-job",
      },
    ],
  );
  assert.equal(
    projection.invariantViolations.some((message) => /excess units/.test(message)),
    true,
  );
});

void test("projects an allowed purchase as market supply at its destination", () => {
  const projection = projectSimulationLedger(
    [],
    [
      {
        id: "demand",
        kind: "demand",
        account,
        quantity: 8,
        source: {
          demandId: "demand",
          stockpileId: "main",
          materialTypeId: 34,
          productTypeId: 34,
          productQuantity: 8,
          plannedQuantity: 8,
          requiredNow: 8,
          reserved: 0,
          destinationLocationId: 20,
          activity: "manufacturing",
        },
      },
      {
        id: "purchase",
        kind: "purchase-requirement",
        account,
        quantity: 8,
      },
    ],
  );
  const balance = projection.balances.get("20:34");
  assert.ok(balance);
  assert.equal(balance.availableFromMarket, 8);
  assert.equal(balance.futureSupply, 8);
  assert.equal(balance.unsatisfied, 0);
  assert.equal(balance.surplus, 0);
});
