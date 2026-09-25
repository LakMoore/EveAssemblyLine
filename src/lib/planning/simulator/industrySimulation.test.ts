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
