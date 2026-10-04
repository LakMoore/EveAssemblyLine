import assert from "node:assert/strict";
import test from "node:test";
import { loadSimulationContext } from "./context";
import { buildDependencyGraph } from "./dependencyGraph";
import { simulateIndustryDemand } from "./industrySimulation";
import { projectSimulationLedger } from "./ledger";
import { parseSimulatorRequest } from "./schema";
import { simulateIndustry } from "./simulate";
import { normalizeSimulatorInventory } from "./sourceLots";
import { inventionSuccessConfidence, minimumAttemptsForSuccesses } from "./binomial";

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

void test("hauls available Charon components to A while protecting A-local demand", async () => {
  const stationA = 70;
  const stationB = 80;
  const stationC = 90;
  const componentTypeId = 21009;
  const result = await simulateIndustry(
    parseSimulatorRequest({
      stockpiles: [
        {
          id: "charon",
          name: "Charon",
          locations: {
            stock: stationA,
            manufacturing: stationA,
            reactions: 30,
            reprocessing: 40,
            copying: 50,
            invention: 60,
          },
          groupAssignments: {
            largeShips: stationA,
            capitalComponents: stationB,
          },
          items: [{ typeId: 20185, quantity: 1, me: 0, te: 0, fromCompression: false }],
        },
        {
          id: "other-stockpile-demand",
          name: "Other stockpile demand",
          locations: {
            stock: 100,
            manufacturing: 91,
            reactions: 91,
            reprocessing: 91,
            copying: 91,
            invention: 91,
          },
          items: [{ typeId: componentTypeId, quantity: 2, me: 0, te: 0, fromCompression: false }],
        },
      ],
      assets: [
        { typeId: componentTypeId, quantity: 1, locationId: stationA },
        { typeId: componentTypeId, quantity: 1, locationId: stationB },
        { typeId: componentTypeId, quantity: 2, locationId: stationC },
      ],
      settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
      simulation: { version: 1, blockInterStockpileHauling: true },
    }),
  );

  const charonJob = result.lists.manufacturingJobs.find((job) => job.productTypeId === 20185);
  const componentJob = result.lists.manufacturingJobs.find(
    (job) => job.productTypeId === componentTypeId && job.locationId === stationB,
  );
  const componentInput = charonJob?.inputs.find((input) => input.typeId === componentTypeId);
  assert.ok(charonJob);
  assert.ok(componentJob);
  assert.ok(componentInput);
  assert.equal(charonJob.locationId, stationA);
  assert.equal(componentJob.locationId, stationB);
  assert.equal(componentInput.availableNow, 1);
  assert.equal(componentInput.availableFromHauling, 3);
  assert.ok(
    componentInput.upstreamReservations?.some(
      (reservation) => reservation.sourceJobId === componentJob.jobId && reservation.quantity === 1,
    ),
  );
  assert.deepEqual(
    result.lists.haulingTasks
      .filter((task) => task.typeId === componentTypeId)
      .map((task) => [task.fromLocationId, task.toLocationId, task.quantity])
      .sort((left, right) => Number(left[0]) - Number(right[0])),
    [
      [stationB, stationA, 1],
      [stationC, stationA, 2],
    ],
  );
  assert.equal(
    result.lists.haulingTasks.some(
      (task) =>
        task.typeId === componentTypeId
        && task.fromLocationId === stationA
        && task.toLocationId === 100,
    ),
    false,
  );
});

void test("rounds reaction inputs per simulated maximum-duration install", async () => {
  const createResult = async (maxReactionJobDurationHours: number) =>
    simulateIndustry(
      parseSimulatorRequest({
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
            items: [{ typeId: 16680, quantity: 15_400, me: 0, te: 0, fromCompression: false }],
          },
        ],
        assets: [],
        settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
        facilityProfiles: [
          {
            locationId: 30,
            systemId: 30_000_142,
            sizeId: 1,
            buildTypeGroups: {
              compositeReactions: {
                manufacturingMaterialMultiplier: 1,
                manufacturingMaterialPercentage: 0,
                manufacturingTimeMultiplier: 1,
                manufacturingTimePercentage: 0,
                reactionMaterialMultiplier: 0.978,
                reactionMaterialPercentage: -2.2,
                reactionTimeMultiplier: 1,
                reactionTimePercentage: 0,
              },
            },
          },
        ],
        simulation: { version: 1, maxReactionJobDurationHours },
      }),
    );

  const [oneHourResult, oneDayResult] = await Promise.all([createResult(1), createResult(24)]);
  const getJob = (result: Awaited<ReturnType<typeof createResult>>) => {
    const job = result.lists.reactionJobs.find((candidate) => candidate.productTypeId === 16680);
    assert.ok(job);
    assert.equal(job.requiredRuns, 7);
    return job;
  };

  const oneHourJob = getJob(oneHourResult);
  const oneDayJob = getJob(oneDayResult);
  assert.equal(oneHourJob.inputs.find((input) => input.typeId === 16663)?.requiredQuantity, 686);
  assert.equal(oneDayJob.inputs.find((input) => input.typeId === 16663)?.requiredQuantity, 685);
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
  const upstreamJob = result.manufacturingJobs.find(
    (candidate) => candidate.productTypeId === 4312,
  );
  assert.ok(input);
  assert.ok(upstreamJob);
  assert.equal(input.requiredQuantity, 6);
  assert.deepEqual(
    input.upstreamReservations?.[0],
    {
      activity: "manufacturing",
      quantity: 6,
      state: "planned",
      sourceJobId: upstreamJob.jobId,
      sourceOutputQuantity: 40,
    },
  );
});

void test("pools shared fuel-block demand before rounding manufacturing runs", async () => {
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
        items: [
          { typeId: 30304, quantity: 250, me: 0, te: 0, fromCompression: false },
          { typeId: 16660, quantity: 200, me: 0, te: 0, fromCompression: false },
        ],
      },
    ],
    assets: [],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const fuelJobs = result.lists.manufacturingJobs.filter((job) => job.productTypeId === 4246);
  const fuelDemand = result.lists.planItems
    .flatMap((bucket) => bucket.items)
    .find((item) => item.typeId === 4246 && item.locationId === 30);
  const fuelProduction = result.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find((item) => item.typeId === 4246);

  assert.ok(fuelDemand);
  assert.equal(
    fuelDemand.demandSources.reduce((total, source) => total + source.plannedQuantity, 0),
    10,
  );
  assert.equal(
    fuelJobs.reduce((total, job) => total + job.requiredRuns, 0),
    1,
  );
  assert.deepEqual(
    fuelJobs[0].demandSources
      .map((source) => source.productTypeId)
      .sort((left, right) => left - right),
    [16660, 30304],
  );
  assert.equal(fuelProduction?.availableFromProduction, 40);
});

void test("pools production for stockpiles sharing activity facilities", async () => {
  const stockpile = (id: string, stock: number, productTypeId: number, quantity: number) => ({
    id,
    name: id,
    locations: {
      stock,
      manufacturing: 20,
      reactions: 30,
      reprocessing: 40,
      copying: 50,
      invention: 60,
    },
    items: [{ typeId: productTypeId, quantity, me: 0, te: 0, fromCompression: false }],
  });
  const result = await simulateIndustry(
    parseSimulatorRequest({
      stockpiles: [stockpile("first", 10, 30304, 250), stockpile("second", 11, 16660, 200)],
      assets: [],
      settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
      simulation: { version: 1, blockInterStockpileHauling: true },
    }),
  );
  const fuelJobs = result.lists.manufacturingJobs.filter((job) => job.productTypeId === 4246);

  assert.equal(
    fuelJobs.reduce((total, job) => total + job.requiredRuns, 0),
    1,
  );
  assert.deepEqual(
    fuelJobs[0].demandSources.map((source) => source.stockpileId).sort(),
    ["first", "second"],
  );
});

void test("plans nested reaction parents before rounding shared fuel-block demand", async () => {
  const result = await simulateIndustry(
    parseSimulatorRequest({
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
          items: [
            { typeId: 30304, quantity: 250, me: 0, te: 0, fromCompression: false },
            { typeId: 16673, quantity: 10_000, me: 0, te: 0, fromCompression: false },
          ],
        },
      ],
      assets: [],
      settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
      simulation: { version: 1 },
    }),
  );
  const fuelJobs = result.lists.manufacturingJobs.filter((job) => job.productTypeId === 4246);
  const fuelDemand = result.lists.planItems
    .flatMap((bucket) => bucket.items)
    .find((item) => item.typeId === 4246 && item.locationId === 30);

  assert.ok(fuelDemand);
  const totalDemand = fuelDemand.demandSources.reduce(
    (total, source) => total + source.plannedQuantity,
    0,
  );
  assert.ok(totalDemand > 5 && totalDemand <= 40);
  assert.equal(
    fuelJobs.reduce((total, job) => total + job.requiredRuns, 0),
    1,
  );
});

void test("prioritizes same-system remote stockpile demand", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "cross-system",
        name: "Cross-system",
        locations: {
          stock: 20,
          manufacturing: 20,
          reactions: 20,
          reprocessing: 20,
          copying: 20,
          invention: 20,
        },
        items: [{ typeId: 34, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
      {
        id: "same-system",
        name: "Same-system",
        locations: {
          stock: 40,
          manufacturing: 40,
          reactions: 40,
          reprocessing: 40,
          copying: 40,
          invention: 40,
        },
        items: [{ typeId: 34, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      {
        typeId: 34,
        quantity: 1,
        locationId: 30,
        rootLocationId: 30,
        sourceSystemId: 30000142,
      },
    ],
    facilityProfiles: [
      { locationId: 20, systemId: 30000143, sizeId: 1, buildTypeGroups: {} },
      { locationId: 30, systemId: 30000142, sizeId: 1, buildTypeGroups: {} },
      { locationId: 40, systemId: 30000142, sizeId: 1, buildTypeGroups: {} },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  assert.deepEqual(
    result.lists.haulingTasks.map((task) => [task.fromLocationId, task.toLocationId]),
    [[30, 40]],
  );
});

void test("aggregates repeated component demand before blueprint allocation", async () => {
  const blueprint = (typeId: number, runs: number) => ({
    typeId,
    quantity: 1,
    locationId: 20,
    rootLocationId: 20,
    type: "bpc" as const,
    runs,
    me: 10,
    te: 0,
  });
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
        items: [{ typeId: 57483, quantity: 3, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: {
      items: [],
      blueprints: [
        blueprint(57520, 1),
        blueprint(57520, 1),
        blueprint(57520, 1),
        blueprint(57517, 40),
        blueprint(57517, 11),
      ],
      industry: [],
      market: [],
    },
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [],
      buyBlacklist: [],
    },
    facilityProfiles: [
      {
        locationId: 20,
        systemId: 30000142,
        sizeId: 1,
        buildTypeGroups: {
          components: {
            manufacturingMaterialMultiplier: 0.94842,
            manufacturingMaterialPercentage: -5.158,
            manufacturingTimeMultiplier: 1,
            manufacturingTimePercentage: 0,
            reactionMaterialMultiplier: 1,
            reactionMaterialPercentage: 0,
            reactionTimeMultiplier: 1,
            reactionTimePercentage: 0,
          },
        },
      },
    ],
    simulation: { version: 1 },
  });
  const result = await simulateIndustry(request);
  const membraneJobs = result.lists.manufacturingJobs.filter((job) => job.productTypeId === 57480);

  assert.equal(membraneJobs.length, 1);
  assert.equal(membraneJobs[0]?.requiredRuns, 3);
  assert.deepEqual(
    membraneJobs[0]?.inputs.map((input) => [input.typeId, input.requiredQuantity]),
    [
      [2361, 257],
      [2348, 769],
      [11399, 3842],
    ],
  );

  const parentJobs = result.lists.manufacturingJobs.filter((job) => job.productTypeId === 57483);
  assert.equal(parentJobs.length, 3);
  assert.deepEqual(
    parentJobs.map(
      (job) =>
        job.inputs.find((input) => input.typeId === 57480)?.upstreamReservations?.[0]?.quantity,
    ),
    [1, 1, 1],
  );
  assert.equal(
    new Set(
      parentJobs.flatMap(
        (job) =>
          job.inputs
            .find((input) => input.typeId === 57480)
            ?.upstreamReservations?.map((reservation) => reservation.sourceJobId) ?? [],
      ),
    ).size,
    1,
  );
});

void test("reports local Tritanium allocation when another prerequisite blocks installation", async () => {
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
  const tritaniumInput = result.manufacturingJobs
    .flatMap((job) => job.inputs)
    .find((input) => input.typeId === 34);
  assert.ok(tritaniumDemand);
  assert.ok(tritaniumInput);
  assert.equal(tritaniumDemand.source.requiredNow, 0);
  const readiness = result.transactions.filter(
    (transaction) =>
      transaction.kind === "demand-readiness"
      && transaction.demandId === tritaniumDemand.source.demandId,
  );
  assert.equal(
    readiness.reduce((total, transaction) => total + transaction.quantity, 0),
    tritaniumInput.availableNow,
  );
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
  assert.equal(
    result.lists.haulingTasks.some((task) => task.typeId === 34),
    false,
  );
  assert.equal(
    result.lists.haulingTasks.some((task) => task.typeId === 587),
    false,
  );
});

void test("credits remote in-flight reaction output without an actionable haul", async () => {
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
  assert.equal(destinationBalance.availableFromProduction, 0);
  assert.equal(destinationBalance.futureSupply, 5_589);
  assert.equal(destinationBalance.unsatisfied, 0);
  assert.equal(sourceBalance.inFlightQuantity, 5_760);
  assert.deepEqual(result.lists.haulingTasks, []);
});

void test("rounds invention output to the whole copies needed for demand", async () => {
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
        items: [{ typeId: 1952, quantity: 10, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      {
        typeId: 11620,
        quantity: 1,
        rootLocationId: 60,
        blueprintPrints: [{ itemId: 1, runs: 25, type: "bpc" }],
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: {
      version: 1,
      characters: [
        {
          characterId: 1,
          freeSlots: { manufacturing: 100, reactions: 100, science: 100 },
          timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
          skillLevels: { "11448": 4, "11453": 4, "21790": 4 },
        },
      ],
    },
  });

  for (const requiredOutputRuns of [4, 10, 40]) {
    const demandRequest = structuredClone(request);
    demandRequest.stockpiles[0].items[0].quantity = requiredOutputRuns;
    const result = await simulateIndustry(demandRequest);
    const inventionJob = result.lists.inventionJobs.find(
      (job) => job.sourceBlueprintTypeId === 11620,
    );
    const sourceInput = inventionJob?.inputs.find((input) => input.typeId === 11620);
    const requiredOutputCopies = Math.ceil(requiredOutputRuns / 10);

    assert.ok(inventionJob);
    assert.ok(sourceInput);
    assert.equal(inventionJob.runsPerSuccess, 10);
    assert.equal(inventionJob.requiredOutputRuns, requiredOutputRuns);
    assert.equal(inventionJob.targetSuccessProbability, inventionSuccessConfidence);
    assert.equal(
      inventionJob.attempts,
      minimumAttemptsForSuccesses(requiredOutputCopies, inventionJob.successProbability),
    );
    assert.equal(inventionJob.expectedOutputCopies, requiredOutputCopies);
    assert.equal(inventionJob.expectedOutputRuns, requiredOutputCopies * 10);
    assert.equal(sourceInput.quantityKind, "blueprint-run");
    assert.equal(sourceInput.requiredQuantity, inventionJob.attempts);
    assert.equal(result.metadata.invariantViolationCount, 0);
  }
});

void test("buys one relic per T3 invention attempt after remote relic stock is hauled", async () => {
  const baseRequest = {
    stockpiles: [
      {
        id: "t3-stockpile",
        name: "T3 stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 29990, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  };
  const unstockedResult = await simulateIndustry(
    parseSimulatorRequest({
      ...baseRequest,
      assets: [],
    }),
  );
  const unstockedJob = unstockedResult.lists.inventionJobs.find(
    (job) => job.sourceBlueprintTypeId === 30752,
  );
  const unstockedRelicPurchase = unstockedResult.lists.materialsToBuy.find(
    (purchase) => purchase.typeId === 30752,
  );

  assert.ok(unstockedJob);
  assert.ok(unstockedRelicPurchase);
  assert.equal(
    unstockedJob.inputs.find((input) => input.typeId === 30752)?.requiredQuantity,
    unstockedJob.attempts,
  );
  assert.equal(unstockedRelicPurchase.quantity, unstockedJob.attempts);
  assert.equal(
    unstockedResult.lists.bpcToCopy.some((job) => job.blueprintTypeId === 30752),
    false,
  );
  assert.equal(
    unstockedResult.lists.bpoToBuy.some((purchase) => purchase.typeId === 30752),
    false,
  );

  const hauledResult = await simulateIndustry(
    parseSimulatorRequest({
      ...baseRequest,
      assets: {
        items: [],
        blueprints: [
          {
            typeId: 30752,
            type: "bpc",
            quantity: 1,
            runs: 1,
            locationId: 80,
            rootLocationId: 80,
          },
        ],
        industry: [],
        market: [],
      },
    }),
  );
  const hauledJob = hauledResult.lists.inventionJobs.find(
    (job) => job.sourceBlueprintTypeId === 30752,
  );
  const hauledRelicPurchase = hauledResult.lists.materialsToBuy.find(
    (purchase) => purchase.typeId === 30752,
  );
  const inventionRelicBalance = hauledResult.ledgers
    .find((ledger) => ledger.locationId === 60)
    ?.balances.find((balance) => balance.typeId === 30752 && balance.quantityKind === "item");

  assert.ok(hauledJob);
  assert.ok(inventionRelicBalance);
  assert.equal(hauledJob.inputs.find((input) => input.typeId === 30752)?.availableFromHauling, 1);
  assert.equal(hauledRelicPurchase?.quantity, hauledJob.attempts - 1);
  assert.equal(hauledResult.lists.haulingTasks.find((task) => task.typeId === 30752)?.quantity, 1);
  assert.equal(inventionRelicBalance.availableFromCopying, 0);
});

void test("reserves invention materials before competing stockpile demand", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "fuel-stock",
        name: "Fuel stock",
        locations: {
          stock: 60,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [
          { typeId: 1952, quantity: 95, me: 0, te: 0, fromCompression: false },
          { typeId: 20417, quantity: 10, me: 0, te: 0, fromCompression: false },
        ],
      },
    ],
    assets: [
      {
        typeId: 11620,
        quantity: 1,
        rootLocationId: 60,
        blueprintPrints: [{ itemId: 1, runs: 25, type: "bpc" }],
      },
      { typeId: 20417, quantity: 10, rootLocationId: 60 },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: {
      version: 1,
      characters: [
        {
          characterId: 1,
          freeSlots: { manufacturing: 100, reactions: 100, science: 100 },
          timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
          skillLevels: { "11448": 4, "11453": 4, "21790": 4 },
        },
      ],
    },
  });

  const result = await simulateIndustry(request);
  const inventionJob = result.lists.inventionJobs.find(
    (job) => job.sourceBlueprintTypeId === 11620,
  );
  const scienceInput = inventionJob?.inputs.find((input) => input.typeId === 20417);

  assert.ok(scienceInput);
  assert.ok(scienceInput.availableNow > 0);
});

void test("reserves full local reaction inputs before competing stockpile demand", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "stockpile-1790119900393-hrnhot",
        name: "Main",
        locations: {
          stock: 60,
          manufacturing: 20,
          reactions: 60,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 4312, quantity: 20_000, me: 0, te: 0, fromCompression: false }],
      },
      {
        id: "a-munory",
        name: "Manufacturing demand one",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 60,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 61199, quantity: 4, me: 0, te: 0, fromCompression: false }],
      },
      {
        id: "z-jita",
        name: "Manufacturing demand two",
        locations: {
          stock: 11,
          manufacturing: 20,
          reactions: 60,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 11688, quantity: 17, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      { typeId: 16682, quantity: 87, locationId: 20, rootLocationId: 20 },
      { typeId: 16664, quantity: 59, locationId: 60, rootLocationId: 60 },
      {
        typeId: 4312,
        quantity: 14_535,
        locationId: 60,
        rootLocationId: 60,
        ownerType: "corporation",
        ownerId: 98686879,
      },
    ],
    settings: {
      includeCorporationAssets: true,
      buildBlacklist: [4312],
      buyBlacklist: [],
    },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  const fuelTotalsByProduct = new Map<number, { required: number; availableNow: number }>();
  for (const job of result.lists.reactionJobs) {
    if (job.productTypeId !== 16682 && job.productTypeId !== 16664) continue;
    const input = job.inputs.find((candidate) => candidate.typeId === 4312);
    assert.ok(input);
    const totals = fuelTotalsByProduct.get(job.productTypeId) ?? {
      required: 0,
      availableNow: 0,
    };
    totals.required += input.requiredQuantity;
    totals.availableNow += input.availableNow;
    fuelTotalsByProduct.set(job.productTypeId, totals);
  }

  for (const productTypeId of [16682, 16664]) {
    const fuel = fuelTotalsByProduct.get(productTypeId);
    assert.ok(fuel);
    assert.ok(fuel.required > 0);
    assert.equal(fuel.availableNow, fuel.required);
  }
  const fuelBalance = result.ledgers
    .find((ledger) => ledger.locationId === 60)
    ?.balances.find((balance) => balance.typeId === 4312);
  assert.ok(fuelBalance);
  assert.equal(
    fuelBalance.demandSources.find(
      (source) => source.stockpileId === "stockpile-1790119900393-hrnhot",
    )?.requiredNow,
    14_535 - [...fuelTotalsByProduct.values()].reduce((total, fuel) => total + fuel.required, 0),
  );
});

void test("uses every active invention BPC copy and exposes manufacturing blueprint demand", async () => {
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
        items: [{ typeId: 1952, quantity: 95, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: {
      items: [],
      market: [],
      blueprints: [],
      industry: [
        {
          jobId: 2,
          typeId: 11808,
          blueprintTypeId: 11620,
          quantity: 11,
          runs: 1,
          licensedRuns: 10,
          activity: "invention",
          status: "active",
          locationId: 60,
          rootLocationId: 60,
        },
      ],
    },
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  const blueprintBalance = result.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find(
      (balance) => balance.typeId === 11808 && balance.quantityKind === "blueprint-run",
    );
  const sourceBalance = result.ledgers
    .find((ledger) => ledger.locationId === 60)
    ?.balances.find(
      (balance) => balance.typeId === 11808 && balance.quantityKind === "blueprint-run",
    );

  assert.equal(result.lists.inventionJobs.length, 0);
  assert.ok(blueprintBalance);
  assert.ok(sourceBalance);
  assert.equal(blueprintBalance.reserved, 95);
  assert.equal(blueprintBalance.availableFromHauling, 0);
  assert.equal(blueprintBalance.availableFromInvention, 95);
  assert.equal(blueprintBalance.futureSupply, 95);
  assert.equal(blueprintBalance.unsatisfied, 0);
  assert.equal(sourceBalance.inFlightQuantity, 110);
  assert.equal(sourceBalance.futureSupply, 15);
  assert.equal(sourceBalance.transferredOut, 0);
  assert.equal(result.metadata.invariantViolationCount, 0);
});
