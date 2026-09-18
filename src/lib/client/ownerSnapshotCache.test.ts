import assert from "node:assert/strict";
import test from "node:test";
import {
  getOwnerSnapshotETags,
  isCompleteClientOwnerSnapshot,
  mergeOwnerSnapshot,
  ownerSnapshotKey,
  ownerSnapshotScope,
  type ClientOwnerSnapshot,
  type ClientOwnerSnapshotResponse,
} from "./ownerSnapshotCache";

function slice<T>(data: T) {
  return { eTag: "test", data, status: { status: "cached" as const, hasBody: true } };
}

const completeSnapshot = {
  schemaVersion: 5,
  owner: { kind: "character", id: 123 },
  assets: slice([]),
  industryJobs: slice([]),
  blueprintInstances: slice([]),
  rootLocations: slice([]),
  corporationSources: slice([]),
  jobs: slice([]),
  marketOrders: slice([]),
  ships: slice([]),
  skills: slice([]),
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

void test("merges modified slices and retains unchanged cached data", () => {
  const response = {
    schemaVersion: 5,
    owner: completeSnapshot.owner,
    assets: {
      eTag: completeSnapshot.assets.eTag,
      isEmpty: false,
      isModified: false,
      status: completeSnapshot.assets.status,
    },
    industryJobs: {
      eTag: "industry-jobs",
      isEmpty: true,
      isModified: true,
      status: { status: "fresh", hasBody: true },
      data: [],
    },
    blueprintInstances: {
      eTag: completeSnapshot.blueprintInstances.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.blueprintInstances.status,
    },
    rootLocations: {
      eTag: completeSnapshot.rootLocations.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.rootLocations.status,
    },
    corporationSources: {
      eTag: completeSnapshot.corporationSources.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.corporationSources.status,
    },
    jobs: {
      eTag: completeSnapshot.jobs.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.jobs.status,
    },
    marketOrders: {
      eTag: completeSnapshot.marketOrders.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.marketOrders.status,
    },
    ships: {
      eTag: completeSnapshot.ships.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.ships.status,
    },
    skills: {
      eTag: completeSnapshot.skills.eTag,
      isEmpty: true,
      isModified: false,
      status: completeSnapshot.skills.status,
    },
  } satisfies ClientOwnerSnapshotResponse;
  const merged = mergeOwnerSnapshot(completeSnapshot, response);

  assert.equal(merged.assets.data, completeSnapshot.assets.data);
  assert.deepEqual(
    merged.industryJobs,
    {
      eTag: "industry-jobs",
      data: [],
      status: { status: "fresh", hasBody: true },
    },
  );
  assert.deepEqual(
    getOwnerSnapshotETags(merged),
    {
      assets: "test",
      blueprintInstances: "test",
      corporationSources: "test",
      industryJobs: "industry-jobs",
      jobs: "test",
      marketOrders: "test",
      rootLocations: "test",
      ships: "test",
      skills: "test",
    },
  );
});

void test("accepts corporation container selection metadata", () => {
  assert.equal(
    isCompleteClientOwnerSnapshot({
      ...completeSnapshot,
      corporationSources: slice([
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
      ]),
    }),
    true,
  );
});

void test("accepts synthetic delivered asset IDs", () => {
  assert.equal(
    isCompleteClientOwnerSnapshot({
      ...completeSnapshot,
      assets: slice([
        {
          itemId: -671463795,
          typeId: 57479,
          quantity: 18,
          locationId: 1055498192868,
          locationType: "item",
          locationFlag: "Unlocked",
          isSingleton: false,
          ownerType: "corporation",
          ownerId: 840323545,
          containerId: 1055498192868,
          rootLocationId: 1055354926818,
          hangarId: 1055380791459,
        },
      ]),
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
    jobs: slice([{}]),
  };
  assert.equal(isCompleteClientOwnerSnapshot(malformed), false);
});

void test("rejects malformed preserved optional fields", () => {
  const malformedStock = {
    ...completeSnapshot,
    marketOrders: slice([
      {
        typeId: 34,
        locationId: 60000001,
        buyOrderQuantity: "bad",
        sellOrderQuantity: 0,
      },
    ]),
  };
  const malformedAsset = {
    ...completeSnapshot,
    assets: slice([
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
    ]),
  };
  const malformedShip = {
    ...completeSnapshot,
    ships: slice([
      {
        itemId: 1,
        typeId: 34,
        ownerType: "character",
        ownerId: 123,
        items: [],
        isInSpace: "yes",
      },
    ]),
  };
  assert.equal(isCompleteClientOwnerSnapshot(malformedStock), false);
  assert.equal(isCompleteClientOwnerSnapshot(malformedAsset), false);
  assert.equal(isCompleteClientOwnerSnapshot(malformedShip), false);
});
