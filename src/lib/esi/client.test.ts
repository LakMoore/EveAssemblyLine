import assert from "node:assert/strict";
import test from "node:test";
import type { TokenSet } from "@/lib/auth/model";
import { fetchEsiEndpoint } from "./client";

const token: TokenSet = {
  refreshToken: "refresh-token",
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  scopes: [],
  lastUsedAt: 0,
};

test("sends the cached ETag for a non-paginated endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let request = { url: "", headers: new Headers() };
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      headers: new Headers(init?.headers),
    };
    return new Response(
      JSON.stringify({ skills: [] }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: "new-etag",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
        },
      },
    );
  };

  const result = await fetchEsiEndpoint<{ skills: unknown[] }>(
    "/characters/42/skills/",
    token,
    "old-etag",
    { paginated: false },
  );

  assert.equal(request.url, "https://esi.evetech.net/latest/characters/42/skills/");
  assert.equal(request.headers.get("if-none-match"), "old-etag");
  assert.equal(request.headers.get("authorization"), "Bearer access-token");
  assert.deepEqual(result.data, { skills: [] });
  assert.equal(result.notModified, false);
  assert.equal(result.headers.get("expires"), "Wed, 26 Aug 2026 17:00:00 GMT");
});

test("returns response metadata for a 304 without fetching another page", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(
      null,
      {
        status: 304,
        headers: {
          etag: "same-etag",
          "last-modified": "Wed, 26 Aug 2026 16:55:00 GMT",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
          "x-pages": "4",
        },
      },
    );
  };

  const result = await fetchEsiEndpoint<number>(
    "/characters/42/assets/",
    token,
    "same-etag",
    { paginated: true },
  );

  assert.deepEqual(requests, ["https://esi.evetech.net/latest/characters/42/assets/?page=1"]);
  assert.equal(result.data, null);
  assert.equal(result.notModified, true);
  assert.equal(result.headers.get("last-modified"), "Wed, 26 Aug 2026 16:55:00 GMT");
});

test("aggregates all pages while preserving first-page metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const page = new URL(url).searchParams.get("page");
    return new Response(
      JSON.stringify(page === "1" ? [1, 2] : [3]),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-pages": "2",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
        },
      },
    );
  };

  const result = await fetchEsiEndpoint<number>(
    "/characters/42/assets/",
    token,
    undefined,
    { paginated: true },
  );

  assert.deepEqual(result.data, [1, 2, 3]);
  assert.deepEqual(
    requests,
    [
      "https://esi.evetech.net/latest/characters/42/assets/?page=1",
      "https://esi.evetech.net/latest/characters/42/assets/?page=2",
    ],
  );
  assert.equal(result.headers.get("expires"), "Wed, 26 Aug 2026 17:00:00 GMT");
  assert.equal(result.notModified, false);
});

test("treats a 420 error-limit response as rate limited", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(
      null,
      {
        status: 420,
        headers: {
          "x-esi-error-limit-reset": "30",
        },
      },
    );

  await assert.rejects(
    fetchEsiEndpoint("/characters/42/assets/", token, undefined, { paginated: false }),
    (error: Error & { status?: number; retryAfter?: string }) => {
      assert.equal(error.status, 420);
      assert.equal(error.retryAfter, "30");
      return true;
    },
  );
});
