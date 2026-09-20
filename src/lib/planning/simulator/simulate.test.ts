import assert from "node:assert/strict";
import test from "node:test";
import { parseSimulatorRequest } from "./schema";
import { simulateIndustry } from "./simulate";

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
    simulation: { version: 1 },
  });
  const first = await simulateIndustry(request);
  const second = await simulateIndustry(request);
  assert.equal(first.metadata.simulatorVersion, 1);
  assert.equal(first.metadata.normalizedInputHash, second.metadata.normalizedInputHash);
  assert.equal(first.metadata.invariantViolationCount, 0);
  assert.ok(first.lists.manufacturingJobs.some((job) => job.productTypeId === 587));
  assert.ok(
    first.lists.planItems.some((bucket) =>
      bucket.items.some((item) => item.activity === "manufacturing"),
    ),
  );
  assert.ok(
    first.ledgers.some((ledger) => ledger.balances.some((balance) => balance.required > 0)),
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

void test("uses one manufacturing ledger for stockpiles sharing a facility", async () => {
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
  const manufacturingLedgers = result.ledgers.filter(
    (ledger) => ledger.activity === "manufacturing" && ledger.locationId === 20,
  );
  assert.equal(manufacturingLedgers.length, 1);
  assert.equal(manufacturingLedgers[0].ledgerId, "manufacturing:20");
  assert.ok(
    manufacturingLedgers[0].balances.some(
      (balance) => new Set(balance.demandSources.map((source) => source.stockpileId)).size === 2,
    ),
  );
});

void test("posts unreserved items only to their location surplus ledger", async () => {
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
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const surplus = result.ledgers.find(
    (ledger) => ledger.activity === "surplus" && ledger.locationId === 50,
  );
  const copying = result.ledgers.find(
    (ledger) => ledger.activity === "copying" && ledger.locationId === 50,
  );
  assert.ok(surplus);
  const amplifier = surplus.balances.find((balance) => balance.typeId === 4393);
  assert.ok(amplifier);
  assert.equal(amplifier.availableNow, 252);
  assert.equal(amplifier.unreserved, 252);
  assert.ok(
    result.lists.surplusItems.some((bucket) => bucket.items.some((item) => item.typeId === 4393)),
  );
  assert.ok(!copying || !copying.balances.some((balance) => balance.typeId === 4393));
});

void test("includes surplus at an unconfigured location only when requested", async () => {
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
  const expanded = await simulateIndustry(
    parseSimulatorRequest({
      ...input,
      simulation: { version: 1, includeSurplusForAllLocations: true },
    }),
  );
  assert.equal(
    limited.ledgers.some((ledger) => ledger.activity === "surplus" && ledger.locationId === 70),
    false,
  );
  assert.equal(
    expanded.ledgers.some((ledger) => ledger.activity === "surplus" && ledger.locationId === 70),
    true,
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
  assert.equal(destination.availableAfterHauling, 0);
  assert.equal(destination.unsatisfied, 50);
  assert.equal(result.lists.haulingTasks.length, 0);
  assert.equal(result.lists.materialsToBuy[0].quantity, 50);
});
