import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getBlueprintsByInventionProductId,
  getGroups,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import { getInventionDecryptorModifiers, getNoDecryptorInventionOutput } from "@/lib/sde/invention";
import { inventionSkillsByTypeId } from "@/lib/invention/skills";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const inventionRequestSchema = z.object({
  productTypeId: z.coerce.number().int().positive(),
  language: z.string().optional(),
  skillLevels: z.string().optional(),
  allSkillLevel: z.coerce.number().int().min(1).max(5).optional(),
});

const skillLevelsSchema = z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(5));

/** Decodes a URL-encoded invention skill-level map. */
function parseSkillLevels(serializedLevels: string | undefined) {
  if (!serializedLevels) return {};
  try {
    const parsed: unknown = JSON.parse(serializedLevels);
    const result = skillLevelsSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }
  catch {
    return null;
  }
}

/** Returns SDE invention outcomes and compatible decryptor modifiers for an invented BPC. */
export async function GET(request: Request) {
  const requestData = inventionRequestSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!requestData.success) {
    return NextResponse.json(
      { error: "A valid invented blueprint type ID is required." },
      { status: 400 },
    );
  }

  const requestedLanguage = requestData.data.language ?? null;
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const skillLevels = parseSkillLevels(requestData.data.skillLevels);
  if (!skillLevels) {
    return NextResponse.json(
      { error: "Invention skill levels must be whole numbers from zero to five." },
      { status: 400 },
    );
  }
  try {
    const sourceBlueprints = await getBlueprintsByInventionProductId(
      requestData.data.productTypeId,
    );
    if (sourceBlueprints.length === 0) {
      return NextResponse.json(
        { error: "This type is not an invention blueprint output." },
        { status: 404 },
      );
    }
    const requiredSkills = (sourceBlueprints[0].activities.invention?.skills ?? []).flatMap(
      (skill) => {
        const inventionSkill = inventionSkillsByTypeId.get(skill.typeID);
        if (!inventionSkill) return [];
        const skillLevelKey = String(skill.typeID);
        const characterSkillLevel = Object.hasOwn(skillLevels, skillLevelKey)
          ? skillLevels[skillLevelKey]
          : 0;
        return [
          {
            typeId: skill.typeID,
            ...inventionSkill,
            requiredLevel: skill.level,
            level: requestData.data.allSkillLevel ?? characterSkillLevel,
          },
        ];
      },
    );
    const scienceLevels = requiredSkills
      .filter((skill) => skill.role === "science")
      .reduce((total, skill) => total + skill.level, 0);
    const encryptionLevel = requiredSkills.find((skill) => skill.role === "encryption")?.level ?? 0;
    const skillMultiplier = 1 + scienceLevels / 30 + encryptionLevel / 40;
    const [types, groups, typeDogma] = await Promise.all([getTypes(), getGroups(), getTypeDogma()]);
    const sources = sourceBlueprints.flatMap((sourceBlueprint) => {
      const outcome = getNoDecryptorInventionOutput(
        sourceBlueprint,
        requestData.data.productTypeId,
      );
      if (!outcome) return [];
      const source = types.get(sourceBlueprint._key);
      return [
        {
          typeId: sourceBlueprint._key,
          name: source?.name[language] ?? source?.name.en ?? `Type ${sourceBlueprint._key}`,
          outcome: {
            ...outcome,
            baseProbability: outcome.probability,
            probability: outcome.probability * skillMultiplier,
          },
        },
      ];
    });
    if (sources.length === 0) {
      return NextResponse.json(
        { error: "The invention output could not be decoded." },
        { status: 422 },
      );
    }
    const decryptors = [...typeDogma]
      .flatMap(([typeId, dogma]) => {
        const type = types.get(typeId);
        if (!type) return [];
        const modifiers = getInventionDecryptorModifiers(typeId, dogma);
        const group = groups.get(type.groupID);
        return type.published && group?.name.en === "Generic Decryptor" && modifiers
          ? [{ name: type.name[language] ?? type.name.en, ...modifiers }]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    const product = types.get(requestData.data.productTypeId);
    return NextResponse.json({
      product: {
        typeId: requestData.data.productTypeId,
        name:
          product?.name[language] ?? product?.name.en ?? `Type ${requestData.data.productTypeId}`,
      },
      sources,
      requiredSkills,
      decryptors,
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE invention data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
