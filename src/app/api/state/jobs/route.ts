import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  getCharacterIndustrySlots,
  getBlueprintInstances,
  getResolvedAssetIndex,
  getRootLocationsByItemId,
  getRunningIndustryJobs,
} from "@/lib/esi/cache";
import { getCharacter, getCharacters } from "@/lib/auth/tokensStore";
import {
  getBlueprintById,
  getStations,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { fetchStructureMetadataPerCharacter, getUsableToken } from "@/lib/esi/client";

const activityNames: Record<number, string> = {
  1: "Manufacturing",
  3: "Time research",
  4: "Material research",
  5: "Copying",
  8: "Invention",
  9: "Reactions",
};
const slotCategories: Partial<Record<number, "Manufacturing" | "Reactions" | "Science">> = {
  1: "Manufacturing",
  3: "Science",
  4: "Science",
  5: "Science",
  8: "Science",
  9: "Reactions",
};

function isActiveJob(status: string) {
  return status.toLowerCase() === "active";
}

async function resolveOutputLocationName(
  locationId: number,
  rootLocations: Awaited<ReturnType<typeof getRootLocationsByItemId>>,
  stations: Awaited<ReturnType<typeof getStations>>,
  systems: Awaited<ReturnType<typeof getSystems>>,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  characterIds: number[],
) {
  const root = rootLocations.get(locationId);
  if (root?.name) return root.name;
  const station = stations.get(locationId);
  if (station) return types.get(station.typeID)?.name.en ?? `Station ${locationId}`;
  const system = systems.get(locationId);
  if (system) return system.name.en;

  for (const characterId of characterIds) {
    const character = await getCharacter(characterId);
    if (!character) continue;
    try {
      const token = await getUsableToken(character);
      const result = await fetchStructureMetadataPerCharacter(locationId, token);
      if (result.data?.name) return result.data.name;
    }
    catch {}
  }
  return `Location ${locationId}`;
}

function outputQuantity(
  job: Awaited<ReturnType<typeof getRunningIndustryJobs>>[number],
  blueprint: Awaited<ReturnType<typeof getBlueprintById>>,
) {
  const installedRuns = job.installedRuns ?? 0;
  if (job.activityId === 5) return installedRuns;
  if (!blueprint || ![1, 8, 9].includes(job.activityId)) return 0;
  const activity =
    job.activityId === 9
      ? blueprint.activities.reaction
      : job.activityId === 1
        ? blueprint.activities.manufacturing
        : blueprint.activities.invention;
  const product = activity?.products?.find((candidate) => candidate.typeID === job.productTypeId);
  return (product?.quantity ?? 0) * installedRuns;
}

function outputRunsPerCopy(job: Awaited<ReturnType<typeof getRunningIndustryJobs>>[number]) {
  return job.activityId === 5 ? job.licensedRuns : undefined;
}

function jobUsesBpo(
  job: Awaited<ReturnType<typeof getRunningIndustryJobs>>[number],
  blueprintInstances: Awaited<ReturnType<typeof getBlueprintInstances>>,
  assets: Awaited<ReturnType<typeof getResolvedAssetIndex>>,
) {
  if (job.activityId === 9) return false;
  const instance = blueprintInstances.find(
    (blueprint) =>
      blueprint.itemId === job.blueprintId
      && blueprint.ownerType === job.ownerType
      && blueprint.ownerId === job.ownerId,
  );
  if (instance) return instance.quantity === -1;
  return assets.get(job.blueprintId)?.runCount === -1;
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const characterIds = await getSessionCharacterIds(session);
  const characters = (await getCharacters()).filter((character) =>
    characterIds.includes(character.characterId),
  );
  const includeCorporationJobs = characters.some((character) => character.hasDirectorRole);
  const availableSlots = await getCharacterIndustrySlots(characterIds, session.sessionId);
  const jobs = (
    await getRunningIndustryJobs(characterIds, includeCorporationJobs, session.sessionId)
  ).filter((job) => isActiveJob(job.status));
  const [stations, systems, rootLocations, blueprintInstances, assets] = await Promise.all([
    getStations(),
    getSystems(),
    getRootLocationsByItemId(characterIds, true, session.sessionId),
    getBlueprintInstances(characterIds, true, session.sessionId),
    getResolvedAssetIndex(characterIds, true, session.sessionId),
  ]);
  const types = await getTypesByIds(
    [
      ...new Set([
        ...jobs.flatMap((job) => [job.blueprintTypeId, job.productTypeId ?? 0]),
        ...[...stations.values()].map((station) => station.typeID),
      ]),
    ].filter((typeId) => typeId > 0),
  );
  const outputLocationNames = new Map(
    await Promise.all(
      [...new Set(jobs.map((job) => job.outputLocationId))].map(
        async (locationId) =>
          [
            locationId,
            await resolveOutputLocationName(
              locationId,
              rootLocations,
              stations,
              systems,
              types,
              characterIds,
            ),
          ] as const,
      ),
    ),
  );
  const blueprints = new Map(
    await Promise.all(
      jobs.map(
        async (job) => [job.blueprintTypeId, await getBlueprintById(job.blueprintTypeId)] as const,
      ),
    ),
  );
  const characterNames = new Map(
    characters.map((character) => [character.characterId, character.characterName]),
  );
  const slots = new Map<number, Record<"Manufacturing" | "Reactions" | "Science", number>>();
  for (const character of characters) {
    slots.set(
      character.characterId,
      {
        Manufacturing: 0,
        Reactions: 0,
        Science: 0,
      },
    );
  }
  for (const job of jobs) {
    const category = slotCategories[job.activityId];
    if (!category) continue;
    const characterSlots = slots.get(job.installerId);
    if (characterSlots) characterSlots[category] += 1;
  }

  return NextResponse.json({
    characters: characters.map((character) => ({
      characterId: character.characterId,
      characterName: character.characterName,
      slots: slots.get(character.characterId) ?? {},
      availableSlots: availableSlots.get(character.characterId) ?? {
        Manufacturing: 1,
        Reactions: 1,
        Science: 1,
      },
    })),
    jobs: jobs
      .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate))
      .map((job) => ({
        jobId: job.jobId,
        characterId: job.installerId,
        characterName: characterNames.get(job.installerId) ?? `Character ${job.installerId}`,
        ownerType: job.ownerType,
        activity: activityNames[job.activityId] ?? "Industry job",
        status: job.status,
        runs: job.runs,
        outputQuantity: outputQuantity(job, blueprints.get(job.blueprintTypeId) ?? null),
        ...(outputRunsPerCopy(job) !== undefined
          ? { outputRunsPerCopy: outputRunsPerCopy(job) }
          : {}),
        ...(jobUsesBpo(job, blueprintInstances, assets) ? { usesBpo: true } : {}),
        startDate: job.startDate,
        endDate: job.endDate,
        facilityId: job.facilityId,
        outputLocationId: job.outputLocationId,
        outputLocationName: outputLocationNames.get(job.outputLocationId),
        blueprintTypeId: job.blueprintTypeId,
        blueprintTypeName: types.get(job.blueprintTypeId)?.name.en,
        ...(job.productTypeId !== undefined
          ? {
              productTypeId: job.productTypeId,
              productTypeName: types.get(job.productTypeId)?.name.en,
            }
          : {}),
      })),
  });
}
