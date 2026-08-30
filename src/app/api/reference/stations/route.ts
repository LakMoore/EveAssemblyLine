import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionFacilities } from "@/lib/auth/tokensStore";
import {
  getKnownMarketStructureLocations,
  resolveMarketStations,
  searchMarketStations,
} from "@/lib/market/stations.server";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const stationQuerySchema = z
  .object({
    stationId: z.coerce.number().int().positive().safe().optional(),
    query: z.string().trim().min(2).max(100).optional(),
  })
  .refine((value) => (value.stationId === undefined) !== (value.query === undefined));

/** Searches market locations or resolves one location for the Signals settings editor. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = stationQuerySchema.safeParse({
    stationId: url.searchParams.get("stationId") ?? undefined,
    query: url.searchParams.get("query") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Provide a station ID or at least two characters of a station name." },
      { status: 400 },
    );
  }
  const requestedLanguage = url.searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  try {
    const session = await getSessionFromRequest(request);
    const characterIds = session ? await getSessionCharacterIds(session) : [];
    const facilities = session?.collectionId
      ? Object.values((await getCollectionFacilities(session.collectionId)).facilities)
      : [];
    if (parsed.data.query !== undefined) {
      return NextResponse.json({
        items: await searchMarketStations(
          parsed.data.query,
          language,
          characterIds,
          session?.sessionId,
          facilities,
        ),
      });
    }
    const rootLocations = session
      ? await getKnownMarketStructureLocations(characterIds, session.sessionId, facilities)
      : undefined;
    const [station] = await resolveMarketStations(
      [parsed.data.stationId!],
      language,
      rootLocations,
    );
    return NextResponse.json({ station });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Station data is unavailable.";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
