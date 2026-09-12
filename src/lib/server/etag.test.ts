import assert from "node:assert/strict";
import test from "node:test";
import { createEtag, matchesIfNoneMatch } from "./etag";

void test("creates the same ETag for the same response body", () => {
  assert.equal(createEtag('{"assets":[]}'), createEtag('{"assets":[]}'));
  assert.notEqual(createEtag('{"assets":[]}'), createEtag('{"assets":[1]}'));
});

void test("matches strong, weak, wildcard, and comma-separated validators", () => {
  const etag = createEtag('{"assets":[]}');

  assert.equal(matchesIfNoneMatch(etag, etag), true);
  assert.equal(matchesIfNoneMatch(`W/${etag}`, etag), true);
  assert.equal(matchesIfNoneMatch(`"other", ${etag}`, etag), true);
  assert.equal(matchesIfNoneMatch("*", etag), true);
  assert.equal(matchesIfNoneMatch('"other"', etag), false);
  assert.equal(matchesIfNoneMatch(null, etag), false);
});
