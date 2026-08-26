import assert from "node:assert/strict";
import test from "node:test";
import { endpointDataStatus, setFresh } from "./cache";

test("uses only response Last-Modified and Expires metadata", () => {
  const previous = setFresh(
    { value: "old" },
    new Headers({
      etag: "old-etag",
      "last-modified": "Wed, 26 Aug 2026 16:00:00 GMT",
      expires: "Wed, 26 Aug 2026 16:30:00 GMT",
    }),
  );
  const current = setFresh(
    { value: "new" },
    new Headers({
      etag: "new-etag",
      "last-modified": "Wed, 26 Aug 2026 16:55:00 GMT",
      expires: "Wed, 26 Aug 2026 17:00:00 GMT",
    }),
    previous,
  );

  assert.equal(current.lastModified, "2026-08-26T16:55:00.000Z");
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
  assert.equal(current.nextRefreshAllowed, "2026-08-26T17:00:00.000Z");
  assert.equal(current.etag, "new-etag");
});

test("does not preserve Last-Modified when the response omits it", () => {
  const current = setFresh(
    [],
    new Headers({ expires: "Wed, 26 Aug 2026 17:00:00 GMT" }),
    {
      lastBody: [],
      lastModified: "2026-08-26T16:00:00.000Z",
      expires: "2026-08-26T16:30:00.000Z",
      nextRefreshAllowed: "2026-08-26T16:30:00.000Z",
      status: "stale",
    },
  );

  assert.equal(current.lastModified, undefined);
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
});

test("preserves Last-Modified when a 304 response omits it", () => {
  const current = setFresh(
    [],
    new Headers({ expires: "Wed, 26 Aug 2026 17:00:00 GMT" }),
    {
      lastBody: [],
      lastModified: "2026-08-26T16:00:00.000Z",
      expires: "2026-08-26T16:30:00.000Z",
      nextRefreshAllowed: "2026-08-26T16:30:00.000Z",
      status: "stale",
    },
    true,
  );

  assert.equal(current.lastModified, "2026-08-26T16:00:00.000Z");
  assert.equal(current.expires, "2026-08-26T17:00:00.000Z");
});

test("expiry takes precedence when determining stale status", () => {
  assert.equal(endpointDataStatus("2026-08-26T16:59:59.000Z", "2020-01-01T00:00:00.000Z"), "stale");
});
