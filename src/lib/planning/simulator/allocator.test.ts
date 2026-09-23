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

void test("greedy hauling claims remote stock before preserving local stock", () => {
  const allocator = new SimulationAllocator(inventory, [], [], false, "greedy");
  const claim = allocator.claimOrdinarySupply(34, 10, 20, account, "job");
  assert.deepEqual(claim, { local: 2, remote: 8, future: 0, futureReservations: [] });
  assert.equal(allocator.haulingTasks[0].quantity, 8);
  assert.equal(allocator.remainingItemQuantity("local"), 2);
});

void test("blocks only hauls between stockpile locations with no shared stockpile", () => {
  const stockpiles = [
    {
      locations: {
        stock: 10,
        manufacturing: 11,
        reactions: 12,
        reprocessing: 13,
        copying: 14,
        invention: 15,
      },
    },
    {
      locations: {
        stock: 20,
        manufacturing: 21,
        reactions: 22,
        reprocessing: 23,
        copying: 24,
        invention: 25,
      },
    },
  ] as const;
  const remoteInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[1], lotId: "cross-stockpile", locationId: 20 }],
  };
  const blocked = new SimulationAllocator(remoteInventory, [], stockpiles, true);
  assert.deepEqual(
    blocked.claimOrdinarySupply(34, 2, 10, account, "job"),
    {
      local: 0,
      remote: 0,
      future: 0,
      futureReservations: [],
    },
  );
  assert.equal(blocked.haulingTasks.length, 0);
  const blockedBlueprint = new SimulationAllocator(
    {
      ...inventory,
      blueprintLots: [{ ...inventory.blueprintLots[0], locationId: 20 }],
    },
    [],
    stockpiles,
    true,
  );
  assert.deepEqual(
    blockedBlueprint.claimManufacturingBlueprints(100, 1, 10, account, "job", 10),
    [],
  );

  const sharedLocationInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[1], lotId: "same-stockpile", locationId: 11 }],
  };
  const sameStockpile = new SimulationAllocator(sharedLocationInventory, [], stockpiles, true);
  assert.equal(sameStockpile.claimOrdinarySupply(34, 2, 10, account, "job").remote, 2);

  const unlistedLocationInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[1], lotId: "unlisted", locationId: 99 }],
  };
  const unlisted = new SimulationAllocator(unlistedLocationInventory, [], stockpiles, true);
  assert.equal(unlisted.claimOrdinarySupply(34, 2, 10, account, "job").remote, 2);
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

void test("does not claim future output delivered to another location", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [
        {
          ...inventory.itemLots[0],
          lotId: "remote-future-output",
          quantity: 4,
          locationId: 30,
          horizon: "after-upstream",
          source: "industry-output",
          activity: "manufacturing",
          industryJobId: 789,
          industryJobStatus: "active",
        },
      ],
    },
    [],
  );

  assert.deepEqual(allocator.availability(34, 20), { local: 0, remote: 0, future: 0 });
  assert.deepEqual(
    allocator.claimFuture(34, 4, account, "demanding-job"),
    {
      quantity: 0,
      reservations: [],
    },
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
