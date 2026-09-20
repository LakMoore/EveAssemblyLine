import assert from "node:assert/strict";
import test from "node:test";
import { SimulationAllocator } from "./allocator";
import type { SimulationLedgerAccount } from "./ledger";
import type { SimulatorInventory } from "./sourceLots";

const account: SimulationLedgerAccount = {
  locationId: 20,
  typeId: 34,
};

const inventory: SimulatorInventory = {
  itemLots: [
    {
      lotId: "local",
      typeId: 34,
      name: "Tritanium",
      quantity: 4,
      locationId: 20,
      unitVolume: 0.01,
      horizon: "now",
      source: "asset",
      eligibleForReprocessing: false,
    },
    {
      lotId: "remote",
      typeId: 34,
      name: "Tritanium",
      quantity: 8,
      locationId: 30,
      unitVolume: 0.01,
      horizon: "now",
      source: "asset",
      eligibleForReprocessing: false,
    },
  ],
  blueprintLots: [
    {
      lotId: "bpc",
      itemId: 99,
      typeId: 100,
      name: "Test Blueprint",
      kind: "bpc",
      runs: 5,
      materialEfficiency: 10,
      timeEfficiency: 20,
      locationId: 20,
      inUse: false,
      horizon: "now",
    },
  ],
  unresolvedLotCount: 0,
};

void test("claims local stock before remote stock and creates an exact haul", () => {
  const allocator = new SimulationAllocator(inventory, []);
  const claim = allocator.claimOrdinarySupply(34, 10, 20, account, "job");
  assert.deepEqual(claim, { local: 4, remote: 6, future: 0, futureReservations: [] });
  assert.equal(allocator.haulingTasks[0].quantity, 6);
  assert.equal(allocator.remainingItemQuantity("remote"), 2);
});

void test("distinguishes active production from planned future output", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [
        {
          ...inventory.itemLots[0],
          lotId: "active-output",
          quantity: 4,
          horizon: "after-upstream",
          source: "industry-output",
          activity: "manufacturing",
          industryJobId: 123,
          industryJobStatus: "active",
          industryJobEndDate: "2026-01-01T01:00:00.000Z",
        },
        {
          ...inventory.itemLots[0],
          lotId: "planned-output",
          quantity: 4,
          horizon: "after-upstream",
          source: "industry-output",
          activity: "reaction",
          industryJobStatus: "ready",
        },
        {
          ...inventory.itemLots[0],
          lotId: "paused-output",
          quantity: 4,
          horizon: "after-upstream",
          source: "industry-output",
          activity: "manufacturing",
          industryJobStatus: "paused",
        },
      ],
    },
    [],
  );

  const claim = allocator.claimFuture(34, 12, account, "job");

  assert.deepEqual(
    claim.reservations,
    [
      {
        activity: "manufacturing",
        quantity: 4,
        state: "in-production",
        sourceJobId: 123,
        sourceOutputQuantity: 4,
        sourceCompletionAt: "2026-01-01T01:00:00.000Z",
      },
      { activity: "manufacturing", quantity: 4, state: "paused" },
      { activity: "reaction", quantity: 4, state: "planned" },
    ],
  );
});

void test("retains the full output when an active job only supplies part of demand", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [
        {
          ...inventory.itemLots[0],
          lotId: "active-job-output",
          quantity: 32,
          horizon: "after-upstream",
          source: "industry-output",
          activity: "manufacturing",
          industryJobId: 456,
          industryJobStatus: "active",
          industryJobEndDate: "2026-01-01T02:00:00.000Z",
        },
      ],
    },
    [],
  );

  const claim = allocator.claimFuture(34, 29, account, "demanding-job");

  assert.deepEqual(
    claim.reservations,
    [
      {
        activity: "manufacturing",
        quantity: 29,
        state: "in-production",
        sourceJobId: 456,
        sourceOutputQuantity: 32,
        sourceCompletionAt: "2026-01-01T02:00:00.000Z",
      },
    ],
  );
});

void test("conserves finite BPC runs across allocations", () => {
  const allocator = new SimulationAllocator(inventory, []);
  const first = allocator.claimManufacturingBlueprints(100, 4, 20, account, "job-1", 10);
  const second = allocator.claimManufacturingBlueprints(100, 4, 20, account, "job-2", 10);
  assert.equal(
    first.reduce((total, allocation) => total + allocation.runs, 0),
    4,
  );
  assert.equal(
    second.reduce((total, allocation) => total + allocation.runs, 0),
    1,
  );
  assert.equal(allocator.remainingBlueprintRuns("bpc"), 0);
});

void test("depletes only the runs used from each copy", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      blueprintLots: [
        { ...inventory.blueprintLots[0], lotId: "first", runs: 3, materialEfficiency: 10 },
        { ...inventory.blueprintLots[0], lotId: "second", runs: 5, materialEfficiency: 9 },
      ],
    },
    [],
  );
  const allocations = allocator.claimManufacturingBlueprints(100, 5, 20, account, "job", 10);
  assert.equal(
    allocations.reduce((total, allocation) => total + allocation.runs, 0),
    5,
  );
  assert.equal(allocator.remainingBlueprintRuns("first"), 0);
  assert.equal(allocator.remainingBlueprintRuns("second"), 3);
});

void test("preserves blueprint names on blueprint hauls", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      blueprintLots: [{ ...inventory.blueprintLots[0], locationId: 30 }],
    },
    [],
  );
  allocator.claimManufacturingBlueprints(100, 1, 20, account, "job", 10);
  assert.equal(allocator.haulingTasks[0].typeName, "Test Blueprint");
  assert.equal(allocator.haulingTasks[0].blueprintKind, "bpc");
});
