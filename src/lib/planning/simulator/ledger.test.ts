import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSimulationLedger,
  type SimulationLedgerAccount,
  type SimulationTransaction,
} from "./ledger";

const account: SimulationLedgerAccount = {
  stockpileId: "main",
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
        account: { ...account, stockpileId: "other" },
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
