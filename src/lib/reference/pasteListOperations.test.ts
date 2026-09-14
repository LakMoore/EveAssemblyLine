import assert from "node:assert/strict";
import test from "node:test";
import { applyPasteListMode } from "./pasteListOperations";

void test("adds quantities for matching types", () => {
  assert.deepEqual(
    applyPasteListMode(
      [{ typeId: 1, quantity: 2 }],
      [
        { typeId: 1, quantity: 3 },
        { typeId: 2, quantity: 4 },
      ],
      "add",
    ),
    [
      { typeId: 1, quantity: 5 },
      { typeId: 2, quantity: 4 },
    ],
  );
});

void test("subtracts quantities without removing zeroed rows", () => {
  assert.deepEqual(
    applyPasteListMode(
      [
        { typeId: 1, quantity: 2 },
        { typeId: 2, quantity: 5 },
      ],
      [
        { typeId: 1, quantity: 3 },
        { typeId: 2, quantity: 2 },
        { typeId: 3, quantity: 1 },
      ],
      "subtract",
    ),
    [
      { typeId: 1, quantity: 0 },
      { typeId: 2, quantity: 3 },
    ],
  );
});
