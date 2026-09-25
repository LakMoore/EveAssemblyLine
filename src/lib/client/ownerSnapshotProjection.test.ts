import assert from "node:assert/strict";
import test from "node:test";
import {
  projectOwnerSnapshotsToClientAssets,
  projectOwnerSnapshotsToClientJobs,
  projectOwnerSnapshotsToClientShips,
} from "./ownerSnapshotProjection";
import type { ClientOwnerSnapshot } from "./ownerSnapshotCache";
import { filterClientAssetsForPlanning, filterClientSellOrdersForPlanning } from "./requestCache";

function slice<T>(data: T) {
  return { eTag: "test", data, status: { status: "cached" as const, hasBody: true } };
}

const snapshot: ClientOwnerSnapshot = {
  schemaVersion: 6,
  owner: { kind: "corporation", id: 900 },
  assets: slice([
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
  ]),
  industryJobs: slice([]),
  blueprintInstances: slice([]),
  rootLocations: slice([]),
  corporationSources: slice([
    {
      corporationId: 900,
      rootLocationId: 600,
      locationFlag: "CorpSAG1",
      label: "Production Hangar",
      rootLocation: {
        locationId: 600,
        kind: "structure",
        name: "Production Fortizar",
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
  ]),
  jobs: slice([]),
  marketOrders: slice([]),
  ships: slice([]),
  skills: slice([]),
};

void test("projects ship ownership and nested fitting items", () => {
  const shipSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    ships: slice([
      {
        itemId: 100,
        typeId: 200,
        name: "Bait Corax",
        ownerType: "character",
        ownerId: 123,
        systemId: 30000142,
        rootLocation: {
          locationId: 600,
          kind: "station",
          name: "Jita IV - Moon 4",
          systemId: 30000142,
          resolved: true,
        },
        items: [
          {
            itemId: 101,
            typeId: 34,
            quantity: 2,
            locationId: 100,
            containerId: 100,
            rootLocationId: 600,
            hangarId: 600,
            locationType: "item",
            locationFlag: "HiSlot0",
            isSingleton: true,
            isAmmo: false,
          },
        ],
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientShips(
    [shipSnapshot],
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
        {
          typeId: 200,
          name: "Test Frigate",
          assembledVolume: 1,
          packagedVolume: 1,
          category: "item",
          assemblyLineGroup: "standard",
        },
      ],
      systemNames: new Map([[30000142, "Jita"]]),
    },
  );

  assert.deepEqual(
    result.ships?.[0],
    {
      itemId: 100,
      typeId: 200,
      name: "Bait Corax",
      systemId: 30000142,
      systemName: "Jita",
      pilotName: undefined,
      locationName: "Jita",
      ownerType: "character",
      ownerId: 123,
      rootLocation: {
        locationId: 600,
        kind: "station",
        name: "Jita IV - Moon 4",
        systemId: 30000142,
        resolved: true,
      },
      items: [
        {
          itemId: 101,
          typeId: 34,
          name: "Tritanium",
          quantity: 2,
          locationId: 100,
          locationType: "item",
          locationFlag: "HiSlot0",
          isSingleton: true,
          isAmmo: false,
        },
      ],
    },
  );
  assert.deepEqual(
    result.types,
    [
      { typeId: 200, name: "Test Frigate" },
      { typeId: 34, name: "Tritanium" },
    ],
  );
});

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
      systemNames: new Map([[30000142, "Jita"]]),
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
        sourceSystemName: "Jita",
        ownerType: "corporation",
        ownerId: 900,
        inUse: undefined,
        isPackaged: true,
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

void test("labels assets in an undocked ship with its solar system", () => {
  const undockedSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([
      {
        ...snapshot.assets.data[0],
        itemId: 45,
        locationId: 900,
        rootLocationId: 700,
        rootLocation: {
          locationId: 700,
          kind: "structure",
          systemId: 30000142,
          resolved: false,
        },
      },
    ]),
    ships: slice([
      {
        itemId: 900,
        typeId: 200,
        ownerType: "corporation",
        ownerId: 900,
        systemId: 30000142,
        isInSpace: true,
        items: [],
      },
    ]),
  };

  const result = projectOwnerSnapshotsToClientAssets(
    [undockedSnapshot],
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
      systemNames: new Map([[30000142, "Jita"]]),
    },
  );

  const projectedAsset = result.assets?.[0];
  assert.ok(projectedAsset);
  assert.equal(projectedAsset.sourceLocationName, "Jita \u00abUndocked\u00bb");
  assert.equal(projectedAsset.sourceLocationKind, "anchored");
  assert.equal(projectedAsset.sourceSystemId, 30000142);

  const dockedResult = projectOwnerSnapshotsToClientAssets(
    [
      {
        ...undockedSnapshot,
        ships: slice([{ ...undockedSnapshot.ships.data[0], isInSpace: undefined }]),
      },
    ],
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

  const dockedAsset = dockedResult.assets?.[0];
  assert.ok(dockedAsset);
  assert.equal(dockedAsset.sourceLocationName, "Structure details unavailable");
  assert.equal(dockedAsset.sourceLocationKind, "structure");
});

void test("falls back to legacy container IDs when needed", () => {
  const legacySnapshot = {
    ...snapshot,
    corporationSources: slice(
      snapshot.corporationSources.data.map(({ containers: _containers, ...source }) => source),
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
    assets: slice([
      {
        ...snapshot.assets.data[0],
        itemId: 45,
        locationId: 44,
        containerId: 44,
        rootLocationId: 600,
        hangarId: 700,
        locationFlag: "Unlocked",
      },
    ]),
    corporationSources: slice([
      {
        ...snapshot.corporationSources.data[0],
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
    ]),
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

void test("filters assets from an unselected container when a sibling is selected", () => {
  const nestedSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([
      {
        ...snapshot.assets.data[0],
        itemId: 45,
        locationId: 44,
        containerId: 44,
      },
    ]),
    corporationSources: slice([
      {
        ...snapshot.corporationSources.data[0],
        containerItemIds: [44, 45],
        containers: [
          {
            itemId: 44,
            name: "Ignored Can",
            locationId: 44,
            rootLocationId: 600,
            selected: false,
          },
          {
            itemId: 45,
            name: "Selected Can",
            locationId: 45,
            rootLocationId: 600,
            selected: true,
          },
        ],
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientAssets([nestedSnapshot], { metadata: [] });

  assert.deepEqual(
    result.assets?.[0]?.corporationSource,
    {
      rootLocationId: 600,
      locationFlag: "CorpSAG1",
      containerItemIds: [44],
    },
  );
  assert.equal(filterClientAssetsForPlanning(result).assets?.length, 0);
});

void test("projects blueprint instance runs for asset aggregation", () => {
  const blueprintSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([
      {
        ...snapshot.assets.data[0],
        typeId: 41583,
        quantity: 1,
      },
    ]),
    blueprintInstances: slice([
      {
        itemId: snapshot.assets.data[0].itemId,
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
    ]),
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

void test("classifies a blueprint original from the blueprint instance quantity", () => {
  const blueprintSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([
      {
        ...snapshot.assets.data[0],
        typeId: 41583,
        quantity: 1,
      },
    ]),
    blueprintInstances: slice([
      {
        itemId: snapshot.assets.data[0].itemId,
        typeId: 41583,
        locationId: 44,
        locationFlag: "CorpSAG1",
        quantity: -1,
        runs: -1,
        me: 10,
        te: 12,
        ownerType: "corporation",
        ownerId: 900,
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [blueprintSnapshot],
    {
      metadata: [{ typeId: 41583, name: "Minokawa Blueprint", category: "blueprint" }],
    },
  );
  const blueprint = result.assets?.[0];
  assert.ok(blueprint);

  assert.equal(blueprint.quantity, 1);
  assert.equal(blueprint.blueprintType, "bpo");
  assert.equal(blueprint.blueprintPrints?.[0]?.type, "bpo");
});

void test("preserves a stacked original blueprint quantity", () => {
  const blueprintSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([]),
    blueprintInstances: slice([
      {
        itemId: 415831,
        typeId: 41583,
        locationId: 44,
        locationFlag: "CorpSAG1",
        quantity: 3,
        runs: -1,
        me: 0,
        te: 0,
        ownerType: "corporation",
        ownerId: 900,
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [blueprintSnapshot],
    { metadata: [{ typeId: 41583, name: "Minokawa Blueprint", category: "blueprint" }] },
  );
  const blueprint = result.assets?.[0];

  assert.ok(blueprint);
  assert.equal(blueprint.quantity, 3);
  assert.equal(blueprint.blueprintType, "bpo");
});

void test("projects a blueprint instance when its asset record is unavailable", () => {
  const blueprintSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([]),
    blueprintInstances: slice([
      {
        itemId: 3840001,
        typeId: 3840,
        locationId: 600,
        locationFlag: "CorpSAG1",
        quantity: -2,
        runs: 7,
        me: 10,
        te: 20,
        ownerType: "corporation",
        ownerId: 900,
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [blueprintSnapshot],
    {
      metadata: [
        { typeId: 3840, name: "Large Shield Extender I Blueprint", category: "blueprint" },
      ],
    },
  );
  const blueprint = result.assets?.find((asset) => asset.typeId === 3840);

  assert.ok(blueprint);
  assert.equal(blueprint.quantity, 1);
  assert.equal(blueprint.blueprintType, "bpc");
  assert.equal(blueprint.blueprintPrints?.[0]?.type, "bpc");
  assert.equal(blueprint.inUse, undefined);
  assert.equal(filterClientAssetsForPlanning(result).assets?.length, 1);
});

void test("projects job output and remaining blueprint runs without an asset record", () => {
  const jobSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([]),
    blueprintInstances: slice([
      {
        itemId: 701,
        typeId: 21018,
        locationId: 600,
        locationFlag: "CorpSAG1",
        quantity: -2,
        runs: 10,
        me: 0,
        te: 0,
        inUse: true,
        ownerType: "corporation",
        ownerId: 900,
      },
    ]),
    industryJobs: slice([
      {
        jobId: 700,
        activityId: 1,
        blueprintId: 701,
        blueprintLocationId: 600,
        blueprintTypeId: 21018,
        endDate: "2026-01-02T00:00:00.000Z",
        facilityId: 601,
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
    ]),
    jobs: slice([
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
    ]),
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
  assert.equal(output.isPackaged, true);
  assert.equal(output.rootLocationId, 600);
  assert.deepEqual(
    output.corporationSource,
    {
      rootLocationId: 600,
      locationFlag: "CorpSAG1",
      containerItemIds: [44],
    },
  );
  assert.equal(output.industryJobEndDate, "2026-01-02T00:00:00.000Z");
  assert.equal(blueprint.blueprintType, "bpc");
  assert.equal(blueprint.blueprintPrints?.[0]?.runs, 10);
  assert.equal(blueprint.inUse, true);
  assert.equal(result.assets?.filter((item) => item.typeId === 21018).length, 1);
  assert.deepEqual(
    filterClientAssetsForPlanning(result).assets?.filter((item) => item.jobId === 700),
    [],
  );
});

void test("uses a direct structure delivery location for future job output", () => {
  const jobSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([]),
    rootLocations: slice([
      {
        itemId: 700,
        location: {
          locationId: 700,
          kind: "structure",
          name: "Delivery Structure",
          systemId: 30000142,
          resolved: true,
        },
      },
    ]),
    jobs: slice([
      {
        jobId: 701,
        characterId: 1,
        ownerId: 900,
        ownerType: "corporation",
        activityId: 1,
        status: "active",
        runs: 1,
        outputQuantity: 1,
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
        facilityId: 600,
        outputLocationId: 700,
        blueprintTypeId: 21018,
        productTypeId: 21017,
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [jobSnapshot],
    { metadata: [{ typeId: 21017, name: "Capital Armor Plates", category: "item" }] },
  );

  assert.equal(result.assets?.find((item) => item.jobId === 701)?.rootLocationId, 700);
});

void test("keeps a running reaction job formula classified as a reaction formula", () => {
  const reactionSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([]),
    industryJobs: slice([
      {
        jobId: 701,
        activityId: 9,
        blueprintId: 702,
        blueprintLocationId: 600,
        blueprintTypeId: 46170,
        endDate: "2026-01-02T00:00:00.000Z",
        facilityId: 600,
        installerId: 1,
        installedRuns: 30,
        licensedRuns: 0,
        locationId: 600,
        outputLocationId: 44,
        ownerType: "corporation",
        ownerId: 900,
        probability: 1,
        productTypeId: 46169,
        runs: 30,
        startDate: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]),
    jobs: slice([
      {
        jobId: 701,
        characterId: 1,
        ownerId: 900,
        ownerType: "corporation",
        activityId: 9,
        status: "active",
        runs: 30,
        outputQuantity: 30,
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
        facilityId: 600,
        outputLocationId: 44,
        blueprintTypeId: 46170,
        productTypeId: 46169,
      },
    ]),
  };
  const result = projectOwnerSnapshotsToClientAssets(
    [reactionSnapshot],
    {
      metadata: [
        { typeId: 46169, name: "Reaction Product", category: "item" },
        { typeId: 46170, name: "Dysporite Reaction Formula", category: "reactionformula" },
      ],
    },
  );

  const formula = result.assets?.find((item) => item.typeId === 46170);
  assert.ok(formula);
  assert.equal(formula.category, "reactionformula");
  assert.equal(formula.blueprintType, undefined);
  assert.equal(formula.blueprintPrints, undefined);
});

void test("does not inherit selected containers for a corporation hangar destination", () => {
  const jobSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    assets: slice([]),
    corporationSources: slice([
      {
        ...snapshot.corporationSources.data[0],
        containerItemIds: [44, 45],
        selected: false,
        containers: [
          ...(snapshot.corporationSources.data[0].containers ?? []),
          {
            itemId: 45,
            name: "Selected Sibling Can",
            locationId: 45,
            rootLocationId: 600,
            selected: true,
          },
        ],
      },
    ]),
    industryJobs: slice([
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
        outputLocationId: 600,
        ownerType: "corporation",
        ownerId: 900,
        probability: 1,
        productTypeId: 21017,
        runs: 30,
        startDate: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]),
    jobs: slice([
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
        outputLocationId: 600,
        blueprintTypeId: 21018,
        productTypeId: 21017,
      },
    ]),
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

  assert.deepEqual(
    filterClientAssetsForPlanning(result).assets?.filter((item) => item.jobId === 700),
    [],
  );
});

void test("counts corporation jobs against the installing character's slots", () => {
  const characterId = 2117375278;
  const characterSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    owner: { kind: "character", id: characterId },
    jobs: slice([]),
  };
  const corporationSnapshot: ClientOwnerSnapshot = {
    ...snapshot,
    jobs: slice(
      Array.from(
        { length: 4 },
        (_, index) => ({
          jobId: index + 1,
          characterId,
          ownerId: 900,
          ownerType: "corporation" as const,
          activityId: 1,
          status: "active",
          runs: 1,
          outputQuantity: 1,
          startDate: "2026-09-13T00:00:00.000Z",
          endDate: "2026-09-14T00:00:00.000Z",
          facilityId: 60000001,
          outputLocationId: 60000001,
          blueprintTypeId: 100,
        }),
      ),
    ),
  };

  const result = projectOwnerSnapshotsToClientJobs([characterSnapshot, corporationSnapshot], []);

  assert.deepEqual(
    result.slotUsage?.[String(characterId)],
    {
      slots: { Manufacturing: 4 },
      availableSlots: {},
    },
  );
});

void test("keeps the server-resolved job location name", () => {
  const result = projectOwnerSnapshotsToClientJobs(
    [
      {
        ...snapshot,
        jobs: slice([
          {
            jobId: 77,
            characterId: 2117375278,
            ownerId: 900,
            ownerType: "corporation" as const,
            activityId: 1,
            status: "active",
            runs: 1,
            outputQuantity: 1,
            startDate: "2026-09-13T00:00:00.000Z",
            endDate: "2026-09-14T00:00:00.000Z",
            facilityId: 1055354926818,
            outputLocationId: 1055354926818,
            outputLocationName: "Jita - Production Fortizar",
            blueprintTypeId: 100,
          },
        ]),
      },
    ],
    [],
  );

  assert.equal(result.jobs?.[0]?.outputLocationName, "Jita - Production Fortizar");
});

void test("projects available slots for characters without active jobs", () => {
  const characterId = 2117375278;
  const result = projectOwnerSnapshotsToClientJobs(
    [
      {
        ...snapshot,
        owner: { kind: "character", id: characterId },
        jobs: slice([]),
      },
    ],
    [],
    new Map([
      [
        characterId,
        {
          Manufacturing: 5,
          Reactions: 3,
          Science: 4,
        },
      ],
    ]),
  );

  assert.deepEqual(
    result.slotUsage?.[String(characterId)],
    {
      slots: {},
      availableSlots: { Manufacturing: 5, Reactions: 3, Science: 4 },
    },
  );
});

void test("projects normalized market order quantities", () => {
  const result = projectOwnerSnapshotsToClientAssets(
    [
      {
        ...snapshot,
        marketOrders: slice([
          {
            typeId: 34,
            locationId: 600,
            buyOrderQuantity: 0,
            sellOrderQuantity: 25,
          },
          {
            typeId: 35,
            locationId: 600,
            buyOrderQuantity: 12,
            sellOrderQuantity: 0,
          },
        ]),
      },
    ],
    { metadata: [] },
  );

  assert.ok(result.assets);
  assert.ok(result.marketBuyOrderQuantities);
  const projectedMarketOrders = result.assets.filter((item) => item.source === "marketOrder");
  assert.equal(projectedMarketOrders.length, 2);
  assert.deepEqual(
    projectedMarketOrders.map((item) => ({
      typeId: item.typeId,
      quantity: item.quantity,
      marketOrderSide: item.marketOrderSide,
    })),
    [
      { typeId: 34, quantity: 25, marketOrderSide: "sell" },
      { typeId: 35, quantity: 12, marketOrderSide: "buy" },
    ],
  );
  assert.equal(projectedMarketOrders[0]?.sourceLocationId, 600);
  assert.equal(projectedMarketOrders[0]?.isPackaged, true);
  assert.equal(result.marketBuyOrderQuantities["35"], 12);
  const planningAssets = filterClientSellOrdersForPlanning(
    result,
    {
      personalSellOrdersAsStock: true,
      allCorporationSellOrdersAsStock: true,
      myCorporationSellOrdersAsStock: true,
    },
    [],
  );
  assert.ok(planningAssets.assets);
  assert.deepEqual(
    planningAssets.assets
      .filter((item) => item.source === "marketOrder")
      .map((item) => item.typeId),
    [34],
  );
});
