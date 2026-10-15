import assert from "node:assert/strict";
import test from "node:test";
import { prepareSimulationAssets } from "./requestAssets";

void test("filters packaged ordinary assets and preserves unpackaged assets", () => {
  const prepared = prepareSimulationAssets([
    { typeId: 1, name: "Packaged", quantity: 1, isPackaged: true },
    { typeId: 2, name: "Unpackaged", quantity: 2, isPackaged: false },
  ]);
  assert.deepEqual(
    prepared.map((item) => item.typeId),
    [2],
  );
});

void test("includes unpackaged ship contents only from approved holds", () => {
  const prepared = prepareSimulationAssets([
    {
      typeId: 1,
      name: "Cargo item",
      quantity: 1,
      isPackaged: false,
      isContainedByShip: true,
      locationFlag: "Cargo",
    },
    {
      typeId: 2,
      name: "Infrastructure hangar item",
      quantity: 1,
      isPackaged: false,
      isContainedByShip: true,
      locationFlag: "InfrastructureHangar",
    },
    {
      typeId: 3,
      name: "Fitted module",
      quantity: 1,
      isPackaged: false,
      isContainedByShip: true,
      locationFlag: "HiSlot0",
    },
    {
      typeId: 4,
      name: "Packaged cargo item",
      quantity: 1,
      isPackaged: true,
      isContainedByShip: true,
      locationFlag: "Cargo",
    },
  ]);

  assert.deepEqual(
    prepared.map((item) => item.typeId),
    [1, 2],
  );
});

void test("accepts unpackaged assets from every approved ship hold", () => {
  const allowedHoldFlags = [
    "Cargo",
    "ExpeditionHold",
    "FleetHangar",
    "InfrastructureHangar",
    "MoonMaterialBay",
    "SpecializedAmmoHold",
    "SpecializedAsteroidHold",
    "SpecializedFuelBay",
    "SpecializedGasHold",
    "SpecializedIceHold",
    "SpecializedIndustrialShipHold",
    "SpecializedLargeShipHold",
    "SpecializedMaterialBay",
    "SpecializedMediumShipHold",
    "SpecializedMineralHold",
    "SpecializedOreHold",
    "SpecializedPlanetaryCommoditiesHold",
    "SpecializedSalvageHold",
    "SpecializedShipHold",
    "SpecializedSmallShipHold",
  ];
  const prepared = prepareSimulationAssets(
    allowedHoldFlags.map((locationFlag, index) => ({
      typeId: index + 1,
      name: locationFlag,
      quantity: 1,
      isPackaged: false,
      isContainedByShip: true,
      locationFlag,
    })),
  );

  assert.equal(prepared.length, allowedHoldFlags.length);
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
