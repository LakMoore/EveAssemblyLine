import assert from "node:assert/strict";
import test from "node:test";
import { getSlotUsageTotals } from "./slotUsage";

void test("aggregates available slots using total capacity minus active jobs", () => {
  const totals = getSlotUsageTotals(
    {
      "100": {
        slots: { Reactions: 2 },
        availableSlots: { Reactions: 10 },
      },
      "200": {
        slots: {},
        availableSlots: { Reactions: 8 },
      },
    },
    "Reactions",
    [100, 200],
  );

  assert.deepEqual(
    totals,
    {
      totalSlots: 18,
      inUseSlots: 2,
      availableSlots: 16,
    },
  );
});
