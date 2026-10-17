import assert from "node:assert/strict";
import test from "node:test";
import { serializeEftFitting } from "./export";
import { parseFitting } from "../reference/fittings";

void test("serializes fitting names, slot sections, loaded ammo and bay quantities to EFT", () => {
  const text = serializeEftFitting(
    {
      name: "Patrol Fit",
      description: "not part of EFT",
      shipTypeId: 587,
      items: [
        { type_id: 100, quantity: 1, flag: 27 },
        { type_id: 200, quantity: 40, flag: 27 },
        { type_id: 300, quantity: 5, flag: 87 },
        { type_id: 400, quantity: 250, flag: 5 },
      ],
    },
    new Map([
      [587, "Rifter"],
      [100, "200mm Autocannon II"],
      [200, "Republic Fleet EMP S"],
      [300, "Hobgoblin II"],
      [400, "Probes"],
    ]),
    new Set([200]),
  );

  assert.match(text, /^\[Rifter, Patrol Fit\]/);
  assert.match(text, /200mm Autocannon II\nRepublic Fleet EMP S x40/);
  assert.match(text, /\[Empty Low Slot\]/);
  assert.match(text, /Hobgoblin II x5/);
  assert.match(text, /Probes x250/);
  const parsed = parseFitting(text);
  assert.equal(parsed.format, "eft");
  assert.equal(parsed.shipTypeName, "Rifter");
  assert.equal(parsed.name, "Patrol Fit");
  assert.deepEqual(
    parsed.items.map(({ name, quantity, slot }) => ({ name, quantity, slot })),
    [
      { name: "200mm Autocannon II", quantity: 1, slot: "high" },
      { name: "Republic Fleet EMP S", quantity: 40, slot: "high" },
      { name: "Hobgoblin II", quantity: 5, slot: "drone" },
      { name: "Probes", quantity: 250, slot: "cargo" },
    ],
  );
});

void test("rejects export when an item name is unavailable", () => {
  assert.throws(
    () =>
      serializeEftFitting(
        {
          name: "Fit",
          description: "",
          shipTypeId: 587,
          items: [{ type_id: 100, quantity: 1, flag: 5 }],
        },
        new Map([[587, "Rifter"]]),
        new Set(),
      ),
    /Could not resolve the name for fitting type 100/,
  );
});
