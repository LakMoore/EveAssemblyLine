import { NextResponse, type NextRequest } from "next/server";
import { isAllowedApiRequest } from "@/lib/security/apiWriteOrigin";

/** Applies the same-origin write policy consistently to every API route. */
export function proxy(request: NextRequest) {
  if (!isAllowedApiRequest(request)) {
    return NextResponse.json({ error: "Cross-origin writes are not allowed." }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
