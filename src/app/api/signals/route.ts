import { NextResponse } from "next/server";
import { z } from "zod";
import { getTypesByIds } from "@/cache/services/sdeCache";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionFacilities } from "@/lib/auth/tokensStore";
import { getResolvedAssets } from "@/lib/esi/cache";
import { getMarketSignals } from "@/lib/market/signals";
import {
  getKnownMarketStructureLocations,
  resolveMarketStations,
} from "@/lib/market/stations.server";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const signalsRequestSchema = z.object({
  language: z.string().optional(),
  stationIds: z.array(z.number().int().positive().safe()).max(20),
  includeCorporationAssets: z.boolean().default(true),
  salesTaxPercent: z.number().min(0).max(100).default(3.6),
  thresholdIsk: z.number().nonnegative().finite().default(5_000_000),
});

/** Returns sale signals for cached stock held at the requested market locations. */
export async function POST(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const parsed = signalsRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid Signals settings." }, { status: 400 });
  }
  const requestedLanguage = parsed.data.language ?? null;
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const characterIds = await getSessionCharacterIds(session);
  let stations;
  try {
    const facilities = session.collectionId
      ? Object.values((await getCollectionFacilities(session.collectionId)).facilities)
      : [];
    const rootLocations = await getKnownMarketStructureLocations(
      characterIds,
      session.sessionId,
      facilities,
    );
    stations = await resolveMarketStations(parsed.data.stationIds, language, rootLocations);
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "A market station is invalid.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const assets = await getResolvedAssets(
      characterIds,
      parsed.data.includeCorporationAssets,
      session.sessionId,
    );
    const types = await getTypesByIds([...new Set(assets.map((asset) => asset.typeId))]);
    const marketableAssets = assets.filter((asset) => {
      const type = types.get(asset.typeId);
      return type?.published === true && type.marketGroupID !== undefined;
    });
    const signals = await getMarketSignals(
      marketableAssets,
      stations,
      parsed.data.salesTaxPercent,
      parsed.data.thresholdIsk,
    );
    const stationById = new Map(stations.map((station) => [station.stationId, station]));
    const items = signals
      .map((signal) => ({
        ...signal,
        name: types.get(signal.typeId)?.name[language] ?? types.get(signal.typeId)?.name.en,
        stationName: stationById.get(signal.stationId)?.name ?? String(signal.stationId),
      }))
      .filter((signal): signal is typeof signal & { name: string } => Boolean(signal.name))
      .sort(
        (left, right) =>
          right.percentageOverAverage - left.percentageOverAverage
          || right.totalPriceAfterTax - left.totalPriceAfterTax,
      );
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      averageWindowDays: 7,
      priceScope: "region",
      volumeScope: "region",
      salesTaxPercent: parsed.data.salesTaxPercent,
      thresholdIsk: parsed.data.thresholdIsk,
      stations,
      items,
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Market signals are unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
