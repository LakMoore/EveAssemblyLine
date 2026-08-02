import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { refreshCharacterState } from "@/lib/esi/cache";
import { getEsiRateLimitUntil } from "@/lib/esi/client";

const activeRefreshes = new Map<
  string,
  Promise<Awaited<ReturnType<typeof refreshCharacterState>>>
>();

export async function POST(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const rateLimitedUntil = getEsiRateLimitUntil();
  if (rateLimitedUntil) {
    return NextResponse.json({ characters: [], rateLimitedUntil });
  }
  const key = session.characterIds
    .slice()
    .sort((left, right) => left - right)
    .join(",");
  const activeRefresh = activeRefreshes.get(key);
  if (activeRefresh) {
    return NextResponse.json({
      ...(await activeRefresh),
      rateLimitedUntil: getEsiRateLimitUntil(),
    });
  }
  const refresh = refreshCharacterState(session.characterIds, { force: body.force === true });
  activeRefreshes.set(key, refresh);
  return NextResponse.json({
    ...(await refresh.finally(() => activeRefreshes.delete(key))),
    rateLimitedUntil: getEsiRateLimitUntil(),
  });
}
