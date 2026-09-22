import assert from "node:assert/strict";
import test from "node:test";
import { createSimulationEtag } from "./etag";

void test("creates a stable validator for the request hash and SDE revision", () => {
  const etag = createSimulationEtag("request-hash", "build-123");

  assert.equal(etag, createSimulationEtag("request-hash", "build-123"));
  assert.notEqual(etag, createSimulationEtag("other-request", "build-123"));
  assert.notEqual(etag, createSimulationEtag("request-hash", "build-124"));
});
