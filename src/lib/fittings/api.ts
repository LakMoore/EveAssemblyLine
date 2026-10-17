import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getShipTypeIds, getTypes } from "@/cache/services/sdeCache";
import { fittingInputSchema, type FittingInput } from "./model";
import { FittingError, getFittingStore } from "./store";

const deleteSchema = z.object({ revision: z.number().int().positive() }).strict();

/** Services replaceable by isolated API tests. */
type FittingApiServices = {
  session: typeof getSessionFromRequest;
  store: typeof getFittingStore;
  validateTypes: (input: FittingInput) => Promise<void>;
};

/** Validates ship and item identities against real SDE data, never fallback recipes. */
async function validateTypes(input: FittingInput): Promise<void> {
  const [ships, types] = await Promise.all([getShipTypeIds(), getTypes()]);
  if (!ships.has(input.shipTypeId)) {
    throw new FittingError("The fitting hull must be a ship type.", 400);
  }
  if (input.items.some((item) => !types.has(item.type_id))) {
    throw new FittingError("The fitting contains an unknown item type.", 400);
  }
}

/** Sends private, non-cacheable HTTP responses; browser persistence is explicitly collection-scoped. */
function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Handles collection-authorized fitting reads, creation and permitted deletion without ESI calls. */
export async function handleFittingRequest(
  request: Request,
  id?: string,
  services: FittingApiServices = {
    session: getSessionFromRequest,
    store: getFittingStore,
    validateTypes,
  },
): Promise<NextResponse> {
  try {
    const session = await services.session(request);
    if (!session?.collectionId) return json({ error: "Not authenticated." }, 401);
    const expectedCollection = request.headers.get("x-fitting-collection");
    if (expectedCollection && expectedCollection !== session.collectionId) {
      return json({ error: "The active collection changed. Reload fittings." }, 409);
    }
    if (id !== undefined && !z.uuid().safeParse(id).success) {
      return json({ error: "Invalid fitting ID." }, 400);
    }
    const allowedMethods = id ? ["GET", "DELETE"] : ["GET", "POST"];
    if (!allowedMethods.includes(request.method)) {
      const response = json({ error: "Existing fittings cannot be edited." }, 405);
      response.headers.set("Allow", allowedMethods.join(", "));
      return response;
    }
    const store = await services.store();
    if (request.method === "GET") {
      if (!id) {
        return json({
          collectionId: session.collectionId,
          fittings: await store.list(session.collectionId),
        });
      }
      const fitting = await store.get(session.collectionId, id);
      return fitting
        ? json({ collectionId: session.collectionId, fitting })
        : json({ error: "Fitting not found." }, 404);
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: "Cross-origin writes are not allowed." }, 403);
    }
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 250000) return json({ error: "Fitting payload is too large." }, 413);
      body = JSON.parse(text);
    }
    catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
    if (request.method === "DELETE" && id) {
      const parsed = deleteSchema.safeParse(body);
      if (!parsed.success) return json({ error: "A valid fitting revision is required." }, 400);
      await store.remove(session.collectionId, id, parsed.data.revision);
      return json({ success: true });
    }
    const parsed = fittingInputSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Invalid fitting.", issues: parsed.error.issues }, 400);
    }
    const input = fittingInputSchema.parse({
      name: parsed.data.name,
      description: parsed.data.description,
      shipTypeId: parsed.data.shipTypeId,
      items: parsed.data.items,
    });
    await services.validateTypes(input);
    const fitting = await store.save(session.collectionId, input);
    return json({ collectionId: session.collectionId, fitting }, 201);
  }
  catch (error) {
    if (error instanceof FittingError) return json({ error: error.message }, error.status);
    return json({ error: "Fitting storage or SDE data is unavailable. Try again shortly." }, 503);
  }
}
