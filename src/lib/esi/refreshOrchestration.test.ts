import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRefreshUnits,
  RefreshCoordinator,
  runRefreshUnits,
  type RefreshUnit,
} from "./refreshOrchestration";

test("creates one personal unit per character and one corporation unit per eligible corporation", () => {
  const units = buildRefreshUnits([
    { characterId: 10, corporationId: 100, hasDirectorRole: true },
    { characterId: 10, corporationId: 100, hasDirectorRole: true },
    { characterId: 11, corporationId: 100, hasDirectorRole: true },
    { characterId: 12, corporationId: 200, hasDirectorRole: false },
    { characterId: 13, hasDirectorRole: false },
  ]);

  assert.deepEqual(
    units,
    [
      {
        key: "character:10",
        kind: "character",
        ownerId: 10,
      },
      {
        key: "character:11",
        kind: "character",
        ownerId: 11,
      },
      {
        key: "character:12",
        kind: "character",
        ownerId: 12,
      },
      {
        key: "character:13",
        kind: "character",
        ownerId: 13,
      },
      {
        key: "corporation:100",
        kind: "corporation",
        ownerId: 100,
        authorizationCharacterId: 10,
      },
    ],
  );
});

test("runs each unit once, limits concurrency, and reports partial failures", async () => {
  const units: RefreshUnit[] = [
    { key: "character:1", kind: "character", ownerId: 1 },
    { key: "character:1", kind: "character", ownerId: 1 },
    { key: "character:2", kind: "character", ownerId: 2 },
    { key: "corporation:3", kind: "corporation", ownerId: 3, authorizationCharacterId: 1 },
  ];
  const started: string[] = [];
  const settled: string[] = [];
  let active = 0;
  let maximumActive = 0;

  const results = await runRefreshUnits(
    units,
    async (unit) => {
      started.push(unit.key);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      if (unit.key === "character:2") throw new Error("character failed");
    },
    {
      concurrency: 2,
      onSettled: (result) => settled.push(`${result.unit.key}:${result.success}`),
    },
  );

  assert.equal(maximumActive, 2);
  assert.deepEqual(started.sort(), ["character:1", "character:2", "corporation:3"]);
  assert.deepEqual(
    results.map((result) => [result.unit.key, result.success]).sort(),
    [
      ["character:1", true],
      ["character:2", false],
      ["corporation:3", true],
    ],
  );
  assert.deepEqual(settled.sort(), ["character:1:true", "character:2:false", "corporation:3:true"]);
});

test("coalesces overlapping work for the same owner across sessions", async () => {
  const coordinator = new RefreshCoordinator();
  let calls = 0;
  const result = { refreshed: true };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = async () => {
    calls += 1;
    await blocked;
    return result;
  };

  const first = coordinator.run("character:10", work);
  const second = coordinator.run("character:10", work);
  release();

  assert.strictEqual(await first, result);
  assert.strictEqual(await second, result);
  assert.equal(calls, 1);
});

test("allows a unit to run again after its previous refresh settles", async () => {
  const coordinator = new RefreshCoordinator();
  let calls = 0;

  await coordinator.run(
    "corporation:20",
    async () => {
      calls += 1;
    },
  );
  await coordinator.run(
    "corporation:20",
    async () => {
      calls += 1;
    },
  );

  assert.equal(calls, 2);
});
