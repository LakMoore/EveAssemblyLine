import assert from "node:assert/strict";
import test from "node:test";
import { handleFittingRequest } from "./api";
import type { SavedFitting } from "./model";
import type { getFittingStore } from "./store";
import type { getSessionFromRequest } from "@/lib/auth/session";

const fitting: SavedFitting = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Patrol",
  description: "",
  shipTypeId: 587,
  items: [],
  revision: 1,
  updatedAt: "2026-10-17T00:00:00.000Z",
};

/** Supplies isolated services so API checks never read or write real Firestore. */
function services(collectionId: string | null = "alpha") {
  const calls: string[] = [];
  const store: Awaited<ReturnType<typeof getFittingStore>> = {
    list: (scope) => {
      calls.push(scope);
      return Promise.resolve([fitting]);
    },
    get: (scope) => {
      calls.push(scope);
      return Promise.resolve(scope === "alpha" ? fitting : undefined);
    },
    save: (scope) => {
      calls.push(scope);
      return Promise.resolve(fitting);
    },
    remove: (scope) => {
      calls.push(scope);
      return Promise.resolve();
    },
    importPersonal: () => Promise.resolve(),
  };
  const session: typeof getSessionFromRequest = () =>
    Promise.resolve(
      collectionId
        ? {
            sessionId: "session",
            collectionId,
            createdAt: fitting.updatedAt,
            lastSeenAt: fitting.updatedAt,
          }
        : null,
    );
  return {
    calls,
    session,
    store: () => Promise.resolve(store),
    validateTypes: () => Promise.resolve(),
  };
}

/** Builds same-origin JSON API requests without browser cookies or credentials. */
function request(method = "GET", body?: unknown, headers?: Record<string, string>): Request {
  return new Request(
    "http://localhost/api/fittings",
    {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

void test("fitting API rejects unauthenticated access before opening storage", async () => {
  const dependencies = services(null);
  assert.equal((await handleFittingRequest(request(), undefined, dependencies)).status, 401);
  assert.deepEqual(dependencies.calls, []);
});

void test("list exposes summaries and details are scoped to the authenticated collection", async () => {
  const alpha = services();
  const response = await handleFittingRequest(request(), undefined, alpha);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(alpha.calls, ["alpha"]);
  assert.equal((await handleFittingRequest(request(), fitting.id, services("beta"))).status, 404);
  assert.equal((await handleFittingRequest(request(), "invalid", alpha)).status, 400);
});

void test("writes reject malformed input, stale collection identity and cross-origin requests", async () => {
  const dependencies = services();
  assert.equal(
    (
      await handleFittingRequest(
        request("POST", { name: "bad", shipTypeId: -1 }),
        undefined,
        dependencies,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleFittingRequest(
        request("POST", {}, { "x-fitting-collection": "beta" }),
        undefined,
        dependencies,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await handleFittingRequest(
        request("POST", {}, { origin: "https://other.example" }),
        undefined,
        dependencies,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleFittingRequest(request("DELETE", {}), fitting.id, dependencies)).status,
    400,
  );
  assert.deepEqual(dependencies.calls, []);
});

void test("creation accepts numeric fitting input while existing fittings reject updates", async () => {
  const dependencies = services();
  const input = { name: fitting.name, description: "", shipTypeId: 587, items: [] };
  assert.equal(
    (await handleFittingRequest(request("POST", input), undefined, dependencies)).status,
    201,
  );
  assert.equal(
    (
      await handleFittingRequest(
        request("PUT", { ...input, revision: 1 }),
        fitting.id,
        dependencies,
      )
    ).status,
    405,
  );
  assert.equal(
    (await handleFittingRequest(request("PUT", input), fitting.id, dependencies)).status,
    405,
  );
  assert.deepEqual(dependencies.calls, ["alpha"]);
});
