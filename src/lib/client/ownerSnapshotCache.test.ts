import assert from "node:assert/strict";
import test from "node:test";
import {
  isCompleteClientOwnerSnapshot,
  ownerSnapshotKey,
  ownerSnapshotScope,
  type ClientOwnerSnapshot,
} from "./ownerSnapshotCache";

const completeSnapshot = {
  schemaVersion: 1,
  owner: { kind: "character", id: 123 },
  assets: [],
  industryJobs: [],
  blueprintInstances: [],
  rootLocations: [],
  corporationSources: [],
  jobs: { slotUsage: {}, jobs: [] },
  marketOrders: { marketOrderStock: null, marketBuyOrderQuantities: null },
  ships: { assets: [], ships: [] },
} satisfies ClientOwnerSnapshot;

void test("keys snapshots by owner kind and ID", () => {
  const scope = ownerSnapshotScope([456, 123, 123]);
  assert.equal(scope, "123,456");
  assert.equal(ownerSnapshotKey({ kind: "character", id: 123 }, scope), "123,456:character:123");
  assert.equal(
    ownerSnapshotKey({ kind: "corporation", id: 123 }, scope),
    "123,456:corporation:123",
  );
  assert.notEqual(
    ownerSnapshotKey({ kind: "character", id: 123 }, scope),
    ownerSnapshotKey({ kind: "character", id: 123 }, "789"),
  );
});

void test("accepts complete owner snapshots", () => {
  assert.equal(isCompleteClientOwnerSnapshot(completeSnapshot), true);
});

void test("accepts corporation container selection metadata", () => {
  assert.equal(
    isCompleteClientOwnerSnapshot({
      ...completeSnapshot,
      corporationSources: [
        {
          corporationId: 900,
          rootLocationId: 60000001,
          locationFlag: "CorpSAG1",
          canTake: true,
          canQuery: true,
          selected: true,
          containerItemIds: [1234],
          containers: [
            {
              itemId: 1234,
              locationId: 60000001,
              rootLocationId: 60000001,
              selected: false,
            },
          ],
        },
      ],
    }),
    true,
  );
});

void test("rejects incomplete owner snapshots", () => {
  const incomplete = { ...completeSnapshot, marketOrders: undefined };
  assert.equal(isCompleteClientOwnerSnapshot(incomplete), false);
});

void test("rejects malformed nested snapshot records", () => {
  const malformed = {
    ...completeSnapshot,
    jobs: {
      slotUsage: { "123": { slots: [], availableSlots: {} } },
      jobs: [],
    },
  };
  assert.equal(isCompleteClientOwnerSnapshot(malformed), false);
});

void test("rejects malformed preserved optional fields", () => {
  const malformedStock = {
    ...completeSnapshot,
    marketOrders: {
      marketOrderStock: [
        {
          typeId: 34,
          quantity: 1,
          corporationSource: {
            rootLocationId: 60000001,
            locationFlag: "CorpSAG1",
            containerItemIds: ["bad"],
          },
        },
      ],
      marketBuyOrderQuantities: null,
    },
  };
  const malformedAsset = {
    ...completeSnapshot,
    assets: [
      {
        itemId: 1,
        typeId: 34,
        quantity: 1,
        locationId: 60000001,
        locationType: "station",
        locationFlag: "Hangar",
        isSingleton: false,
        ownerType: "character",
        ownerId: 123,
        inUse: "yes",
      },
    ],
  };
  const malformedShip = {
    ...completeSnapshot,
    ships: { assets: [], ships: [{ itemId: 1, typeId: 34, isInSpace: "yes" }] },
  };
  assert.equal(isCompleteClientOwnerSnapshot(malformedStock), false);
  assert.equal(isCompleteClientOwnerSnapshot(malformedAsset), false);
  assert.equal(isCompleteClientOwnerSnapshot(malformedShip), false);
});
