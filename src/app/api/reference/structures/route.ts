import { NextResponse } from "next/server";
import { getSdeBuildNumber, getStations } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const stationNameCache = new Map<string, string>();
const stationNameCacheSeconds = 60 * 60 * 24 * 365;

async function stationName(stationId: number, language: SdeLanguage, sdeBuildNumber: string) {
  const cacheKey = `${sdeBuildNumber}:${stationId}:${language}`;
  const cachedName = stationNameCache.get(cacheKey);
  if (cachedName) return cachedName;

  try {
    const response = await fetch(
      `https://esi.evetech.net/latest/universe/stations/${stationId}/?datasource=tranquility&language=${language}&sde_build=${sdeBuildNumber}`,
      { next: { revalidate: stationNameCacheSeconds } },
    );
    if (!response.ok) {
      throw new Error(`Station ${stationId} metadata request failed.`);
    }
    const data = (await response.json()) as { name?: string };
    const name = data.name?.trim();
    if (!name) throw new Error(`Station ${stationId} metadata did not include a name.`);
    stationNameCache.set(cacheKey, name);
    return name;
  }
  catch (error) {
    throw error instanceof Error
      ? error
      : new Error(`Station ${stationId} metadata request failed.`);
  }
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const systemIdValue = searchParams.get("systemId");
  const systemId = systemIdValue && /^\d+$/.test(systemIdValue) ? Number(systemIdValue) : null;
  const requestedLanguage = searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";

  if (systemId === null) {
    return NextResponse.json({ error: "A valid system ID is required." }, { status: 400 });
  }

  try {
    const [sdeBuildNumber, stationById] = await Promise.all([getSdeBuildNumber(), getStations()]);
    const stations = [...stationById.values()]
      .filter((station) => station.solarSystemID === systemId)
      .sort((left, right) => left._key - right._key);
    const items = await Promise.all(
      stations.map(async (station) => ({
        structureId: station._key,
        name: await stationName(station._key, language, sdeBuildNumber),
      })),
    );
    return NextResponse.json({ items });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
