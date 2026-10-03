import assert from "node:assert/strict";
import test from "node:test";
import { requiredMaterialQuantity, requiredMaterialQuantityInBatches } from "./materialQuantities";

void test("applies blueprint ME and facility material reduction to manufacturing", () => {
  assert.equal(requiredMaterialQuantity("manufacturing", 100, 2, { me: 10 }, 0.9), 162);
});

void test("rounds manufacturing material reductions after multiplying by runs", () => {
  assert.equal(requiredMaterialQuantity("manufacturing", 35, 3, { me: 10 }, 0.92), 88);
});

void test("applies the minimum one unit per material per run", () => {
  assert.equal(requiredMaterialQuantity("manufacturing", 1, 3, { me: 10 }, 0.5), 3);
});

void test("does not apply blueprint ME to reactions", () => {
  assert.equal(requiredMaterialQuantity("reaction", 100, 2, { me: 10 }, 0.9), 180);
});

void test("rounds each reaction install batch independently", () => {
  const inputsForJob = (runs: number) =>
    requiredMaterialQuantityInBatches("reaction", 100, runs, { me: 0 }, 0.978, 17);

  assert.equal(inputsForJob(27), 2641);
  assert.equal(inputsForJob(144), 14087);
  assert.equal(inputsForJob(27) + inputsForJob(144), 16728);
});
