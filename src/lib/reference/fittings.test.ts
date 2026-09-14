import assert from "node:assert/strict";
import test from "node:test";
import { parseFitting } from "./fittings";

void test("parses EFT fittings into ESI slot flags and quantities", () => {
  const fitting = parseFitting(`[Sotiyo, J130330 - I The Industrial Menace]
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
  assert.equal(fitting.name, "J130330 - I The Industrial Menace");
  assert.deepEqual(
    fitting.items.slice(0, 3).map(({ name, flag, quantity }) => ({ name, flag, quantity })),
    [
      { name: "Standup Ballistic Control System II", flag: 27, quantity: 1 },
      { name: "Standup Signal Amplifier II", flag: 28, quantity: 1 },
      { name: "Standup Ballistic Control System II", flag: 29, quantity: 1 },
    ],
  );
  assert.deepEqual(
    fitting.items.filter((item) => item.flag >= 92 && item.flag < 100),
    [
      {
        flag: 93,
        name: "Standup XL-Set Ship Manufacturing Efficiency I",
        quantity: 1,
      },
      {
        flag: 94,
        name: "Standup XL-Set Structure and Component Manufacturing Efficiency I",
        quantity: 1,
      },
    ],
  );
  assert.deepEqual(
    fitting.items.filter((item) => item.flag === 5),
    [
      { flag: 5, name: "Standup Radar ECM Script", quantity: 4 },
      { flag: 5, name: "Standup Cruise Missile", quantity: 3000 },
      { flag: 5, name: "Standup Siren II", quantity: 19 },
    ],
  );
});
