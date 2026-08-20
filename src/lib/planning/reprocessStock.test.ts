import assert from "node:assert/strict";
import test from "node:test";
import { reprocessCompressedStock, specialReprocessableTypeIds } from "./reprocessStock";

const types = new Map([[62516, { _key: 62516, portionSize: 100 }]]);
const materials = new Map([
  [62516, { _key: 62516, materials: [{ materialTypeID: 34, quantity: 400 }] }],
]);
const compressibleTypes = new Map([[34, 62516]]);

test("reprocesses complete compressed portions into SDE material yields", () => {
  const result = reprocessCompressedStock(
    new Map([[62516, 250]]),
    new Map(),
    compressibleTypes,
    materials,
    types,
    undefined,
    new Map([[62516, 100]]),
  );

  assert.deepEqual(result.consumedCompressed, new Map([[62516, 200]]));
  assert.deepEqual(result.producedMaterials, new Map([[34, 800]]));
  assert.deepEqual(
    result.stock,
    new Map([
      [62516, 50],
      [34, 800],
    ]),
  );
});

test("defaults missing reprocessing efficiency to the base 50% yield", () => {
  const result = reprocessCompressedStock(
    new Map([[62516, 100]]),
    new Map(),
    compressibleTypes,
    materials,
    types,
  );

  assert.deepEqual(result.producedMaterials, new Map([[34, 200]]));
});

test("does not consume partial portions or unrelated compressed stock", () => {
  const result = reprocessCompressedStock(
    new Map([
      [62516, 99],
      [70000, 500],
    ]),
    new Map(),
    compressibleTypes,
    materials,
    types,
  );

  assert.deepEqual(result.consumedCompressed, new Map());
  assert.deepEqual(result.producedMaterials, new Map());
  assert.deepEqual(
    result.stock,
    new Map([
      [62516, 99],
      [70000, 500],
    ]),
  );
});

test("reserves compressed stock needed as a direct build requirement", () => {
  const result = reprocessCompressedStock(
    new Map([[62516, 250]]),
    new Map([[62516, 100]]),
    compressibleTypes,
    materials,
    types,
    undefined,
    new Map([[62516, 100]]),
  );

  assert.deepEqual(result.consumedCompressed, new Map([[62516, 100]]));
  assert.deepEqual(result.producedMaterials, new Map([[34, 400]]));
  assert.deepEqual(
    result.stock,
    new Map([
      [62516, 150],
      [34, 400],
    ]),
  );
});

test("reprocesses scrap metal and reinforced scrap metal with separate yields", () => {
  const scrapTypes = new Map([
    [15331, { portionSize: 1 }],
    [30497, { portionSize: 1 }],
  ]);
  const scrapMaterials = new Map([
    [15331, { _key: 15331, materials: [{ materialTypeID: 34, quantity: 500 }] }],
    [30497, { _key: 30497, materials: [{ materialTypeID: 34, quantity: 2500 }] }],
  ]);

  const result = reprocessCompressedStock(
    new Map([
      [15331, 2],
      [30497, 3],
    ]),
    new Map(),
    new Map(),
    scrapMaterials,
    scrapTypes,
    specialReprocessableTypeIds,
    new Map([
      [15331, 100],
      [30497, 100],
    ]),
  );

  assert.deepEqual(
    result.consumedCompressed,
    new Map([
      [15331, 2],
      [30497, 3],
    ]),
  );
  assert.deepEqual(result.producedMaterials, new Map([[34, 8500]]));
  assert.deepEqual(result.stock, new Map([[34, 8500]]));
});
