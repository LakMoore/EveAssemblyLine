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
import { requestEsi, fetchLocationMetadata, getUsableToken } from "@/lib/esi/client";
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
};
const structureServiceCache = new Map<number, { canReprocess: boolean; expiresAt: number }>();
const structureServiceCacheTtlMs = 6 * 60 * 60 * 1000;

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
  markPhase("locations");
  const npcLocations = assetLocations
    .filter((location) => location.locationType === "station")
    .map((location) => ({
      id: `npc:${location.locationId}`,
      name: location.name,
      structure: "NPC" as const,
      canReprocess: (stations.get(location.locationId)?.reprocessingEfficiency ?? 0) > 0,
      securityStatus:
        location.systemId === undefined
          ? undefined
          : systems.get(location.systemId)?.securityStatus,
    }));
  const assetStructures = assetLocations
    .filter((location) => location.locationType === "structure")
    .map((location) => {
      const typeName =
        location.typeId === undefined ? undefined : types.get(location.typeId)?.name.en;
      if (!typeName) return null;
      const suppliedStructure = suppliedStructures.find(
        (structure) => structure.id === `structure:${location.locationId}`,
      );
      return {
        id: `structure:${location.locationId}`,
        name: location.name,
        structureTypeId: location.typeId,
        structure: typeName as "NPC" | "Athanor" | "Tatara",
        canReprocess: typeName === "Athanor" || typeName === "Tatara" ? undefined : false,
        securityStatus:
          location.systemId === undefined
            ? undefined
            : systems.get(location.systemId)?.securityStatus,
        ...(suppliedStructure
          ? { reprocessingRig: suppliedRigLevel(typeDogma, suppliedStructure.rigs) }
          : {}),
      } as const;
    })
    .filter((location): location is NonNullable<typeof location> => location !== null);
  const session = await getSessionFromRequest(request);
  const characterIds = session ? await getSessionCharacterIds(session) : [];
  const records = session
    ? (await getCharacters()).filter((record) => characterIds.includes(record.characterId))
    : [];
  markPhase("session");
  const now = Date.now();
  const uncachedStructures = assetStructures.filter((location) => {
    const cached = structureServiceCache.get(Number(location.id.slice("structure:".length)));
    return cached === undefined || cached.expiresAt <= now;
  });
  const structureTokens =
    uncachedStructures.length === 0
      ? []
      : (
          await Promise.all(
            records.map((record) => getUsableToken(record, "personal").catch(() => null)),
          )
        ).filter((token): token is NonNullable<typeof token> => token !== null);
  const resolvedStructures = await Promise.all(
    assetStructures.map(async (location) => {
      const structureId = Number(location.id.slice("structure:".length));
      const cached = structureServiceCache.get(structureId);
      if (cached && cached.expiresAt > now) {
        return { ...location, canReprocess: cached.canReprocess };
      }
      const metadata = await Promise.all(
        structureTokens.map((token) =>
          fetchLocationMetadata(
            Number(location.id.slice("structure:".length)),
            "structure",
            token,
          ).catch(() => null),
        ),
      );
      const structure = metadata.find((entry) => entry?.data)?.data;
      if (!structure?.services) return location;
      const canReprocess = structure.services.some(
        (service) => service.name.toLowerCase().includes("reprocess") && service.state === "online",
      );
      structureServiceCache.set(
        structureId,
        {
          canReprocess,
          expiresAt: now + structureServiceCacheTtlMs,
        },
      );
      return { ...location, canReprocess };
    }),
  );
  markPhase("structures");
  const characters = await Promise.all(
    records.map(async (record) => {
      const token = await getUsableToken(record, "personal").catch(() => null);
      const skills = token
        ? await requestEsi<{ skills?: Array<{ skill_id: number; active_skill_level: number }> }>(
            `/characters/${record.characterId}/skills/`,
            token,
          ).catch(() => ({ data: null }))
        : { data: null };
      const clones = token
        ? await requestEsi<{
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
  const suppliedLocations = suppliedStructures
    .filter((structure) => structure.type === 35835 || structure.type === 35836)
    .map((structure) => {
      const securityStatus = systems.get(structure.systemId)?.securityStatus;
      if (securityStatus === undefined) throw new Error(`Unknown system ID ${structure.systemId}.`);
      return {
        id: structure.id,
        structureTypeId: structure.type,
        structure: structure.type === 35835 ? ("Athanor" as const) : ("Tatara" as const),
        securityStatus,
        reprocessingRig: suppliedRigLevel(typeDogma, structure.rigs),
      };
    });
  const locationRecords = [...npcLocations, ...resolvedStructures, ...suppliedLocations];
  const baseYieldMaps = { types, groups: await getGroups(), typeDogma, dogmaAttributes };
  const locations = locationRecords.map((location) => {
    const { structure: structureType, ...locationData } = location;
    return {
      ...locationData,
      structureType,
      baseYield:
        structureType === "NPC"
          ? 50
          : calculateReprocessingEfficiency(
              baseYieldMaps,
              structureType,
              {},
              0,
              location.securityStatus,
              "reprocessingRig" in location ? location.reprocessingRig : 0,
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
      structures: assetStructures.length,
      structureTokens: structureTokens.length,
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
