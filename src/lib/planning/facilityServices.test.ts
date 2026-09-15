import assert from "node:assert/strict";
import test from "node:test";
import { facilityServiceFromName, facilityServicesFromNames } from "./facilityServices";

void test("maps facility fitting service modules to activity settings", () => {
  assert.deepEqual(
    [
      "Standup Capital Shipyard I",
      "Standup Hyasyoda Research Lab",
      "Standup Invention Lab I",
      "Standup Manufacturing Plant",
      "Standup Manufacturing Plant I",
      "Standup Research Lab I",
      "Standup Supercapital Shipyard I",
      "Standup Reprocessing Facility I",
      "Standup Biochemical Reactor I",
      "Standup Composite Reactor I",
      "Standup Hybrid Reactor I",
    ].map(facilityServiceFromName),
    [
      "capital",
      "research",
      "invention",
      "standard",
      "standard",
      "research",
      "supercapital",
      "reprocessing",
      "biochemical",
      "composite",
      "hybrid",
    ],
  );
  assert.equal(facilityServiceFromName("Unknown Service I"), null);
});

void test("keeps recognized services when a fitting contains an unsupported module", () => {
  assert.deepEqual(
    [
      ...facilityServicesFromNames([
        "Standup Cloning Center I",
        "Standup Capital Shipyard I",
        "Standup Manufacturing Plant I",
        "Unknown Service I",
        "Standup Invention Lab I",
      ]),
    ],
    ["capital", "standard", "invention"],
  );
});
