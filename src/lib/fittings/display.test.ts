import assert from "node:assert/strict";
import test from "node:test";
import { fittingDisplayItems, groupFittingItems, type FittingDisplayItem } from "./display";

/** Creates a minimal ship asset fixture without production data. */
function item(itemId: number, locationFlag: string, isAmmo = false): FittingDisplayItem {
  return { itemId, locationFlag, isAmmo, typeId: 1, quantity: isAmmo ? 100 : 1 };
}

void test("groups slots in ship-dialog order and keeps loaded ammo beside its module", () => {
  const items = [
    item(1, "Cargo", true),
    item(2, "HiSlot1"),
    item(3, "LoSlot0"),
    item(4, "HiSlot0", true),
    item(5, "HiSlot0"),
    item(6, "RigSlot0"),
    item(7, "MedSlot0"),
  ];
  const before = structuredClone(items);
  const groups = groupFittingItems(items);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["High Slots", "Medium Slots", "Low Slots", "Rig Slots", "Cargo"],
  );
  assert.deepEqual(
    groups[0].rows.map((row) => row.item.itemId),
    [5, 2],
  );
  assert.deepEqual(
    groups[0].rows[0].ammunition.map((ammo) => ammo.itemId),
    [4],
  );
  assert.equal(groups.at(-1)?.rows[0].item.quantity, 100);
  assert.deepEqual(items, before);
});

void test("retains unpaired charges, repeated modules and independently named holds", () => {
  const groups = groupFittingItems([
    item(1, "HiSlot1", true),
    item(2, "HiSlot0"),
    item(3, "HiSlot0"),
    item(4, "FleetHangar"),
  ]);
  assert.equal(groups[0].rows.length, 3);
  assert.equal(groups[1].label, "Fleet Hangar");
  assert.deepEqual(groupFittingItems([]), []);
});

void test("saved fittings use the same slot groups, ammo pairing and bay quantities", () => {
  const items = fittingDisplayItems(
    [
      { type_id: 10, quantity: 1, flag: 27 },
      { type_id: 11, quantity: 40, flag: 27 },
      { type_id: 11, quantity: 500, flag: 5 },
      { type_id: 12, quantity: 5, flag: 87 },
      { type_id: 13, quantity: 1, flag: 126 },
      { type_id: 14, quantity: 1, flag: 164 },
    ],
    new Set([11]),
  );
  const groups = groupFittingItems(items);
  assert.equal(groups[0].rows[0].ammunition[0].quantity, 40);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["High Slots", "Subsystem Slots", "Service Slots", "Cargo", "Drone Bay"],
  );
  assert.equal(groups.find((group) => group.key === "Cargo")?.rows[0].item.quantity, 500);
});
