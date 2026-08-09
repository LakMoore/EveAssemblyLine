import assert from "node:assert/strict";
import test from "node:test";
import { compressMaterials, type CompressionCandidate } from "./compressEngine";

const names = new Map([
  [34, "Tritanium"],
  [35, "Pyerite"],
  [62516, "Compressed Veldspar"],
  [62520, "Compressed Scordite"],
  [28430, "Batch Compressed Veldspar II-Grade"],
]);
const candidates: CompressionCandidate[] = [
  { typeId: 62516, name: "Compressed Veldspar", unitsToReprocess: 100, efficiency: 100, yields: new Map([[34, 400]]) },
  { typeId: 62520, name: "Compressed Scordite", unitsToReprocess: 100, efficiency: 100, yields: new Map([[34, 150], [35, 110]]) },
];

test("compresses exact Tritanium into one compressed Veldspar", () => {
  const result = compressMaterials([{ typeId: 34, name: "Tritanium", quantity: 400 }], candidates, names);
  assert.deepEqual(result.toBuy, [{ typeId: 62516, name: "Compressed Veldspar", quantity: 100 }]);
  assert.deepEqual(result.plan, [{ typeId: 34, name: "Tritanium", quantity: 400, fromReprocessing: 400, surplus: 0 }]);
  assert.deepEqual(result.surplus, []);
});

test("selects exact mixed-ore quantities for Tritanium and Pyerite", () => {
  const result = compressMaterials([
    { typeId: 34, name: "Tritanium", quantity: 150 },
    { typeId: 35, name: "Pyerite", quantity: 110 },
  ], candidates, names);
  assert.deepEqual(result.toBuy, [{ typeId: 62520, name: "Compressed Scordite", quantity: 100 }]);
  assert.deepEqual(result.surplus, []);
});

test("uses one unit for batch-compressed ore", () => {
  const result = compressMaterials([{ typeId: 34, name: "Tritanium", quantity: 420 }], [{ typeId: 28430, name: "Batch Compressed Veldspar II-Grade", unitsToReprocess: 1, efficiency: 100, yields: new Map([[34, 420]]) }], names);
  assert.deepEqual(result.toBuy, [{ typeId: 28430, name: "Batch Compressed Veldspar II-Grade", quantity: 1 }]);
});

test("keeps minerals without a matching recipe in the buy list", () => {
  const result = compressMaterials([{ typeId: 35, name: "Pyerite", quantity: 1 }], candidates.slice(0, 1), names);
  assert.deepEqual(result.toBuy, [{ typeId: 35, name: "Pyerite", quantity: 1 }]);
});