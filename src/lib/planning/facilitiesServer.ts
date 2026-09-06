import {
  getDogmaAttributes,
  getDogmaEffects,
  getGroups,
  getIndustryModifierSources,
  getIndustryTargetFilters,
  getStations,
  getSystems,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  getCachedCorporationStructures,
  getCorporationSourceCatalog,
  getCorporationSourcePolicies,
  getRootLocationsByItemId,
} from "@/lib/esi/cache";
import { getCollectionCorporationSettings } from "@/lib/auth/tokensStore";
import { fetchIndustrySystems, fetchStationMetadata } from "@/lib/esi/client";
import {
  emptyActivitiesRequest,
  normalizeFacilitySettings,
  supportsReactionSettings,
  type ActivitiesResponse,
  type FacilityResponse,
  type FacilitySettingsEntry,
  type FacilitySettingsPayload,
} from "@/lib/planning/facilities";
import { calculateReprocessingEfficiency } from "@/lib/planning/reprocessingEfficiency";
import {
  calculateFacilityBonuses,
  calculateFacilityGroupBonuses,
} from "@/lib/planning/facilityBonuses";
import { getProductionGroupReferences } from "@/lib/planning/productionGroups";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { formatLocationName, normalizeLocationName } from "@/lib/reference/locationName";
import { createTimingScope, type TimingScope } from "@/lib/server/timing";

type FacilityCandidate = Omit<FacilitySettingsEntry, "locationId"> & {
  id: number | string;
  locationId?: number;
  locationType: "station" | "structure";
  securityStatus?: number;
  services?: Array<{ name: string; state: string }>;
};

export type FacilityCalculationContext = {
  session: NonNullable<Awaited<ReturnType<typeof getSessionFromRequest>>>;
  characterIds: number[];
  corporationPolicies: Awaited<ReturnType<typeof getCorporationSourcePolicies>>;
  roots: Awaited<ReturnType<typeof getRootLocationsByItemId>>;
  corporationSources: Awaited<ReturnType<typeof getCorporationSourceCatalog>>;
  stations: Awaited<ReturnType<typeof getStations>>;
  systems: Awaited<ReturnType<typeof getSystems>>;
  groups: Awaited<ReturnType<typeof getGroups>>;
};

function serviceIsOnline(services: FacilityCandidate["services"], name: string) {
  return (services ?? []).some(
    (service) => service.name.toLowerCase().includes(name) && service.state === "online",
  );
}

function emptyActivities(): ActivitiesResponse {
  return {
    reprocessing: {
      available: false,
    },
    manufacturing: {
      available: false,
      standard: { available: false },
      capital: { available: false },
    },
    reactions: {
      available: false,
      biochemical: { available: false },
      composite: { available: false },
      hybrid: { available: false },
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

/** Builds the session-scoped facility response from refreshed ESI state and saved settings. */
export async function calculateFacilities(
  request: Request,
  settings: FacilitySettingsPayload,
  timing?: TimingScope,
  context?: FacilityCalculationContext,
): Promise<FacilityResponse> {
  const timingScope = timing ?? createTimingScope();
  const markPhase = (name: string) => timingScope.mark(name);
  const requestedLanguage = new URL(request.url).searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const resolvedContext = context ?? (await loadFacilityCalculationContext(request));
  const {
    session,
    characterIds,
    corporationPolicies,
    roots,
    corporationSources,
    stations,
    systems,
    groups,
  } = resolvedContext;
  markPhase("auth");
  const [
    types,
    typeDogma,
    dogmaEffects,
    dogmaAttributes,
    modifierSources,
    targetFilters,
    industrySystems,
  ] = await Promise.all([
    getTypes(),
    getTypeDogma(),
    getDogmaEffects(),
    getDogmaAttributes(),
    getIndustryModifierSources(),
    getIndustryTargetFilters(),
    fetchIndustrySystems().catch(() => ({ data: [] })),
  ]);
  const productionGroups = getProductionGroupReferences(targetFilters, groups, language);
  markPhase("loadDependencies");
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
  const candidates = new Map<number | string, FacilityCandidate>();
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
        id: root.locationId,
        locationId: root.locationId,
        systemId,
        name: root.name
          ? root.kind === "structure"
            ? formatLocationName(systems.get(systemId)?.name.en, root.name)
            : normalizeLocationName(systems.get(systemId)?.name.en, root.name)
          : root.kind === "structure"
            ? "Structure details unavailable"
            : "Station details unavailable",
        typeId: root.typeId,
        rigTypeIds: saved?.rigTypeIds ?? [],
        ...(saved?.services ? { services: saved.services } : {}),
        activities: saved?.activities ?? emptyActivitiesRequest,
        ...(saved?.settingsLastModified === undefined
          ? {}
          : { settingsLastModified: saved.settingsLastModified }),
        locationType: root.kind,
        securityStatus: systems.get(systemId)?.securityStatus,
      },
    );
  }
  for (const source of corporationSources) {
    const root = source.rootLocation;
    if (!root || (root.kind !== "station" && root.kind !== "structure")) continue;
    const systemId =
      root.systemId
      ?? (root.kind === "station" ? stations.get(root.locationId)?.solarSystemID : undefined);
    if (!systemId || candidates.has(root.locationId)) continue;
    const saved = savedByLocationId.get(root.locationId);
    candidates.set(
      root.locationId,
      {
        id: root.locationId,
        locationId: root.locationId,
        systemId,
        name: root.name
          ? root.kind === "structure"
            ? formatLocationName(systems.get(systemId)?.name.en, root.name)
            : normalizeLocationName(systems.get(systemId)?.name.en, root.name)
          : root.kind === "structure"
            ? "Structure details unavailable"
            : "Station details unavailable",
        typeId: root.typeId,
        rigTypeIds: saved?.rigTypeIds ?? [],
        ...(saved?.services ? { services: saved.services } : {}),
        activities: saved?.activities ?? emptyActivitiesRequest,
        ...(saved?.settingsLastModified === undefined
          ? {}
          : { settingsLastModified: saved.settingsLastModified }),
        locationType: root.kind,
        securityStatus: systems.get(systemId)?.securityStatus,
      },
    );
  }
  for (const [settingsKey, facility] of Object.entries(settings.facilities)) {
    const candidateId = facility.locationId ?? settingsKey;
    if (candidates.has(candidateId)) continue;
    candidates.set(
      candidateId,
      {
        ...facility,
        id: candidateId,
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
        id: structure.structure_id,
        locationId: structure.structure_id,
        systemId: structure.system_id,
        name: structure.name
          ? formatLocationName(systems.get(structure.system_id)?.name.en, structure.name)
          : "Structure details unavailable",
        typeId: structure.type_id,
        rigTypeIds: saved?.rigTypeIds ?? [],
        services: structure.services ?? saved?.services,
        activities: saved?.activities ?? emptyActivitiesRequest,
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
      .filter(
        (facility): facility is FacilityCandidate & { locationId: number } =>
          facility.locationType === "station" && facility.locationId !== undefined,
      )
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
    const stationServices =
      facility.locationId === undefined
        ? undefined
        : metadataById.get(facility.locationId)?.data?.services;
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
      facility.securityStatus,
    );
    const groupBonuses = calculateFacilityGroupBonuses(
      typeDogma.get(facility.typeId ?? 0),
      facility.rigTypeIds,
      typeDogma,
      dogmaEffects,
      modifierSources,
      productionGroups,
      facility.securityStatus,
    );
    const reactionSettingsAllowed = supportsReactionSettings(
      facility.typeId,
      facility.securityStatus,
    );
    const activities = emptyActivities();
    const requestActivities = facility.activities;
    activities.reprocessing.available =
      facility.locationType === "structure"
        ? requestActivities.reprocessing.available
        : (services?.some((service) => service.name.toLowerCase().includes("reprocess")) ?? false)
          && requestActivities.reprocessing.available;
    activities.manufacturing.available =
      facility.locationType === "structure"
        ? (serviceIsOnline(services, "manufact") || services === undefined)
          && requestActivities.manufacturing.available
        : serviceIsOnline(services, "factory") && requestActivities.manufacturing.available;
    activities.reactions.available =
      facility.locationType === "structure"
      && reactionSettingsAllowed
      && requestActivities.reactions.available;
    activities.meResearch.available =
      (facility.locationType === "structure" ? true : serviceIsOnline(services, "laboratory"))
      && requestActivities.meResearch.available;
    activities.teResearch.available = activities.meResearch.available;
    activities.invention.available =
      (facility.locationType === "structure" ? true : serviceIsOnline(services, "laboratory"))
      && requestActivities.invention.available;
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
    activities.reprocessing.taxRate = requestActivities.reprocessing.taxRate;
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
    activities.manufacturing.standard = {
      available: activities.manufacturing.available,
      taxRate: requestActivities.manufacturing.standard.taxRate,
    };
    activities.manufacturing.capital = {
      available:
        activities.manufacturing.available && requestActivities.manufacturing.capital.available,
      taxRate: requestActivities.manufacturing.capital.taxRate,
    };
    activities.reactions.biochemical = {
      available:
        activities.reactions.available && requestActivities.reactions.biochemical.available,
      taxRate: requestActivities.reactions.biochemical.taxRate,
    };
    activities.reactions.composite = {
      available: activities.reactions.available && requestActivities.reactions.composite.available,
      taxRate: requestActivities.reactions.composite.taxRate,
    };
    activities.reactions.hybrid = {
      available: activities.reactions.available && requestActivities.reactions.hybrid.available,
      taxRate: requestActivities.reactions.hybrid.taxRate,
    };
    activities.invention.taxRate = requestActivities.invention.taxRate;
    activities.meResearch.taxRate = requestActivities.meResearch.taxRate;
    activities.teResearch.taxRate = requestActivities.teResearch.taxRate;
    return {
      id: facility.id,
      name:
        facility.locationType === "structure"
          ? formatLocationName(
              systems.get(facility.systemId)?.name.en,
              facility.name
                || types.get(facility.typeId ?? 0)?.name.en
                || "Structure details unavailable",
            )
          : normalizeLocationName(
              systems.get(facility.systemId)?.name.en,
              facility.name
                || types.get(facility.typeId ?? 0)?.name.en
                || "Station details unavailable",
            ),
      locationType: facility.locationType,
      typeId: facility.typeId ?? 0,
      systemId: facility.systemId,
      systemName:
        systems.get(facility.systemId)?.name[language] ?? systems.get(facility.systemId)?.name.en,
      sizeId:
        typeDogma
          .get(facility.typeId ?? 0)
          ?.dogmaAttributes.find((attribute) => attribute.attributeID === 1547)?.value ?? 0,
      securityStatus: facility.securityStatus,
      systemCostIndices: Object.fromEntries(systemIndices ?? []),
      activities,
      buildTypeGroups: groupBonuses,
      services: services ?? [],
      rigTypeIds: facility.rigTypeIds,
      settingsLastModified: facility.settingsLastModified ?? settings.lastModified,
    };
  });
  markPhase("calculateFacilities");
  timingScope.complete();
  return { facilities, settings: normalizeFacilitySettings(settings), productionGroups };
}

async function loadFacilityCalculationContext(
  request: Request,
): Promise<FacilityCalculationContext> {
  const session = await getSessionFromRequest(request);
  if (!session) throw new Error("Not authenticated.");
  const characterIds = await getSessionCharacterIds(session);
  const corporationSettings = session.collectionId
    ? await getCollectionCorporationSettings(session.collectionId)
    : [];
  const corporationPolicies = await getCorporationSourcePolicies(
    characterIds,
    corporationSettings,
    session.sessionId,
  );
  const [roots, corporationSources, stations, systems, groups] = await Promise.all([
    getRootLocationsByItemId(characterIds, true, session.sessionId, corporationPolicies),
    getCorporationSourceCatalog(characterIds, corporationPolicies, session.sessionId),
    getStations(),
    getSystems(),
    getGroups(),
  ]);
  return {
    session,
    characterIds,
    corporationPolicies,
    roots,
    corporationSources,
    stations,
    systems,
    groups,
  };
}
