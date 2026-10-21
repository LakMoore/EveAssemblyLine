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
import {
  compressMaterials,
  CompressionSolveError,
  maximumDemandRuns,
  type CompressionResultItem,
} from "@/lib/planning/compressEngine";
import {
  calculateReprocessingProfile,
  efficiencyForType,
  reprocessingSkillForType,
} from "@/lib/planning/reprocessingEfficiency";
import { reprocessingProfileSchema } from "@/lib/planning/reprocessingProfile";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import {
  calculateRegionalAppraisalPrices,
  getRegionalMarketOrders,
  getSevenDayAverageVolume,
} from "@/lib/esi/marketHistory";
import { globalPlexMarket, marketHubs } from "@/lib/reference/marketHubs";
import { specialReprocessableTypeIds } from "@/lib/planning/reprocessStock";
import type { GroupsRecord, TypesRecord, TypeDogmaRecord } from "@/lib/sde/generated";

// Zod schema for validating the compression request body
const compressionRequestSchema = z
  .object({
    language: z.string().optional(),
    items: z
      .array(
        z
          .object({
            typeId: z.number().int().describe("Type ID"),
            quantity: z.number().int().positive().describe("Positive quantity"),
            name: z.string().describe("Type name"),
          })
          .strict(),
      )
      .nonempty("A non-empty list of raw materials is required."),
    reprocessingProfile: reprocessingProfileSchema,
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
  })
  .strict();

type OreGroupCache = Map<string, { typeIds: number[]; baseTypeIds: number[] }>;
type OreGroupMaps = {
  types: Map<number, TypesRecord>;
  groups: Map<number, GroupsRecord>;
  typeDogma: Map<number, TypeDogmaRecord>;
  dogmaAttributes: Map<number, { _key: number; name: string; defaultValue: number }>;
};
type MarketCandidate = {
  typeId: number;
  price?: number;
  unitsToReprocess: number;
  efficiency: number;
  yields: ReadonlyMap<number, number>;
  packagedVolume?: number;
  maxRuns?: number;
};
type AppraisedCompressionItem = CompressionResultItem & {
  sellPrice: number | null;
  sellTotal: number | null;
};
let oreGroupCache: OreGroupCache | undefined;

/** Combines same-price lots and drops tiers too expensive to be reached within the cargo cap. */
function compactSellOrders<Candidate extends MarketCandidate>(
  orders: Candidate[],
  originalVolume: number,
  required: ReadonlyMap<number, number>,
): Candidate[] {
  const byType = new Map<number, Candidate[]>();
  for (const order of orders) {
    const group = byType.get(order.typeId) ?? [];
    group.push(order);
    byType.set(order.typeId, group);
  }
  return [...byType.values()].flatMap((group) => {
    const priced = group
      .filter(
        (candidate): candidate is Candidate & { price: number; maxRuns: number } =>
          candidate.price !== undefined && candidate.maxRuns !== undefined && candidate.maxRuns > 0,
      )
      .sort((left, right) => left.price - right.price);
    const volumePerRun = (group[0]?.packagedVolume ?? 0) * (group[0]?.unitsToReprocess ?? 0);
    if (volumePerRun <= 0) return [];
    const tiers = new Map<number, Candidate & { price: number; maxRuns: number }>();
    for (const candidate of priced) {
      const previous = tiers.get(candidate.price);
      tiers.set(
        candidate.price,
        {
          ...candidate,
          maxRuns: (previous?.maxRuns ?? 0) + candidate.maxRuns,
        },
      );
    }
    // No plan can use more of one ore than fits in the uncompressed input cargo.
    const maxUsefulRuns = Math.min(
      Math.floor(originalVolume / volumePerRun),
      maximumDemandRuns(group[0], required),
    );
    let capacity = 0;
    return [...tiers.values()].filter((tier) => {
      if (capacity >= maxUsefulRuns) return false;
      capacity += tier.maxRuns;
      return true;
    });
  });
}

/** Appraises rows with the acquisition price or realizable bid used by the solve. */
function addAppraisals(
  items: readonly CompressionResultItem[],
  pricesByTypeId: ReadonlyMap<number, number | null>,
): AppraisedCompressionItem[] {
  return items.map((item) => {
    const sellPrice = item.typeId === undefined ? null : (pricesByTypeId.get(item.typeId) ?? null);
    return {
      ...item,
      sellPrice,
      sellTotal: sellPrice === null ? null : sellPrice * item.quantity,
    };
  });
}

/** Returns a complete sell value only when every row has a current sell price. */
function sumSellOrderValues(items: readonly AppraisedCompressionItem[]) {
  if (items.some((item) => item.sellTotal === null)) return null;
  return items.reduce((total, item) => total + (item.sellTotal ?? 0), 0);
}

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
    const rawBody: unknown = await request.json();

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
    const marketId = body.marketId;
    const orderType = body.orderType;
    const selectedMarket =
      marketHubs.find((market) => market.regionId === marketId) ?? marketHubs[0];

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
    if (
      body.reprocessingProfile.structureTypeId !== 0
      && !types.has(body.reprocessingProfile.structureTypeId)
    ) {
      return NextResponse.json({ error: "Unknown structure type ID." }, { status: 400 });
    }
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
    const candidateTypeIds = new Set([
      ...compressibleTypes.values(),
      ...specialReprocessableTypeIds,
    ]);
    const { calculated: calculatedEfficiency, efficiencies } = calculateReprocessingProfile(
      maps,
      candidateTypeIds,
      body.reprocessingProfile,
    );
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
              efficiency: efficiencies[String(compressedTypeId)],
              packagedVolume: type.packagedVolume ?? type.volume,
              skill,
              yields,
            },
          ]
        : [];
    });
    const requestedTypeIds = new Set(body.items.map((item) => item.typeId));
    const relevantCandidates = baseCandidates.filter(
      (candidate) =>
        !candidate.name.startsWith("Batch Compressed ")
        && [...candidate.yields.keys()].some((typeId) => requestedTypeIds.has(typeId)),
    );
    const supportedTypeIds = new Set(
      relevantCandidates.flatMap((candidate) => [...candidate.yields.keys()]),
    );
    const required = new Map<number, number>();
    for (const item of body.items) {
      if (supportedTypeIds.has(item.typeId)) {
        required.set(item.typeId, (required.get(item.typeId) ?? 0) + item.quantity);
      }
    }
    const marketTypeIds = new Set([
      ...requestedTypeIds,
      ...relevantCandidates.map((candidate) => candidate.typeId),
      ...relevantCandidates.flatMap((candidate) => [...candidate.yields.keys()]),
    ]);
    const [marketOrders, marketVolumes] = await Promise.all([
      Promise
        .all(
          [...marketTypeIds].map(
            async (typeId) =>
              [typeId, await getRegionalMarketOrders(marketId, typeId).catch(() => null)] as const,
          ),
        )
        .then((entries) => new Map(entries)),
      Promise
        .all(
          orderType === "sell"
            ? []
            : relevantCandidates.map(
                async (candidate) =>
                  [
                    candidate.typeId,
                    await getSevenDayAverageVolume(marketId, candidate.typeId).catch(
                      () => undefined,
                    ),
                  ] as const,
              ),
        )
        .then((entries) => new Map(entries)),
    ]);
    const marketPrices = new Map(
      [...marketOrders].map(
        ([typeId, orders]) =>
          [
            typeId,
            orders === null
              ? null
              : calculateRegionalAppraisalPrices(
                  orders,
                  typeId === globalPlexMarket.typeId ? undefined : selectedMarket.stationId,
                ),
          ] as const,
      ),
    );
    const candidates =
      orderType === "sell"
        ? compactSellOrders(
            relevantCandidates.flatMap((candidate) =>
              (marketOrders.get(candidate.typeId) ?? [])
                .filter(
                  (order) =>
                    !order.isBuyOrder
                    && order.volumeRemain > 0
                    && order.locationId === selectedMarket.stationId,
                )
                .map((order) => ({
                  ...candidate,
                  selectionId: order.orderId,
                  maxRuns: Math.floor(order.volumeRemain / candidate.unitsToReprocess),
                  price: order.price,
                })),
            ),
            [...required].reduce(
              (total, [typeId, quantity]) => {
                const type = types.get(typeId);
                return total + quantity * (type?.packagedVolume ?? type?.volume ?? 0);
              },
              0,
            ),
            required,
          )
        : relevantCandidates.map((candidate) => {
            const averageVolume = marketVolumes.get(candidate.typeId);
            return averageVolume === undefined
              ? candidate
              : {
                  ...candidate,
                  maxRuns: Math.floor(
                    (averageVolume * (orderType === "buy-5-day" ? 5 : 1))
                      / candidate.unitsToReprocess,
                  ),
                };
          });
    const efficiencyGroups = [...skillTypes].map(([key, entries]) => {
      const skillId = /^\d+$/.test(key) ? Number(key) : undefined;
      const skillName =
        skillId === undefined
          ? key
          : (types.get(skillId)?.name[language] ?? types.get(skillId)?.name.en ?? key);
      const candidate = baseCandidates.find(
        (entry) => (entry.skill.id?.toString() ?? entry.skill.name) === key,
      );
      const representativeTypeId = entries[0]?.typeId;
      const groupEfficiency =
        candidate?.efficiency
        ?? efficiencyForType(
          maps,
          representativeTypeId,
          calculatedEfficiency,
          body.reprocessingProfile.skillLevels,
        );
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
    const pricedCandidates = candidates.map((candidate) => ({
      ...candidate,
      price:
        orderType === "sell"
          ? "price" in candidate && typeof candidate.price === "number"
            ? candidate.price
            : undefined
          : (marketPrices.get(candidate.typeId)?.maxBuyPrice ?? undefined),
    }));
    const volumes = new Map(
      [...types].flatMap(([typeId, type]) => {
        const volume = type.packagedVolume ?? type.volume;
        return volume === undefined ? [] : [[typeId, volume] as const];
      }),
    );
    const surplusOrders = new Map(
      [...new Set(pricedCandidates.flatMap((candidate) => [...candidate.yields.keys()]))].map(
        (typeId) => {
          const grouped = new Map<number, number>();
          for (const order of marketOrders.get(typeId) ?? []) {
            if (!order.isBuyOrder || order.locationId !== selectedMarket.stationId) continue;
            if (order.volumeRemain <= 0 || order.price <= 0) continue;
            grouped.set(order.price, (grouped.get(order.price) ?? 0) + order.volumeRemain);
          }
          return [
            typeId,
            [...grouped]
              .map(([price, volumeRemain]) => ({ price, volumeRemain }))
              .sort((left, right) => right.price - left.price),
          ] as const;
        },
      ),
    );
    const compressionResult = await compressMaterials(
      body.items,
      pricedCandidates,
      names,
      {
        volumes,
        buyPrices: new Map(
          [...marketPrices].flatMap(([typeId, prices]) =>
            prices?.minSellPrice === null || !prices
              ? []
              : [[typeId, prices.minSellPrice] as const],
          ),
        ),
        surplusOrders,
      },
      supportedTypeIds,
    );
    const appraisedPlan = addAppraisals(
      compressionResult.plan,
      new Map([...marketPrices].map(([typeId, prices]) => [typeId, prices?.minSellPrice ?? null])),
    );
    const toBuyPrices = new Map<number, number | null>(compressionResult.purchasePrices);
    for (const item of compressionResult.toBuy) {
      if (item.ignored && item.typeId !== undefined) {
        toBuyPrices.set(item.typeId, marketPrices.get(item.typeId)?.minSellPrice ?? null);
      }
    }
    const appraisedToBuy = addAppraisals(compressionResult.toBuy, toBuyPrices);
    const appraisedSurplus = addAppraisals(
      compressionResult.surplus,
      new Map(
        compressionResult.surplus.flatMap((item) =>
          item.typeId === undefined
            ? []
            : [
                [
                  item.typeId,
                  (compressionResult.surplusCredits.get(item.typeId) ?? 0) / item.quantity,
                ] as const,
              ],
        ),
      ),
    );
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
      marketName: selectedMarket.name,
      metrics: compressionResult.metrics,
      plan: addPackagedVolumes(appraisedPlan),
      toBuy: addPackagedVolumes(appraisedToBuy),
      surplus: addPackagedVolumes(appraisedSurplus),
      appraisal: {
        planTotal: sumSellOrderValues(appraisedPlan),
        toBuyTotal: sumSellOrderValues(appraisedToBuy),
        surplusTotal: sumSellOrderValues(appraisedSurplus),
      },
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
    if (error instanceof CompressionSolveError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "SDE compression data is unavailable." },
      { status: 503 },
    );
  }
}
