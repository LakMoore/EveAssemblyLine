import assert from "node:assert/strict";
import test from "node:test";
import type { BlueprintsRecord } from "@/lib/sde/generated";
import { buildDependencyGraph } from "./dependencyGraph";

/** Creates a minimal manufacturing blueprint fixture. */
function blueprint(
  blueprintTypeId: number,
  productTypeId: number,
  materialTypeId: number,
): BlueprintsRecord {
  return {
    _key: blueprintTypeId,
    blueprintTypeID: blueprintTypeId,
    maxProductionLimit: 10,
    activities: {
      manufacturing: {
        time: 1,
        products: [{ typeID: productTypeId, quantity: 1 }],
        materials: [{ typeID: materialTypeId, quantity: 2 }],
      },
    },
  };
}

void test("discovers a production chain without quantities", () => {
  const first = blueprint(1001, 2001, 2002);
  const second = blueprint(1002, 2002, 34);
  const graph = buildDependencyGraph(
    [2001],
    {
      blueprints: {
        byBuildProductTypeId: new Map([
          [2001, { activity: "manufacturing" as const, blueprint: first }],
          [2002, { activity: "manufacturing" as const, blueprint: second }],
        ]),
        byBlueprintId: new Map(),
        byInventionProductId: new Map(),
        productByTypeId: new Map(),
        materialsByBlueprintId: new Map(),
        reactionMaterialsByBlueprintId: new Map(),
        reactionProductByTypeId: new Map(),
      },
    },
    { buildBlacklist: new Set(), buyBlacklist: new Set(), maxNodes: 100, maxDepth: 10 },
  );
  assert.deepEqual(
    [...graph.reachableTypeIds].sort((a, b) => a - b),
    [34, 2001, 2002],
  );
  assert.equal(graph.warnings.length, 0);
});

void test("reports and terminates a production cycle", () => {
  const first = blueprint(1001, 2001, 2002);
  const second = blueprint(1002, 2002, 2001);
  const graph = buildDependencyGraph(
    [2001],
    {
      blueprints: {
        byBuildProductTypeId: new Map([
          [2001, { activity: "manufacturing" as const, blueprint: first }],
          [2002, { activity: "manufacturing" as const, blueprint: second }],
        ]),
        byBlueprintId: new Map(),
        byInventionProductId: new Map(),
        productByTypeId: new Map(),
        materialsByBlueprintId: new Map(),
        reactionMaterialsByBlueprintId: new Map(),
        reactionProductByTypeId: new Map(),
      },
    },
    { buildBlacklist: new Set(), buyBlacklist: new Set(), maxNodes: 100, maxDepth: 10 },
  );
  assert.equal(
    graph.warnings.some((warning) => warning.code === "cycle-detected"),
    true,
  );
});
