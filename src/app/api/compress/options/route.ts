import { NextResponse } from "next/server";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import {
  getDogmaAttributes,
  getGroups,
  getStations,
  getSystems,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import {
  fetchCorporationStructures,
  fetchStationMetadata,
  getUsableToken,
  requestCachedEsi,
} from "@/lib/esi/client";
import { calculateReprocessingEfficiency } from "@/lib/planning/reprocessingEfficiency";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

type SuppliedStructure = { id: string; type: number; systemId: number; rigs: number[] };
type AssetLocation = {
  locationId: number;
  name: string;
  locationType: "station" | "structure";
  typeId?: number;
  systemId?: number;
};
type OptionsRequest = {
  language?: string;
  structures?: SuppliedStructure[];
  assetLocations?: AssetLocation[];
  stationIds?: number[];
};

function getEsiStructureId(locationId: string) {
  if (!locationId.startsWith("structure:")) return undefined;
  const structureId = Number(locationId.slice("structure:".length));
  return Number.isSafeInteger(structureId) && structureId > 0 ? structureId : undefined;
}

function suppliedRigLevel(
  typeDogma: Map<number, { dogmaAttributes: Array<{ attributeID: number; value: number }> }>,
  rigTypeIds: number[],
) {
  const multipliers = rigTypeIds.map(
    (typeId) =>
      typeDogma.get(typeId)?.dogmaAttributes.find((attribute) => attribute.attributeID === 717)
        ?.value ?? 0.5,
  );
  const maximumMultiplier = Math.max(...multipliers, 0.5);
  return maximumMultiplier >= 0.53 ? 2 : maximumMultiplier > 0.5 ? 1 : 0;
}

async function getOptions(
  request: Request,
  language: SdeLanguage,
  suppliedStructures: SuppliedStructure[] = [],
  assetLocations: AssetLocation[] = [],
) {
  const startedAt = performance.now();
  let lastPhaseAt = startedAt;
  const phaseDurations: Record<string, number> = {};
  const markPhase = (name: string) => {
    const now = performance.now();
    phaseDurations[name] = Math.round(now - lastPhaseAt);
    lastPhaseAt = now;
  };
  const [types, systems, typeDogma, dogmaAttributes, stations] = await Promise.all([
    getTypes(),
    getSystems(),
    getTypeDogma(),
    getDogmaAttributes(),
    getStations(),
  ]);
  markPhase("sde");
  const stationAssetLocations = assetLocations.filter(
    (location) => location.locationType === "station",
  );
  const stationIds = [...new Set(stationAssetLocations.map((location) => location.locationId))];
  const stationMetadata = await Promise.all(
    stationIds.map((stationId) => fetchStationMetadata(stationId).catch(() => null)),
  );
  const stationMetadataById = new Map(
    stationMetadata.flatMap((metadata, index) => {
      const stationId = stationIds[index];
      return metadata?.data === null || metadata?.data === undefined
        ? []
        : [[stationId, metadata.data] as const];
    }),
  );
  const stationReprocessingById = new Map(
    stationMetadata.flatMap((metadata, index) => {
      const stationId = stationIds[index];
      if (!metadata?.data?.services) return [];
      return [
        [
          stationId,
          metadata.data.services.some(
            (service) => typeof service === "string" && service.toLowerCase().includes("reprocess"),
          ),
        ] as const,
      ];
    }),
  );
  const npcLocations = stationAssetLocations.map((location) => {
    const station = stations.get(location.locationId);
    const metadata = stationMetadataById.get(location.locationId);
    return {
      id: `npc:${location.locationId}`,
      name: metadata?.name ?? location.name,
      structureTypeId: 0,
      ...(stationReprocessingById.has(location.locationId)
        ? { canReprocess: stationReprocessingById.get(location.locationId) }
        : {}),
      securityStatus:
        location.systemId === undefined
          ? systems.get(station?.solarSystemID ?? 0)?.securityStatus
          : systems.get(location.systemId)?.securityStatus,
    };
  });
  markPhase("locations");
  const structureSources = new Map<
    string,
    { assetLocation?: AssetLocation; suppliedStructure?: SuppliedStructure }
  >();
  for (const structure of suppliedStructures) {
    structureSources.set(structure.id, { suppliedStructure: structure });
  }
  for (const location of assetLocations) {
    if (location.locationType !== "structure") continue;
    const id = `structure:${location.locationId}`;
    structureSources.set(id, { ...structureSources.get(id), assetLocation: location });
  }
  const structureLocations = [...structureSources].flatMap(([id, source]) => {
    const structureTypeId = source.assetLocation?.typeId ?? source.suppliedStructure?.type;
    if (structureTypeId === undefined || !types.has(structureTypeId)) return [];
    const systemId = source.assetLocation?.systemId ?? source.suppliedStructure?.systemId;
    const reprocessingRig = source.suppliedStructure
      ? suppliedRigLevel(typeDogma, source.suppliedStructure.rigs)
      : 0;
    return [
      {
        id,
        name:
          source.assetLocation?.name
          ?? types.get(structureTypeId)?.name[language]
          ?? types.get(structureTypeId)?.name.en
          ?? `Structure ${id}`,
        structureTypeId,
        canReprocess: true,
        securityStatus: systemId === undefined ? undefined : systems.get(systemId)?.securityStatus,
        reprocessingRig,
      },
    ];
  });
  const session = await getSessionFromRequest(request);
  const characterIds = session ? await getSessionCharacterIds(session) : [];
  const records = session
    ? (await getCharacters()).filter((record) => characterIds.includes(record.characterId))
    : [];
  markPhase("session");
  const structureAuthorizationScope = "esi-corporations.read_structures.v1";
  const authorizedStructureRecords = records
    .filter(
      (record) =>
        record.corporationId !== undefined
        && (record.hasStationManagerRole || record.hasDirectorRole)
        && record.personalAuth.scopes.includes(structureAuthorizationScope),
    )
    .filter(
      (record, index, authorizedRecords) =>
        authorizedRecords.findIndex((candidate) => candidate.corporationId === record.corporationId)
        === index,
    );
  const corporationStructures = (
    await Promise.all(
      authorizedStructureRecords.map((record) =>
        fetchCorporationStructures(record).catch(() => []),
      ),
    )
  ).flat();
  const structuresById = new Map(
    corporationStructures.map((structure) => [structure.structure_id, structure]),
  );
  const resolvedStructures = await Promise.all(
    structureLocations.map((location) => {
      const structureId = getEsiStructureId(location.id);
      if (structureId === undefined) return location;
      const structure = structuresById.get(structureId);
      if (!structure) return location;
      const canReprocess = (structure.services ?? []).some(
        (service) => service.name.toLowerCase().includes("reprocess") && service.state === "online",
      );
      return { ...location, canReprocess };
    }),
  );
  markPhase("structures");
  const characters = await Promise.all(
    records.map(async (record) => {
      const token = await getUsableToken(record, "personal").catch(() => null);
      const skills = token
        ? await requestCachedEsi<{
            skills?: Array<{ skill_id: number; active_skill_level: number }>;
          }>(`/characters/${record.characterId}/skills/`, token).catch(() => ({ data: null }))
        : { data: null };
      const clones = token
        ? await requestCachedEsi<{
            active_clone_id?: number;
            clones?: Array<{ clone_id: number; implants?: number[] }>;
          }>(`/characters/${record.characterId}/clones/`, token).catch(() => ({ data: null }))
        : { data: null };
      return {
        id: `character:${record.characterId}`,
        characterId: record.characterId,
        name: record.characterName,
        skills: Object.fromEntries(
          (skills.data?.skills ?? []).map((skill) => [skill.skill_id, skill.active_skill_level]),
        ),
        implants: [
          ...new Set(
            (clones.data?.clones ?? []).find(
              (clone) => clone.clone_id === clones.data?.active_clone_id,
            )?.implants ?? [],
          ),
        ],
      };
    }),
  );
  markPhase("characters");
  const implantLevels: Record<string, number> = { "RX-801": 1, "RX-802": 2, "RX-804": 4 };
  const implantNames = ["RX-801", "RX-802", "RX-804"].map((name) => {
    const type = [...types.values()].find((entry) => entry.name.en.endsWith(name));
    return {
      id: type ? `implant:${type._key}` : `implant:${name}`,
      typeId: type?._key,
      name: type?.name[language] ?? type?.name.en ?? name,
      level: implantLevels[name],
    };
  });
  const cloneImplantIds = [...new Set(characters.flatMap((character) => character.implants))];
  const cloneImplants = cloneImplantIds
    .filter((typeId) => !implantNames.some((implant) => implant.typeId === typeId))
    .map((typeId) => ({
      id: `implant:${typeId}`,
      typeId,
      name: types.get(typeId)?.name[language] ?? types.get(typeId)?.name.en ?? `Implant ${typeId}`,
      level: 0,
    }));
  const skillAttributeId = [...dogmaAttributes.values()].find(
    (attribute) => attribute.name === "reprocessingSkillType",
  )?._key;
  const processingSkillIds = [
    "Reprocessing",
    "Reprocessing Efficiency",
    "Gas Decompression Efficiency",
    "Scrapmetal Processing",
  ]
    .map((name) => [...types.values()].find((type) => type.name.en === name)?._key)
    .filter((id): id is number => id !== undefined);
  const scrapMetalSkillId = [...types.values()].find(
    (type) => type.name.en === "Scrapmetal Processing",
  )?._key;
  const relevantSkillIds = [
    ...new Set([
      ...[...typeDogma.values()].flatMap((record) =>
        record.dogmaAttributes
          .filter((attribute) => attribute.attributeID === skillAttributeId)
          .map((attribute) => attribute.value),
      ),
      ...processingSkillIds,
      ...(scrapMetalSkillId === undefined ? [] : [scrapMetalSkillId]),
    ]),
  ];
  const locationRecords = [...npcLocations, ...resolvedStructures];
  const baseYieldMaps = { types, groups: await getGroups(), typeDogma, dogmaAttributes };
  const locations = locationRecords.map((location) => {
    const { structureTypeId, ...locationData } = location;
    return {
      ...locationData,
      structureTypeId,
      baseYield:
        "canReprocess" in location && location.canReprocess === false
          ? 0
          : structureTypeId === 0
            ? 50
            : calculateReprocessingEfficiency(
                baseYieldMaps,
                structureTypeId,
                {},
                0,
                location.securityStatus,
                "reprocessingRig" in location && typeof location.reprocessingRig === "number"
                  ? location.reprocessingRig
                  : 0,
              ).normalOre,
    };
  });
  markPhase("derived");
  const totalMs = Math.round(performance.now() - startedAt);
  const timingHeader = [
    `total;dur=${totalMs}`,
    ...Object.entries(phaseDurations).map(([name, duration]) => `${name};dur=${duration}`),
  ].join(", ");
  console.info(
    "[compress/options] timing",
    {
      totalMs,
      phasesMs: phaseDurations,
      assetLocations: assetLocations.length,
      structures: structureLocations.length,
      corporationStructures: corporationStructures.length,
      authorizedStructureCharacters: authorizedStructureRecords.length,
      characters: records.length,
      suppliedStructures: suppliedStructures.length,
    },
  );
  const response = NextResponse.json({
    locations,
    characters,
    relevantSkillIds,
    implants: [{ id: "none", name: "No implant", level: 0 }, ...implantNames, ...cloneImplants],
  });
  response.headers.set("Server-Timing", timingHeader);
  return response;
}

export async function GET(request: Request) {
  return getOptions(request, "en");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as OptionsRequest;
    const requestedLanguage = body.language ?? null;
    const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
    if (
      body.structures !== undefined
      && (
        !Array.isArray(body.structures)
        || body.structures.some(
          (structure) =>
            typeof structure.id !== "string"
            || !Number.isInteger(structure.type)
            || !Number.isSafeInteger(structure.systemId)
            || structure.systemId <= 0
            || !Array.isArray(structure.rigs)
            || structure.rigs.some((rig) => !Number.isInteger(rig) || rig < 0),
        )
      )
    ) {
      return NextResponse.json(
        { error: "structures must be a valid structure list." },
        { status: 400 },
      );
    }
    if (
      body.assetLocations !== undefined
      && (
        !Array.isArray(body.assetLocations)
        || body.assetLocations.some(
          (location) =>
            !Number.isSafeInteger(location.locationId)
            || typeof location.name !== "string"
            || (location.typeId !== undefined && !Number.isSafeInteger(location.typeId))
            || (location.systemId !== undefined && !Number.isSafeInteger(location.systemId)),
        )
      )
    ) {
      return NextResponse.json(
        { error: "assetLocations must be a valid location list." },
        { status: 400 },
      );
    }
    return await getOptions(request, language, body.structures ?? [], body.assetLocations ?? []);
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid options request." },
      { status: 400 },
    );
  }
}
