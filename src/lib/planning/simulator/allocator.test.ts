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

void test("previews each physical lot once before remote activity demand", () => {
  const allocator = new SimulationAllocator(inventory, []);

  assert.equal(allocator.previewOrdinarySupply(34, 4, 20), 4);
  assert.equal(allocator.previewOrdinarySupply(34, 8, 40), 8);
  assert.equal(allocator.previewOrdinarySupply(34, 1, 30), 0);
  assert.equal(allocator.remainingItemQuantity("local"), 4);
  assert.equal(allocator.remainingItemQuantity("remote"), 8);
  assert.deepEqual(allocator.transactions, []);
});

void test("protects reserved activity inputs from stockpile demand", () => {
  const allocator = new SimulationAllocator(inventory, []);
  allocator.reserveActivityDemand(34, 4, 20);

  const stockpileClaim = allocator.claimOrdinarySupply(
    34,
    4,
    20,
    account,
    undefined,
    "stockpile",
    "stock",
  );
  const activityClaim = allocator.claimOrdinarySupply(
    34,
    4,
    20,
    account,
    "industry-job",
    undefined,
    "manufacturing",
    "activity-input",
  );

  assert.deepEqual(stockpileClaim, { local: 0, remote: 4, future: 0, futureReservations: [] });
  assert.deepEqual(activityClaim, { local: 4, remote: 0, future: 0, futureReservations: [] });
  assert.equal(allocator.haulingTasks[0].purpose, "stockpile-demand");
  assert.equal(allocator.remainingItemQuantity("local"), 0);
});

void test("protects local stockpile supply from remote activity demand", () => {
  const allocator = new SimulationAllocator(
    { ...inventory, itemLots: [inventory.itemLots[0]] },
    [],
  );
  allocator.reserveLocalStockpileDemand(34, 4, 20);
  allocator.reserveRemoteActivityDemand();

  const activityClaim = allocator.claimOrdinarySupply(
    34,
    4,
    40,
    { ...account, locationId: 40 },
    "remote-industry-job",
    undefined,
    "manufacturing",
    "activity-input",
  );
  const stockpileClaim = allocator.claimOrdinarySupply(
    34,
    4,
    20,
    account,
    undefined,
    "local-stockpile",
    "stock",
    "stockpile-demand",
  );

  assert.deepEqual(activityClaim, { local: 0, remote: 0, future: 0, futureReservations: [] });
  assert.deepEqual(stockpileClaim, { local: 4, remote: 0, future: 0, futureReservations: [] });
});

void test("protects remote activity supply from remote stockpile demand", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [{ ...inventory.itemLots[1], quantity: 4, locationId: 30 }],
    },
    [],
  );
  allocator.reserveActivityDemand(34, 4, 40);
  allocator.reserveRemoteActivityDemand();

  const stockpileClaim = allocator.claimOrdinarySupply(
    34,
    4,
    20,
    account,
    undefined,
    "remote-stockpile",
    "stock",
    "stockpile-demand",
  );
  const activityClaim = allocator.claimOrdinarySupply(
    34,
    4,
    40,
    { ...account, locationId: 40 },
    "remote-industry-job",
    undefined,
    "manufacturing",
    "activity-input",
  );

  assert.deepEqual(stockpileClaim, { local: 0, remote: 0, future: 0, futureReservations: [] });
  assert.deepEqual(activityClaim, { local: 0, remote: 4, future: 0, futureReservations: [] });
});

void test("preserves locally reserved activity inputs from a remote activity claim", () => {
  const allocator = new SimulationAllocator(inventory, []);
  allocator.reserveActivityDemand(34, 4, 20);

  const remoteClaim = allocator.claimOrdinarySupply(
    34,
    8,
    40,
    { ...account, locationId: 40 },
    "remote-industry-job",
    undefined,
    "manufacturing",
    "activity-input",
  );
  const localClaim = allocator.claimOrdinarySupply(
    34,
    4,
    20,
    account,
    "local-industry-job",
    undefined,
    "reaction",
    "activity-input",
  );

  assert.deepEqual(remoteClaim, { local: 0, remote: 8, future: 0, futureReservations: [] });
  assert.deepEqual(localClaim, { local: 4, remote: 0, future: 0, futureReservations: [] });
  assert.equal(allocator.remainingItemQuantity("local"), 0);
  assert.equal(allocator.remainingItemQuantity("remote"), 0);
});

void test("protects local stockpile demand from an earlier remote claim", () => {
  const allocator = new SimulationAllocator(
    { ...inventory, itemLots: [inventory.itemLots[0]] },
    [],
  );
  allocator.reserveLocalStockpileDemand(34, 4, 20);
  allocator.reserveRemoteStockpileDemand();

  const remoteClaim = allocator.claimOrdinarySupply(
    34,
    4,
    30,
    { ...account, locationId: 30 },
    "remote-stockpile",
    "remote",
    "stock",
    "stockpile-demand",
  );
  const localClaim = allocator.claimOrdinarySupply(
    34,
    4,
    20,
    account,
    "local-stockpile",
    "local",
    "stock",
    "stockpile-demand",
  );

  assert.deepEqual(remoteClaim, { local: 0, remote: 0, future: 0, futureReservations: [] });
  assert.deepEqual(localClaim, { local: 4, remote: 0, future: 0, futureReservations: [] });
  assert.equal(allocator.haulingTasks.length, 0);
});

void test("blocks a haul route for every owner", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [
        { ...inventory.itemLots[1], ownerType: "character", ownerId: 7 },
        {
          ...inventory.itemLots[1],
          lotId: "remote-corporation",
          ownerType: "corporation",
          ownerId: 8,
        },
      ],
    },
    [{ typeId: 34, fromLocationId: 30, toLocationId: 20 }],
  );
  assert.deepEqual(
    allocator.claimOrdinarySupply(34, 10, 20, account, "job"),
    { local: 0, remote: 0, future: 0, futureReservations: [] },
  );
  assert.equal(allocator.haulingTasks.length, 0);
});

void test("blocks cross-stockpile activity hauls but allows end-destination hauls", () => {
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
    itemLots: [{ ...inventory.itemLots[1], lotId: "cross-stockpile", locationId: 21 }],
  };
  const blocked = new SimulationAllocator(remoteInventory, [], stockpiles, true);
  assert.deepEqual(
    blocked.claimOrdinarySupply(34, 2, 11, { ...account, locationId: 11 }, "job"),
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
      blueprintLots: [{ ...inventory.blueprintLots[0], locationId: 21 }],
    },
    [],
    stockpiles,
    true,
  );
  assert.deepEqual(
    blockedBlueprint.claimManufacturingBlueprints(
      100,
      1,
      11,
      { ...account, locationId: 11 },
      "job",
      10,
    ),
    [],
  );

  const sharedLocationInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[1], lotId: "same-stockpile", locationId: 11 }],
  };
  const sameStockpile = new SimulationAllocator(sharedLocationInventory, [], stockpiles, true);
  assert.equal(
    sameStockpile.claimOrdinarySupply(34, 2, 14, { ...account, locationId: 14 }, "job").remote,
    2,
  );

  const unlistedLocationInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[1], lotId: "unlisted", locationId: 99 }],
  };
  const unlisted = new SimulationAllocator(unlistedLocationInventory, [], stockpiles, true);
  assert.equal(unlisted.claimOrdinarySupply(34, 2, 10, account, "job").remote, 2);

  const endDestinationSource = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [{ ...inventory.itemLots[1], lotId: "end-destination-source", locationId: 20 }],
    },
    [],
    stockpiles,
    true,
  );
  assert.equal(
    endDestinationSource.claimOrdinarySupply(34, 2, 10, { ...account, locationId: 10 }, "job")
      .remote,
    2,
  );

  const endDestinationTarget = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [{ ...inventory.itemLots[1], lotId: "end-destination-target", locationId: 11 }],
    },
    [],
    stockpiles,
    true,
  );
  assert.equal(endDestinationTarget.claimOrdinarySupply(34, 2, 20, account, "job").remote, 2);
});
void test("includes assigned facilities in inter-stockpile haul restrictions", () => {
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
      groupAssignments: { capitalComponents: 16 },
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
  const overrideStationInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[1], lotId: "assigned-station", locationId: 16 }],
  };

  const blocked = new SimulationAllocator(overrideStationInventory, [], stockpiles, true);
  assert.equal(
    blocked.claimOrdinarySupply(34, 2, 21, { ...account, locationId: 21 }, "job").remote,
    0,
  );

  const sameStockpile = new SimulationAllocator(overrideStationInventory, [], stockpiles, true);
  assert.equal(
    sameStockpile.claimOrdinarySupply(34, 2, 11, { ...account, locationId: 11 }, "job").remote,
    2,
  );
});

void test("protects reserved activity stock from another stockpile's haul", () => {
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
      groupAssignments: { capitalComponents: 16 },
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
  const localInventory = {
    ...inventory,
    itemLots: [{ ...inventory.itemLots[0], lotId: "reserved-at-a", quantity: 2, locationId: 11 }],
  };
  const allocator = new SimulationAllocator(localInventory, [], stockpiles, true);
  allocator.reserveActivityDemand(34, 2, 11);
  allocator.reserveRemoteActivityDemand();

  const competingStockpileClaim = allocator.claimOrdinarySupply(
    34,
    2,
    20,
    { ...account, locationId: 20 },
    "other-stockpile-job",
    "other-stockpile",
    "stock",
    "stockpile-demand",
  );
  assert.deepEqual(
    competingStockpileClaim,
    {
      local: 0,
      remote: 0,
      future: 0,
      futureReservations: [],
    },
  );
  assert.equal(allocator.haulingTasks.length, 0);

  const activityClaim = allocator.claimOrdinarySupply(
    34,
    2,
    11,
    { ...account, locationId: 11 },
    "station-a-job",
    undefined,
    "manufacturing",
    "activity-input",
  );
  assert.equal(activityClaim.local, 2);
});

void test("protects future activity output from another stockpile's haul", () => {
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
  const futureInventory = {
    ...inventory,
    itemLots: [
      {
        ...inventory.itemLots[0],
        lotId: "future-at-a",
        quantity: 2,
        locationId: 11,
        horizon: "after-upstream" as const,
        source: "industry-output" as const,
        activity: "manufacturing" as const,
        industryJobId: 123,
        industryJobStatus: "active" as const,
      },
    ],
  };
  const allocator = new SimulationAllocator(futureInventory, [], stockpiles, true);
  allocator.reserveActivityDemand(34, 2, 11);
  allocator.reserveRemoteActivityDemand();

  const competingStockpileClaim = allocator.claimOrdinarySupply(
    34,
    2,
    20,
    { ...account, locationId: 20 },
    "other-stockpile-job",
    "other-stockpile",
    "stock",
    "stockpile-demand",
  );
  assert.equal(competingStockpileClaim.future, 0);

  const activityClaim = allocator.claimOrdinarySupply(
    34,
    2,
    11,
    { ...account, locationId: 11 },
    "station-a-job",
    undefined,
    "manufacturing",
    "activity-input",
  );
  assert.equal(activityClaim.future, 2);
  assert.equal(allocator.remainingItemQuantity("future-at-a"), 0);
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

void test("does not claim future output across an excluded route", () => {
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
    [{ typeId: 34, fromLocationId: 30, toLocationId: 20 }],
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

void test("claims remote future output with a completion haul", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [
        {
          ...inventory.itemLots[0],
          lotId: "remote-active-output",
          quantity: 5_760,
          locationId: 30,
          horizon: "after-upstream",
          source: "industry-output",
          activity: "reaction",
          industryJobId: 123,
          industryJobStatus: "active",
          industryJobEndDate: "2026-01-01T02:00:00.000Z",
        },
      ],
    },
    [],
  );

  const claim = allocator.claimOrdinarySupply(34, 5_589, 20, account, "stockpile-demand");

  assert.equal(claim.local, 0);
  assert.equal(claim.remote, 0);
  assert.equal(claim.future, 5_589);
  assert.equal(allocator.haulingTasks[0]?.purpose, "completion");
  assert.equal(allocator.haulingTasks[0]?.quantity, 5_589);
  assert.equal(allocator.remainingItemQuantity("remote-active-output"), 171);
  assert.equal(
    allocator.transactions.some((transaction) => transaction.kind === "transfer-commitment"),
    true,
  );
});

void test("reserves future blueprint runs with a completion haul for the print", () => {
  const allocator = new SimulationAllocator(
    {
      ...inventory,
      itemLots: [],
      blueprintLots: [
        {
          ...inventory.blueprintLots[0],
          lotId: "remote-in-flight-copy",
          locationId: 30,
          horizon: "after-upstream",
          activity: "copying",
          industryJobId: 456,
          industryJobStatus: "active",
        },
      ],
    },
    [],
  );

  const claims = allocator.claimBlueprintCopyRuns(100, 3, 20, account, "manufacturing-job");

  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.runs, 3);
  assert.equal(claims[0]?.horizon, "after-upstream");
  assert.equal(allocator.haulingTasks[0]?.quantity, 1);
  assert.equal(allocator.haulingTasks[0]?.purpose, "completion");
  assert.equal(
    allocator.transactions.some((transaction) => transaction.kind === "transfer-commitment"),
    true,
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

void test("does not split one physical BPC across different facilities", () => {
  const preview = new SimulationAllocator(inventory, []);
  assert.deepEqual(
    preview.previewManufacturingBlueprints(100, 3, 30, 10),
    [{ runs: 3, materialEfficiency: 10 }],
  );
  assert.deepEqual(preview.previewManufacturingBlueprints(100, 2, 40, 10), []);

  const allocator = new SimulationAllocator(inventory, []);
  const first = allocator.claimManufacturingBlueprints(
    100,
    3,
    30,
    {
      locationId: 30,
      typeId: 100,
    },
    "job-one",
    10,
  );
  const second = allocator.claimManufacturingBlueprints(
    100,
    2,
    40,
    {
      locationId: 40,
      typeId: 100,
    },
    "job-two",
    10,
  );
  assert.equal(
    first.reduce((total, allocation) => total + allocation.runs, 0),
    3,
  );
  assert.deepEqual(second, []);
  assert.deepEqual(
    allocator.haulingTasks.map((task) => task.toLocationId),
    [30],
  );
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
