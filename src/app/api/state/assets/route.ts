import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getAssetCacheMetadata, getResolvedAssets } from "@/lib/esi/cache";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const url = new URL(request.url);
  const requested = (url.searchParams.get("characterIds") ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && session.characterIds.includes(id));
  const characterIds = requested.length > 0 ? requested : session.characterIds;
  const includeCorporationAssets = url.searchParams.get("includeCorporationAssets") !== "false";
  const assets = await getResolvedAssets(characterIds, includeCorporationAssets);
  const metadata = await getAssetCacheMetadata(characterIds, includeCorporationAssets);
  return NextResponse.json({
    assets,
    unresolvedAssetCount: metadata.unresolvedAssetCount,
    lastUpdated: metadata.assetsLastUpdated,
  });
}
