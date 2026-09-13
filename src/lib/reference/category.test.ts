import assert from "node:assert/strict";
import test from "node:test";
import type { GroupsRecord, MarketGroupsRecord } from "@/lib/sde/generated";
import { isCargoContainerType } from "./category";

function group(categoryID: number): GroupsRecord {
  return { _key: 1, categoryID, name: { en: "Test" } } as GroupsRecord;
}

function marketGroup(name: string): MarketGroupsRecord {
  return { _key: 1, name: { en: name } } as MarketGroupsRecord;
}

void test("does not classify container blueprints as physical containers", () => {
  assert.equal(
    isCargoContainerType(
      { groupID: 1, marketGroupID: 1, name: { en: "Container Blueprint" } },
      new Map([[1, group(9)]]),
      new Map([[1, marketGroup("Cargo Containers")]]),
    ),
    false,
  );
});

void test("classifies physical cargo containers", () => {
  assert.equal(
    isCargoContainerType(
      { groupID: 1, marketGroupID: 1, name: { en: "Cargo Container" } },
      new Map([[1, group(2)]]),
      new Map([[1, marketGroup("Cargo Containers")]]),
    ),
    true,
  );
});
