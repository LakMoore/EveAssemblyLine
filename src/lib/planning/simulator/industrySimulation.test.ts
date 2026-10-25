import assert from "node:assert/strict";
import test from "node:test";
import { loadSimulationContext } from "./context";
import { buildDependencyGraph } from "./dependencyGraph";
import { simulateIndustryDemand, splitReactionRuns } from "./industrySimulation";
import { projectSimulationLedger } from "./ledger";
import { scheduleSimulationJobs } from "./scheduler";
import { parseSimulatorRequest } from "./schema";
import { simulateIndustry } from "./simulate";
import { normalizeSimulatorInventory } from "./sourceLots";
import { inventionSuccessConfidence, minimumAttemptsForSuccesses } from "./binomial";
import type { RequestProfiler } from "@/lib/server/profiling";

void test("balances duration-limited reaction batches across the minimum job count", () => {
  const runsPerJob = splitReactionRuns(617, 73);

  assert.equal(runsPerJob.length, 9);
  assert.deepEqual(runsPerJob, [69, 69, 69, 69, 69, 68, 68, 68, 68]);
  assert.equal(
    runsPerJob.reduce((total, runs) => total + runs, 0),
    617,
  );
  assert.ok(runsPerJob.every((runs) => runs <= 73));
});

void test("reserves shared scarce fuel for complete reaction run kits before blocked runs", async () => {
  const context = await loadSimulationContext();
  const productTypeId = 33362;
  const fuelTypeId = 4051;
  const bottleneckTypeId = 16654;
  const production = context.blueprints.byBuildProductTypeId.get(productTypeId);
  const recipe = production?.blueprint.activities.reaction;
  assert.ok(recipe);
  assert.ok(production);
  const fuel = recipe.materials.find((material) => material.typeID === fuelTypeId);
  const bottleneck = recipe.materials.find((material) => material.typeID === bottleneckTypeId);
  assert.ok(fuel);
  assert.ok(bottleneck);
  const sibling = [...context.blueprints.byBuildProductTypeId.entries()].find(
    ([typeId, candidate]) =>
      typeId > productTypeId
      && candidate.activity === "reaction"
      && candidate.blueprint.activities.reaction?.materials.some(
        (material) => material.typeID === fuelTypeId,
      )
      && candidate.blueprint.activities.reaction.materials.every(
        (material) => material.typeID !== bottleneckTypeId && material.typeID !== productTypeId,
      ),
  );
  assert.ok(sibling);
  const [siblingTypeId, siblingProduction] = sibling;
  const siblingRecipe = siblingProduction.blueprint.activities.reaction;
  assert.ok(siblingRecipe);
  const siblingFuel = siblingRecipe.materials.find((material) => material.typeID === fuelTypeId);
  assert.ok(siblingFuel);
  const product = recipe.products.find((candidate) => candidate.typeID === productTypeId);
  const siblingProduct = siblingRecipe.products.find(
    (candidate) => candidate.typeID === siblingTypeId,
  );
  assert.ok(product);
  assert.ok(siblingProduct);
  const quantities = new Map<number, number>();
  for (const [materials, runs] of [
    [recipe.materials, 10],
    [siblingRecipe.materials, 3],
  ] as const) {
    for (const material of materials) {
      if (material.typeID === fuelTypeId) continue;
      const quantity = material.quantity * (material.typeID === bottleneckTypeId ? 7 : runs);
      quantities.set(material.typeID, (quantities.get(material.typeID) ?? 0) + quantity);
    }
  }
  quantities.set(fuelTypeId, fuel.quantity * 7 + siblingFuel.quantity * 3);
  const request = parseSimulatorRequest({
    stockpiles: [
      {
        id: "shared-fuel",
        name: "Shared fuel",
        locations: {
          stock: 30,
          manufacturing: 30,
          reactions: 30,
          reprocessing: 30,
          copying: 30,
          invention: 30,
        },
        items: [
          {
            typeId: productTypeId,
            quantity: product.quantity * 10,
            me: 0,
            te: 0,
            fromCompression: false,
          },
          {
            typeId: siblingTypeId,
            quantity: siblingProduct.quantity * 3,
            me: 0,
            te: 0,
            fromCompression: false,
          },
        ],
      },
    ],
    assets: [
      ...[...quantities].map(([typeId, quantity]) => ({ typeId, quantity, rootLocationId: 30 })),
      { typeId: production.blueprint._key, quantity: 1, rootLocationId: 30 },
      { typeId: siblingProduction.blueprint._key, quantity: 1, rootLocationId: 30 },
    ],
    settings: {
      includeCorporationAssets: true,
      buildBlacklist: [...quantities.keys()],
      buyBlacklist: [],
    },
    simulation: { version: 1, maxReactionJobDurationHours: 8760 },
  });
  const result = await simulateIndustry(request);
  const firstJob = result.lists.reactionJobs.find((job) => job.productTypeId === productTypeId);
  const siblingJob = result.lists.reactionJobs.find((job) => job.productTypeId === siblingTypeId);
  assert.ok(firstJob);
  assert.ok(siblingJob);
  assert.equal(firstJob.readyNowRuns, 7);
  assert.equal(
    firstJob.inputs.find((input) => input.typeId === fuelTypeId)?.availableNow,
    fuel.quantity * 7,
  );
  assert.equal(siblingJob.readyNowRuns, 3);
  assert.equal(
    siblingJob.inputs.find((input) => input.typeId === fuelTypeId)?.availableNow,
    siblingFuel.quantity * 3,
  );
  assert.equal(result.metadata.invariantViolationCount, 0);
});

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
  const rifterSkillRequirements = result.jobSkillRequirements.filter(
    (requirement) => requirement.jobId === rifterJob.jobId,
  );
  assert.ok(rifterSkillRequirements.length > 0);
  assert.ok(
    rifterSkillRequirements.every((requirement) =>
      result.skillsRequired.some(
        (summary) =>
          summary.skillId === requirement.skillId
          && summary.jobIds.includes(rifterJob.jobId)
          && summary.requiredLevel >= requirement.requiredLevel,
      ),
    ),
  );
  assert.equal(rifterJob.readyNowRuns, 0);
  assert.equal(
    rifterJob.inputs.every(
      (input) => Number.isSafeInteger(input.requiredQuantity) && input.requiredQuantity > 0,
    ),
    true,
  );
  const projection = projectSimulationLedger(inventory.itemLots, result.transactions);
  assert.deepEqual(projection.invariantViolations, []);

  const activeInput = rifterJob.inputs[0];
  assert.ok(activeInput);
  const activeOutputRequest = parseSimulatorRequest({
    ...request,
    assets: [
      {
        typeId: activeInput.typeId,
        quantity: activeInput.requiredQuantity,
        locationId: 20,
        rootLocationId: 20,
        industryOutput: {
          activity: "reaction",
          state: "active",
          sourceJobId: 123,
        },
      },
    ],
  });
  const activeOutputInventory = normalizeSimulatorInventory(activeOutputRequest, context);
  const activeOutputResult = simulateIndustryDemand(
    activeOutputRequest,
    context,
    activeOutputInventory,
    graph,
  );
  const activeOutputJob = activeOutputResult.manufacturingJobs.find(
    (job) => job.productTypeId === 587,
  );
  const activeOutputInput = activeOutputJob?.inputs.find(
    (input) => input.typeId === activeInput.typeId,
  );

  assert.ok(activeOutputInput);
  assert.deepEqual(
    activeOutputInput.upstreamReservations,
    [
      {
        activity: "reaction",
        quantity: activeInput.requiredQuantity,
        state: "in-production",
        sourceJobId: 123,
        sourceOutputQuantity: activeInput.requiredQuantity,
      },
    ],
  );
});

void test("uses fallback blueprint ME and TE and schedules the modeled manufacturing job", async () => {
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
        items: [{ typeId: 587, quantity: 100, me: 0, te: 0, fromCompression: false }],
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
      fallbackT1Me: 8,
      fallbackT1Te: 10,
    },
    simulation: { version: 1 },
  });
  const baselineRequest = structuredClone(request);
  baselineRequest.settings.fallbackT1Me = 0;
  baselineRequest.settings.fallbackT1Te = 0;
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
  const baselineIndustry = simulateIndustryDemand(
    baselineRequest,
    context,
    normalizeSimulatorInventory(baselineRequest, context),
    graph,
  );
  const configuredIndustry = simulateIndustryDemand(
    request,
    context,
    normalizeSimulatorInventory(request, context),
    graph,
  );
  const baselineRifters = baselineIndustry.manufacturingJobs.filter(
    (job) => job.productTypeId === 587,
  );
  const configuredRifters = configuredIndustry.manufacturingJobs.filter(
    (job) => job.productTypeId === 587,
  );

  assert.ok(baselineRifters.length > 0);
  assert.ok(configuredRifters.length > 0);
  assert.equal(configuredRifters[0]?.blueprint.blueprintKind, "fallback");
  assert.equal(configuredRifters[0]?.blueprint.materialEfficiency, 8);
  assert.equal(configuredRifters[0]?.blueprint.timeEfficiency, 10);
  const totalInputQuantityByType = (jobs: typeof configuredRifters) =>
    jobs
      .flatMap((job) => job.inputs)
      .reduce(
        (quantities, input) =>
          quantities.set(
            input.typeId,
            (quantities.get(input.typeId) ?? 0) + input.requiredQuantity,
          ),
        new Map<number, number>(),
      );
  const baselineInputQuantities = totalInputQuantityByType(baselineRifters);
  const configuredInputQuantities = totalInputQuantityByType(configuredRifters);
  const baselineFirstRifter = baselineRifters[0];
  const configuredFirstRifter = configuredRifters[0];
  assert.ok(baselineFirstRifter);
  assert.ok(configuredFirstRifter);
  assert.ok(
    [...configuredInputQuantities].some(
      ([typeId, quantity]) => quantity < (baselineInputQuantities.get(typeId) ?? 0),
    ),
  );
  assert.ok(
    configuredFirstRifter.durationPerRunSeconds < baselineFirstRifter.durationPerRunSeconds,
  );

  const scheduled = scheduleSimulationJobs(
    configuredIndustry.manufacturingJobs,
    configuredIndustry.reactionJobs,
    configuredIndustry.inventionJobs,
    configuredIndustry.copyJobs,
    [
      {
        characterId: 1,
        systemId: 30_000_142,
        freeSlots: { manufacturing: 4, reactions: 4, science: 4 },
        timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
        skillLevels: {},
      },
    ],
    new Map([[20, 30_000_142]]),
    undefined,
    undefined,
    undefined,
    [
      {
        slotKey: "1:M:0",
        activity: "manufacturing",
        characterId: 1,
        systemId: 30_000_142,
        slotIndex: 0,
        availableAtSeconds: 0,
      },
    ],
  );
  const scheduledRifter = scheduled.manufacturingJobs.find((job) => job.productTypeId === 587);

  assert.ok(scheduledRifter);
  assert.equal(scheduledRifter.installs.length, 1);
  assert.equal(
    scheduledRifter.installs[0].durationSeconds,
    Math.ceil(scheduledRifter.requiredRuns * scheduledRifter.durationPerRunSeconds),
  );
});

void test("uses available T2 blueprint ME in descending order before T2 fallback ME", async () => {
  const context = await loadSimulationContext();
  const createRequest = (quantity: number, assets: unknown[]) =>
    parseSimulatorRequest({
      stockpiles: [
        {
          id: "t2-me",
          name: "T2 ME",
          locations: {
            stock: 10,
            manufacturing: 20,
            reactions: 30,
            reprocessing: 40,
            copying: 50,
            invention: 60,
          },
          items: [{ typeId: 482, quantity, me: 0, te: 0, fromCompression: false }],
        },
      ],
      assets,
      settings: {
        includeCorporationAssets: true,
        personalSellOrdersAsStock: false,
        allCorporationSellOrdersAsStock: false,
        myCorporationSellOrdersAsStock: false,
        buildBlacklist: [],
        buyBlacklist: [],
        fallbackT2OrT3Me: 7,
      },
      simulation: { version: 1 },
    });
  const simulate = (quantity: number, assets: unknown[]) => {
    const request = createRequest(quantity, assets);
    const graph = buildDependencyGraph(
      [482],
      context,
      {
        buildBlacklist: new Set(),
        buyBlacklist: new Set(),
        maxNodes: request.simulation.policy.maxGraphNodes,
        maxDepth: request.simulation.policy.maxGraphDepth,
      },
    );
    const inventory = normalizeSimulatorInventory(request, context);
    return simulateIndustryDemand(request, context, inventory, graph);
  };

  assert.equal(context.types.get(482)?.techLevel, 2);
  const withBlueprints = simulate(
    2,
    [
      {
        typeId: 784,
        quantity: 1,
        locationId: 20,
        rootLocationId: 20,
        blueprintPrints: [{ itemId: 7001, runs: 1, type: "bpc", me: 4, te: 0 }],
      },
      {
        typeId: 784,
        quantity: 1,
        locationId: 20,
        rootLocationId: 20,
        blueprintPrints: [{ itemId: 7002, runs: 1, type: "bpc", me: 10, te: 0 }],
      },
    ],
  );
  const blueprintJobs = withBlueprints.manufacturingJobs.filter((job) => job.productTypeId === 482);

  assert.deepEqual(
    blueprintJobs.map((job) => [job.blueprint.blueprintKind, job.blueprint.materialEfficiency]),
    [
      ["bpc", 10],
      ["bpc", 4],
    ],
  );

  const withoutBlueprint = simulate(1, []);
  const fallbackJob = withoutBlueprint.manufacturingJobs.find((job) => job.productTypeId === 482);
  assert.ok(fallbackJob);
  assert.equal(fallbackJob.blueprint.blueprintKind, "fallback");
  assert.equal(fallbackJob.blueprint.materialEfficiency, 7);
});

void test("splits physical and fallback Jackdaw blueprints by duration and remaining runs", async () => {
  const context = await loadSimulationContext();
  const createRequest = (assets: unknown[]) =>
    parseSimulatorRequest({
      stockpiles: [
        {
          id: "jackdaw-batches",
          name: "Jackdaw batches",
          locations: {
            stock: 10,
            manufacturing: 20,
            reactions: 30,
            reprocessing: 40,
            copying: 50,
            invention: 60,
          },
          items: [{ typeId: 34828, quantity: 10, me: 0, te: 0, fromCompression: false }],
        },
      ],
      assets,
      settings: {
        includeCorporationAssets: true,
        personalSellOrdersAsStock: false,
        allCorporationSellOrdersAsStock: false,
        myCorporationSellOrdersAsStock: false,
        buildBlacklist: [],
        buyBlacklist: [],
        fallbackT2OrT3Me: 3,
        fallbackT2OrT3Te: 20,
      },
      simulation: { version: 1, maxReactionJobDurationHours: 100 },
    });
  const simulate = (assets: unknown[]) => {
    const request = createRequest(assets);
    const graph = buildDependencyGraph(
      [34828],
      context,
      {
        buildBlacklist: new Set(),
        buyBlacklist: new Set(),
        maxNodes: request.simulation.policy.maxGraphNodes,
        maxDepth: request.simulation.policy.maxGraphDepth,
      },
    );
    return simulateIndustryDemand(
      request,
      context,
      normalizeSimulatorInventory(request, context),
      graph,
    ).manufacturingJobs.filter((job) => job.productTypeId === 34828);
  };
  const physicalJobs = simulate([
    {
      typeId: 34829,
      quantity: 1,
      locationId: 20,
      rootLocationId: 20,
      blueprintPrints: [{ itemId: 9001, runs: 5, type: "bpc", me: 3, te: 20 }],
    },
    {
      typeId: 34829,
      quantity: 1,
      locationId: 20,
      rootLocationId: 20,
      blueprintPrints: [{ itemId: 9002, runs: 5, type: "bpc", me: 3, te: 20 }],
    },
  ]);
  const fallbackJobs = simulate([]);
  const expectedPhysicalBatchRuns = [2, 2, 2, 2, 1, 1];
  const expectedFallbackBatchRuns = [2, 2, 2, 2, 2];

  assert.deepEqual(
    physicalJobs.map((job) => job.requiredRuns),
    expectedPhysicalBatchRuns,
  );
  assert.deepEqual(
    fallbackJobs.map((job) => job.requiredRuns),
    expectedFallbackBatchRuns,
  );
  assert.equal(
    physicalJobs.reduce((total, job) => total + job.requiredRuns, 0),
    10,
  );
  assert.equal(
    fallbackJobs.reduce((total, job) => total + job.requiredRuns, 0),
    10,
  );
  assert.ok(physicalJobs.every((job) => job.blueprint.blueprintKind === "bpc"));
  assert.ok(fallbackJobs.every((job) => job.blueprint.blueprintKind === "fallback"));
  assert.ok(
    [...physicalJobs, ...fallbackJobs].every(
      (job) => job.requiredRuns * job.durationPerRunSeconds <= 100 * 3600,
    ),
  );
  assert.ok(
    [...physicalJobs, ...fallbackJobs].every(
      (job) => job.blueprint.materialEfficiency === 3 && job.blueprint.timeEfficiency === 20,
    ),
  );
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
      .sort((left, right) => left[0] - right[0]),
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
  const createResult = async (maxReactionJobDurationHours: number, quantity = 15_400) =>
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
            items: [{ typeId: 16680, quantity, me: 0, te: 0, fromCompression: false }],
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
  const getJobs = (result: Awaited<ReturnType<typeof createResult>>) => {
    const jobs = result.lists.reactionJobs.filter((candidate) => candidate.productTypeId === 16680);
    assert.ok(jobs.length > 0);
    assert.equal(
      jobs.reduce((total, job) => total + job.requiredRuns, 0),
      7,
    );
    return jobs;
  };

  const oneHourJobs = getJobs(oneHourResult);
  const oneDayJobs = getJobs(oneDayResult);
  const assertJobsFitDuration = (jobs: typeof oneHourJobs, maxDurationHours: number) => {
    assert.ok(
      jobs.every(
        (job) =>
          job.requiredRuns === 1
          || job.requiredRuns * job.durationPerRunSeconds <= maxDurationHours * 3600,
      ),
    );
  };
  assertJobsFitDuration(oneHourJobs, 1);
  assertJobsFitDuration(oneDayJobs, 24);
  const totalMaterialQuantity = (jobs: typeof oneHourJobs) =>
    jobs
      .flatMap((job) => job.inputs)
      .filter((input) => input.typeId === 16663)
      .reduce((total, input) => total + input.requiredQuantity, 0);
  assert.equal(totalMaterialQuantity(oneHourJobs), 686);
  assert.equal(totalMaterialQuantity(oneDayJobs), 685);

  const maxRunsPerJob = Math.floor((24 * 3600) / oneDayJobs[0].durationPerRunSeconds);
  const totalRuns = maxRunsPerJob * 8 + Math.floor(maxRunsPerJob / 2);
  const evenlySplitResult = await createResult(24, totalRuns * oneDayJobs[0].outputPerRun);
  const evenlySplitJobs = evenlySplitResult.lists.reactionJobs.filter(
    (job) => job.productTypeId === 16680,
  );
  const runsPerJob = evenlySplitJobs.map((job) => job.requiredRuns);
  const lowerRunCount = Math.floor(totalRuns / 9);
  const upperRunCount = Math.ceil(totalRuns / 9);

  assert.equal(evenlySplitJobs.length, 9);
  assert.equal(
    runsPerJob.reduce((total, runs) => total + runs, 0),
    totalRuns,
  );
  assert.ok(runsPerJob.every((runs) => runs === lowerRunCount || runs === upperRunCount));
  assert.ok(evenlySplitJobs.every((job) => job.requiredRuns <= maxRunsPerJob));
});

void test("pools reaction demand across stockpiles before batch input rounding", async () => {
  const stockpile = (id: string, stock: number, quantity: number) => ({
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
    items: [{ typeId: 16680, quantity, me: 0, te: 0, fromCompression: false }],
  });
  const result = await simulateIndustry(
    parseSimulatorRequest({
      stockpiles: [stockpile("first", 10, 6_600), stockpile("second", 11, 8_800)],
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
      simulation: { version: 1, maxReactionJobDurationHours: 24 },
    }),
  );
  const jobs = result.lists.reactionJobs.filter((job) => job.productTypeId === 16680);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].requiredRuns, 7);
  assert.equal(
    jobs[0].inputs
      .filter((input) => input.typeId === 16663)
      .reduce((total, input) => total + input.requiredQuantity, 0),
    685,
  );
  const contributions = jobs[0].demandContributions.map(
    ({ stockpileId, destinationLocationId, quantity }): [string, number, number] => [
      stockpileId,
      destinationLocationId,
      quantity,
    ],
  );
  assert.deepEqual(
    contributions.sort(([leftStockpileId], [rightStockpileId]) =>
      leftStockpileId.localeCompare(rightStockpileId),
    ),
    [
      ["first", 10, 6_600],
      ["second", 11, 8_800],
    ],
  );
});

void test("reuses repeated reaction input splits without sharing weights between buckets", async () => {
  const context = await loadSimulationContext();
  const recipe = context.blueprints.byBuildProductTypeId.get(16680)?.blueprint.activities.reaction;
  assert.ok(recipe?.materials);
  const stockpile = (id: string, reactions: number, quantity: number) => ({
    id,
    name: id,
    locations: {
      stock: 10,
      manufacturing: 20,
      reactions,
      reprocessing: 40,
      copying: 50,
      invention: 60,
    },
    items: [{ typeId: 16680, quantity, me: 0, te: 0, fromCompression: false }],
  });
  const sectionCounts = new Map<string, number>();
  const profiler: RequestProfiler = {
    start(section) {
      sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
    },
    end() {},
    measureSync(_section, operation) {
      return operation();
    },
    async measure(_section, operation) {
      return operation();
    },
    finish() {
      return undefined;
    },
  };
  const result = await simulateIndustry(
    parseSimulatorRequest({
      stockpiles: [
        stockpile("first-a", 30, 6_600),
        stockpile("first-b", 30, 8_800),
        stockpile("second-a", 31, 2_200),
        stockpile("second-b", 31, 13_200),
      ],
      assets: [],
      settings: {
        includeCorporationAssets: true,
        buildBlacklist: recipe.materials.map((material) => material.typeID),
        buyBlacklist: [],
      },
      simulation: { version: 1, maxReactionJobDurationHours: 1 },
    }),
    profiler,
  );
  const jobs = result.lists.reactionJobs;
  const distinctQuantitiesByLocation = new Map<number, Set<number>>();
  const contributionsByStockpile = new Map<string, number>();
  for (const job of jobs) {
    assert.equal(job.productTypeId, 16680);
    assert.equal(job.requiredRuns, 1);
    const quantities = distinctQuantitiesByLocation.get(job.locationId) ?? new Set<number>();
    for (const input of job.inputs) quantities.add(input.requiredQuantity);
    distinctQuantitiesByLocation.set(job.locationId, quantities);
    for (const contribution of job.demandContributions) {
      contributionsByStockpile.set(
        contribution.stockpileId,
        (contributionsByStockpile.get(contribution.stockpileId) ?? 0) + contribution.quantity,
      );
    }
  }

  assert.equal(jobs.length, 14);
  assert.equal(distinctQuantitiesByLocation.size, 2);
  assert.equal(
    sectionCounts.get("distribute-reaction-input-shares"),
    [...distinctQuantitiesByLocation.values()].reduce(
      (total, quantities) => total + quantities.size,
      0,
    ),
  );
  assert.equal(sectionCounts.get("reserve-reaction-input-shares"), 14 * recipe.materials.length);
  assert.deepEqual(
    [...contributionsByStockpile].sort(([left], [right]) => left.localeCompare(right)),
    [
      ["first-a", 6_600],
      ["first-b", 8_800],
      ["second-a", 2_200],
      ["second-b", 13_200],
    ],
  );
  assert.equal(result.metadata.invariantViolationCount, 0);
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
          systemId: 30_000_142,
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

void test("hauls a BPO to copying when invention needs additional source BPC runs", async () => {
  const baseRequest = {
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
        name: "Invention Source Blueprint",
        quantity: 1,
        locationId: 80,
        blueprintPrints: [{ itemId: 31, runs: -1, type: "bpo" as const, me: 0, te: 0 }],
      },
    ],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [] },
    simulation: {
      version: 1,
      characters: [
        {
          characterId: 1,
          systemId: 30_000_142,
          freeSlots: { manufacturing: 100, reactions: 100, science: 100 },
          timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
          skillLevels: { "11448": 4, "11453": 4, "21790": 4 },
        },
      ],
    },
  };

  const baselineResult = await simulateIndustry(parseSimulatorRequest(baseRequest));
  const baselineInventionJob = baselineResult.lists.inventionJobs.find(
    (job) => job.sourceBlueprintTypeId === 11620,
  );
  assert.ok(baselineInventionJob);

  const oneRunShortResult = await simulateIndustry(
    parseSimulatorRequest({
      ...baseRequest,
      assets: [
        ...baseRequest.assets,
        {
          typeId: 11620,
          name: "Invention Source Blueprint",
          quantity: 1,
          locationId: 60,
          blueprintPrints: [
            {
              itemId: 32,
              runs: baselineInventionJob.attempts - 1,
              type: "bpc" as const,
              me: 0,
              te: 0,
            },
          ],
        },
      ],
    }),
  );
  const inventionJob = oneRunShortResult.lists.inventionJobs.find(
    (job) => job.sourceBlueprintTypeId === 11620,
  );
  const sourceInput = inventionJob?.inputs.find((input) => input.typeId === 11620);
  const copyingJob = oneRunShortResult.lists.bpcToCopy.find((job) => job.blueprintTypeId === 11620);
  const bpoHaul = oneRunShortResult.lists.haulingTasks.find(
    (task) => task.typeId === 11620 && task.blueprintKind === "bpo",
  );

  assert.ok(inventionJob);
  assert.equal(inventionJob.attempts, baselineInventionJob.attempts);
  assert.ok(sourceInput);
  assert.ok(copyingJob);
  assert.ok(bpoHaul);
  assert.equal(copyingJob.totalLicensedRuns, 1);
  assert.equal(sourceInput.requiredQuantity - (baselineInventionJob.attempts - 1), 1);
  assert.equal(sourceInput.requiredQuantity, inventionJob.attempts);
  assert.equal(sourceInput.unsatisfiedQuantity, 0);
  assert.equal(bpoHaul.fromLocationId, 80);
  assert.equal(bpoHaul.toLocationId, 50);
  assert.equal(oneRunShortResult.metadata.invariantViolationCount, 0);
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
          systemId: 30_000_142,
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
    assert.equal(
      fuel.availableNow,
      fuel.required,
      `Reaction ${productTypeId} input totals: ${JSON.stringify(fuel)}`,
    );
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
  assert.equal(sourceBalance.futureSupply, 110);
  assert.equal(sourceBalance.transferredOut, 95);
  assert.equal(sourceBalance.surplus, 15);
  assert.equal(result.metadata.invariantViolationCount, 0);
});
