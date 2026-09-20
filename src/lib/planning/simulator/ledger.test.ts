import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSimulationLedger,
  type SimulationLedgerAccount,
  type SimulationTransaction,
} from "./ledger";

const account: SimulationLedgerAccount = {
  activity: "manufacturing",
  locationId: 20,
  typeId: 34,
};

void test("projects demand and horizon-specific reservations", () => {
  const transactions: SimulationTransaction[] = [
    {
      id: "demand-1",
      kind: "demand",
      account,
      quantity: 10,
      source: {
        demandId: "demand-1",
        stockpileId: "main",
        typeId: 34,
        quantity: 10,
        inputQuantity: 10,
        destinationLocationId: 20,
      },
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
  const balance = [...projection.balances.values()][0];
  assert.equal(balance.required, 10);
  assert.equal(balance.availableNow, 4);
  assert.equal(balance.availableAfterHauling, 3);
  assert.equal(balance.unsatisfied, 3);
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
          typeId: 34,
          quantity: 4,
          inputQuantity: 4,
          destinationLocationId: 20,
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
          typeId: 34,
          quantity: 6,
          inputQuantity: 6,
          destinationLocationId: 20,
        },
      },
    ],
  );
  const balances = [...projection.balances.values()];
  assert.equal(balances.length, 1);
  assert.equal(balances[0].required, 10);
  assert.deepEqual(
    balances[0].demandSources.map((source) => source.stockpileId),
    ["main", "other"],
  );
});

void test("posts production at its source ledger before crediting another location", () => {
  const destinationAccount: SimulationLedgerAccount = {
    activity: "market",
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
          typeId: 34,
          quantity: 8,
          inputQuantity: 8,
          destinationLocationId: 10,
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
  const sourceBalance = projection.balances.get("manufacturing:20:34");
  const destinationBalance = projection.balances.get("market:10:34");
  assert.equal(sourceBalance?.availableFromProduction, 8);
  assert.equal(sourceBalance?.transferredOut, 8);
  assert.equal(sourceBalance?.surplus, 0);
  assert.equal(destinationBalance?.availableFromProduction, 8);
  assert.equal(destinationBalance?.unsatisfied, 0);
});
