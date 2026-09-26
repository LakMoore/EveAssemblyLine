import assert from "node:assert/strict";
import test from "node:test";
import { loadSimulationContext } from "./context";
import { buildDependencyGraph } from "./dependencyGraph";
import { simulateIndustryDemand } from "./industrySimulation";
import { projectSimulationLedger } from "./ledger";
import { parseSimulatorRequest } from "./schema";
import { simulateIndustry } from "./simulate";
import { normalizeSimulatorInventory } from "./sourceLots";

void test("declares an exact SDE-backed manufacturing job without inventing available stock", async () => {
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
  const context = await loadSimulationContext();
  const graph = buildDependencyGraph(
    [587],
    context,
    {
      buildBlacklist: new Set(),
      buyBlacklist: new Set(),
      maxNodes: request.simulation.policy.maxGraphNodes,
      maxDepth: request.simulation.policy.maxGraphDepth,
    },
  );
  const inventory = normalizeSimulatorInventory(request, context);
  const result = simulateIndustryDemand(request, context, inventory, graph);
  const rifterJob = result.manufacturingJobs.find((job) => job.productTypeId === 587);
  assert.ok(rifterJob);
  assert.equal(rifterJob.requiredRuns, 1);
  assert.equal(rifterJob.readyNowRuns, 0);
  assert.equal(
    rifterJob.inputs.every(
      (input) => Number.isSafeInteger(input.requiredQuantity) && input.requiredQuantity > 0,
    ),
    true,
  );
  const projection = projectSimulationLedger(inventory.itemLots, result.transactions);
  assert.deepEqual(projection.invariantViolations, []);
});

void test("keeps upstream demand separate from a multi-unit job output", async () => {
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
        items: [{ typeId: 33017, quantity: 1, me: 0, te: 0, fromCompression: false }],
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
  const context = await loadSimulationContext();
  const graph = buildDependencyGraph(
    [33017],
    context,
    {
      buildBlacklist: new Set(),
      buyBlacklist: new Set(),
      maxNodes: request.simulation.policy.maxGraphNodes,
      maxDepth: request.simulation.policy.maxGraphDepth,
    },
  );
  const result = simulateIndustryDemand(
    request,
    context,
    normalizeSimulatorInventory(request, context),
    graph,
  );
  const job = result.manufacturingJobs.find((candidate) => candidate.productTypeId === 33017);
  const input = job?.inputs.find((candidate) => candidate.typeId === 4312);
  assert.ok(input);
  assert.equal(input.requiredQuantity, 6);
  assert.deepEqual(
    input.upstreamReservations?.[0],
    {
      activity: "manufacturing",
      quantity: 6,
      state: "planned",
      sourceJobId: "fba93b5d4b2c079a:0",
      sourceOutputQuantity: 40,
    },
  );
});

void test("defers available Tritanium when another job prerequisite blocks installation", async () => {
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
    assets: [{ typeId: 34, name: "Tritanium", quantity: 1_000_000, locationId: 20 }],
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
  const context = await loadSimulationContext();
  const graph = buildDependencyGraph(
    [587],
    context,
    {
      buildBlacklist: new Set(),
      buyBlacklist: new Set(),
      maxNodes: request.simulation.policy.maxGraphNodes,
      maxDepth: request.simulation.policy.maxGraphDepth,
    },
  );
  const inventory = normalizeSimulatorInventory(request, context);
  const result = simulateIndustryDemand(request, context, inventory, graph);
  const tritaniumDemand = result.transactions.find(
    (transaction): transaction is Extract<typeof transaction, { kind: "demand" }> =>
      transaction.kind === "demand" && transaction.source.materialTypeId === 34,
  );
  assert.ok(tritaniumDemand);
  assert.equal(tritaniumDemand.source.requiredNow, 0);
  assert.equal(tritaniumDemand.source.reserved, tritaniumDemand.source.plannedQuantity);
  assert.equal(
    result.unmetDemands.some((demand) => demand.account.typeId === 34),
    false,
  );
});

void test("uses sell orders for direct demand and keeps their ledger source separate", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "market-stockpile",
        name: "Market stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 34, quantity: 150, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      { typeId: 34, name: "Tritanium", quantity: 71, locationId: 10 },
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 81,
        locationId: 10,
        source: "marketOrder",
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const balance = result.ledgers
    .find((ledger) => ledger.locationId === 10)
    ?.balances.find((candidate) => candidate.typeId === 34);

  assert.ok(balance);
  assert.equal(balance.availableNow, 71);
  assert.equal(balance.availableFromSellOrders, 81);
  assert.equal(balance.unsatisfied, 0);
  assert.equal(result.lists.haulingTasks.length, 0);
});

void test("does not haul remote stock when local sell orders satisfy demand", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "market-stockpile",
        name: "Market stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 34, quantity: 2, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      { typeId: 34, name: "Tritanium", quantity: 3, locationId: 10, source: "marketOrder" },
      { typeId: 34, name: "Tritanium", quantity: 2, locationId: 20 },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const balance = result.ledgers
    .find((ledger) => ledger.locationId === 10)
    ?.balances.find((candidate) => candidate.typeId === 34);
  const remoteBalance = result.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find((candidate) => candidate.typeId === 34);

  assert.ok(balance);
  assert.ok(remoteBalance);
  assert.equal(balance.availableFromSellOrders, 3);
  assert.equal(balance.availableFromHauling, 0);
  assert.equal(balance.futureDemand, 0);
  assert.equal(balance.unsatisfied, 0);
  assert.deepEqual(result.lists.haulingTasks, []);
  assert.equal(remoteBalance.availableNow, 2);
  assert.equal(remoteBalance.transferredOut, 0);
});

void test("satisfies Amarr stockpile demand from local Reinforced Carbon Fiber sell orders", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "amarr-stockpile",
        name: "Amarr Stockpile",
        locations: {
          stock: 60008494,
          manufacturing: 1055354926818,
          reactions: 1055354982663,
          reprocessing: 1055354982663,
          copying: 1055355113677,
          invention: 1055355113677,
        },
        items: [{ typeId: 57457, quantity: 500_000, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      {
        typeId: 57457,
        name: "Reinforced Carbon Fiber",
        quantity: 1_027_851,
        locationId: 60008494,
        source: "marketOrder",
      },
      {
        typeId: 57457,
        name: "Reinforced Carbon Fiber",
        quantity: 500_000,
        locationId: 60003760,
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const balance = result.ledgers
    .find((ledger) => ledger.locationId === 60008494)
    ?.balances.find((candidate) => candidate.typeId === 57457);

  assert.ok(balance);
  assert.equal(balance.availableFromSellOrders, 1_027_851);
  assert.equal(balance.requiredNow, 500_000);
  assert.equal(balance.futureSupply, 0);
  assert.equal(balance.surplus, 527_851);
  assert.equal(
    result.lists.haulingTasks.some((task) => task.typeId === 57457),
    false,
  );
});

void test("does not use sell orders for manufacturing inputs or hauling", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "manufacturing-stockpile",
        name: "Manufacturing stockpile",
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
        typeId: 34,
        name: "Tritanium",
        quantity: 1_000_000,
        locationId: 20,
        source: "marketOrder",
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const job = result.lists.manufacturingJobs.find((candidate) => candidate.productTypeId === 587);
  const input = job?.inputs.find((candidate) => candidate.typeId === 34);

  assert.ok(input);
  assert.equal(input.availableNow, 0);
  assert.equal(input.availableFromHauling, 0);
  assert.ok((input.purchaseQuantity ?? 0) > 0);
  assert.equal(result.lists.haulingTasks.length, 0);
});

void test("hauls only the missing quantity from a remote in-flight reaction output", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "industrial-menace",
        name: "The Industrial Menace",
        locations: {
          stock: 100,
          manufacturing: 100,
          reactions: 200,
          reprocessing: 100,
          copying: 100,
          invention: 100,
        },
        items: [{ typeId: 30305, quantity: 5_991, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: {
      items: [{ typeId: 30305, quantity: 402, locationId: 100, rootLocationId: 100 }],
      market: [],
      blueprints: [],
      industry: [
        {
          jobId: 123,
          typeId: 30305,
          blueprintTypeId: 46160,
          quantity: 5_760,
          runs: 48,
          activity: "reaction",
          status: "active",
          locationId: 200,
          rootLocationId: 200,
        },
      ],
    },
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const destinationBalance = result.ledgers
    .find((ledger) => ledger.locationId === 100)
    ?.balances.find((candidate) => candidate.typeId === 30305);
  const sourceBalance = result.ledgers
    .find((ledger) => ledger.locationId === 200)
    ?.balances.find((candidate) => candidate.typeId === 30305);

  assert.equal(result.lists.reactionJobs.length, 0);
  assert.ok(destinationBalance);
  assert.ok(sourceBalance);
  assert.equal(destinationBalance.availableNow, 402);
  assert.equal(destinationBalance.availableFromHauling, 5_589);
  assert.equal(destinationBalance.unsatisfied, 0);
  assert.equal(sourceBalance.inFlightQuantity, 5_760);
  assert.equal(sourceBalance.transferredOut, 5_589);
  assert.equal(sourceBalance.surplus, 171);
  assert.deepEqual(
    result.lists.haulingTasks.map((task) => task.quantity),
    [5_589],
  );
  assert.equal(result.lists.haulingTasks[0]?.fromLocationId, 200);
  assert.equal(result.lists.haulingTasks[0]?.toLocationId, 100);
});
