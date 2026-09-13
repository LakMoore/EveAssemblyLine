import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { getCorporationSourcePolicies } from "@/lib/esi/cache";
import { getJobsForCharacter, getJobsForCorporation } from "@/lib/data/jobs";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const characterIds = await getSessionCharacterIds(session);
  const corporationSettings = session.collectionId
    ? await getCollectionCorporationSettings(session.collectionId)
    : [];
  const corporationPolicies = await getCorporationSourcePolicies(
    characterIds,
    corporationSettings,
    session.sessionId,
  );
  const context = {
    sessionId: session.sessionId,
    characterIds,
    corporationPolicies,
  };
  const characterResponses = await Promise.all(
    characterIds.map((characterId) => getJobsForCharacter(characterId, context)),
  );
  const corporationResponses = await Promise.all(
    corporationPolicies.map((policy) => getJobsForCorporation(policy.corporationId, context)),
  );
  const ownerResponses = [...characterResponses, ...corporationResponses];
  const slotUsage = Object.fromEntries(
    characterResponses.flatMap((response) => Object.entries(response.slotUsage)),
  );
  const jobs = ownerResponses
    .flatMap((response) => response.jobs)
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate));

  return NextResponse.json({ slotUsage, jobs });
}
