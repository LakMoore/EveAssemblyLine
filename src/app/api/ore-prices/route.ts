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
  getRegionalAppraisalPrices,
  selectRegionalAppraisalPrice,
  type RegionalAppraisalPrices,
} from "@/lib/esi/marketHistory";
import { calculateReprocessingProfile } from "@/lib/planning/reprocessingEfficiency";
import { reprocessingProfileSchema } from "@/lib/planning/reprocessingProfile";
import { specialReprocessableTypeIds } from "@/lib/planning/reprocessStock";
import { calculateReprocessingYields } from "@/lib/planning/simulator/reprocessing";
import { marketHubs } from "@/lib/reference/marketHubs";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const orePricesRequestSchema = z
  .object({
    language: z.string().optional(),
    buyMarketId: z
      .enum(marketHubs.map((market) => market.id) as [string, ...string[]])
      .default("jita"),
    buyPriceType: z.enum(["buy", "split", "sell"]).default("sell"),
    sellMarketId: z
      .enum(marketHubs.map((market) => market.id) as [string, ...string[]])
      .default("jita"),
    sellPriceType: z.enum(["buy", "split", "sell"]).default("buy"),
    reprocessingProfile: reprocessingProfileSchema,
  })
  .strict();

const emptyAppraisalPrices: RegionalAppraisalPrices = {
  fivePercentSellPrice: null,
  minSellPrice: null,
  splitPrice: null,
  maxBuyPrice: null,
  fivePercentBuyPrice: null,
};

/** Returns minimum-batch yields for the supplied profile and regional sell appraisals. */
export async function POST(request: Request) {
  const parsed = orePricesRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Provide a supported market and reprocessing profile." },
      { status: 400 },
    );
  }

  const requestedLanguage = parsed.data.language ?? null;
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const buyMarket =
    marketHubs.find((candidate) => candidate.id === parsed.data.buyMarketId) ?? marketHubs[0];
  const sellMarket =
    marketHubs.find((candidate) => candidate.id === parsed.data.sellMarketId) ?? marketHubs[0];
  try {
    const [types, groups, typeDogma, dogmaAttributes, compressibleTypes, typeMaterials] =
      await Promise.all([
        getTypes(),
        getGroups(),
        getTypeDogma(),
        getDogmaAttributes(),
        getCompressibleTypes(),
        getTypeMaterials(),
      ]);
    const compressibleTypeIds = [...new Set(compressibleTypes.values())];
    if (
      parsed.data.reprocessingProfile.structureTypeId !== 0
      && !types.has(parsed.data.reprocessingProfile.structureTypeId)
    ) {
      return NextResponse.json({ error: "Unknown structure type ID." }, { status: 400 });
    }
    const { efficiencies: reprocessingEfficiencies } = calculateReprocessingProfile(
      { types, groups, typeDogma, dogmaAttributes },
      [...compressibleTypeIds, ...specialReprocessableTypeIds],
      parsed.data.reprocessingProfile,
    );
    const missingEfficiencies = compressibleTypeIds.filter(
      (typeId) => !Object.hasOwn(reprocessingEfficiencies, String(typeId)),
    );
    if (missingEfficiencies.length > 0) {
      return NextResponse.json(
        { error: "Reprocessing efficiencies are missing for one or more ore types." },
        { status: 400 },
      );
    }
    const ores = compressibleTypeIds.flatMap((typeId) => {
      const type = types.get(typeId);
      if (!type) return [];

      const sourceMaterials = typeMaterials.get(typeId)?.materials ?? [];
      const reprocessingEfficiency = reprocessingEfficiencies[String(typeId)];
      const quantity = Math.max(1, type.portionSize);
      const yields = calculateReprocessingYields(sourceMaterials, 1, reprocessingEfficiency)
        .filter((material) => material.quantity > 0)
        .map((material) => {
          const materialType = types.get(material.typeId);
          return {
            typeId: material.typeId,
            name:
              materialType?.name[language] ?? materialType?.name.en ?? `Type ${material.typeId}`,
            quantity: material.quantity,
            unitVolume: materialType?.packagedVolume ?? materialType?.volume ?? 0,
          };
        });

      return [
        {
          typeId,
          name: type.name[language] ?? type.name.en,
          quantity,
          unitVolume: type.packagedVolume ?? type.volume ?? 0,
          reprocessingEfficiency,
          reprocessingAvailable: sourceMaterials.length > 0,
          yields,
        },
      ];
    });

    const typeIds = new Set([
      ...ores.map((ore) => ore.typeId),
      ...ores.flatMap((ore) => ore.yields.map((material) => material.typeId)),
    ]);
    const selectedMarkets = [buyMarket];
    if (sellMarket.id !== buyMarket.id) selectedMarkets.push(sellMarket);
    const pricesByMarket = new Map<string, Map<number, RegionalAppraisalPrices>>();
    await Promise.all(
      selectedMarkets.map(async (market) => {
        const appraisalEntries = await Promise.all(
          [...typeIds].map(async (typeId) => {
            const prices = await getRegionalAppraisalPrices(
              market.regionId,
              typeId,
              market.stationId,
            ).catch(() => emptyAppraisalPrices);
            return [typeId, prices] as const;
          }),
        );
        pricesByMarket.set(market.id, new Map(appraisalEntries));
      }),
    );

    const items = ores.map((ore) => {
      const buyPrices = pricesByMarket.get(buyMarket.id)?.get(ore.typeId) ?? emptyAppraisalPrices;
      const oreUnitPrice = selectRegionalAppraisalPrice(buyPrices, parsed.data.buyPriceType);
      const oreCost = oreUnitPrice === null ? null : oreUnitPrice * ore.quantity;
      const materials = ore.yields.map((material) => {
        const sellPrices =
          pricesByMarket.get(sellMarket.id)?.get(material.typeId) ?? emptyAppraisalPrices;
        const unitPrice = selectRegionalAppraisalPrice(sellPrices, parsed.data.sellPriceType);
        return {
          ...material,
          volume: material.unitVolume * material.quantity,
          unitPrice,
          totalValue: unitPrice === null ? null : unitPrice * material.quantity,
        };
      });
      const materialsVolume = materials.reduce((total, material) => total + material.volume, 0);
      const materialsValue =
        ore.reprocessingAvailable && materials.every((material) => material.totalValue !== null)
          ? materials.reduce((total, material) => total + (material.totalValue ?? 0), 0)
          : null;
      const difference =
        oreCost === null || materialsValue === null ? null : materialsValue - oreCost;

      return {
        ...ore,
        oreUnitPrice,
        oreCost,
        oreVolume: ore.unitVolume * ore.quantity,
        materials,
        materialsVolume,
        materialsValue,
        difference,
        differencePercent:
          difference === null || oreCost === null || oreCost === 0
            ? null
            : (difference / oreCost) * 100,
      };
    });

    return NextResponse.json({
      markets: { buy: buyMarket.name, sell: sellMarket.name },
      generatedAt: new Date().toISOString(),
      items,
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Ore price data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
