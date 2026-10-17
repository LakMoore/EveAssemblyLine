import { handleFittingRequest } from "@/lib/fittings/api";

/** Dynamic fitting ID supplied by the Next.js route. */
type FittingRouteContext = { params: Promise<{ id: string }> };

/** Reads a single collection-owned fitting. */
export async function GET(request: Request, context: FittingRouteContext) {
  return handleFittingRequest(request, (await context.params).id);
}

/** Rejects updates because saved fittings are read-only. */
export async function PUT(request: Request, context: FittingRouteContext) {
  return handleFittingRequest(request, (await context.params).id);
}

/** Removes a collection-owned fitting after checking its revision. */
export async function DELETE(request: Request, context: FittingRouteContext) {
  return handleFittingRequest(request, (await context.params).id);
}
