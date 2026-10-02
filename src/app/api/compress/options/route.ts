import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import { getCharacter } from "@/lib/auth/tokensStore";
import { getDogmaAttributes, getTypeDogma, getTypes } from "@/cache/services/sdeCache";
import {
  fetchCharacterClones,
  fetchCharacterImplants,
  getCharacterCloneImplantIds,
} from "@/lib/esi/client";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const optionsRequestSchema = z.object({ language: z.string().optional() }).strict();
const compressOptionsVersion = 4;
const reprocessingImplants = [
  { name: "RX-801", level: 1 },
  { name: "RX-802", level: 2 },
  { name: "RX-804", level: 4 },
] as const;

let relevantSkillIdsPromise: Promise<number[]> | undefined;

/** Returns the SDE skill IDs that can affect reprocessing calculations. */
async function getRelevantSkillIds(
  types: Awaited<ReturnType<typeof getTypes>>,
  typeDogma: Awaited<ReturnType<typeof getTypeDogma>>,
  dogmaAttributes: Awaited<ReturnType<typeof getDogmaAttributes>>,
) {
  relevantSkillIdsPromise
    ??= Promise.resolve().then(() => {
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
      const dogmaSkillIds = [...typeDogma.values()].flatMap((record) =>
        record.dogmaAttributes
          .filter((attribute) => attribute.attributeID === skillAttributeId)
          .map((attribute) => attribute.value),
      );
      return [...new Set([...dogmaSkillIds, ...processingSkillIds])];
    });
  return relevantSkillIdsPromise;
}

/** Builds compression options using session-owned characters and server-side ESI data. */
async function getOptions(request: Request, language: SdeLanguage) {
  const [types, typeDogma, dogmaAttributes] = await Promise.all([
    getTypes(),
    getTypeDogma(),
    getDogmaAttributes(),
  ]);
  const session = await getSessionFromRequest(request);
  const characterIds = session ? await getSessionCharacterIds(session) : [];
  const records = session
    ? (await Promise.all(characterIds.map((id) => getCharacter(id)))).filter(
        (record) => record !== null,
      )
    : [];
  const characterImplants = await Promise.all(
    records.map(async (record) => {
      const [clones, activeImplants] = await Promise.all([
        fetchCharacterClones(record).catch(() => ({ data: null })),
        fetchCharacterImplants(record).catch(() => ({ data: null })),
      ]);
      return {
        characterId: record.characterId,
        implants: [...new Set(getCharacterCloneImplantIds(clones.data, activeImplants.data ?? []))],
      };
    }),
  );
  const implants = reprocessingImplants.map(({ name, level }) => {
    const type = [...types.values()].find((entry) => entry.name.en.endsWith(name));
    return {
      id: type ? `implant:${type._key}` : `implant:${name}`,
      typeId: type?._key,
      name: type?.name[language] ?? type?.name.en ?? name,
      level,
    };
  });
  const knownImplantTypeIds = new Set(
    implants.flatMap((implant) => (implant.typeId === undefined ? [] : [implant.typeId])),
  );
  const cloneImplantIds = [
    ...new Set(characterImplants.flatMap((character) => character.implants)),
  ];
  const cloneImplants = cloneImplantIds
    .filter((typeId) => !knownImplantTypeIds.has(typeId))
    .map((typeId) => ({
      id: `implant:${typeId}`,
      typeId,
      name: types.get(typeId)?.name[language] ?? types.get(typeId)?.name.en ?? `Implant ${typeId}`,
      level: 0,
    }));
  const relevantSkillIds = await getRelevantSkillIds(types, typeDogma, dogmaAttributes);

  return NextResponse.json({
    optionsVersion: compressOptionsVersion,
    characterImplants: Object.fromEntries(
      characterImplants.map((character) => [String(character.characterId), character.implants]),
    ),
    relevantSkillIds,
    implants: [{ id: "none", name: "No implant", level: 0 }, ...implants, ...cloneImplants],
  });
}

/** Returns English compression options for clients that do not provide a language. */
export async function GET(request: Request) {
  return getOptions(request, "en");
}

/** Validates the requested language before returning localized compression options. */
export async function POST(request: Request) {
  try {
    const parsedBody = optionsRequestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Invalid options request." }, { status: 400 });
    }
    const language = parsedBody.data.language ?? "en";
    if (!isSdeLanguage(language)) {
      return NextResponse.json({ error: "Unsupported language." }, { status: 400 });
    }
    return await getOptions(request, language);
  }
  catch {
    return NextResponse.json({ error: "Invalid options request." }, { status: 400 });
  }
}
