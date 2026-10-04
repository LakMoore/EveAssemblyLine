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
  assert.equal(tasks[0].lotId, "one");
  assert.equal(tasks[0].sourceLots, undefined);
});

void test("groups source lots by haul route while retaining purpose and lot quantities", () => {
  const sharedRoute = {
    typeId: 34,
    typeName: "Tritanium",
    unitVolume: 0.01,
    fromLocationId: 10,
    toLocationId: 20,
    ownerType: "character" as const,
    ownerId: 7,
  };
  const tasks = aggregateHaulingTasks([
    {
      ...sharedRoute,
      transferId: "first",
      lotId: "lot-a",
      quantity: 5,
      purpose: "stockpile-demand",
      demands: [{ jobId: "first-job", quantity: 5 }],
    },
    {
      ...sharedRoute,
      transferId: "second",
      lotId: "lot-b",
      quantity: 7,
      purpose: "stockpile-demand",
      demands: [{ jobId: "second-job", quantity: 7 }],
    },
    {
      ...sharedRoute,
      transferId: "third",
      lotId: "lot-c",
      quantity: 3,
      purpose: "industry-input",
      demands: [{ jobId: "third-job", quantity: 3 }],
    },
  ]);
  assert.deepEqual(
    tasks.map((task) => [task.purpose, task.quantity]),
    [
      ["industry-input", 3],
      ["stockpile-demand", 12],
    ],
  );
  assert.deepEqual(
    tasks[1].sourceLots,
    [
      { lotId: "lot-a", quantity: 5 },
      { lotId: "lot-b", quantity: 7 },
    ],
  );
  assert.equal(tasks[1].lotId, undefined);
  assert.deepEqual(
    tasks[1].demands,
    [
      { jobId: "first-job", quantity: 5 },
      { jobId: "second-job", quantity: 7 },
    ],
  );
});

void test("keeps haul horizons and blueprint kinds distinct with stable grouped identities", () => {
  const common = {
    typeId: 57457,
    typeName: "Reinforced Carbon Fiber",
    unitVolume: 0.1,
    fromLocationId: 10,
    toLocationId: 20,
    ownerType: "character" as const,
    ownerId: 7,
    purpose: "stockpile-demand" as const,
    demands: [],
  };
  const transfers = Array.from(
    { length: 5 },
    (_, index) => ({
      ...common,
      transferId: `transfer-${index}`,
      lotId: `lot-${index}`,
      quantity: 3600,
      horizon: "now" as const,
    }),
  );
  const distinctHorizon = {
    ...transfers[0],
    transferId: "future-transfer",
    lotId: "future-lot",
    horizon: "after-upstream" as const,
  };
  const distinctBlueprintKind = {
    ...transfers[0],
    transferId: "blueprint-transfer",
    lotId: "blueprint-lot",
    blueprintKind: "bpc" as const,
  };
  const tasks = aggregateHaulingTasks([...transfers, distinctHorizon, distinctBlueprintKind]);
  assert.equal(tasks.length, 3);
  const combined = tasks.find((task) => task.horizon === "now" && !task.blueprintKind);
  assert.equal(combined?.quantity, 18000);
  assert.equal(combined.quantity * combined.unitVolume, 1800);
  assert.equal(combined.sourceLots?.length, 5);
  assert.equal(combined.lotId, undefined);
  assert.equal(aggregateHaulingTasks([...transfers].reverse())[0].transferId, combined.transferId);
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
  assert.equal(first.metadata.simulatorVersion, 15);
  assert.equal(first.metadata.normalizedInputHash, second.metadata.normalizedInputHash);
  assert.equal(first.metadata.invariantViolationCount, 0);
  assert.ok(first.lists.manufacturingJobs.some((job) => job.productTypeId === 587));
  const manufacturedPlanItem = first.lists.planItems
    .flatMap((bucket) => bucket.items)
    .find((item) => item.typeId === 587);
  assert.ok(manufacturedPlanItem);
  assert.ok(manufacturedPlanItem.availableFromProduction > 0);
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
  const facilityOutput = first.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find((balance) => balance.typeId === 587);
  assert.equal(facilityOutput?.availableFromProduction, 1);
  assert.equal(facilityOutput.transferredOut, 1);
  assert.deepEqual(
    first.lists.haulingTasks
      .filter((task) => task.typeId === 587)
      .map((task) => [task.fromLocationId, task.toLocationId, task.quantity, task.purpose]),
    [],
  );
});

void test("keeps sell-order availability in the Plan presentation", async () => {
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
        items: [{ typeId: 34, quantity: 81, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
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
  const item = result.lists.planItems
    .flatMap((bucket) => bucket.items)
    .find((candidate) => candidate.typeId === 34);

  assert.ok(item);
  assert.equal(item.availableNow, 0);
  assert.equal(item.availableFromSellOrders, 81);
});

void test("buys and declares complete portions for committed reprocessing input", async () => {
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
        items: [{ typeId: 18, quantity: 99, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  assert.equal(result.lists.materialsToBuy.find((item) => item.typeId === 18)?.quantity, 100);
  assert.equal(result.lists.reprocessingJobs[0]?.quantities.afterPurchaseSourceQuantity, 100);
  const source = result.lists.planItems
    .flatMap((bucket) => bucket.items)
    .find((item) => item.typeId === 18);
  assert.equal((source?.requiredNow ?? 0) + (source?.reserved ?? 0), 100);
});

void test("tracks reaction formula counts and required runs at the reaction location", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "reaction-stockpile",
        name: "Reaction stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 16672, quantity: 20, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      {
        typeId: 46207,
        name: "Reaction Formula",
        quantity: 2,
        category: "reactionformula",
        locationId: 30,
      },
      {
        typeId: 46207,
        name: "Reaction Formula",
        quantity: 1,
        category: "reactionformula",
        locationId: 30,
        inUse: true,
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
  const reactionJob = result.lists.reactionJobs.find((job) => job.productTypeId === 16672);
  const formula = result.lists.reactionFormulas
    ?.find((bucket) => bucket.locationId === 30)
    ?.items.find((item) => item.typeId === 46207);

  assert.ok(reactionJob);
  assert.ok(formula);
  assert.equal(formula.ownedQuantity, 3);
  assert.equal(formula.availableQuantity, 2);
  assert.equal(formula.inUseQuantity, 1);
  assert.equal(formula.requiredRuns, reactionJob.requiredRuns);
  assert.equal(formula.demandSources[0]?.jobId, reactionJob.jobId);
  assert.equal(
    result.lists.bpoToBuy.some((purchase) => purchase.typeId === 46207),
    false,
  );
});

void test("adds missing reaction formulas to blueprint purchases", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "reaction-stockpile",
        name: "Reaction stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 16672, quantity: 20, me: 0, te: 0, fromCompression: false }],
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
  const formulaPurchase = result.lists.bpoToBuy.find((purchase) => purchase.typeId === 46207);

  assert.ok(result.lists.reactionFormulas?.some((bucket) => bucket.items.length > 0));
  assert.ok(formulaPurchase);
  assert.equal(formulaPurchase.quantity, 1);
  assert.equal(formulaPurchase.destinations[0]?.locationId, 30);
});

void test("buys one missing reaction formula per type and reaction location", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "reaction-stockpile",
        name: "Reaction stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [
          { typeId: 16672, quantity: 20, me: 0, te: 0, fromCompression: false },
          { typeId: 16673, quantity: 20, me: 0, te: 0, fromCompression: false },
        ],
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
  const formulaPurchases = result.lists.bpoToBuy.filter((purchase) => purchase.typeId === 46207);

  assert.equal(formulaPurchases.length, 1);
  assert.equal(formulaPurchases[0]?.quantity, 1);
  assert.equal(formulaPurchases[0]?.destinations.length, 1);
  assert.equal(formulaPurchases[0]?.destinations[0]?.locationId, 30);
});

void test("buys one reusable original for stockpiles sharing a manufacturing location", async () => {
  const locations = {
    stock: 10,
    manufacturing: 20,
    reactions: 30,
    reprocessing: 40,
    copying: 50,
    invention: 60,
  };
  const request = parseSimulatorRequest({
    stockpiles: ["alpha", "beta"].map((id) => ({
      id,
      name: id,
      locations,
      items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
    })),
    assets: [],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  const originals = result.lists.bpoToBuy.filter((purchase) => purchase.typeId === 691);
  assert.equal(originals.length, 1);
  assert.equal(originals[0]?.quantity, 1);
});

void test("buys a reaction formula when the only available copy is haul-excluded", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "reaction-stockpile",
        name: "Reaction stockpile",
        locations: {
          stock: 10,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [{ typeId: 16672, quantity: 20, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [
      {
        typeId: 46207,
        name: "Reaction Formula",
        quantity: 1,
        category: "reactionformula",
        locationId: 31,
      },
    ],
    haulExclusions: [{ typeId: 46207, fromLocationId: 31, toLocationId: 30 }],
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

  const formulaPurchase = result.lists.bpoToBuy.find((purchase) => purchase.typeId === 46207);
  assert.ok(formulaPurchase);
  assert.equal(formulaPurchase.quantity, 1);
  assert.equal(formulaPurchase.destinations[0]?.locationId, 30);
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
  const sharedJob = result.lists.manufacturingJobs.find((job) => job.productTypeId === 587);
  assert.ok(sharedJob);
  assert.deepEqual(
    sharedJob.demandSources.map((source) => source.stockpileId).sort(),
    ["alpha", "beta"],
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

void test("uses unclaimed stock after exact blueprint efficiency is known", async () => {
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 20,
          manufacturing: 20,
          reactions: 30,
          reprocessing: 40,
          copying: 50,
          invention: 60,
        },
        items: [
          { typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false },
          { typeId: 34, quantity: 3200, me: 0, te: 0, fromCompression: false },
        ],
      },
    ],
    assets: {
      items: [{ typeId: 34, quantity: 32000, locationId: 20, rootLocationId: 20 }],
      blueprints: [
        {
          typeId: 691,
          itemId: 1,
          quantity: 1,
          locationId: 20,
          rootLocationId: 20,
          type: "bpo",
          runs: 0,
          me: 10,
          te: 0,
        },
      ],
      market: [],
      industry: [],
    },
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  assert.equal(
    result.lists.manufacturingJobs
      .find((job) => job.productTypeId === 587)
      ?.inputs.find((input) => input.typeId === 34)?.requiredQuantity,
    28800,
  );
  assert.equal(
    result.lists.materialsToBuy.some((item) => item.typeId === 34),
    false,
  );
  const tritanium = result.lists.planItems
    .flatMap((bucket) => bucket.items)
    .find((item) => item.typeId === 34 && item.locationId === 20);
  assert.equal(tritanium?.requiredNow, 32000);
  assert.equal(tritanium.surplus, 0);
});

void test("preserves local recursive activity demand before final stockpile hauling", async () => {
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
    simulation: { version: 1 },
  };
  const result = await simulateIndustry(parseSimulatorRequest(input));

  assert.deepEqual(
    result.lists.haulingTasks.filter((task) => task.typeId === 11370),
    [],
  );
  const localAunerBalance = result.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find((balance) => balance.typeId === 11370);
  assert.ok(localAunerBalance);
  assert.equal(localAunerBalance.availableNow, 96);
  assert.equal(localAunerBalance.availableFromProduction, 203);
  assert.equal(localAunerBalance.transferredOut, 0);
});

void test("protects complete local reaction inputs when earlier demand consumes finished stock", async () => {
  const locations = (stock: number, reactions: number) => ({
    stock,
    manufacturing: reactions,
    reactions,
    reprocessing: reactions,
    copying: reactions,
    invention: reactions,
  });
  const item = (typeId: number, quantity: number) => ({
    typeId,
    quantity,
    me: 0,
    te: 0,
    fromCompression: false,
  });
  const request = parseSimulatorRequest({
    stockpiles: [
      { id: "a-first", name: "First", locations: locations(10, 20), items: [item(30304, 250)] },
      { id: "b-react", name: "React", locations: locations(10, 20), items: [item(30304, 7500)] },
      { id: "c-remote", name: "Remote", locations: locations(30, 30), items: [item(35, 783)] },
    ],
    assets: [
      { typeId: 30304, name: "PPD Fullerene Fibers", quantity: 250, locationId: 10 },
      { typeId: 35, name: "Pyerite", quantity: 23475, locationId: 20 },
    ],
    facilityProfiles: [
      {
        locationId: 20,
        systemId: 30000142,
        sizeId: 1,
        buildTypeGroups: {
          hybridReactions: {
            manufacturingMaterialMultiplier: 1,
            manufacturingMaterialPercentage: 0,
            manufacturingTimeMultiplier: 1,
            manufacturingTimePercentage: 0,
            reactionMaterialMultiplier: 0.978125,
            reactionMaterialPercentage: -2.1875,
            reactionTimeMultiplier: 1,
            reactionTimePercentage: 0,
          },
        },
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: { version: 1 },
  });

  const result = await simulateIndustry(request);
  const reaction = result.lists.reactionJobs.find((job) => job.productTypeId === 30304);
  const pyerite = reaction?.inputs.find((input) => input.typeId === 35);
  assert.ok(pyerite);
  assert.equal(pyerite.requiredQuantity, 23475);
  assert.equal(pyerite.availableNow, 23475);
  assert.equal(result.lists.haulingTasks.filter((task) => task.typeId === 35).length, 0);
  assert.equal(result.lists.materialsToBuy.find((buy) => buy.typeId === 35)?.quantity, 783);
  const balance = result.ledgers
    .find((ledger) => ledger.locationId === 20)
    ?.balances.find((row) => row.typeId === 35);
  assert.ok(balance);
  assert.equal(balance.requiredNow, 23475);
  assert.equal(balance.transferredOut, 0);
});
