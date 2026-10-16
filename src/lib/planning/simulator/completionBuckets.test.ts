import assert from "node:assert/strict";
import test from "node:test";
import { simulationCompletionBuckets } from "./completionBuckets";
import type { SimulationUpstreamReservation } from "./types";

const now = Date.parse("2026-10-16T00:00:00.000Z");

void test("aggregates unique in-flight outputs into 24-hour completion buckets", () => {
  const reservations: SimulationUpstreamReservation[] = [
    {
      activity: "reaction",
      quantity: 20,
      sourceOutputQuantity: 80,
      sourceJobId: 1,
      sourceCompletionAt: "2026-10-16T08:00:00.000Z",
      state: "in-production",
    },
    {
      activity: "reaction",
      quantity: 10,
      sourceOutputQuantity: 80,
      sourceJobId: 1,
      sourceCompletionAt: "2026-10-16T08:00:00.000Z",
      state: "in-production",
    },
    {
      activity: "reaction",
      quantity: 30,
      sourceOutputQuantity: 120,
      sourceJobId: 2,
      sourceCompletionOffsetSeconds: 86_400,
      state: "in-production",
    },
    {
      activity: "reaction",
      quantity: 40,
      sourceOutputQuantity: 160,
      sourceJobId: 3,
      sourceCompletionAt: "2026-10-17T00:00:01.000Z",
      state: "in-production",
    },
    {
      activity: "reaction",
      quantity: 50,
      sourceJobId: 4,
      sourceCompletionAt: "2026-10-16T01:00:00.000Z",
      state: "planned",
    },
  ];

  assert.deepEqual(
    simulationCompletionBuckets(reservations, now),
    [
      { days: 1, quantity: 200 },
      { days: 2, quantity: 160 },
    ],
  );
});

void test("returns no completion rows when in-flight jobs have no valid end time", () => {
  assert.deepEqual(
    simulationCompletionBuckets(
      [
        {
          activity: "manufacturing",
          quantity: 10,
          sourceJobId: 1,
          sourceCompletionAt: "invalid",
          state: "in-production",
        },
      ],
      now,
    ),
    [],
  );
});

void test("groups due and overdue in-flight output as ready now", () => {
  assert.deepEqual(
    simulationCompletionBuckets(
      [
        {
          activity: "reaction",
          quantity: 10,
          sourceOutputQuantity: 40,
          sourceJobId: 1,
          sourceCompletionAt: "2026-10-15T23:59:59.000Z",
          state: "in-production",
        },
        {
          activity: "reaction",
          quantity: 15,
          sourceOutputQuantity: 60,
          sourceJobId: 2,
          sourceCompletionAt: "2026-10-16T00:00:00.000Z",
          state: "in-production",
        },
      ],
      now,
    ),
    [{ days: 0, quantity: 100 }],
  );
});

void test("uses a valid completion offset when the absolute timestamp is invalid", () => {
  assert.deepEqual(
    simulationCompletionBuckets(
      [
        {
          activity: "reaction",
          quantity: 5,
          sourceJobId: 1,
          sourceCompletionAt: "invalid",
          sourceCompletionOffsetSeconds: 12 * 60 * 60,
          state: "in-production",
        },
      ],
      now,
    ),
    [{ days: 1, quantity: 5 }],
  );
});
