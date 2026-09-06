import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionFacilities, saveCollectionFacilities } from "@/lib/auth/tokensStore";
import { normalizeFacilitySettings } from "@/lib/planning/facilities";
import { calculateFacilities } from "@/lib/planning/facilitiesServer";
import { createTimingScope, logTiming, type TimingScope } from "@/lib/server/timing";

async function loadFacilities(request: Request, timing: TimingScope) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return calculateFacilities(
    request,
    await getCollectionFacilities(session.collectionId),
    timing.child("calculateFacilities"),
  );
}

async function withTiming<T>(label: string, operation: (timing: TimingScope) => Promise<T>) {
  const timing = createTimingScope();
  try {
    const result = await operation(timing);
    if (process.env.NODE_ENV === "development") logTiming(label, timing.complete());
    return result;
  }
  catch (error) {
    if (process.env.NODE_ENV === "development") logTiming(label, timing.complete());
    throw error;
  }
}

export async function GET(request: Request) {
  try {
    return await withTiming(
      "[facilities] timing",
      async (timing) => NextResponse.json(await loadFacilities(request, timing)),
    );
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Facilities unavailable." },
      { status: 503 },
    );
  }
}

async function saveFacilities(request: Request, timing: TimingScope) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const payload = normalizeFacilitySettings(await request.json());
    await saveCollectionFacilities(session.collectionId, payload);
    return NextResponse.json(
      await calculateFacilities(
        request,
        await getCollectionFacilities(session.collectionId),
        timing.child("calculateFacilities"),
      ),
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
  return withTiming("[facilities] timing", (timing) => saveFacilities(request, timing));
}

export async function PUT(request: Request) {
  return withTiming("[facilities] timing", (timing) => saveFacilities(request, timing));
}
