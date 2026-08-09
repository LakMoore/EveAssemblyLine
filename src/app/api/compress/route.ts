import { NextResponse } from "next/server";
import { getCompressibleTypes, getDogmaAttributes, getGroups, getTypeDogma, getTypeMaterials, getTypes } from "@/cache/services/sdeCache";
import { compressMaterials, type CompressionRequestItem } from "@/lib/planning/compressEngine";
import { calculateReprocessingEfficiency, efficiencyForType, reprocessingSkillForType, type ReprocessingStructure } from "@/lib/planning/reprocessingEfficiency";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { language?: string; items?: CompressionRequestItem[]; structure?: ReprocessingStructure; skillLevels?: Record<string, number>; reprocessingSkillLevel?: number; reprocessingEfficiencySkillLevel?: number; implantLevel?: number; securityStatus?: number; rigModifier?: number };
    if (!Array.isArray(body.items) || body.items.length === 0)
      return NextResponse.json({ error: "A non-empty list of raw materials is required." }, { status: 400 });
    if (body.items.some((item) => !Number.isSafeInteger(item.typeId) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || typeof item.name !== "string"))
      return NextResponse.json({ error: "Each material requires a type ID, name, and positive whole quantity." }, { status: 400 });
    const structure = body.structure ?? "NPC";
    const implantLevel = body.implantLevel ?? 0;
    if (structure !== "NPC" && structure !== "Athanor" && structure !== "Tatara")
      return NextResponse.json({ error: "Structure must be NPC, Athanor, or Tatara." }, { status: 400 });
    if (!Number.isInteger(implantLevel) || ![0, 1, 2, 4].includes(implantLevel))
      return NextResponse.json({ error: "Implant level must be 0, 1, 2, or 4." }, { status: 400 });
    if (body.securityStatus !== undefined && (!Number.isFinite(body.securityStatus) || body.securityStatus < -1 || body.securityStatus > 1))
      return NextResponse.json({ error: "Security status must be between -1 and 1." }, { status: 400 });
    const rigModifier = body.rigModifier ?? 0;
    if (!Number.isInteger(rigModifier) || ![0, 1, 3].includes(rigModifier))
      return NextResponse.json({ error: "Rig modifier must be 0, 1, or 3." }, { status: 400 });
    const skillLevels = body.skillLevels ?? {};
    if (Object.values(skillLevels).some((level) => !Number.isInteger(level) || level < 0 || level > 5) || [body.reprocessingSkillLevel, body.reprocessingEfficiencySkillLevel].some((level) => level !== undefined && (!Number.isInteger(level) || level < 0 || level > 5)))
      return NextResponse.json({ error: "Skill levels must be whole numbers from 0 through 5." }, { status: 400 });

    const requestedLanguage = body.language ?? null;
    const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
    const [types, groups, typeDogma, dogmaAttributes, compressibleTypes, typeMaterials] = await Promise.all([getTypes(), getGroups(), getTypeDogma(), getDogmaAttributes(), getCompressibleTypes(), getTypeMaterials()]);
    const reprocessingId = [...types.values()].find((type) => type.name.en === "Reprocessing")?._key;
    const reprocessingEfficiencyId = [...types.values()].find((type) => type.name.en === "Reprocessing Efficiency")?._key;
    const effectiveSkillLevels = { ...skillLevels };
    if (body.reprocessingSkillLevel !== undefined && reprocessingId !== undefined) effectiveSkillLevels[String(reprocessingId)] = body.reprocessingSkillLevel;
    if (body.reprocessingEfficiencySkillLevel !== undefined && reprocessingEfficiencyId !== undefined) effectiveSkillLevels[String(reprocessingEfficiencyId)] = body.reprocessingEfficiencySkillLevel;
    const calculatedEfficiency = calculateReprocessingEfficiency({ types, groups, typeDogma, dogmaAttributes }, structure, effectiveSkillLevels, implantLevel, body.securityStatus, rigModifier);
    const names = new Map<number, string>();
    for (const type of types.values()) names.set(type._key, type.name[language] ?? type.name.en ?? `Type ${type._key}`);
    const maps = { types, groups, typeDogma, dogmaAttributes };
    const skillTypes = new Map<string, Array<{ typeId: number; name: string }>>();
    for (const type of types.values()) {
      const name = type.name[language] ?? type.name.en;
      if (!type.published || name.startsWith("Compressed ") || name.startsWith("Batch Compressed ") || name.endsWith("-Grade")) continue;
      const skill = reprocessingSkillForType(maps, type._key);
      if (!skill || skill.id === undefined || types.get(skill.id)?.published !== true) continue;
      const key = skill.id?.toString() ?? skill.name;
      const entries = skillTypes.get(key) ?? [];
      entries.push({ typeId: type._key, name });
      skillTypes.set(key, entries);
    }
    const baseTypesForSkill = (entries: Array<{ typeId: number; name: string }>) => {
      const byFirstWord = new Map<string, Array<{ typeId: number; name: string }>>();
      for (const entry of entries) {
        const firstWord = entry.name.trim().split(/\s+/, 1)[0];
        const family = byFirstWord.get(firstWord) ?? [];
        family.push(entry);
        byFirstWord.set(firstWord, family);
      }
      return [...byFirstWord.values()]
        .filter((family) => family.length === 1)
        .map(([entry]) => entry);
    };
    const candidates = [...compressibleTypes].flatMap(([, compressedTypeId]) => {
      const materialRecord = typeMaterials.get(compressedTypeId);
      const type = types.get(compressedTypeId);
      if (!materialRecord || !type) return [];
      const skill = reprocessingSkillForType(maps, compressedTypeId);
      if (!skill || skill.id === undefined || types.get(skill.id)?.published !== true) return [];
      const yields = new Map((materialRecord.materials ?? []).map((material) => [material.materialTypeID, material.quantity]));
      return yields.size > 0 ? [{ typeId: compressedTypeId, name: (names.get(compressedTypeId) ?? `Type ${compressedTypeId}`).replace(/^Compressed /, ""), unitsToReprocess: type.portionSize, efficiency: efficiencyForType(maps, compressedTypeId, calculatedEfficiency, effectiveSkillLevels), skill, yields }] : [];
    });
    const efficiencyGroups = [...skillTypes].map(([key, entries]) => {
      const skillId = /^\d+$/.test(key) ? Number(key) : undefined;
      const skillName = skillId === undefined ? key : types.get(skillId)?.name[language] ?? types.get(skillId)?.name.en ?? key;
      const candidate = candidates.find((entry) => (entry.skill.id?.toString() ?? entry.skill.name) === key);
      return { skillId, skillName, efficiency: candidate?.efficiency ?? calculatedEfficiency.normalOre, marketCategories: baseTypesForSkill(entries) };
    });
    return NextResponse.json({
      ...compressMaterials(body.items, candidates, names),
      efficiencies: {
        ...calculatedEfficiency,
        groups: efficiencyGroups,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "SDE compression data is unavailable." }, { status: 503 });
  }
}
