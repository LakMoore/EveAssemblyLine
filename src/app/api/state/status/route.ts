import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getStateStatus, refreshCharacterState } from "@/lib/esi/cache";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  await refreshCharacterState(session.characterIds);
  return NextResponse.json(await getStateStatus(session.characterIds));
}
