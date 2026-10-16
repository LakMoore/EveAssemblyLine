import assert from "node:assert/strict";
import test from "node:test";
import { filterSimulationAssetsByTakeAccess, prepareSimulationAssets } from "./requestAssets";

void test("filters corporation assets without TAKE access and preserves personal assets", () => {
  const filtered = filterSimulationAssetsByTakeAccess([
    { typeId: 1, name: "Personal blueprint", quantity: 1, ownerType: "character" },
    {
      typeId: 2,
      name: "TAKE hangar asset",
      quantity: 1,
      ownerType: "corporation",
      corporationSource: {
        rootLocationId: 10,
        locationFlag: "CorpSAG1",
        containerItemIds: [],
        canTake: true,
        canQuery: true,
      },
    },
    {
      typeId: 3,
      name: "QUERY-only blueprint",
      quantity: 1,
      ownerType: "corporation",
      corporationSource: {
        rootLocationId: 11,
        locationFlag: "CorpSAG2",
        containerItemIds: [],
        canTake: false,
        canQuery: true,
      },
    },
    {
      typeId: 4,
      name: "Corporation blueprint without source permissions",
      quantity: 1,
      ownerType: "corporation",
    },
    {
      typeId: 5,
      name: "Corporation market order",
      quantity: 1,
      ownerType: "corporation",
      source: "marketOrder",
    },
  ]);

  assert.deepEqual(
    filtered.map((item) => item.typeId),
    [1, 2, 5],
  );
});

void test("excludes every non-TAKE corporation hangar source regardless of asset type", () => {
  const queryOnlySource = (containerItemIds: number[]) => ({
    rootLocationId: 10,
    locationFlag: "CorpSAG1",
    containerItemIds,
    canTake: false,
    canQuery: true,
  });
  const filtered = filterSimulationAssetsByTakeAccess([
    {
      typeId: 10,
      name: "Direct hangar item without owner metadata",
      quantity: 1,
      corporationSource: queryOnlySource([]),
    },
    {
      typeId: 11,
      name: "Nested blueprint",
      quantity: 1,
      category: "blueprint",
      corporationSource: queryOnlySource([100]),
    },
    {
      typeId: 12,
      name: "Nested reaction formula",
      quantity: 1,
      category: "reactionformula",
      ownerType: "corporation",
      corporationSource: queryOnlySource([100]),
    },
    {
      typeId: 13,
      name: "TAKE hangar formula",
      quantity: 1,
      category: "reactionformula",
      ownerType: "corporation",
      corporationSource: { ...queryOnlySource([]), canTake: true },
    },
    { typeId: 14, name: "Personal asset", quantity: 1, ownerType: "character" },
  ]);

  assert.deepEqual(
    filtered.map((item) => item.typeId),
    [13, 14],
  );
});

void test("preserves packaged ordinary assets and excludes packaged ships", () => {
  const prepared = prepareSimulationAssets([
    { typeId: 1, name: "Packaged ordinary item", quantity: 1, isPackaged: true },
    { typeId: 2, name: "Unpackaged", quantity: 2, isPackaged: false },
    { typeId: 3, name: "Packaged ship", quantity: 1, isPackaged: true, isShip: true },
  ]);
  assert.deepEqual(
    prepared.map((item) => item.typeId),
    [1, 2],
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
