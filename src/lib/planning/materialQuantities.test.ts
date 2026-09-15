import assert from "node:assert/strict";
import test from "node:test";
import { requiredMaterialQuantity } from "./materialQuantities";

void test("applies blueprint ME and facility material reduction to manufacturing", () => {
  assert.equal(requiredMaterialQuantity("manufacturing", 100, 2, { me: 10 }, 0.9), 162);
});

void test("applies the minimum one unit per material per run", () => {
  assert.equal(requiredMaterialQuantity("manufacturing", 1, 3, { me: 10 }, 0.5), 3);
});

void test("does not apply blueprint ME to reactions", () => {
  assert.equal(requiredMaterialQuantity("reaction", 100, 2, { me: 10 }, 0.9), 180);
});
