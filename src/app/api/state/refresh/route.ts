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
    return NextResponse.json({
      success: false,
      characters: [],
      rateLimitedUntil,
    });
  }
  const key = session.characterIds
    .slice()
    .sort((left, right) => left - right)
    .join(",");
  const activeRefresh = activeRefreshes.get(key);
  if (activeRefresh) {
    const result = await activeRefresh;
    return NextResponse.json({
      ...result,
      success: true,
      refreshedAt: new Date().toISOString(),
      rateLimitedUntil: getEsiRateLimitUntil(),
    });
  }
  const refresh = refreshCharacterState(session.characterIds, { force: body.force === true });
  activeRefreshes.set(key, refresh);
  const result = await refresh.finally(() => activeRefreshes.delete(key));
  return NextResponse.json({
    ...result,
    success: true,
    refreshedAt: new Date().toISOString(),
    rateLimitedUntil: getEsiRateLimitUntil(),
  });
}
