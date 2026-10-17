import assert from "node:assert/strict";
import test from "node:test";
import type { SavedFitting } from "@/lib/fittings/model";
import {
  addStockpileFitting,
  expandStockpileItems,
  stockpileFittingSnapshotSchema,
  reconcileStockpilePaste,
} from "./stockpileFittings";
import { createPlannerSimulationRequest } from "./simulator/plannerRequest";
import { parsePlannerSettings } from "./preferences";

const fitting: SavedFitting = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  revision: 1,
  updatedAt: "2026-10-17T00:00:00.000Z",
  name: "Patrol",
  shipTypeId: 100,
  description: "",
  items: [
    { type_id: 200, quantity: 1, flag: 27 },
    { type_id: 200, quantity: 1, flag: 28 },
    { type_id: 300, quantity: 50, flag: 5 },
  ],
};

void test("adds a detached snapshot and merges repeated selections by fitting ID", () => {
  const first = addStockpileFitting([], fitting);
  const next = addStockpileFitting(first, { ...fitting, items: [] });
  assert.equal(next.length, 1);
  assert.equal(next[0].quantity, 2);
  assert.equal(first[0].quantity, 1);
  assert.deepEqual(next[0].fitting?.items, fitting.items);
  assert.notEqual(first[0].fitting?.items, fitting.items);
  assert.notEqual(first[0].fitting?.items[0], fitting.items[0]);
  assert.ok(
    stockpileFittingSnapshotSchema.safeParse(JSON.parse(JSON.stringify(first[0].fitting))).success,
  );
});

void test("expands n hulls and every module/ammo stack without a library lookup", () => {
  const items = addStockpileFitting([], fitting);
  items[0].quantity = 3;
  assert.deepEqual(
    expandStockpileItems(items),
    [
      { typeId: 100, quantity: 3, me: 0, te: 0, fromCompression: false },
      { typeId: 200, quantity: 6, me: 0, te: 0, fromCompression: false },
      { typeId: 300, quantity: 150, me: 0, te: 0, fromCompression: false },
    ],
  );
  assert.deepEqual(expandStockpileItems([{ ...items[0], isIncluded: false }]), []);
});

void test("separates fittings sharing a hull from ordinary type rows", () => {
  const normal = {
    name: "Hull",
    typeId: 100,
    quantity: 4,
    categoryName: "Ships",
    me: 3,
    te: 4,
    fromCompression: false,
  };
  const items = addStockpileFitting(
    addStockpileFitting([normal], fitting),
    { ...fitting, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  );
  assert.equal(items.length, 3);
  assert.deepEqual(
    expandStockpileItems([normal]),
    [{ typeId: 100, quantity: 4, me: 3, te: 4, fromCompression: false }],
  );
});

void test("rejects malformed snapshots and unsafe expanded quantities", () => {
  const items = addStockpileFitting([], fitting);
  assert.throws(
    () => expandStockpileItems([{ ...items[0], quantity: Number.MAX_SAFE_INTEGER }]),
    /safe integers/,
  );
  assert.equal(
    stockpileFittingSnapshotSchema.safeParse({
      ...items[0].fitting,
      items: [{ type_id: -1, quantity: 1, flag: 5 }],
    }).success,
    false,
  );
});

void test("the actual simulator request expands fitting snapshots and omits library references", () => {
  const items = addStockpileFitting([], fitting);
  items[0].quantity = 2;
  const request = createPlannerSimulationRequest({
    stockpiles: [
      {
        id: "main",
        name: "Main",
        locations: {
          stock: 1,
          manufacturing: 1,
          reactions: 1,
          reprocessing: 1,
          copying: 1,
          invention: 1,
        },
        items,
      },
    ],
    stock: [],
    requestReady: true,
    settings: parsePlannerSettings({}),
    characterStatuses: [],
    language: "en",
    locationOptions: [],
    cachedAssetLocations: [],
    knownStructures: [],
    haulExclusions: [],
    jobs: null,
    includeStock: false,
    simulateSurplus: false,
    allowInterStockpileHauling: false,
    onlyIncludeTakeAccessAssets: false,
  });
  assert.deepEqual(
    request?.stockpiles[0].items,
    [
      { typeId: 100, quantity: 2, me: 0, te: 0, fromCompression: false },
      { typeId: 200, quantity: 4, me: 0, te: 0, fromCompression: false },
      { typeId: 300, quantity: 100, me: 0, te: 0, fromCompression: false },
    ],
  );
  assert.equal(JSON.stringify(request).includes(fitting.id), false);
});

void test("replacing a fitting with its copied expanded types never doubles demand", () => {
  const original = addStockpileFitting([], fitting);
  original[0].quantity = 3;
  const expected = expandStockpileItems(original);
  const copied = expected.map((item) => ({ ...item, name: `Type ${item.typeId}` }));
  const replaced = reconcileStockpilePaste(original, copied, "replace");
  assert.equal(
    replaced.some((item) => item.fitting),
    false,
  );
  assert.deepEqual(expandStockpileItems(replaced), expected);
});

void test("adding a pasted normal hull keeps the fitting snapshot separate", () => {
  const original = addStockpileFitting([], fitting);
  const added = reconcileStockpilePaste(
    original,
    [{ name: "Hull", typeId: 100, quantity: 4 }],
    "add",
  );
  assert.equal(added.length, 2);
  assert.equal(added[0].fitting?.id, fitting.id);
  assert.equal(added[1].fitting, undefined);
  assert.equal(added[1].quantity, 4);
});
