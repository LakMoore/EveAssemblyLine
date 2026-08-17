import { NextResponse } from "next/server";
import {
  getDogmaAttributes,
  getDogmaEffects,
  getGroups,
  getStations,
  getSystems,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  getCollectionFacilities,
  saveCollectionFacilities,
  getCharacters,
} from "@/lib/auth/tokensStore";
import { getCachedCorporationStructures, getRootLocationsByItemId } from "@/lib/esi/cache";
import { fetchIndustrySystems, fetchStationMetadata } from "@/lib/esi/client";
import {
  normalizeFacilitySettings,
  supportsReactionSettings,
  type FacilitySettingsEntry,
  type FacilityActivity,
  type FacilitySettingsPayload,
} from "@/lib/planning/facilities";
import { calculateReprocessingEfficiency } from "@/lib/planning/reprocessingEfficiency";
import { calculateFacilityBonuses } from "@/lib/planning/facilityBonuses";

type FacilityCandidate = Omit<FacilitySettingsEntry, "locationId"> & {
  locationId: number;
  locationType: "station" | "structure";
  securityStatus?: number;
  services?: Array<{ name: string; state: string }>;
};

function serviceIsOnline(services: FacilityCandidate["services"], name: string) {
  return (services ?? []).some(
    (service) => service.name.toLowerCase().includes(name) && service.state === "online",
  );
}

function emptyActivities(): Record<string, FacilityActivity> {
  return {
    reprocessing: {
      available: false,
    },
    manufacturing: {
      available: false,
    },
    reactions: {
      available: false,
    },
    meResearch: {
      available: false,
    },
    teResearch: {
      available: false,
    },
    invention: {
      available: false,
    },
    copying: {
      available: false,
    },
  };
}

function reprocessingRigTypeId(
  typeDogma: Awaited<ReturnType<typeof getTypeDogma>>,
  rigTypeIds: number[],
) {
  return rigTypeIds
    .filter(
      (typeId) =>
        typeId > 0
        && (
          typeDogma
            .get(typeId)
            ?.dogmaAttributes.some(
              (attribute) => attribute.attributeID === 379 || attribute.attributeID === 717,
            )
          ?? false
        ),
    )
    .sort(
      (left, right) =>
        (
          typeDogma.get(right)?.dogmaAttributes.find((attribute) => attribute.attributeID === 717)
            ?.value ?? 0.5
        )
        - (
          typeDogma.get(left)?.dogmaAttributes.find((attribute) => attribute.attributeID === 717)
            ?.value ?? 0.5
        ),
    )[0];
}

async function calculateFacilities(request: Request, settings: FacilitySettingsPayload) {
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  const phaseTimings: Record<string, number> = {};
  const markPhase = (name: string) => {
    const now = performance.now();
    phaseTimings[name] = Number((now - phaseStartedAt).toFixed(1));
    phaseStartedAt = now;
  };
  const session = await getSessionFromRequest(request);
  if (!session) throw new Error("Not authenticated.");
  const characterIds = await getSessionCharacterIds(session);
  markPhase("auth");
  const [
    characters,
    roots,
    stations,
    systems,
    types,
    typeDogma,
    dogmaEffects,
    dogmaAttributes,
    groups,
    industrySystems,
  ] = await Promise.all([
    getCharacters(),
    getRootLocationsByItemId(characterIds, true, session.sessionId),
    getStations(),
    getSystems(),
    getTypes(),
    getTypeDogma(),
    getDogmaEffects(),
    getDogmaAttributes(),
    getGroups(),
    fetchIndustrySystems().catch(() => ({ data: [] })),
  ]);
  markPhase("loadDependencies");
  const authorized = characters.filter(
    (character) =>
      characterIds.includes(character.characterId)
      && character.corporationId
      && (character.hasDirectorRole || character.hasStationManagerRole),
  );
  const authorizedByCorporation = new Map<number, (typeof authorized)[number]>();
  for (const character of authorized) {
    if (character.corporationId !== undefined) {
      authorizedByCorporation.set(character.corporationId, character);
    }
  }
  const corporationStructuresPromise = getCachedCorporationStructures(
    characterIds,
    session.sessionId,
  );
  const savedByLocationId = new Map(
    Object
      .values(settings.facilities)
      .filter((facility) => facility.locationId !== undefined)
      .map((facility) => [facility.locationId!, facility]),
  );
  const candidates = new Map<number, FacilityCandidate>();
  for (const root of roots.values()) {
    if (root.kind !== "station" && root.kind !== "structure") continue;
    const saved = savedByLocationId.get(root.locationId);
    const systemId =
      root.systemId
      ?? (root.kind === "station" ? stations.get(root.locationId)?.solarSystemID : undefined);
    if (!systemId) continue;
    candidates.set(
      root.locationId,
      {
        locationId: root.locationId,
        systemId,
        name: root.name ?? `Location ${root.locationId}`,
        typeId: root.typeId,
        rigTypeIds: saved?.rigTypeIds ?? [],
        ...(saved?.services ? { services: saved.services } : {}),
        allowStandardBuilds: saved?.allowStandardBuilds !== false,
        allowReactionBuilds: saved?.allowReactionBuilds !== false,
        allowBiochemicalReactions:
          saved?.allowBiochemicalReactions ?? saved?.allowReactionBuilds !== false,
        allowCompositeReactions:
          saved?.allowCompositeReactions ?? saved?.allowReactionBuilds !== false,
        allowHybridReactions: saved?.allowHybridReactions ?? saved?.allowReactionBuilds !== false,
        allowInvention: saved?.allowInvention !== false,
        allowResearch: saved?.allowResearch !== false,
        ...(saved?.allowCapitalBuilds === undefined
          ? {}
          : { allowCapitalBuilds: saved.allowCapitalBuilds }),
        ...(saved?.standardTaxRate === undefined ? {} : { standardTaxRate: saved.standardTaxRate }),
        ...(saved?.capitalTaxRate === undefined ? {} : { capitalTaxRate: saved.capitalTaxRate }),
        ...(saved?.reactionTaxRate === undefined ? {} : { reactionTaxRate: saved.reactionTaxRate }),
        ...(saved?.biochemicalTaxRate === undefined
          ? {}
          : { biochemicalTaxRate: saved.biochemicalTaxRate }),
        ...(saved?.compositeTaxRate === undefined
          ? {}
          : { compositeTaxRate: saved.compositeTaxRate }),
        ...(saved?.hybridTaxRate === undefined ? {} : { hybridTaxRate: saved.hybridTaxRate }),
        ...(saved?.inventionTaxRate === undefined
          ? {}
          : { inventionTaxRate: saved.inventionTaxRate }),
        ...(saved?.researchTaxRate === undefined ? {} : { researchTaxRate: saved.researchTaxRate }),
        ...(saved?.settingsLastModified === undefined
          ? {}
          : { settingsLastModified: saved.settingsLastModified }),
        locationType: root.kind,
        securityStatus: systems.get(systemId)?.securityStatus,
      },
    );
  }
  for (const facility of Object.values(settings.facilities)) {
    if (facility.locationId === undefined || candidates.has(facility.locationId)) continue;
    candidates.set(
      facility.locationId,
      {
        ...facility,
        locationId: facility.locationId,
        locationType: "structure",
        securityStatus: systems.get(facility.systemId)?.securityStatus,
      },
    );
  }
  markPhase("rootCandidates");
  const corpStructures = (await corporationStructuresPromise).flat();
  for (const structure of corpStructures) {
    const saved = savedByLocationId.get(structure.structure_id);
    const candidate = candidates.get(structure.structure_id);
    if (candidate) {
      candidate.services = structure.services ?? candidate.services;
      continue;
    }
    candidates.set(
      structure.structure_id,
      {
        locationId: structure.structure_id,
        systemId: structure.system_id,
        name: structure.name ?? `Structure ${structure.structure_id}`,
        typeId: structure.type_id,
        rigTypeIds: saved?.rigTypeIds ?? [],
        services: structure.services ?? saved?.services,
        allowStandardBuilds: saved?.allowStandardBuilds !== false,
        allowReactionBuilds: saved?.allowReactionBuilds !== false,
        allowBiochemicalReactions:
          saved?.allowBiochemicalReactions ?? saved?.allowReactionBuilds !== false,
        allowCompositeReactions:
          saved?.allowCompositeReactions ?? saved?.allowReactionBuilds !== false,
        allowHybridReactions: saved?.allowHybridReactions ?? saved?.allowReactionBuilds !== false,
        allowInvention: saved?.allowInvention !== false,
        allowResearch: saved?.allowResearch !== false,
        ...(saved?.allowCapitalBuilds === undefined
          ? {}
          : { allowCapitalBuilds: saved.allowCapitalBuilds }),
        ...(saved?.standardTaxRate === undefined ? {} : { standardTaxRate: saved.standardTaxRate }),
        ...(saved?.capitalTaxRate === undefined ? {} : { capitalTaxRate: saved.capitalTaxRate }),
        ...(saved?.reactionTaxRate === undefined ? {} : { reactionTaxRate: saved.reactionTaxRate }),
        ...(saved?.biochemicalTaxRate === undefined
          ? {}
          : { biochemicalTaxRate: saved.biochemicalTaxRate }),
        ...(saved?.compositeTaxRate === undefined
          ? {}
          : { compositeTaxRate: saved.compositeTaxRate }),
        ...(saved?.hybridTaxRate === undefined ? {} : { hybridTaxRate: saved.hybridTaxRate }),
        ...(saved?.inventionTaxRate === undefined
          ? {}
          : { inventionTaxRate: saved.inventionTaxRate }),
        ...(saved?.researchTaxRate === undefined ? {} : { researchTaxRate: saved.researchTaxRate }),
        ...(saved?.settingsLastModified === undefined
          ? {}
          : { settingsLastModified: saved.settingsLastModified }),
        locationType: "structure",
        securityStatus: systems.get(structure.system_id)?.securityStatus,
      },
    );
  }
  markPhase("corporationStructures");
  const stationMetadata = await Promise.all(
    [...candidates.values()]
      .filter((facility) => facility.locationType === "station")
      .map(
        async (facility) =>
          [
            facility.locationId,
            await fetchStationMetadata(facility.locationId).catch(() => null),
          ] as const,
      ),
  );
  const metadataById = new Map(stationMetadata);
  markPhase("stationMetadata");
  const costIndices = new Map(
    (industrySystems.data ?? []).map((system) => [
      system.solar_system_id,
      new Map((system.cost_indices ?? []).map((index) => [index.activity, index.cost_index])),
    ]),
  );
  const facilities = [...candidates.values()].map((facility) => {
    const stationServices = metadataById.get(facility.locationId)?.data?.services;
    const services =
      facility.services
      ?? stationServices?.flatMap((service) =>
        typeof service === "string" ? [{ name: service, state: "online" }] : [service],
      );
    const bonusResult = calculateFacilityBonuses(
      typeDogma.get(facility.typeId ?? 0),
      facility.rigTypeIds,
      typeDogma,
      dogmaEffects,
    );
    const reactionSettingsAllowed = supportsReactionSettings(
      facility.typeId,
      facility.securityStatus,
    );
    const activities = emptyActivities();
    activities.reprocessing.available =
      facility.locationType === "structure"
        ? true
        : (services?.some((service) => service.name.toLowerCase().includes("reprocess")) ?? false);
    activities.manufacturing.available =
      facility.locationType === "structure"
        ? (serviceIsOnline(services, "manufact") || services === undefined)
          && facility.allowStandardBuilds !== false
        : serviceIsOnline(services, "factory") && facility.allowStandardBuilds !== false;
    activities.reactions.available =
      facility.locationType === "structure"
      && reactionSettingsAllowed
      && facility.allowReactionBuilds !== false;
    activities.meResearch.available =
      (facility.locationType === "structure" ? true : serviceIsOnline(services, "laboratory"))
      && facility.allowResearch !== false;
    activities.teResearch.available = activities.meResearch.available;
    activities.invention.available =
      (facility.locationType === "structure" ? true : serviceIsOnline(services, "laboratory"))
      && facility.allowInvention !== false;
    activities.copying.available = activities.meResearch.available;
    for (const activity of Object.values(activities)) {
      activity.materialConsumption = bonusResult.manufacturing.material.percentage;
      activity.jobDuration = bonusResult.manufacturing.time.percentage;
      activity.jobCost = bonusResult.manufacturing.cost.percentage;
    }
    const systemIndices = costIndices.get(facility.systemId);
    const reprocessingYield =
      facility.locationType === "station"
        ? 0.5
        : calculateReprocessingEfficiency(
            { types, groups, typeDogma, dogmaAttributes },
            facility.typeId ?? 0,
            {},
            0,
            facility.securityStatus,
            0,
            reprocessingRigTypeId(typeDogma, facility.rigTypeIds),
          ).normalOre / 100;
    activities.reprocessing.baseYield = reprocessingYield;
    activities.manufacturing.jobDuration = bonusResult.manufacturing.time.percentage;
    activities.manufacturing.materialConsumption = bonusResult.manufacturing.material.percentage;
    activities.manufacturing.jobCost = bonusResult.manufacturing.cost.percentage;
    activities.manufacturing.rawJobDurationMultiplier =
      bonusResult.manufacturing.time.rawMultiplier;
    activities.manufacturing.rawMaterialConsumptionMultiplier =
      bonusResult.manufacturing.material.rawMultiplier;
    activities.manufacturing.rawJobCostMultiplier = bonusResult.manufacturing.cost.rawMultiplier;
    activities.reactions.materialConsumption = bonusResult.reactions.material.percentage;
    activities.reactions.jobDuration = bonusResult.reactions.time.percentage;
    activities.reactions.jobCost = bonusResult.reactions.cost.percentage;
    activities.reactions.rawJobDurationMultiplier = bonusResult.reactions.time.rawMultiplier;
    activities.reactions.rawMaterialConsumptionMultiplier =
      bonusResult.reactions.material.rawMultiplier;
    activities.reactions.rawJobCostMultiplier = bonusResult.reactions.cost.rawMultiplier;
    activities.manufacturing.standard = facility.standardTaxRate ?? null;
    activities.manufacturing.capital = facility.allowCapitalBuilds
      ? (facility.capitalTaxRate ?? null)
      : null;
    activities.reactions.reactions = reactionSettingsAllowed
      ? (facility.reactionTaxRate ?? null)
      : 0;
    activities.reactions.biochemical = reactionSettingsAllowed
      ? (facility.biochemicalTaxRate ?? facility.reactionTaxRate ?? null)
      : 0;
    activities.reactions.composite = reactionSettingsAllowed
      ? (facility.compositeTaxRate ?? facility.reactionTaxRate ?? null)
      : 0;
    activities.reactions.hybrid = reactionSettingsAllowed
      ? (facility.hybridTaxRate ?? facility.reactionTaxRate ?? null)
      : 0;
    activities.invention.invention = facility.inventionTaxRate ?? null;
    activities.meResearch.research = facility.researchTaxRate ?? null;
    activities.teResearch.research = facility.researchTaxRate ?? null;
    return {
      id: facility.locationId,
      name:
        facility.name
        || types.get(facility.typeId ?? 0)?.name.en
        || `Location ${facility.locationId}`,
      locationType: facility.locationType,
      typeId: facility.typeId ?? 0,
      systemId: facility.systemId,
      securityStatus: facility.securityStatus,
      systemCostIndices: Object.fromEntries(systemIndices ?? []),
      activities,
      buildTypeGroups: {},
      services: services ?? [],
      rigTypeIds: facility.rigTypeIds,
      settingsLastModified: facility.settingsLastModified ?? settings.lastModified,
    };
  });
  markPhase("calculateFacilities");
  console.info(
    "[facilities] timing",
    {
      totalMs: Number((performance.now() - startedAt).toFixed(1)),
      phases: phaseTimings,
      characters: characterIds.length,
      roots: roots.size,
      corporationStructures: corpStructures.length,
      corporationsRequested: authorizedByCorporation.size,
      candidates: candidates.size,
      stationsWithMetadata: stationMetadata.length,
      facilities: facilities.length,
    },
  );
  return { facilities, settings };
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    return NextResponse.json(
      await calculateFacilities(request, await getCollectionFacilities(session.collectionId)),
    );
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Facilities unavailable." },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const payload = normalizeFacilitySettings(await request.json());
    await saveCollectionFacilities(session.collectionId, payload);
    return NextResponse.json(
      await calculateFacilities(request, await getCollectionFacilities(session.collectionId)),
    );
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Facilities could not be saved." },
      { status: 400 },
    );
  }
}
