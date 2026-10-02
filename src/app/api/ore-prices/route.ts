import { NextResponse } from "next/server";
import { z } from "zod";
import { getCompressibleTypes, getTypeMaterials, getTypes } from "@/cache/services/sdeCache";
import { getRegionalAppraisalPrices, type RegionalAppraisalPrices } from "@/lib/esi/marketHistory";
import { calculateReprocessingYields } from "@/lib/planning/simulator/reprocessing";
import { marketHubs } from "@/lib/reference/marketHubs";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const orePricesRequestSchema = z.object({
  language: z.string().optional(),
  marketId: z.enum(marketHubs.map((market) => market.id) as [string, ...string[]]).default("jita"),
  reprocessingEfficiencies: z.record(
    z.string().regex(/^\d+$/),
    z.number().finite().min(0).max(150),
  ),
});

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
      { error: "Provide a supported market and calculated reprocessing efficiencies." },
      { status: 400 },
    );
  }

  const requestedLanguage = parsed.data.language ?? null;
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const market =
    marketHubs.find((candidate) => candidate.id === parsed.data.marketId) ?? marketHubs[0];
  try {
    const [types, compressibleTypes, typeMaterials] = await Promise.all([
      getTypes(),
      getCompressibleTypes(),
      getTypeMaterials(),
    ]);
    const compressibleTypeIds = [...new Set(compressibleTypes.values())];
    const missingEfficiencies = compressibleTypeIds.filter(
      (typeId) => !Object.hasOwn(parsed.data.reprocessingEfficiencies, String(typeId)),
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
      const reprocessingEfficiency = parsed.data.reprocessingEfficiencies[String(typeId)];
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
    const pricesByTypeId = new Map(appraisalEntries);

    const items = ores.map((ore) => {
      const oreUnitPrice = pricesByTypeId.get(ore.typeId)?.minSellPrice ?? null;
      const oreCost = oreUnitPrice === null ? null : oreUnitPrice * ore.quantity;
      const materials = ore.yields.map((material) => {
        const unitPrice = pricesByTypeId.get(material.typeId)?.minSellPrice ?? null;
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
      market: market.name,
      generatedAt: new Date().toISOString(),
      items,
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Ore price data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
