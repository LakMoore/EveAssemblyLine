import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPendingStockpileActiveStates,
  clearCommittedStockpileActiveStates,
  getPendingStockpileActiveStates,
  resetPendingStockpileActiveStates,
  setPendingStockpileActiveState,
} from "./plannerStockpileActiveState";

void test("clears a pending override after its stockpile state commits", () => {
  resetPendingStockpileActiveStates();
  setPendingStockpileActiveState("alpha", false);

  clearCommittedStockpileActiveStates([{ id: "alpha", isActive: false }]);

  assert.equal(getPendingStockpileActiveStates().has("alpha"), false);
});

void test("drops overrides for removed stockpiles before a same-id import", () => {
  resetPendingStockpileActiveStates();
  setPendingStockpileActiveState("alpha", false);

  clearCommittedStockpileActiveStates([{ id: "beta", isActive: true }]);

  const importedStockpiles = [{ id: "alpha", isActive: true }];
  assert.deepEqual(applyPendingStockpileActiveStates(importedStockpiles), importedStockpiles);
  assert.equal(getPendingStockpileActiveStates().has("alpha"), false);
});
