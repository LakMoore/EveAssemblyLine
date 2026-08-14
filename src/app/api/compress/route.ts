import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getCompressibleTypes,
  getDogmaAttributes,
  getGroups,
  getTypeDogma,
  getTypeMaterials,
  getTypes,
} from "@/cache/services/sdeCache";
import { compressMaterials, type CompressionRequestItem } from "@/lib/planning/compressEngine";
import {
  calculateReprocessingEfficiency,
  efficiencyForType,
  reprocessingSkillForType,
} from "@/lib/planning/reprocessingEfficiency";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { getMarketSellOrders, getSevenDayAverageVolume } from "@/lib/esi/marketHistory";
import { marketHubs } from "@/lib/reference/marketHubs";
import type { GroupsRecord, TypesRecord, TypeDogmaRecord } from "@/lib/sde/generated";

// Zod schema for validating the compression request body
const compressionRequestSchema = z.object({
  language: z.string().optional(),
  items: z
    .array(
      z.object({
        typeId: z.number().int().safe().describe("Type ID"),
        quantity: z.number().int().safe().positive().describe("Positive quantity"),
        name: z.string().describe("Type name"),
      }),
    )
    .nonempty("A non-empty list of raw materials is required."),
  structureTypeId: z
    .number()
    .int()
    .safe()
    .nonnegative()
    .optional()
    .default(0)
    .describe("Structure type ID, or 0 for an NPC station"),
  reprocessingRig: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional()
    .default(0)
    .describe("Reprocessing rig level"),
  skillLevels: z
    .record(
      z.string().regex(/^\d+$/, "Skill IDs must be numeric strings"),
      z.number().int().min(0).max(5),
    )
    .refine((obj) => Object.keys(obj).length > 0, "skillLevels must be a non-empty map")
    .describe("Map of skill IDs to levels (0-5)"),
  implantLevel: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)])
    .optional()
    .default(0)
    .describe("Implant level: 0, 1, 2, or 4"),
  securityStatus: z.number().min(-1).max(1).optional().describe("Security status between -1 and 1"),
  marketId: z
    .number()
    .int()
    .refine(
      (id) => marketHubs.some((market) => market.regionId === id),
      "marketId must be a supported market region ID",
    )
    .optional()
    .default(marketHubs[0].regionId)
    .describe("Market region ID"),
  orderType: z
    .enum(["buy-1-day", "buy-5-day", "sell"])
    .optional()
    .describe("Order type for price calculations"),
});

type OreGroupCache = Map<string, { typeIds: number[]; baseTypeIds: number[] }>;
type OreGroupMaps = {
  types: Map<number, TypesRecord>;
  groups: Map<number, GroupsRecord>;
  typeDogma: Map<number, TypeDogmaRecord>;
  dogmaAttributes: Map<number, { _key: number; name: string; defaultValue: number }>;
};
let oreGroupCache: OreGroupCache | undefined;

function getOreGroupCache(maps: OreGroupMaps): OreGroupCache {
  if (oreGroupCache) return oreGroupCache;
  const englishGroups = new Map<string, Array<{ typeId: number; name: string }>>();
  for (const type of maps.types.values()) {
    const name = type.name.en;
    if (
      !type.published
      || name.startsWith("Compressed ")
      || name.startsWith("Batch Compressed ")
      || name.endsWith("-Grade")
    ) continue;
    const skill = reprocessingSkillForType(maps, type._key);
    if (!skill || skill.id === undefined || maps.types.get(skill.id)?.published !== true) continue;
    const key = String(skill.id);
    englishGroups.set(key, [...(englishGroups.get(key) ?? []), { typeId: type._key, name }]);
  }
  oreGroupCache = new Map(
    [...englishGroups].map(([key, entries]) => {
      const byFirstWord = new Map<string, Array<{ typeId: number; name: string }>>();
      for (const entry of entries) {
        const firstWord = entry.name.trim().split(/\s+/, 1)[0];
        byFirstWord.set(firstWord, [...(byFirstWord.get(firstWord) ?? []), entry]);
      }
      return [
        key,
        {
          typeIds: entries.map((entry) => entry.typeId),
          baseTypeIds: [...byFirstWord.values()]
            .filter((family) => family.length === 1)
            .map(([entry]) => entry.typeId),
        },
      ];
    }),
  );
  return oreGroupCache;
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();

    // Parse and validate the request body with Zod
    const validationResult = compressionRequestSchema.safeParse(rawBody);
    if (!validationResult.success) {
      const errorMessages = validationResult.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return `${path || "request"}: ${issue.message}`;
      });
      return NextResponse.json({ error: errorMessages.join(" ") }, { status: 400 });
    }

    const body = validationResult.data;
    const structureTypeId = body.structureTypeId;
    const marketId = body.marketId;
    const orderType = body.orderType;
    const implantLevel = body.implantLevel;
    const reprocessingRig = body.reprocessingRig;
    const skillLevels = body.skillLevels;

    const requestedLanguage = body.language ?? null;
    const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
    const [types, groups, typeDogma, dogmaAttributes, compressibleTypes, typeMaterials] =
      await Promise.all([
        getTypes(),
        getGroups(),
        getTypeDogma(),
        getDogmaAttributes(),
        getCompressibleTypes(),
        getTypeMaterials(),
      ]);
    if (structureTypeId !== 0 && !types.has(structureTypeId)) {
      return NextResponse.json({ error: "Unknown structure type ID." }, { status: 400 });
    }
    const calculatedEfficiency = calculateReprocessingEfficiency(
      { types, groups, typeDogma, dogmaAttributes },
      structureTypeId,
      skillLevels,
      implantLevel,
      body.securityStatus,
      reprocessingRig,
    );
    const names = new Map<number, string>();
    for (const type of types.values()) {
      names.set(type._key, type.name[language] ?? type.name.en);
    }
    const maps = { types, groups, typeDogma, dogmaAttributes };
    const oreGroups = getOreGroupCache(maps);
    const skillTypes = new Map(
      [...oreGroups].map(([key, group]) => [
        key,
        group.typeIds.map((typeId) => ({ typeId, name: names.get(typeId) ?? `Type ${typeId}` })),
      ]),
    );
    const candidateTypeIds = new Set([...compressibleTypes.values(), 15331, 30497]);
    const baseCandidates = [...candidateTypeIds].flatMap((compressedTypeId) => {
      const materialRecord = typeMaterials.get(compressedTypeId);
      const type = types.get(compressedTypeId);
      if (!materialRecord || !type) return [];
      const skill = reprocessingSkillForType(maps, compressedTypeId);
      if (!skill || skill.id === undefined || types.get(skill.id)?.published !== true) return [];
      const yields = new Map(
        (materialRecord.materials ?? []).map((material) => [
          material.materialTypeID,
          material.quantity,
        ]),
      );
      return yields.size > 0
        ? [
            {
              typeId: compressedTypeId,
              name: (names.get(compressedTypeId) ?? `Type ${compressedTypeId}`).replace(
                /^Compressed /,
                "",
              ),
              unitsToReprocess: type.portionSize,
              efficiency: efficiencyForType(
                maps,
                compressedTypeId,
                calculatedEfficiency,
                skillLevels,
              ),
              skill,
              yields,
            },
          ]
        : [];
    });
    const groupName = (name: string) => name.replace(/\s+(?:II|III|IV)-Grade$/, "");
    const candidatesByGroup = new Map<string, typeof baseCandidates>();
    for (const candidate of baseCandidates) {
      const group = groupName(candidate.name);
      candidatesByGroup.set(group, [...(candidatesByGroup.get(group) ?? []), candidate]);
    }
    const baselineYields = new Map<string, Map<number, number>>();
    for (const [group, variants] of candidatesByGroup) {
      const baseline = variants.find((candidate) => candidate.name === group) ?? variants[0];
      baselineYields.set(group, baseline.yields);
    }
    const candidates =
      orderType === "sell"
        ? (
            await Promise.all(
              baseCandidates.map(async (candidate) => {
                if (
                  ![...candidate.yields.keys()].some((typeId) =>
                    body.items.some((item) => item.typeId === typeId),
                  )
                ) return [];
                const baseline = baselineYields.get(groupName(candidate.name));
                const baselineMaterial = baseline
                  ? [...baseline.entries()].find(([, quantity]) => quantity > 0)
                  : undefined;
                const candidateMaterial = baselineMaterial
                  ? candidate.yields.get(baselineMaterial[0])
                  : undefined;
                const multiplier =
                  baselineMaterial && candidateMaterial
                    ? candidateMaterial / baselineMaterial[1]
                    : 1;
                const orders = await getMarketSellOrders(marketId, candidate.typeId).catch(
                  () => [],
                );
                return orders.map((order) => {
                  const yields = new Map(
                    (baseline ?? candidate.yields)
                      .entries()
                      .map(([typeId, quantity]) => [typeId, quantity * multiplier] as const),
                  );
                  return {
                    ...candidate,
                    selectionId: order.orderId,
                    maxRuns: Math.floor(order.volumeRemain / candidate.unitsToReprocess),
                    price: order.price / multiplier,
                    yields,
                  };
                });
              }),
            )
          ).flat()
        : await Promise.all(
            baseCandidates.map(async (candidate) => {
              if (
                ![...candidate.yields.keys()].some((typeId) =>
                  body.items.some((item) => item.typeId === typeId),
                )
              ) return candidate;
              const averageVolume = await getSevenDayAverageVolume(
                marketId,
                candidate.typeId,
              ).catch(() => undefined);
              return averageVolume === undefined
                ? candidate
                : {
                    ...candidate,
                    maxRuns: Math.floor(
                      (averageVolume * (orderType === "buy-5-day" ? 5 : 1))
                        / candidate.unitsToReprocess,
                    ),
                  };
            }),
          );
    const efficiencyGroups = [...skillTypes].map(([key, entries]) => {
      const skillId = /^\d+$/.test(key) ? Number(key) : undefined;
      const skillName =
        skillId === undefined
          ? key
          : (types.get(skillId)?.name[language] ?? types.get(skillId)?.name.en ?? key);
      const candidate = candidates.find(
        (entry) => (entry.skill.id?.toString() ?? entry.skill.name) === key,
      );
      const representativeTypeId = entries[0]?.typeId;
      const groupEfficiency =
        candidate?.efficiency
        ?? efficiencyForType(maps, representativeTypeId, calculatedEfficiency, skillLevels);
      const baseTypeIds = oreGroups.get(key)?.baseTypeIds ?? [];
      return {
        skillId,
        skillName,
        efficiency: groupEfficiency,
        marketCategories: baseTypeIds.map((typeId) => ({
          typeId,
          name: names.get(typeId) ?? `Type ${typeId}`,
        })),
      };
    });
    const averageEfficiency = (groups: typeof efficiencyGroups) =>
      groups.length > 0
        ? groups.reduce((total, group) => total + group.efficiency, 0) / groups.length
        : 0;
    const englishSkillName = (group: (typeof efficiencyGroups)[number]) =>
      group.skillId === undefined ? "" : (types.get(group.skillId)?.name.en ?? "");
    const asteroidGroups = efficiencyGroups.filter(
      (group) => !/moon|ice|gas|scrapmetal/i.test(englishSkillName(group)),
    );
    const moonGroups = efficiencyGroups.filter((group) => /moon/i.test(englishSkillName(group)));
    const iceRate =
      efficiencyGroups.find((group) => /^ice processing$/i.test(englishSkillName(group)))
        ?.efficiency ?? calculatedEfficiency.ice;
    const compressionResult = compressMaterials(body.items, candidates, names);
    const addPackagedVolumes = (items: typeof compressionResult.plan) =>
      items.map((item) => ({
        ...item,
        ...(item.typeId !== undefined && types.get(item.typeId)?.volume !== undefined
          ? {
              packagedVolume:
                types.get(item.typeId)?.packagedVolume ?? types.get(item.typeId)?.volume,
            }
          : {}),
      }));
    return NextResponse.json({
      plan: addPackagedVolumes(compressionResult.plan),
      toBuy: addPackagedVolumes(compressionResult.toBuy),
      surplus: addPackagedVolumes(compressionResult.surplus),
      efficiencies: {
        gas: calculatedEfficiency.gas,
        scrapMetal: calculatedEfficiency.scrapMetal,
        ice: iceRate,
        averageAsteroid: averageEfficiency(asteroidGroups),
        averageMoon: averageEfficiency(moonGroups),
        groups: efficiencyGroups,
      },
    });
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "SDE compression data is unavailable." },
      { status: 503 },
    );
  }
}
