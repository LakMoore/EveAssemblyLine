const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Allows safe methods and same-origin writes, resolving the public origin behind the app proxy. */
export function isAllowedApiRequest(request: Request): boolean {
  if (safeMethods.has(request.method.toUpperCase())) return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    const url = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
    const requestOrigin = host ? new URL(`${protocol}://${host}`).origin : url.origin;
    return new URL(origin).origin === requestOrigin;
  }
  catch {
    return false;
  }
}
