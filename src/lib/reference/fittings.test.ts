import assert from "node:assert/strict";
import test from "node:test";
import { FittingSlot, parseFitting } from "./fittings";

void test("parses EFT fittings into ESI slot flags and quantities", () => {
  const fitting = parseFitting(`[Sotiyo, A Sotiyo far far away]
Standup Ballistic Control System II
Standup Signal Amplifier II
Standup Ballistic Control System II

Standup Target Painter II
Standup Stasis Webifier II
Standup Cap Battery II
Standup Focused Warp Disruptor II

Standup Multirole Missile Launcher II
Standup Multirole Missile Launcher II
Standup Heavy Energy Neutralizer II
Standup Multirole Missile Launcher II
Standup Guided Bomb Launcher II
Standup Point Defense Battery II

[Empty Rig slot]
Standup XL-Set Ship Manufacturing Efficiency I
Standup XL-Set Structure and Component Manufacturing Efficiency I

Standup Cloning Center I
Standup Capital Shipyard I
Standup Manufacturing Plant I
[Empty Service slot]
Standup Invention Lab I

Standup Radar ECM Script x4
Standup Cruise Missile x3000

Standup Siren II x19`);

  assert.equal(fitting.format, "eft");
  assert.equal(fitting.shipTypeName, "Sotiyo");
  assert.equal(fitting.name, "A Sotiyo far far away");
  assert.deepEqual(
    fitting.items
      .slice(0, 3)
      .map(({ name, slot, slotIndex, quantity }) => ({
        name,
        slot,
        slotIndex,
        quantity,
      })),
    [
      {
        name: "Standup Ballistic Control System II",
        slot: FittingSlot.Low,
        slotIndex: 0,
        quantity: 1,
      },
      { name: "Standup Signal Amplifier II", slot: FittingSlot.Low, slotIndex: 1, quantity: 1 },
      {
        name: "Standup Ballistic Control System II",
        slot: FittingSlot.Low,
        slotIndex: 2,
        quantity: 1,
      },
    ],
  );
  assert.deepEqual(
    fitting.items.slice(3, 7).map(({ slot, slotIndex }) => ({ slot, slotIndex })),
    [0, 1, 2, 3].map((slotIndex) => ({ slot: FittingSlot.Medium, slotIndex })),
  );
  assert.deepEqual(
    fitting.items.slice(7, 13).map(({ slot, slotIndex }) => ({ slot, slotIndex })),
    [0, 1, 2, 3, 4, 5].map((slotIndex) => ({ slot: FittingSlot.High, slotIndex })),
  );
  assert.deepEqual(
    fitting.items.filter((item) => item.slot === FittingSlot.Service),
    [
      { name: "Standup Cloning Center I", quantity: 1, slot: FittingSlot.Service, slotIndex: 0 },
      { name: "Standup Capital Shipyard I", quantity: 1, slot: FittingSlot.Service, slotIndex: 1 },
      {
        name: "Standup Manufacturing Plant I",
        quantity: 1,
        slot: FittingSlot.Service,
        slotIndex: 2,
      },
      { name: "Standup Invention Lab I", quantity: 1, slot: FittingSlot.Service, slotIndex: 4 },
    ],
  );
  assert.deepEqual(
    fitting.items.filter((item) => item.slot === FittingSlot.Rig),
    [
      {
        name: "Standup XL-Set Ship Manufacturing Efficiency I",
        quantity: 1,
        slot: FittingSlot.Rig,
        slotIndex: 1,
      },
      {
        name: "Standup XL-Set Structure and Component Manufacturing Efficiency I",
        quantity: 1,
        slot: FittingSlot.Rig,
        slotIndex: 2,
      },
    ],
  );
  assert.deepEqual(
    fitting.items.filter((item) => item.slot === FittingSlot.Cargo),
    [
      { name: "Standup Radar ECM Script", quantity: 4, slot: FittingSlot.Cargo, slotIndex: 0 },
      { name: "Standup Cruise Missile", quantity: 3000, slot: FittingSlot.Cargo, slotIndex: 1 },
    ],
  );
  assert.deepEqual(
    fitting.items.filter((item) => item.slot === FittingSlot.Drone),
    [{ name: "Standup Siren II", quantity: 19, slot: FittingSlot.Drone, slotIndex: 0 }],
  );
});
