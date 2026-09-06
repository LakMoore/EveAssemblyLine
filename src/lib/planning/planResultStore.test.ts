import assert from "node:assert/strict";
import test from "node:test";
import { isPlanResult } from "./planResultStore";

const planListNames = [
  "planItems",
  "materialsToBuy",
  "bpcsNeeded",
  "bpcsToBuy",
  "inventionJobs",
  "reactionJobs",
  "manufacturingJobs",
  "reprocessingJobs",
  "skillsRequired",
  "haulingTasks",
] as const;

test("accepts a complete cached plan", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: Object.fromEntries(planListNames.map((name) => [name, []])),
  };

  assert.equal(isPlanResult(plan), true);
});

test("rejects a cached plan with a missing output list", () => {
  const plan = {
    metadata: { generatedAt: "2026-09-06T00:00:00.000Z" },
    lists: Object.fromEntries(planListNames.slice(0, -1).map((name) => [name, []])),
  };

  assert.equal(isPlanResult(plan), false);
});
