import assert from "node:assert/strict";
import test from "node:test";
import { prepareSimulationAssets } from "./requestAssets";

void test("filters non-packaged ordinary assets and preserves packaged assets", () => {
  const prepared = prepareSimulationAssets([
    { typeId: 1, name: "Unpackaged", quantity: 1, isPackaged: false },
    { typeId: 2, name: "Packaged", quantity: 2, isPackaged: true },
  ]);
  assert.deepEqual(
    prepared.map((item) => item.typeId),
    [2],
  );
});

void test("preserves packaged market orders", () => {
  const prepared = prepareSimulationAssets([
    {
      typeId: 34,
      name: "Tritanium",
      quantity: 81,
      locationId: 10,
      isPackaged: true,
      source: "marketOrder",
    },
  ]);

  assert.deepEqual(
    prepared.map((item) => item.typeId),
    [34],
  );
});

void test("preserves packaged in-flight industry outputs", () => {
  const prepared = prepareSimulationAssets([
    {
      typeId: 57453,
      name: "Carbon Fiber",
      quantity: 154_200,
      locationId: 20,
      rootLocationId: 20,
      category: "item",
      inBuild: true,
      isPackaged: true,
      jobId: 123,
      activityName: "manufacturing",
      industryJobStatus: "active",
    },
    {
      typeId: 34,
      name: "Tritanium",
      quantity: 2,
      locationId: 20,
      rootLocationId: 20,
      category: "item",
      inBuild: true,
      isPackaged: true,
      jobId: 124,
      activityName: "Reactions",
      industryJobStatus: "paused",
    },
  ]);

  assert.deepEqual(
    prepared.map((item) => item.typeId),
    [57453, 34],
  );
});

void test("merges blueprint prints by type, location, and owner", () => {
  const prepared = prepareSimulationAssets([
    {
      typeId: 100,
      name: "Blueprint",
      quantity: 1,
      locationId: 10,
      rootLocationId: 10,
      ownerType: "character",
      ownerId: 7,
      isPackaged: false,
      blueprintPrints: [{ itemId: 101, runs: 5, type: "bpc", me: 4 }],
    },
    {
      typeId: 100,
      name: "Blueprint",
      quantity: 1,
      locationId: 10,
      rootLocationId: 10,
      ownerType: "character",
      ownerId: 7,
      isPackaged: false,
      blueprintPrints: [{ itemId: 102, runs: 8, type: "bpc", me: 10 }],
    },
  ]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.quantity, 2);
  assert.deepEqual(
    prepared[0]?.blueprintPrints?.map((print) => print.itemId),
    [101, 102],
  );
  assert.deepEqual(
    prepared[0]?.blueprintPrints?.map((print) => [print.runs, print.me]),
    [
      [5, 4],
      [8, 10],
    ],
  );
});
