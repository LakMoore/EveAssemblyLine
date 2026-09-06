import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionFacilities, saveCollectionFacilities } from "@/lib/auth/tokensStore";
import { normalizeFacilitySettings } from "@/lib/planning/facilities";
import { calculateFacilities } from "@/lib/planning/facilitiesServer";

async function loadFacilities(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return calculateFacilities(request, await getCollectionFacilities(session.collectionId));
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(await loadFacilities(request));
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Facilities unavailable." },
      { status: 503 },
    );
  }
}

async function saveFacilities(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const payload = normalizeFacilitySettings(await request.json());
    await saveCollectionFacilities(session.collectionId, payload);
    return NextResponse.json(
      await calculateFacilities(request, await getCollectionFacilities(session.collectionId)),
    );
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Facilities could not be saved." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  return saveFacilities(request);
}

export async function PUT(request: Request) {
  return saveFacilities(request);
}
