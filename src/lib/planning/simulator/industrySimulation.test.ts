import assert from "node:assert/strict";
import test from "node:test";
import { loadSimulationContext } from "./context";
import { buildDependencyGraph } from "./dependencyGraph";
import { simulateIndustryDemand } from "./industrySimulation";
import { projectSimulationLedger } from "./ledger";
import { parseSimulatorRequest } from "./schema";
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
