import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedApiRequest } from "./apiWriteOrigin";

void test("allows same-origin writes using the public forwarded origin", () => {
  const request = new Request(
    "http://internal/api/fittings",
    {
      method: "POST",
      headers: {
        origin: "https://assemblyline.example",
        "x-forwarded-host": "assemblyline.example",
        "x-forwarded-proto": "https",
      },
    },
  );

  assert.equal(isAllowedApiRequest(request), true);
});

void test("rejects cross-origin writes and writes without an Origin header", () => {
  const forwardedHeaders = {
    "x-forwarded-host": "assemblyline.example",
    "x-forwarded-proto": "https",
  };
  const crossOrigin = new Request(
    "http://internal/api/fittings",
    {
      method: "POST",
      headers: { ...forwardedHeaders, origin: "https://other.example" },
    },
  );
  const missingOrigin = new Request(
    "http://internal/api/fittings",
    {
      method: "DELETE",
      headers: forwardedHeaders,
    },
  );

  assert.equal(isAllowedApiRequest(crossOrigin), false);
  assert.equal(isAllowedApiRequest(missingOrigin), false);
});

void test("does not block safe API methods based on Origin", () => {
  const request = new Request(
    "http://internal/api/fittings",
    {
      method: "GET",
      headers: { origin: "https://other.example" },
    },
  );

  assert.equal(isAllowedApiRequest(request), true);
});
