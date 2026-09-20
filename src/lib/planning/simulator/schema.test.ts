import assert from "node:assert/strict";
import test from "node:test";
import { parseSimulatorRequest, simulatorRequestSchema } from "./schema";

/** Builds the smallest valid request accepted by the simulator boundary. */
function request() {
  return {
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 1,
          manufacturing: 2,
          reactions: 3,
          reprocessing: 4,
          copying: 5,
          invention: 6,
        },
        items: [{ typeId: 587, quantity: 1, me: 0, te: 0, fromCompression: false }],
      },
    ],
    assets: [] as unknown[],
    settings: {
      includeCorporationAssets: true,
      personalSellOrdersAsStock: false,
      allCorporationSellOrdersAsStock: false,
      myCorporationSellOrdersAsStock: false,
      buildBlacklist: [] as number[],
      buyBlacklist: [] as number[],
    },
    simulation: { version: 1 },
  };
}

void test("defaults the simulator policy", () => {
  const parsed = parseSimulatorRequest(request());
  assert.equal(parsed.simulation.includeSurplusForAllLocations, false);
  assert.equal(parsed.simulation.policy.inventionExpectedOutputFactor, 1.2);
  assert.equal(parsed.simulation.policy.fallbackInventionSkillLevel, 3);
  assert.deepEqual(parsed.simulation.characters, []);
});

void test("rejects fractional build quantities", () => {
  const input = request();
  input.stockpiles[0].items[0].quantity = 1.5;
  assert.equal(simulatorRequestSchema.safeParse(input).success, false);
});

void test("rejects conflicting build and buy policies", () => {
  const input = request();
  input.settings.buildBlacklist = [34];
  input.settings.buyBlacklist = [34];
  const parsed = simulatorRequestSchema.safeParse(input);
  assert.equal(parsed.success, false);
  assert.ok(!parsed.success);
  assert.match(parsed.error.issues[0].message, /both build and buy/);
});

void test("accepts stockpiles that share a physical activity location", () => {
  const input = request();
  input.stockpiles.push({
    ...input.stockpiles[0],
    id: "shared-facility",
    name: "Shared facility",
  });
  assert.equal(simulatorRequestSchema.safeParse(input).success, true);
});

void test("accepts unlimited BPO runs and rejects negative BPC runs", () => {
  const bpoInput = request();
  bpoInput.assets = [
    {
      typeId: 691,
      name: "Rifter Blueprint",
      quantity: 1,
      locationId: 2,
      category: "blueprint",
      blueprintPrints: [{ itemId: 1, runs: -1, type: "bpo" }],
    },
  ];
  assert.equal(simulatorRequestSchema.safeParse(bpoInput).success, true);

  const bpcInput = request();
  bpcInput.assets = [
    {
      typeId: 691,
      name: "Rifter Blueprint",
      quantity: 1,
      locationId: 2,
      category: "blueprint",
      blueprintPrints: [{ itemId: 2, runs: -1, type: "bpc" }],
    },
  ];
  assert.equal(simulatorRequestSchema.safeParse(bpcInput).success, false);
});
