import assert from "node:assert/strict";
import test from "node:test";
import { parseSimulatorRequest } from "./schema";
import { aggregateHaulingTasks, simulateIndustry } from "./simulate";

void test("aggregates hauling tasks by route and owner with demand provenance", () => {
  const tasks = aggregateHaulingTasks([
    {
      transferId: "haul:one",
      lotId: "one",
      typeId: 40,
      typeName: "Megacyte",
      quantity: 10,
      unitVolume: 0.01,
      fromLocationId: 100,
      toLocationId: 200,
      ownerType: "character",
      ownerId: 1,
      purpose: "industry-input",
      demands: [{ jobId: "job-a", quantity: 10 }],
    },
    {
      transferId: "haul:two",
      lotId: "two",
      typeId: 40,
      typeName: "Megacyte",
      quantity: 5,
      unitVolume: 0.01,
      fromLocationId: 100,
      toLocationId: 300,
      ownerType: "character",
      ownerId: 1,
      purpose: "industry-input",
      demands: [{ jobId: "job-b", quantity: 5 }],
    },
    {
      transferId: "haul:other-owner",
      lotId: "three",
      typeId: 40,
      typeName: "Megacyte",
      quantity: 7,
      unitVolume: 0.01,
      fromLocationId: 100,
      toLocationId: 200,
      ownerType: "corporation",
      ownerId: 1,
      purpose: "industry-input",
      demands: [{ jobId: "job-c", quantity: 7 }],
    },
  ]);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].quantity, 10);
  assert.deepEqual(tasks[0].demands, [{ jobId: "job-a", quantity: 10 }]);
});

void test("assembles a versioned invariant-safe result from the cached SDE", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1, simulateSurplus: true },
  });
  const first = await simulateIndustry(request);
  const second = await simulateIndustry(request);
  assert.equal(first.metadata.simulatorVersion, 1);
  assert.equal(first.metadata.normalizedInputHash, second.metadata.normalizedInputHash);
  assert.equal(first.metadata.invariantViolationCount, 0);
  assert.ok(first.lists.manufacturingJobs.some((job) => job.productTypeId === 587));
  assert.ok(
    first.lists.planItems.some((bucket) =>
      bucket.items.some((item) => item.requiredNow + item.reserved > 0),
    ),
  );
  assert.ok(
    first.ledgers.some((ledger) =>
      ledger.balances.some((balance) => balance.requiredNow + balance.reserved > 0),
    ),
  );
});

void test("produces identical facts for equivalent input permutations", async () => {
  const stockpile = (id: string, offset: number) => ({
    id,
    name: id,
    locations: {
      stock: 10 + offset,
      manufacturing: 20 + offset,
      reactions: 30 + offset,
      reprocessing: 40 + offset,
      copying: 50 + offset,
      invention: 60 + offset,
    },
    items: [{ typeId: 34, quantity: 50, me: 0, te: 0, fromCompression: false }],
  });
  const asset = (locationId: number) => ({
    typeId: 34,
    name: "Tritanium",
    quantity: 50,
    locationId,
  });
  const input = {
    stockpiles: [stockpile("beta", 100), stockpile("alpha", 0)],
    assets: [asset(120), asset(20)],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1 },
  };
  const permuted = {
    ...input,
    stockpiles: [...input.stockpiles].reverse(),
    assets: [...input.assets].reverse(),
  };
  const [first, second] = await Promise.all([
    simulateIndustry(parseSimulatorRequest(input)),
    simulateIndustry(parseSimulatorRequest(permuted)),
  ]);
  assert.equal(first.metadata.normalizedInputHash, second.metadata.normalizedInputHash);
  assert.deepEqual(first.lists, second.lists);
  assert.deepEqual(first.ledgers, second.ledgers);
});

void test("combines stockpile demand in one canonical location ledger", async () => {
  const sharedLocations = {
    stock: 10,
    manufacturing: 20,
    reactions: 30,
    reprocessing: 40,
    copying: 50,
    invention: 60,
  };
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "alpha",
        name: "Alpha",
        locations: sharedLocations,
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
      {
        id: "beta",
        name: "Beta",
        locations: sharedLocations,
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const manufacturingLedger = result.ledgers.find((ledger) => ledger.locationId === 20);
  assert.ok(manufacturingLedger);
  assert.equal(manufacturingLedger.ledgerId, "location:20");
  assert.ok(
    manufacturingLedger.balances.some(
      (balance) => new Set(balance.demandSources.map((source) => source.stockpileId)).size === 2,
    ),
  );
});

void test("shows configured-location stock only on the surplus tab when requested", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      {
        typeId: 4393,
        name: "Drone Damage Amplifier I",
        quantity: 252,
        locationId: 50,
      },
    ],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1, simulateSurplus: true },
  });
  const result = await simulateIndustry(request);
  const ledger = result.ledgers.find((candidate) => candidate.locationId === 50);
  assert.ok(ledger);
  const amplifier = ledger.balances.find((balance) => balance.typeId === 4393);
  assert.ok(amplifier);
  assert.equal(amplifier.availableNow, 252);
  assert.equal(amplifier.reserved, 0);
  assert.ok(
    result.lists.surplusItems?.some((bucket) => bucket.items.some((item) => item.typeId === 4393)),
  );
  assert.ok(
    !result.lists.planItems.some((bucket) => bucket.items.some((item) => item.typeId === 4393)),
  );
});

void test("omits surplus and ledgers for unconfigured locations", async () => {
  const input = {
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [{ typeId: 4393, name: "Drone Damage Amplifier I", quantity: 252, locationId: 70 }],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1 },
  };
  const limited = await simulateIndustry(parseSimulatorRequest(input));
  const simulated = await simulateIndustry(
    parseSimulatorRequest({
      ...input,
      simulation: { version: 1, simulateSurplus: true },
    }),
  );
  assert.equal("surplusItems" in limited.lists, false);
  assert.equal(
    simulated.lists.surplusItems?.some((bucket) => bucket.locationId === 70),
    false,
  );
  assert.equal(
    simulated.ledgers.some((ledger) => ledger.locationId === 70),
    false,
  );
});

void test("does not expose haul-excluded remote stock to destination demand", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 34, quantity: 50, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [{ typeId: 34, name: "Tritanium", quantity: 50, locationId: 20 }],
    haulExclusions: [{ typeId: 34, fromLocationId: 20, toLocationId: 10 }],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const destination = result.lists.planItems
    .find((bucket) => bucket.locationId === 10)
    ?.items.find((item) => item.typeId === 34);
  assert.ok(destination);
  assert.equal(destination.availableFromHauling, 0);
  assert.equal(destination.availableFromMarket, 50);
  assert.equal(destination.unsatisfied, 0);
  assert.equal(result.lists.haulingTasks.length, 0);
  assert.equal(result.lists.materialsToBuy[0].quantity, 50);
});

void test("keeps connected material surplus on the plan tab", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 34, quantity: 50, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [{ typeId: 34, name: "Tritanium", quantity: 75, locationId: 10 }],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const tritanium = result.lists.planItems
    .find((bucket) => bucket.locationId === 10)
    ?.items.find((item) => item.typeId === 34);
  assert.ok(tritanium);
  assert.equal(tritanium.availableNow, 75);
  assert.equal(tritanium.requiredNow, 50);
  assert.equal(tritanium.reserved, 0);
  assert.equal(tritanium.surplus, 25);
  assert.ok(
    !result.lists.surplusItems?.some((bucket) => bucket.items.some((item) => item.typeId === 34)),
  );
});

void test("preserves local recursive demand before hauling in local-first mode", async () => {
  const input = {
    stockpiles: [
      {
        id: "a-jita",
        name: "Jita",
        locations: {
          stock: 10,
          manufacturing: 10,
          reactions: 10,
          reprocessing: 10,
          copying: 10,
          invention: 10,
        },
        items: [{ typeId: 11370, quantity: 150, me: 0, te: 0, fromCompression: false }],
      },
      {
        id: "b-auner",
        name: "Auner",
        locations: {
          stock: 20,
          manufacturing: 20,
          reactions: 20,
          reprocessing: 20,
          copying: 20,
          invention: 20,
        },
        items: [{ typeId: 11577, quantity: 299, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [{ typeId: 11370, name: "Prototype Cloaking Device I", quantity: 96, locationId: 20 }],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    simulation: { version: 1, haulingAllocationMode: "local-first" as const },
  };
  const localFirst = await simulateIndustry(parseSimulatorRequest(input));
  const greedy = await simulateIndustry(
    parseSimulatorRequest({
      ...input,
      simulation: { version: 1, haulingAllocationMode: "greedy" },
    }),
  );

  assert.deepEqual(
    localFirst.lists.haulingTasks.filter((task) => task.typeId === 11370),
    [],
  );
  assert.deepEqual(
    greedy.lists.haulingTasks
      .filter((task) => task.typeId === 11370)
      .map((task) => ({
        from: task.fromLocationId,
        to: task.toLocationId,
        quantity: task.quantity,
      })),
    [{ from: 20, to: 10, quantity: 96 }],
  );
  const localAunerBalance = localFirst.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find((balance) => balance.typeId === 11370);
  assert.ok(localAunerBalance);
  assert.equal(localAunerBalance.availableNow, 96);
  assert.equal(localAunerBalance.availableFromProduction, 203);
  assert.equal(localAunerBalance.transferredOut, 0);
});
