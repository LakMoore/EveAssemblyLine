import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getStateStatus } from "@/lib/esi/cache";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    await getStateStatus(await getSessionCharacterIds(session), session.sessionId),
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
