import assert from "node:assert/strict";
import test from "node:test";
import { toCompatiblePlanResponse } from "./compatibility";
import { loadSimulationContext } from "./context";
import { parseSimulatorRequest } from "./schema";
import { simulateIndustry } from "./simulate";

void test("maps the native result into every legacy planner list", async () => {
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
  const [context, native] = await Promise.all([loadSimulationContext(), simulateIndustry(request)]);
  const compatible = toCompatiblePlanResponse(request, context, native);
  assert.deepEqual(
    Object.keys(compatible.lists).sort(),
    [
      "bpcToCopy",
      "bpoToBuy",
      "haulingTasks",
      "inventionJobs",
      "manufacturingJobs",
      "materialsToBuy",
      "planItems",
      "reactionJobs",
      "reprocessingJobs",
      "skillsRequired",
      "warnings",
    ],
  );
  const nativeJob = native.lists.manufacturingJobs.find((job) => job.productTypeId === 587);
  const compatibleJob = compatible.lists.manufacturingJobs
    .flatMap((bucket) => bucket.items)
    .find((job) => job.typeId === 587);
  assert.ok(nativeJob);
  assert.ok(compatibleJob);
  assert.equal(compatibleJob.runsAvailable, nativeJob.readyAfterHaulingRuns);
  const nativeMaterial = native.lists.planItems.find((balance) => balance.required > 0);
  const compatibleMaterial = compatible.lists.planItems.all.find(
    (item) => item.typeId === nativeMaterial?.typeId,
  );
  assert.ok(nativeMaterial);
  assert.ok(compatibleMaterial);
  assert.equal(
    compatibleMaterial.availableQuantity,
    nativeMaterial.availableNow + nativeMaterial.availableAfterHauling,
  );
  assert.equal(
    compatibleMaterial.neededQuantity,
    nativeMaterial.unsatisfied
      + nativeMaterial.availableFromProduction
      + nativeMaterial.availableFromCopying
      + nativeMaterial.availableFromInvention
      + nativeMaterial.availableFromReprocessing,
  );

  const balanceWithAcquisitionSources = {
    ...nativeMaterial,
    unsatisfied: 5,
    availableFromProduction: 7,
    availableFromCopying: 11,
    availableFromInvention: 13,
    availableFromReprocessing: 17,
  };
  const compatibleWithAcquisitionSources = toCompatiblePlanResponse(
    request,
    context,
    {
      ...native,
      lists: {
        ...native.lists,
        planItems: [balanceWithAcquisitionSources],
      },
    },
  );
  assert.equal(
    compatibleWithAcquisitionSources.lists.planItems.all[0].neededQuantity,
    5 + 7 + 11 + 13 + 17,
  );
});
