import assert from "node:assert/strict";
import { test } from "node:test";
import type { StockItem } from "@/lib/planning/types";
import { blueprintImageVariation, countBlueprints, countReactionFormulas } from "./blueprintCounts";

void test("counts visible copies and originals but excludes query-only corp stock from owned", () => {
  const assets: StockItem[] = [
    {
      typeId: 1,
      name: "BP",
      category: "blueprint",
      quantity: 1,
      blueprintType: "bpo",
      ownerType: "character",
    },
    {
      typeId: 1,
      name: "BP",
      category: "blueprint",
      quantity: 1,
      blueprintType: "bpc",
      ownerType: "corporation",
      corporationSource: {
        rootLocationId: 1,
        locationFlag: "CorpSAG1",
        containerItemIds: [],
        canTake: false,
      },
      blueprintPrints: [{ itemId: 10, type: "bpc", runs: 5 }],
    },
    {
      typeId: 1,
      name: "BP",
      category: "blueprint",
      quantity: 1,
      blueprintType: "bpc",
      ownerType: "corporation",
      corporationSource: {
        rootLocationId: 1,
        locationFlag: "CorpSAG2",
        containerItemIds: [],
        canTake: true,
      },
      blueprintPrints: [{ itemId: 11, type: "bpc", runs: 3 }],
    },
    {
      typeId: 2,
      name: "BP 2",
      category: "blueprint",
      quantity: 1,
      blueprintType: "bpc",
      blueprintPrints: [{ itemId: 12, type: "bpc", runs: 0 }],
    },
    {
      typeId: 1,
      name: "BP",
      category: "blueprint",
      quantity: 1,
      blueprintType: "bpc",
      inBuild: true,
      licensedRuns: 10,
    },
    {
      typeId: 2,
      name: "BP 2",
      category: "blueprint",
      quantity: 1,
      blueprintType: "bpc",
      inUse: true,
      blueprintPrints: [{ itemId: 13, type: "bpc", runs: 7 }],
    },
  ];
  const visible = countBlueprints(assets, "visible");
  const owned = countBlueprints(assets, "owned");
  assert.deepEqual(
    visible.get(1),
    { bpoCount: 1, bpcCount: 2, bpcRuns: 8, availableBpoCount: 1, availableBpcRuns: 8 },
  );
  assert.deepEqual(
    owned.get(1),
    { bpoCount: 1, bpcCount: 1, bpcRuns: 3, availableBpoCount: 1, availableBpcRuns: 3 },
  );
  assert.equal(blueprintImageVariation(visible.get(1)), "bpc");
  assert.equal(visible.get(2)?.bpcRuns, 7);
  assert.equal(visible.get(2)?.availableBpcRuns, 0);
  assert.equal(blueprintImageVariation(visible.get(2)), "bp");
  assert.equal(blueprintImageVariation(owned.get(1)), "bpc");
});

void test("counts visible formulas and excludes query-only, in-use, and nonphysical availability", () => {
  const assets: StockItem[] = [
    {
      typeId: 1,
      name: "Formula",
      category: "reactionformula",
      quantity: 2,
      ownerType: "character",
    },
    {
      typeId: 1,
      name: "Formula",
      category: "reactionformula",
      quantity: 1,
      inUse: true,
      ownerType: "character",
    },
    {
      typeId: 1,
      name: "Formula",
      category: "reactionformula",
      quantity: 3,
      ownerType: "corporation",
      corporationSource: {
        rootLocationId: 1,
        locationFlag: "CorpSAG1",
        containerItemIds: [],
        canTake: false,
      },
    },
    {
      typeId: 1,
      name: "Formula",
      category: "reactionformula",
      quantity: 4,
      ownerType: "corporation",
      corporationSource: {
        rootLocationId: 1,
        locationFlag: "CorpSAG2",
        containerItemIds: [],
        canTake: true,
      },
    },
    { typeId: 1, name: "Formula", category: "reactionformula", quantity: 5, inBuild: true },
    { typeId: 1, name: "Formula", category: "reactionformula", quantity: 6, source: "marketOrder" },
    { typeId: 1, name: "Blueprint", category: "blueprint", quantity: 1, blueprintType: "bpo" },
  ];

  assert.deepEqual(
    countReactionFormulas(assets, "visible").get(1),
    {
      totalCount: 10,
      availableCount: 9,
    },
  );
  assert.deepEqual(
    countReactionFormulas(assets, "owned").get(1),
    {
      totalCount: 7,
      availableCount: 6,
    },
  );
});
