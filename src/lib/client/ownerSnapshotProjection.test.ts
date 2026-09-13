import assert from "node:assert/strict";
import test from "node:test";
import { projectOwnerSnapshotsToClientAssets } from "./ownerSnapshotProjection";
import type { ClientOwnerSnapshot } from "./ownerSnapshotCache";
import { filterClientAssetsForPlanning } from "./requestCache";

const snapshot: ClientOwnerSnapshot = {
  schemaVersion: 1,
  owner: { kind: "corporation", id: 900 },
  assets: [
    {
      itemId: 44,
      typeId: 34,
      quantity: 12,
      locationId: 44,
      containerId: 44,
      rootLocationId: 600,
      hangarId: 600,
      locationType: "item",
      locationFlag: "CorpSAG1",
      isSingleton: false,
      ownerType: "corporation",
      ownerId: 900,
      rootLocation: {
        locationId: 600,
        kind: "structure",
        name: "Jita - Production Fortizar",
        systemId: 30000142,
        resolved: true,
      },
    },
  ],
  industryJobs: [],
  blueprintInstances: [],
  rootLocations: [],
  corporationSources: [
    {
      corporationId: 900,
      rootLocationId: 600,
      locationFlag: "CorpSAG1",
      label: "Production Hangar",
      rootLocation: {
        locationId: 600,
        kind: "structure",
        name: "Production Fortizar",
        systemName: "Jita",
        systemId: 30000142,
        resolved: true,
      },
      canTake: true,
      canQuery: true,
      selected: true,
      containerItemIds: [44],
      containers: [
        {
          itemId: 44,
          name: "Mineral Bin",
          locationId: 44,
          rootLocationId: 600,
          selected: false,
        },
      ],
    },
  ],
  jobs: { slotUsage: {}, jobs: [] },
  marketOrders: { marketOrderStock: null, marketBuyOrderQuantities: null },
  ships: { assets: [], ships: [] },
};

void test("projects stable owner assets into enriched client assets", () => {
  const result = projectOwnerSnapshotsToClientAssets(
    [snapshot],
    {
      metadata: [
        {
          typeId: 34,
          name: "Tritanium",
          assembledVolume: 0.01,
          packagedVolume: 0.01,
          category: "item",
          assemblyLineGroup: "standard",
        },
      ],
    },
  );

  assert.deepEqual(
    result.assets,
    [
      {
        typeId: 34,
        name: "Tritanium",
        quantity: 12,
        locationId: 44,
        rootLocationId: 600,
        sourceLocationName: "Jita - Production Fortizar",
        sourceLocationKind: "structure",
        sourceSystemId: 30000142,
        sourceSystemName: "System 30000142",
        ownerType: "corporation",
        ownerId: 900,
        inUse: undefined,
        me: undefined,
        te: undefined,
        category: "item",
        assembledVolume: 0.01,
        packagedVolume: 0.01,
        techLevel: undefined,
        assemblyLineGroup: "standard",
        corporationSource: {
          rootLocationId: 600,
          locationFlag: "CorpSAG1",
          containerItemIds: [44],
        },
      },
    ],
  );
  const projectedSource = result.corporationSources?.[0];
  assert.ok(projectedSource);
  assert.deepEqual(
    projectedSource.containers,
    [
      {
        itemId: 44,
        name: "Mineral Bin",
        locationId: 44,
        rootLocationId: 600,
        selected: false,
      },
    ],
  );
  assert.equal(projectedSource.label, "Production Hangar");
  assert.deepEqual(
    projectedSource.rootLocation,
    {
      locationId: 600,
      kind: "structure",
      name: "Production Fortizar",
      systemName: "Jita",
      systemId: 30000142,
      resolved: true,
    },
  );
  assert.equal(filterClientAssetsForPlanning(result).assets?.length, 0);
});

void test("falls back to legacy container IDs when needed", () => {
  const legacySnapshot = {
    ...snapshot,
    corporationSources: snapshot.corporationSources.map(
      ({ containers: _containers, ...source }) => source,
    ),
  };
  const result = projectOwnerSnapshotsToClientAssets([legacySnapshot], { metadata: [] });

  assert.deepEqual(
    result.corporationSources?.[0]?.containers,
    [
      {
        itemId: 44,
        locationId: 600,
        rootLocationId: 600,
        selected: true,
      },
    ],
  );
});

void test("associates nested assets with their corporation container source", () => {
  const nestedSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: [
      {
        ...snapshot.assets[0],
        itemId: 45,
        locationId: 44,
        containerId: 44,
        rootLocationId: 600,
        hangarId: 700,
        locationFlag: "Unlocked",
      },
    ],
    corporationSources: [
      {
        ...snapshot.corporationSources[0],
        rootLocationId: 700,
        locationFlag: "CorpSAG3",
        containerItemIds: [44],
        containers: [
          {
            itemId: 44,
            name: "Mineral Bin",
            locationId: 44,
            rootLocationId: 600,
            selected: true,
          },
        ],
      },
    ],
  };
  const result = projectOwnerSnapshotsToClientAssets([nestedSnapshot], { metadata: [] });

  assert.deepEqual(
    result.assets?.[0]?.corporationSource,
    {
      rootLocationId: 700,
      locationFlag: "CorpSAG3",
      containerItemIds: [44],
    },
  );
  assert.equal(filterClientAssetsForPlanning(result).assets?.length, 1);
});

void test("projects blueprint instance runs for asset aggregation", () => {
  const blueprintSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: [
      {
        ...snapshot.assets[0],
        typeId: 41583,
        quantity: 1,
      },
    ],
    blueprintInstances: [
      {
        itemId: snapshot.assets[0].itemId,
        typeId: 41583,
        locationId: 44,
        locationFlag: "CorpSAG1",
        quantity: -2,
        runs: 7,
        me: 10,
        te: 12,
        ownerType: "corporation",
        ownerId: 900,
      },
    ],
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [blueprintSnapshot],
    {
      metadata: [{ typeId: 41583, name: "Minokawa Blueprint", category: "blueprint" }],
    },
  );

  assert.deepEqual(
    result.assets?.[0]?.blueprintPrints,
    [
      {
        itemId: 44,
        runs: 7,
        type: "bpc",
        me: 10,
        te: 12,
      },
    ],
  );
});

void test("projects job output and remaining blueprint runs without an asset record", () => {
  const jobSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: [],
    industryJobs: [
      {
        jobId: 700,
        activityId: 1,
        blueprintId: 701,
        blueprintLocationId: 600,
        blueprintTypeId: 21018,
        endDate: "2026-01-02T00:00:00.000Z",
        facilityId: 600,
        installerId: 1,
        installedRuns: 30,
        licensedRuns: 40,
        locationId: 600,
        outputLocationId: 44,
        ownerType: "corporation",
        ownerId: 900,
        probability: 1,
        productTypeId: 21017,
        runs: 30,
        startDate: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ],
    jobs: {
      slotUsage: {},
      jobs: [
        {
          jobId: 700,
          characterId: 1,
          ownerId: 900,
          ownerType: "corporation",
          activityId: 1,
          status: "active",
          runs: 30,
          outputQuantity: 30,
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-01-02T00:00:00.000Z",
          facilityId: 600,
          outputLocationId: 44,
          blueprintTypeId: 21018,
          productTypeId: 21017,
        },
      ],
    },
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [jobSnapshot],
    {
      metadata: [
        { typeId: 21017, name: "Capital Armor Plates", category: "item" },
        { typeId: 21018, name: "Capital Armor Plates Blueprint", category: "blueprint" },
      ],
    },
  );

  const output = result.assets?.find((item) => item.typeId === 21017);
  const blueprint = result.assets?.find((item) => item.typeId === 21018);
  assert.ok(output);
  assert.ok(blueprint);
  assert.equal(output.quantity, 30);
  assert.equal(output.inBuildQuantity, 30);
  assert.equal(blueprint.blueprintType, "bpc");
  assert.equal(blueprint.blueprintPrints?.[0]?.runs, 10);
});

void test("preserves market order source location names", () => {
  const result = projectOwnerSnapshotsToClientAssets(
    [
      {
        ...snapshot,
        marketOrders: {
          marketOrderStock: [
            {
              typeId: 34,
              quantity: 25,
              sourceLocationId: 600,
              sourceLocationName: "Jita IV - Moon 4",
              sourceLocationKind: "station",
              sourceSystemId: 30000142,
              sourceSystemName: "Jita",
              source: "marketOrder",
            },
          ],
          marketBuyOrderQuantities: null,
        },
      },
    ],
    { metadata: [] },
  );

  const projectedMarketOrder = result.assets?.[1];
  assert.ok(projectedMarketOrder);
  assert.equal(projectedMarketOrder.sourceLocationName, "Jita IV - Moon 4");
  assert.equal(projectedMarketOrder.sourceSystemName, "Jita");
});
