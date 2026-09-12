import { createHash } from "node:crypto";

/** Creates a strong ETag for the exact response body sent to the client. */
export function createEtag(body: string): string {
  return `"${createHash("sha256").update(body, "utf8").digest("hex")}"`;
}

/** Checks whether an If-None-Match value matches the current entity tag. */
export function matchesIfNoneMatch(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false;
  return headerValue
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}
