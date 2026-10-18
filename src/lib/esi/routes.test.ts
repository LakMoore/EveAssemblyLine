import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getSystemJumpDistance } from "./routes";
import { clearEsiRequestLogTimer } from "./logger";

after(() => {
  clearEsiRequestLogTimer();
});

void test("shortest distances count jumps and reuse reverse and concurrent lookups", async (context) => {
  const requests: string[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url.pathname + url.search);
      return Promise.resolve(Response.json([31000101, 31000102, 31000103]));
    },
  );
  assert.deepEqual(
    await Promise.all([
      getSystemJumpDistance(31000101, 31000103),
      getSystemJumpDistance(31000103, 31000101),
    ]),
    [2, 2],
  );
  assert.equal(await getSystemJumpDistance(31000101, 31000103), 2);
  assert.equal(await getSystemJumpDistance(31000101, 31000101), 0);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes("/route/31000101/31000103/?flag=shortest"));
});

void test("unreachable system pairs are cached without repeating route requests", async (context) => {
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    () => Promise.resolve(Response.json({ error: "No route found" }, { status: 404 })),
  );
  assert.equal(await getSystemJumpDistance(31000201, 31000202), null);
  assert.equal(await getSystemJumpDistance(31000202, 31000201), null);
  assert.equal(fetchMock.mock.callCount(), 1);
});

void test("transient failures and malformed routes do not poison the lifetime cache", async (context) => {
  let attempts = 0;
  context.mock.method(
    globalThis,
    "fetch",
    () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
      }
      if (attempts === 2) return Promise.resolve(Response.json([31000301, 31000399]));
      return Promise.resolve(Response.json([31000301, 31000302]));
    },
  );
  await assert.rejects(getSystemJumpDistance(31000301, 31000302));
  await assert.rejects(getSystemJumpDistance(31000301, 31000302), /incorrect endpoints/);
  assert.equal(await getSystemJumpDistance(31000301, 31000302), 1);
  assert.equal(attempts, 3);
});

void test("invalid system IDs are rejected before making ESI requests", async (context) => {
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    () => Promise.reject(new Error("Unexpected fetch")),
  );
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(getSystemJumpDistance(invalid, 30000142));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});
