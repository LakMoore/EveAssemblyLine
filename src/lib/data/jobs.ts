import { getCharacter } from "@/lib/auth/tokensStore";
import {
  getBlueprintInstances,
  getCharacterIndustrySlots,
  getResolvedAssetIndex,
  getRootLocationsByItemId,
  getRunningIndustryJobs,
  resolveStructureLocationForOwner,
  type StructureLocationSource,
} from "@/lib/esi/cache";
import {
  getBlueprintById,
  getStations,
  getSystems,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import {
  assertCharacterOwner,
  assertCorporationOwner,
  getCorporationPolicy,
  type OwnerDataContext,
} from "./types";

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

export type OwnerJobsResponse = {
  slotUsage: Record<
    string,
    {
      slots: Record<string, number>;
      availableSlots: Record<string, number>;
    }
  >;
  jobs: Array<{
    jobId: number;
    characterId: number;
    ownerId: number;
    ownerType: "character" | "corporation";
    activity: string;
    status: string;
    runs: number;
    outputQuantity: number;
    outputRunsPerCopy?: number;
    usesBpo?: boolean;
    startDate: string;
    endDate: string;
    facilityId: number;
    outputLocationId: number;
    outputLocationName: string;
    blueprintTypeId: number;
    blueprintTypeName?: string;
    productTypeId?: number;
    productTypeName?: string;
  }>;
};

function isActiveJob(status: string) {
  return status.toLowerCase() === "active";
}

async function resolveOutputLocationName(
  locationId: number,
  source: StructureLocationSource,
  rootLocations: Awaited<ReturnType<typeof getRootLocationsByItemId>>,
  stations: Awaited<ReturnType<typeof getStations>>,
  systems: Awaited<ReturnType<typeof getSystems>>,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  characterIds: readonly number[],
  sessionId: string,
) {
  const root = rootLocations.get(locationId);
  if (root?.name) return root.name;
  const station = stations.get(locationId);
  if (station) return types.get(station.typeID)?.name.en ?? `Station ${locationId}`;
  const system = systems.get(locationId);
  if (system) return system.name.en;

  const structure = await resolveStructureLocationForOwner(
    locationId,
    source,
    [...characterIds],
    sessionId,
  ).catch(() => undefined);
  if (structure?.name) return structure.name;
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

async function buildJobsResponse(
  jobs: Awaited<ReturnType<typeof getRunningIndustryJobs>>,
  characterIds: readonly number[],
  context: OwnerDataContext,
  includeSlotUsage: boolean,
  includeCorporationData: boolean,
): Promise<OwnerJobsResponse> {
  const [stations, systems, rootLocations, blueprintInstances, assets] = await Promise.all([
    getStations(),
    getSystems(),
    getRootLocationsByItemId(
      [...characterIds],
      includeCorporationData,
      context.sessionId,
      context.corporationPolicies,
    ),
    getBlueprintInstances(
      [...characterIds],
      includeCorporationData,
      context.sessionId,
      context.corporationPolicies,
    ),
    getResolvedAssetIndex(
      [...characterIds],
      includeCorporationData,
      context.sessionId,
      context.corporationPolicies,
    ),
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
      [...new Map(jobs.map((job) => [job.outputLocationId, job])).values()].map(
        async (job) =>
          [
            job.outputLocationId,
            await resolveOutputLocationName(
              job.outputLocationId,
              {
                ownerType: job.ownerType,
                ownerId: job.ownerId,
                recordType: "job",
              },
              rootLocations,
              stations,
              systems,
              types,
              characterIds,
              context.sessionId,
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
  const slotUsage: OwnerJobsResponse["slotUsage"] = {};
  if (includeSlotUsage) {
    const availableSlots = await getCharacterIndustrySlots([...characterIds], context.sessionId);
    const characters = (await Promise.all(characterIds.map((id) => getCharacter(id)))).filter(
      (character) => character !== null,
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
    for (const character of characters) {
      slotUsage[String(character.characterId)] = {
        slots: slots.get(character.characterId) ?? {},
        availableSlots: character.onDeployment
          ? { Manufacturing: 0, Reactions: 0, Science: 0 }
          : (
              availableSlots.get(character.characterId) ?? {
                Manufacturing: 1,
                Reactions: 1,
                Science: 1,
              }
            ),
      };
    }
  }
  return {
    slotUsage,
    jobs: jobs
      .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate))
      .map((job) => ({
        jobId: job.jobId,
        characterId: job.installerId,
        ownerId: job.ownerId,
        ownerType: job.ownerType,
        activityId: job.activityId,
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
        outputLocationName: outputLocationNames.get(job.outputLocationId) ?? "Location unavailable",
        blueprintTypeId: job.blueprintTypeId,
        blueprintTypeName: types.get(job.blueprintTypeId)?.name.en,
        ...(job.productTypeId !== undefined
          ? {
              productTypeId: job.productTypeId,
              productTypeName: types.get(job.productTypeId)?.name.en,
            }
          : {}),
      })),
  };
}

/** Builds active industry jobs and slot usage for one attached character. */
export async function getJobsForCharacter(
  characterId: number,
  context: OwnerDataContext,
): Promise<OwnerJobsResponse> {
  assertCharacterOwner(characterId, context);
  const jobs = (await getRunningIndustryJobs([characterId], false, context.sessionId, [])).filter(
    (job) => isActiveJob(job.status),
  );
  return buildJobsResponse(jobs, [characterId], context, true, false);
}

/** Builds source-filtered active industry jobs for one authorized corporation. */
export async function getJobsForCorporation(
  corporationId: number,
  context: OwnerDataContext,
): Promise<OwnerJobsResponse> {
  assertCorporationOwner(corporationId, context);
  const policy = getCorporationPolicy(corporationId, context);
  const jobs = (
    await getRunningIndustryJobs(
      [...context.characterIds],
      true,
      context.sessionId,
      policy ? [policy] : [],
    )
  )
    .filter((job) => job.ownerType === "corporation" && job.ownerId === corporationId)
    .filter((job) => isActiveJob(job.status));
  return buildJobsResponse(jobs, context.characterIds, context, false, true);
}
