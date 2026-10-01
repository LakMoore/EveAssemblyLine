import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationEtag } from "./etag";

void test("creates a stable validator for inputs, SDE data, and calculation version", () => {
  const etag = createSimulationEtag("request-hash", "build-123", 3);

  assert.equal(etag, createSimulationEtag("request-hash", "build-123", 3));
  assert.notEqual(etag, createSimulationEtag("other-request", "build-123", 3));
  assert.notEqual(etag, createSimulationEtag("request-hash", "build-124", 3));
  assert.notEqual(etag, createSimulationEtag("request-hash", "build-123", 4));
});
