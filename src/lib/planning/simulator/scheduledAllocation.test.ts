import assert from "node:assert/strict";
import test from "node:test";
import { SimulationAllocator } from "./allocator";
import type { IndustrySimulationResult } from "./industrySimulation";
import { projectSimulationLedger, type SimulationTransaction } from "./ledger";
import { allocateScheduledIndustryInputs } from "./scheduledAllocation";
import { parseSimulatorRequest } from "./schema";
import type { SimulatorInventory } from "./sourceLots";
import type { SimulationIndustryJob } from "./types";

/** Creates one fixture job consuming ten units of a shared material. */
function fixtureJob(
  jobId: string,
  activity: SimulationIndustryJob["activity"],
  local: number,
): SimulationIndustryJob {
  return {
    jobId,
    activity,
    depth: 1,
    locationId: 20,
    productTypeId: activity === "reaction" ? 200 : 300,
    productName: jobId,
    blueprint: {
      blueprintTypeId: 400,
      blueprintKind: activity === "reaction" ? "formula" : "bpo",
      sourceLocationId: 20,
      horizon: "now",
      runs: 1,
      materialEfficiency: 0,
      timeEfficiency: 0,
    },
    outputPerRun: 1,
    requiredRuns: 1,
    readyNowRuns: local === 10 ? 1 : 0,
    readyAfterHaulingRuns: local === 10 ? 1 : 0,
    readyAfterUpstreamRuns: local === 10 ? 1 : 0,
    blockedRuns: local === 10 ? 0 : 1,
    unscheduledRuns: 1,
    materialMultiplier: 1,
    timeMultiplier: 1,
    durationPerRunSeconds: 100,
    inputs: [
      {
        typeId: 100,
        typeName: "Shared material",
        quantityPerRun: 10,
        requiredQuantity: 10,
        availableNow: local,
        availableFromHauling: 0,
        availableAfterUpstream: local,
        unsatisfiedQuantity: 10 - local,
      },
    ],
    installs: [],
    demandSources: [],
    demandContributions: [],
  };
}

/** Declares actual allocator claims and additive demand facts for fixture jobs. */
function fixtureIndustry(jobs: SimulationIndustryJob[]): {
  industry: IndustrySimulationResult;
  inventory: SimulatorInventory;
} {
  const inventory: SimulatorInventory = {
    itemLots: [
      {
        lotId: "shared",
        typeId: 100,
        name: "Shared material",
        quantity: jobs.reduce((total, job) => total + job.inputs[0].availableNow, 0),
        locationId: 20,
        unitVolume: 1,
        horizon: "now",
        source: "asset",
        eligibleForReprocessing: false,
      },
    ],
    blueprintLots: [],
    unresolvedLotCount: 0,
  };
  const allocator = new SimulationAllocator(inventory, []);
  const transactions: SimulationTransaction[] = [];
  const industry: IndustrySimulationResult = {
    manufacturingJobs: jobs.filter((job) => job.activity === "manufacturing"),
    reactionJobs: jobs.filter((job) => job.activity === "reaction"),
    inventionJobs: [],
    copyJobs: [],
    transactions,
    unmetDemands: [],
    blueprintPurchases: [],
    skillsRequired: [],
    jobSkillRequirements: [],
    warnings: [],
    allocator,
  };
  for (const job of jobs) {
    const input = job.inputs[0];
    const source = {
      demandId: `demand:${job.jobId}`,
      stockpileId: "fixture",
      materialTypeId: 100,
      productTypeId: job.productTypeId,
      productQuantity: 1,
      plannedQuantity: 10,
      requiredNow: 0,
      reserved: 10,
      destinationLocationId: 20,
      activity: job.activity,
      demandingJobId: job.jobId,
    };
    transactions.push({
      id: source.demandId,
      kind: "demand",
      account: { locationId: 20, typeId: 100 },
      quantity: 10,
      source,
    });
    allocator.claimOrdinarySupply(
      100,
      input.availableNow,
      20,
      { locationId: 20, typeId: 100 },
      job.jobId,
      undefined,
      job.activity,
      "activity-input",
    );
    if (input.availableNow > 0) {
      transactions.push({
        id: `readiness:${job.jobId}`,
        kind: "demand-readiness",
        account: { locationId: 20, typeId: 100 },
        quantity: input.availableNow,
        demandId: source.demandId,
      });
    }
    if (input.unsatisfiedQuantity > 0) {
      industry.unmetDemands.push({
        account: { locationId: 20, typeId: 100 },
        quantity: input.unsatisfiedQuantity,
        source: { ...source, requiredNow: input.availableNow, reserved: 10 - input.availableNow },
        blockedByBuyBlacklist: true,
        purpose: "material",
      });
    }
  }
  transactions.push(...allocator.transactions);
  return { industry, inventory };
}

/** Supplies a free reaction slot and a manufacturing slot busy for two days. */
function fixtureRequest() {
  return parseSimulatorRequest({
    stockpiles: [
      {
        id: "fixture",
        name: "Fixture",
        locations: {
          stock: 20,
          manufacturing: 20,
          reactions: 20,
          reprocessing: 20,
          copying: 20,
          invention: 20,
        },
        items: [],
      },
    ],
    assets: [],
    settings: { includeCorporationAssets: true, buildBlacklist: [], buyBlacklist: [100] },
    facilityProfiles: [{ locationId: 20, systemId: 30000142, sizeId: 0, buildTypeGroups: {} }],
    simulation: {
      version: 1,
      characters: [
        {
          characterId: 1,
          systemId: 30000142,
          timeMultipliers: { manufacturing: 1, reactions: 1, copying: 1, invention: 1 },
          skillLevels: {},
        },
      ],
      slots: [
        {
          slotKey: "1:R:0",
          activity: "reaction",
          characterId: 1,
          systemId: 30000142,
          slotIndex: 0,
          availableAtSeconds: 0,
        },
        {
          slotKey: "1:M:0",
          activity: "manufacturing",
          characterId: 1,
          systemId: 30000142,
          slotIndex: 0,
          availableAtSeconds: 172800,
        },
      ],
    },
  });
}

void test("allocates shared stock to the earlier slot instead of the earlier declaration", () => {
  const late = fixtureJob("late", "manufacturing", 10);
  const early = fixtureJob("early", "reaction", 0);
  const { industry, inventory } = fixtureIndustry([late, early]);
  allocateScheduledIndustryInputs(fixtureRequest(), industry, inventory);
  assert.equal(early.readyNowRuns, 1);
  assert.equal(early.inputs[0].availableNow, 10);
  assert.equal(late.inputs[0].availableNow, 0);
  assert.equal(industry.unmetDemands.length, 1);
  assert.equal(industry.unmetDemands[0].source.demandingJobId, "late");
  assert.equal(industry.unmetDemands[0].blockedByBuyBlacklist, true);
  const reservations = industry.transactions.filter(
    (transaction) => transaction.kind === "source-reservation",
  );
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].demandingJobId, "early");
  assert.deepEqual(
    projectSimulationLedger(inventory.itemLots, industry.transactions).invariantViolations,
    [],
  );
});

void test("keeps active output provenance when local stock moves to an earlier scheduled job", () => {
  const late = fixtureJob("late", "manufacturing", 10);
  const early = fixtureJob("early", "reaction", 0);
  early.inputs[0].upstreamReservations = [
    {
      activity: "reaction",
      quantity: 10,
      state: "in-production",
      sourceJobId: 999,
      sourceOutputQuantity: 10,
      sourceCompletionOffsetSeconds: 86400,
    },
  ];
  early.inputs[0].availableAfterUpstream = 10;
  early.inputs[0].unsatisfiedQuantity = 0;
  const { industry, inventory } = fixtureIndustry([late, early]);
  allocateScheduledIndustryInputs(fixtureRequest(), industry, inventory);
  assert.equal(early.inputs[0].availableNow, 10);
  assert.deepEqual(
    late.inputs[0].upstreamReservations,
    [
      {
        activity: "reaction",
        quantity: 10,
        state: "in-production",
        sourceJobId: 999,
        sourceOutputQuantity: 10,
        sourceCompletionOffsetSeconds: 86400,
      },
    ],
  );
  assert.equal(late.inputs[0].availableAfterUpstream, 10);
  assert.equal(industry.unmetDemands.length, 0);
});

void test("allocates identically when declaration order changes", () => {
  const first = fixtureIndustry([
    fixtureJob("late", "manufacturing", 10),
    fixtureJob("early", "reaction", 0),
  ]);
  const second = fixtureIndustry([
    fixtureJob("early", "reaction", 0),
    fixtureJob("late", "manufacturing", 10),
  ]);
  allocateScheduledIndustryInputs(fixtureRequest(), first.industry, first.inventory);
  allocateScheduledIndustryInputs(fixtureRequest(), second.industry, second.inventory);
  assert.deepEqual(first.industry.reactionJobs, second.industry.reactionJobs);
  assert.deepEqual(first.industry.manufacturingJobs, second.industry.manufacturingJobs);
});

void test("moves remote lot and haul provenance without changing physical transfer quantities", () => {
  const late = fixtureJob("late", "manufacturing", 10);
  const early = fixtureJob("early", "reaction", 0);
  early.inputs[0].availableFromHauling = 10;
  early.inputs[0].availableAfterUpstream = 10;
  early.inputs[0].unsatisfiedQuantity = 0;
  const fixture = fixtureIndustry([late, early]);
  const inventory: SimulatorInventory = {
    ...fixture.inventory,
    itemLots: [
      ...fixture.inventory.itemLots,
      {
        lotId: "remote",
        typeId: 100,
        name: "Shared material",
        quantity: 10,
        locationId: 90,
        unitVolume: 1,
        horizon: "now",
        source: "asset",
        eligibleForReprocessing: false,
      },
    ],
  };
  const facts: SimulationTransaction[] = [
    {
      id: "remote-reservation",
      kind: "source-reservation",
      account: { locationId: 20, typeId: 100 },
      lotId: "remote",
      quantity: 10,
      horizon: "after-hauling",
      demandingJobId: "early",
    },
    {
      id: "remote-transfer",
      kind: "transfer-commitment",
      sourceAccount: { locationId: 90, typeId: 100 },
      destinationAccount: { locationId: 20, typeId: 100 },
      lotId: "remote",
      quantity: 10,
      demandingJobId: "early",
    },
  ];
  fixture.industry.transactions.push(...facts);
  fixture.industry.allocator.transactions.push(...facts);
  fixture.industry.allocator.haulingTasks.push({
    transferId: "remote-haul",
    lotId: "remote",
    typeId: 100,
    typeName: "Shared material",
    quantity: 10,
    unitVolume: 1,
    fromLocationId: 90,
    toLocationId: 20,
    ownerType: "corporation",
    ownerId: 123,
    purpose: "industry-input",
    demands: [{ jobId: "early", quantity: 10 }],
  });
  allocateScheduledIndustryInputs(fixtureRequest(), fixture.industry, inventory);
  assert.equal(early.inputs[0].availableNow, 10);
  assert.equal(late.inputs[0].availableFromHauling, 10);
  const transfer = fixture.industry.transactions.find(
    (transaction) => transaction.kind === "transfer-commitment",
  );
  assert.ok(transfer);
  assert.equal(transfer.quantity, 10);
  assert.equal(transfer.demandingJobId, "late");
  assert.deepEqual(
    fixture.industry.allocator.haulingTasks[0].demands,
    [{ jobId: "late", quantity: 10 }],
  );
  assert.equal(fixture.industry.allocator.haulingTasks[0].ownerId, 123);
  assert.deepEqual(
    projectSimulationLedger(inventory.itemLots, fixture.industry.transactions).invariantViolations,
    [],
  );
});

void test("rebuilds planned-output dependencies for the new consumer", () => {
  const late = fixtureJob("late", "manufacturing", 10);
  const early = fixtureJob("early", "reaction", 0);
  early.inputs[0].upstreamReservations = [
    {
      activity: "reaction",
      quantity: 10,
      state: "planned",
      sourceJobId: "producer",
      sourceOutputQuantity: 10,
    },
  ];
  early.inputs[0].availableAfterUpstream = 10;
  early.inputs[0].unsatisfiedQuantity = 0;
  const { industry, inventory } = fixtureIndustry([late, early]);
  const producer = fixtureJob("producer", "reaction", 0);
  producer.productTypeId = 100;
  producer.outputPerRun = 10;
  producer.inputs = [];
  const earlyDemand = industry.transactions.find(
    (transaction) => transaction.kind === "demand" && transaction.source.demandingJobId === "early",
  );
  assert.ok(earlyDemand?.kind === "demand");
  producer.demandSources = [earlyDemand.source];
  producer.demandContributions = [
    {
      demandId: earlyDemand.source.demandId,
      stockpileId: "fixture",
      destinationLocationId: 20,
      quantity: 10,
    },
  ];
  industry.reactionJobs.push(producer);
  allocateScheduledIndustryInputs(fixtureRequest(), industry, inventory);
  assert.deepEqual(
    producer.demandSources.map((source) => source.demandingJobId),
    ["late"],
  );
  assert.deepEqual(
    producer.demandContributions,
    [{ demandId: "demand:late", stockpileId: "fixture", destinationLocationId: 20, quantity: 10 }],
  );
  assert.equal(late.inputs[0].availableAfterUpstream, 10);
});

void test("does not prioritize an ineligible job over a later eligible slot", () => {
  const late = fixtureJob("ineligible", "manufacturing", 10);
  const early = fixtureJob("eligible", "reaction", 0);
  const { industry, inventory } = fixtureIndustry([late, early]);
  industry.jobSkillRequirements.push({ jobId: late.jobId, skillId: 99, requiredLevel: 5 });
  const request = fixtureRequest();
  request.simulation.slots[0].availableAtSeconds = 43200;
  request.simulation.slots[1].availableAtSeconds = 0;
  allocateScheduledIndustryInputs(request, industry, inventory);
  assert.equal(early.inputs[0].availableNow, 10);
  assert.equal(late.inputs[0].availableNow, 0);
});
