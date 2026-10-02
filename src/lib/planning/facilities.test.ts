import assert from "node:assert/strict";
import test from "node:test";
import { emptyActivitiesRequest, normalizeFacilitySettings } from "./facilities";

void test("removes zero rig placeholders from facility settings", () => {
  const payload = normalizeFacilitySettings({
    lastModified: "2026-10-02T00:00:00.000Z",
    facilities: {
      refinery: {
        systemId: 30000142,
        name: "Test refinery",
        rigTypeIds: [1234, 0, 5678],
        activities: emptyActivitiesRequest,
      },
    },
  });

  assert.deepEqual(Object.values(payload.facilities)[0]?.rigTypeIds, [1234, 5678]);
});

void test("does not read facility settings from the legacy structures field", () => {
  const payload = normalizeFacilitySettings({
    structures: {
      refinery: {
        systemId: 30000142,
        name: "Legacy refinery",
        rigTypeIds: [1234],
        activities: emptyActivitiesRequest,
      },
    },
  });

  assert.deepEqual(payload.facilities, {});
});
