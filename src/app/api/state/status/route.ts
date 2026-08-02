import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getStateStatus } from "@/lib/esi/cache";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  return NextResponse.json(getStateStatus(session.characterIds));
}
