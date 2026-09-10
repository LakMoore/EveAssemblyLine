import assert from "node:assert/strict";
import test from "node:test";
import { AssemblyLineGroups } from "./assemblyLineGroups";

test("groups items in first-seen AssemblyLine group order", () => {
  const groups = AssemblyLineGroups.groupBy(
    [
      { typeId: 2, group: "Ships" },
      { typeId: 3, group: "Minerals" },
      { typeId: 4, group: "Ships" },
      { typeId: 5, group: undefined },
    ],
    (item) => item.group,
  );

  assert.deepEqual(
    groups,
    [
      {
        assemblyLineGroup: "Ships",
        items: [
          { typeId: 2, group: "Ships" },
          { typeId: 4, group: "Ships" },
        ],
      },
      {
        assemblyLineGroup: "Minerals",
        items: [{ typeId: 3, group: "Minerals" }],
      },
    ],
  );
});
