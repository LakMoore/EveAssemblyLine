import { z } from "zod";
import {
  fittingListSchema,
  savedFittingSchema,
  type FittingInput,
  type SavedFitting,
} from "@/lib/fittings/model";
import { deleteEndpointRecord, loadEndpointRecord, saveEndpointResponse } from "./refreshCache";
import { loadClientSession } from "./requestCache";
import { fetchTypeMetadata } from "@/lib/reference/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import type { TypeSearchResult } from "@/components/TypeSearch";

/** Searches only the authenticated collection's fitting names and supplies hull identities. */
export async function searchStockpileFittings(
  query: string,
  language: SdeLanguage,
): Promise<TypeSearchResult[]> {
  const session = await loadClientSession();
  if (!session.authenticated || !session.snapshotScope || !session.collectionId) return [];
  const scope = session.snapshotScope;
  const collectionId = session.collectionId;
  const data = await fetchFittings(scope, collectionId);
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  const matches = data.fittings.filter((fitting) =>
    fitting.name.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery),
  );
  const metadata = await fetchTypeMetadata(
    matches.map((fitting) => fitting.shipTypeId),
    language,
  );
  const names = new Map(metadata.map((type) => [type.typeId, type.name]));
  return matches.map((fitting) => ({
    name: fitting.name,
    typeId: fitting.shipTypeId,
    shipName: names.get(fitting.shipTypeId),
    fittingSource: { id: fitting.id, collectionId, scope },
  }));
}

/** Auth/API failures distinguish forbidden data from a temporarily unavailable server. */
export class FittingRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const detailSchema = z.object({ collectionId: z.string().min(1), fitting: savedFittingSchema });

/** Fetches a validated fitting response, preserving useful API errors. */
async function request<Schema extends z.ZodType>(
  url: string,
  schema: Schema,
  init?: RequestInit,
): Promise<z.output<Schema>> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new FittingRequestError(
      error.success ? error.data.error : "Fitting request failed.",
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("The server returned an invalid fitting response.");
  return parsed.data;
}

/** Reads a validated cached list only after the current authenticated scope is established. */
export async function loadCachedFittings(scope: string, collectionId: string) {
  const record = await loadEndpointRecord<unknown>(`fittings:${scope}`).catch(() => null);
  const parsed = fittingListSchema.safeParse(record?.data);
  return record?.scope === scope && parsed.success && parsed.data.collectionId === collectionId
    ? { ...parsed.data, cachedAt: record.returnedAt }
    : null;
}

/** Revalidates the list and persists it in the shared IndexedDB endpoint cache. */
export async function fetchFittings(scope: string, collectionId: string) {
  const data = await request(
    "/api/fittings",
    fittingListSchema,
    { headers: { "x-fitting-collection": collectionId } },
  );
  if (data.collectionId !== collectionId) {
    throw new FittingRequestError("The active collection changed. Reload fittings.", 409);
  }
  await saveEndpointResponse(`fittings:${scope}`, "/api/fittings", data, undefined, scope).catch(
    () => undefined,
  );
  return data;
}

/** Reads a fitting body from the server; callers may explicitly opt into stale cached fallback. */
export async function fetchFitting(
  scope: string,
  collectionId: string,
  id: string,
): Promise<{ fitting: SavedFitting; stale: boolean }> {
  const key = `fittings:${scope}:${id}`;
  try {
    const data = await request(
      `/api/fittings/${id}`,
      detailSchema,
      { headers: { "x-fitting-collection": collectionId } },
    );
    if (data.collectionId !== collectionId) {
      throw new FittingRequestError("The active collection changed. Reload fittings.", 403);
    }
    await saveEndpointResponse(key, `/api/fittings/${id}`, data, undefined, scope).catch(
      () => undefined,
    );
    return { fitting: data.fitting, stale: false };
  }
  catch (error) {
    if (error instanceof FittingRequestError && error.status < 500) throw error;
    const cached = await loadEndpointRecord<unknown>(key).catch(() => null);
    const parsed = detailSchema.safeParse(cached?.data);
    if (cached?.scope !== scope || !parsed.success || parsed.data.collectionId !== collectionId) {
      throw error;
    }
    return { fitting: parsed.data.fitting, stale: true };
  }
}

/** Creates through the server before updating local cache; existing fittings are immutable. */
export async function saveFitting(
  scope: string,
  collectionId: string,
  input: FittingInput,
): Promise<SavedFitting> {
  const url = "/api/fittings";
  const data = await request(
    url,
    detailSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fitting-collection": collectionId },
      body: JSON.stringify(input),
    },
  );
  if (data.collectionId !== collectionId) {
    throw new FittingRequestError("The active collection changed. Reload fittings.", 403);
  }
  await saveEndpointResponse(
    `fittings:${scope}:${data.fitting.id}`,
    url,
    data,
    undefined,
    scope,
  ).catch(() => undefined);
  await updateCachedLibrary(scope, collectionId, data.fitting).catch(() => undefined);
  return data.fitting;
}

/** Applies confirmed mutations to the cached list before attempting network revalidation. */
async function updateCachedLibrary(
  scope: string,
  collectionId: string,
  fitting?: SavedFitting,
  removedId?: string,
): Promise<void> {
  const cached = await loadCachedFittings(scope, collectionId);
  const fittings = (cached?.fittings ?? []).filter(
    (entry) => entry.id !== (fitting?.id ?? removedId),
  );
  if (fitting) {
    const { items: _items, description: _description, ...summary } = fitting;
    fittings.push(summary);
  }
  fittings.sort((first, second) => first.name.localeCompare(second.name));
  await saveEndpointResponse(
    `fittings:${scope}`,
    "/api/fittings",
    { collectionId, fittings },
    undefined,
    scope,
  );
}

/** Deletes a known revision on the server. */
export async function deleteFitting(
  scope: string,
  fitting: SavedFitting,
  collectionId: string,
): Promise<void> {
  await request(
    `/api/fittings/${fitting.id}`,
    z.object({ success: z.literal(true) }),
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-fitting-collection": collectionId },
      body: JSON.stringify({ revision: fitting.revision }),
    },
  );
  await Promise
    .all([
      updateCachedLibrary(scope, collectionId, undefined, fitting.id),
      deleteEndpointRecord(`fittings:${scope}:${fitting.id}`),
    ])
    .catch(() => undefined);
}
