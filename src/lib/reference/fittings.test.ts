import assert from "node:assert/strict";
import test from "node:test";
import { FittingSlot, parseFitting } from "./fittings";

void test("parses native XML with explicit module slots and quantities", () => {
  const fitting = parseFitting(`<?xml version="1.0"?><fittings><fitting name="Patrol">
    <shipType value="Rifter"/><hardware type="200mm AutoCannon II" slot="hi slot 0"/>
    <hardware type="EMP S" slot="cargo bay" qty="1200"/>
    <hardware type="Standup Siren II" slot="fighter bay" qty="2"/>
    </fitting></fittings>`);
  assert.equal(fitting.shipTypeName, "Rifter");
  assert.equal(fitting.items[0].slot, FittingSlot.High);
  assert.equal(fitting.items[1].quantity, 1200);
  assert.equal(fitting.items[2].slot, FittingSlot.Fighter);
  assert.throws(() => parseFitting("<!DOCTYPE fits><fittings/>"), /invalid|entities/);
});

void test("parses ship fittings without requiring structure service sections", () => {
  const fitting = parseFitting(`[Rifter, Empty lower slots]
[Empty Low slot]

[Empty Med slot]

200mm AutoCannon II

[Empty Rig slot]`);
  assert.equal(fitting.items[0]?.slot, FittingSlot.High);
  assert.equal(fitting.items[0]?.name, "200mm AutoCannon II");
});

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

void test("keeps services in the service slot when the paste has extra blank lines", () => {
  const fitting = parseFitting(`[Tatara, J130330 - V The Empire Refines Back]
Standup Capacitor Power Relay II
Standup Capacitor Power Relay II
Standup Capacitor Power Relay II

Standup Variable Spectrum ECM II
Standup Variable Spectrum ECM II
[Empty Med slot]
Standup Variable Spectrum ECM II

Standup Heavy Energy Neutralizer I
Standup Heavy Energy Neutralizer I
Standup Point Defense Battery II
Standup Heavy Energy Neutralizer I
Standup Heavy Energy Neutralizer I

Standup L-Set Reprocessing Monitor II
Standup L-Set Reactor Efficiency I


Standup Cloning Center I
Standup Reprocessing Facility I`);

  assert.deepEqual(
    fitting.items.filter((item) => item.slot === FittingSlot.Service).map((item) => item.name),
    ["Standup Cloning Center I", "Standup Reprocessing Facility I"],
  );
});

void test("uses the hull section order when subsystem ships omit the service section", () => {
  const fitting = parseFitting(
    `[Loki, Exploration]

Low Module

Medium Module

High Module

Rig Module

Loki Core - Augmented Nuclear Reactor

Acolyte II x5

Covert Ops Cloaking Device II`,
    {
      eftSlotOrder: [
        FittingSlot.Low,
        FittingSlot.Medium,
        FittingSlot.High,
        FittingSlot.Rig,
        FittingSlot.Subsystem,
        FittingSlot.Drone,
        FittingSlot.Cargo,
      ],
    },
  );

  assert.deepEqual(
    fitting.items.map(({ name, slot }) => ({ name, slot })),
    [
      { name: "Low Module", slot: FittingSlot.Low },
      { name: "Medium Module", slot: FittingSlot.Medium },
      { name: "High Module", slot: FittingSlot.High },
      { name: "Rig Module", slot: FittingSlot.Rig },
      { name: "Loki Core - Augmented Nuclear Reactor", slot: FittingSlot.Subsystem },
      { name: "Acolyte II", slot: FittingSlot.Drone },
      { name: "Covert Ops Cloaking Device II", slot: FittingSlot.Cargo },
    ],
  );
});

void test("uses the hull section order when structures omit the subsystem section", () => {
  const fitting = parseFitting(
    `[Sotiyo, Industry]

Low Module

Medium Module

High Module

Rig Module

Standup Manufacturing Plant I

Standup Siren II x2

Nanite Repair Paste x50`,
    {
      eftSlotOrder: [
        FittingSlot.Low,
        FittingSlot.Medium,
        FittingSlot.High,
        FittingSlot.Rig,
        FittingSlot.Service,
        FittingSlot.Drone,
        FittingSlot.Cargo,
      ],
    },
  );

  assert.deepEqual(
    fitting.items.map(({ name, slot }) => ({ name, slot })),
    [
      { name: "Low Module", slot: FittingSlot.Low },
      { name: "Medium Module", slot: FittingSlot.Medium },
      { name: "High Module", slot: FittingSlot.High },
      { name: "Rig Module", slot: FittingSlot.Rig },
      { name: "Standup Manufacturing Plant I", slot: FittingSlot.Service },
      { name: "Standup Siren II", slot: FittingSlot.Drone },
      { name: "Nanite Repair Paste", slot: FittingSlot.Cargo },
    ],
  );
});
