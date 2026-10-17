import { handleFittingRequest } from "@/lib/fittings/api";

/** Lists fitting names and ship type IDs for the current collection. */
export async function GET(request: Request) {
  return handleFittingRequest(request);
}

/** Adds an app-managed fitting to the current collection. */
export async function POST(request: Request) {
  return handleFittingRequest(request);
}
