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
      { lotId: "local", typeId: 34, quantity: 4, locationId: 20 },
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
    [],
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
        producingJobId: "job-1",
      },
    ],
  );
  const sourceBalance = projection.balances.get("20:34");
  const destinationBalance = projection.balances.get("10:34");
  assert.equal(sourceBalance, undefined);
  assert.ok(destinationBalance);
  assert.equal(destinationBalance.availableFromProduction, 8);
  assert.equal(destinationBalance.unsatisfied, 0);
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
  assert.equal(balance.unsatisfied, 0);
  assert.equal(balance.surplus, 0);
});
