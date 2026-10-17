import assert from "node:assert/strict";
import test from "node:test";
import type { Storage } from "@/lib/storage";
import {
  esiFittingSchema,
  fittingInputSchema,
  type FittingInput,
  type PersonalFitting,
} from "./model";
import { createFittingStore } from "./store";

/** Builds an isolated transactional adapter; never touches real Firestore. */
function fixture() {
  const records = new Map<string, unknown>();
  const storage: Storage = {
    getItem: <T>(key: string) =>
      Promise.resolve(structuredClone(records.get(key)) as T | undefined),
    getItemsByPrefix: () => Promise.resolve([]),
    setItem: (key, value) => {
      records.set(key, structuredClone(value));
      return Promise.resolve();
    },
    deleteItem: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
    async runTransaction(callback) {
      const writes = new Map<string, unknown>();
      const result = await callback({
        getItem: <T>(key: string) => storage.getItem<T>(key),
        getItemsByPrefix: (prefix: string) => storage.getItemsByPrefix(prefix),
        setItem(key, value) {
          writes.set(key, structuredClone(value));
        },
        deleteItem(key) {
          writes.set(key, undefined);
        },
      });
      for (const [key, value] of writes) {
        if (value === undefined) records.delete(key);
        else records.set(key, value);
      }
      return result;
    },
  };
  return createFittingStore(storage);
}

const input: FittingInput = { name: "Patrol", description: "", shipTypeId: 587, items: [] };
const personal: PersonalFitting = {
  fitting_id: 1,
  name: "Patrol",
  description: "",
  ship_type_id: 587,
  items: [],
};

void test("normalizes live symbolic ESI flags and accepts legacy numeric exports", () => {
  const parsed = esiFittingSchema.parse({
    ...personal,
    items: [
      { type_id: 2889, quantity: 1, flag: "HiSlot0" },
      { type_id: 1, quantity: 2, flag: "Cargo" },
      { type_id: 1, quantity: 3, flag: "DroneBay" },
      { type_id: 1, quantity: 1, flag: "RigSlot2" },
      { type_id: 1, quantity: 1, flag: 19 },
    ],
  });
  assert.deepEqual(
    parsed.items.map((item) => item.flag),
    [27, 5, 87, 94, 19],
  );
  assert.equal(
    esiFittingSchema.safeParse({
      ...personal,
      items: [{ type_id: 1, quantity: 1, flag: "HiSlot99" }],
    }).success,
    false,
  );
});

void test("fitting creation is collection-scoped, case-insensitive and deletion is revision protected", async () => {
  const store = fixture();
  assert.deepEqual(await store.list("alpha"), []);
  const fitting = await store.save("alpha", input);
  assert.equal((await store.list("alpha"))[0]?.shipTypeId, 587);
  assert.equal(await store.get("beta", fitting.id), undefined);
  await assert.rejects(store.save("alpha", { ...input, name: "PATROL" }), /already exists/);
  await assert.rejects(store.remove("beta", fitting.id, 1), /not found/);
  await assert.rejects(store.remove("alpha", fitting.id, 2), /changed/);
  await store.remove("alpha", fitting.id, 1);
  assert.deepEqual(await store.list("alpha"), []);
  assert.equal(await store.get("alpha", fitting.id), undefined);
});

void test("ESI seeding renames clashes and imported fittings cannot be deleted", async () => {
  const store = fixture();
  await store.save("alpha", input);
  await store.importPersonal("alpha", 99, [personal, { ...personal, fitting_id: 2 }]);
  const imported = (await store.list("alpha")).filter((fitting) => fitting.source);
  assert.deepEqual(
    imported.map((fitting) => fitting.name),
    ["Patrol (2)", "Patrol (3)"],
  );
  for (const fitting of imported) {
    await assert.rejects(
      store.remove("alpha", fitting.id, 1),
      { status: 403, message: "ESI-imported fittings cannot be deleted." },
    );
    assert.ok(await store.get("alpha", fitting.id));
  }
  await store.importPersonal("alpha", 99, [personal, { ...personal, fitting_id: 2 }]);
  assert.deepEqual(
    (await store.list("alpha")).map((fitting) => fitting.name),
    ["Patrol", "Patrol (2)", "Patrol (3)"],
  );
});

void test("fitting payload validation rejects malformed IDs, quantities and names", () => {
  for (const invalid of [
    { ...input, name: " " },
    { ...input, shipTypeId: -1 },
    { ...input, items: [{ flag: 27, type_id: 1, quantity: 0 }] },
    { ...input, collectionId: "other" },
  ]) assert.equal(fittingInputSchema.safeParse(invalid).success, false);
});
