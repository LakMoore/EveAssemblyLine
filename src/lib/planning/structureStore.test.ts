import assert from "node:assert/strict";
import test from "node:test";
import type { KnownStructure } from "./preferences";
import { assignPlannerLocationIds } from "./structureStore";

/** Creates a minimal local structure for planner identity tests. */
function localStructure(id: string): KnownStructure {
  return {
    id,
    systemId: 30000142,
    systemName: "Jita",
    type: "Astrahus",
    typeId: 35832,
    size: "Medium",
    name: `Structure ${id}`,
    rigTypeIds: [],
  };
}

void test("assigns unique stable negative IDs to local structures", () => {
  const structures = assignPlannerLocationIds([
    localStructure("local:a"),
    localStructure("local:b"),
  ]);
  assert.ok(structures[0].plannerLocationId !== undefined);
  assert.ok(structures[1].plannerLocationId !== undefined);
  assert.ok(structures[0].plannerLocationId < 0);
  assert.ok(structures[1].plannerLocationId < 0);
  assert.notEqual(structures[0].plannerLocationId, structures[1].plannerLocationId);
  assert.deepEqual(assignPlannerLocationIds(structures), structures);
});
