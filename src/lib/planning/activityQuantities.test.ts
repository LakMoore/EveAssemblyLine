import assert from "node:assert/strict";
import test from "node:test";
import { getDisplayedActivityQuantity } from "./activityQuantities";

const job = { countNeeded: 12, runsAvailable: 7 };

void test("uses the installable quantity when Show is Installable", () => {
  assert.equal(getDisplayedActivityQuantity(job, false), 7);
});

void test("uses the total quantity when Show is Total", () => {
  assert.equal(getDisplayedActivityQuantity(job, true), 12);
});
