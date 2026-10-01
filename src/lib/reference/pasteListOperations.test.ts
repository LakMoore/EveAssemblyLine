import assert from "node:assert/strict";
import test from "node:test";
import { applyPasteListMode, reconcilePasteListItems } from "./pasteListOperations";

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

void test("preserves metadata for duplicate type rows one at a time", () => {
  assert.deepEqual(
    reconcilePasteListItems(
      [
        { typeId: 1, quantity: 5, fromCompression: false },
        { typeId: 1, quantity: 7, fromCompression: true },
      ],
      [
        { typeId: 1, quantity: 8 },
        { typeId: 1, quantity: 7 },
      ],
      (item) => ({ ...item, fromCompression: false }),
    ),
    [
      { typeId: 1, quantity: 8, fromCompression: false },
      { typeId: 1, quantity: 7, fromCompression: true },
    ],
  );
});
