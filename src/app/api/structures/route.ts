import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionStructureRigs, saveCollectionStructureRigs } from "@/lib/auth/tokensStore";
import { normalizeStructureRigs } from "@/lib/planning/structureRigs";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    return NextResponse.json(await getCollectionStructureRigs(session.collectionId));
  }
  catch {
    return NextResponse.json({ error: "Structure rigs are unavailable." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  }
  catch {
    return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "A structure rig map is required." }, { status: 400 });
  }
  const candidate = body as { lastModified?: unknown; structures?: unknown };
  if (
    typeof candidate.lastModified !== "string"
    || Number.isNaN(Date.parse(candidate.lastModified))
  ) {
    return NextResponse.json({ error: "lastModified must be an ISO timestamp." }, { status: 400 });
  }
  if (
    !candidate.structures
    || typeof candidate.structures !== "object"
    || Array.isArray(candidate.structures)
  ) {
    return NextResponse.json(
      { error: "structures must be a map of structure rig entries." },
      { status: 400 },
    );
  }

  try {
    const saved = await saveCollectionStructureRigs(
      session.collectionId,
      normalizeStructureRigs(candidate),
    );
    return NextResponse.json(saved);
  }
  catch {
    return NextResponse.json({ error: "Structure rigs could not be saved." }, { status: 503 });
  }
}
