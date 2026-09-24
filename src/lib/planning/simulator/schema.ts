import { z } from "zod";
import type { SimulationRequestV1 } from "./types";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const percentage = z.number().finite().min(0).max(100);
const multiplier = z.number().finite().positive().max(10);
const defaultSimulationPolicy = {
  inventionExpectedOutputFactor: 1.2,
  fallbackInventionSkillLevel: 3,
  decryptorTypeIdByProductBlueprintTypeId: {},
  maxGraphNodes: 10000,
  maxGraphDepth: 100,
} as const;
const defaultSimulationOptions = {
  version: 1 as const,
  simulateSurplus: false,
  blockInterStockpileHauling: false,
  haulingAllocationMode: "local-first" as const,
  characters: [],
  scienceProfiles: [],
  policy: defaultSimulationPolicy,
};

const ownerSchema = z
  .object({
    ownerType: z.enum(["character", "corporation"]).optional(),
    ownerId: positiveSafeInteger.optional(),
  })
  .superRefine((owner, context) => {
    if ((owner.ownerType === undefined) !== (owner.ownerId === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Owner type and owner ID must be provided together.",
      });
    }
  });

const blueprintPrintSchema = z
  .object({
    itemId: positiveSafeInteger,
    runs: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    type: z.enum(["bpc", "bpo"]),
    me: percentage.optional(),
    te: percentage.optional(),
    activity: z.string().max(100).optional(),
  })
  .superRefine((blueprint, context) => {
    if (blueprint.type === "bpc" && blueprint.runs < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runs"],
        message: "BPC runs must be a nonnegative integer.",
      });
    }
  });

const planStockItemSchema = z
  .object({
    typeId: positiveSafeInteger,
    quantity: nonNegativeInteger,
    locationId: positiveSafeInteger.optional(),
    rootLocationId: positiveSafeInteger.optional(),
    sourceLocationId: positiveSafeInteger.optional(),
    sourceLocationName: z.string().max(500).optional(),
    sourceSystemId: positiveSafeInteger.optional(),
    blueprintPrints: z.array(blueprintPrintSchema).max(10000).optional(),
    inBuildQuantity: nonNegativeInteger.optional(),
    futureReprocessingOutput: z.boolean().optional(),
    source: z.literal("marketOrder").optional(),
    inBuild: z.boolean().optional(),
    inUse: z.boolean().optional(),
    jobId: positiveSafeInteger.optional(),
    industryJobStatus: z
      .enum(["active", "cancelled", "delivered", "paused", "ready", "reverted"])
      .optional(),
    industryJobEndDate: z.string().max(100).optional(),
    blueprintRunsAtInstall: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
    licensedRuns: nonNegativeInteger.optional(),
    activityName: z.string().max(100).optional(),
    jobRuns: nonNegativeInteger.optional(),
    me: percentage.optional(),
    te: percentage.optional(),
  })
  .and(ownerSchema);

const categorizedItemSchema = z.object({
  typeId: positiveSafeInteger,
  quantity: nonNegativeInteger,
  locationId: positiveSafeInteger,
  rootLocationId: positiveSafeInteger,
});

const categorizedBlueprintSchema = categorizedItemSchema.extend({
  itemId: positiveSafeInteger.optional(),
  type: z.enum(["bpc", "bpo"]),
  runs: nonNegativeInteger,
  me: percentage.optional(),
  te: percentage.optional(),
});

const categorizedIndustrySchema = categorizedItemSchema.extend({
  jobId: positiveSafeInteger,
  blueprintId: positiveSafeInteger.optional(),
  runs: nonNegativeInteger,
  activity: z.string().min(1).max(100),
  status: z.enum(["active", "cancelled", "delivered", "paused", "ready", "reverted"]).optional(),
  blueprintTypeId: positiveSafeInteger.optional(),
  blueprintRunsAtInstall: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
  licensedRuns: nonNegativeInteger.optional(),
  installedRuns: nonNegativeInteger.optional(),
});

const buildItemSchema = z.object({
  typeId: positiveSafeInteger,
  quantity: positiveSafeInteger,
  me: percentage.max(10),
  te: percentage.max(20),
  fromCompression: z.boolean(),
});

const locationsSchema = z.object({
  stock: positiveSafeInteger,
  manufacturing: positiveSafeInteger,
  reactions: positiveSafeInteger,
  reprocessing: positiveSafeInteger,
  copying: positiveSafeInteger,
  invention: positiveSafeInteger,
});

const groupAssignmentsSchema = z.record(z.string().min(1), positiveSafeInteger);

const stockpileSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["standard", "special"]).optional(),
  stockLocationName: z.string().max(500).optional(),
  locations: locationsSchema,
  groupAssignments: groupAssignmentsSchema.optional(),
  reprocessingEfficiencies: z.record(z.string().regex(/^\d+$/), percentage).optional(),
  items: z.array(buildItemSchema).max(10000),
});

const facilityBonusSchema = z.object({
  manufacturingMaterialMultiplier: z.number().finite().min(0).max(2),
  manufacturingMaterialPercentage: z.number().finite().min(-100).max(100),
  manufacturingTimeMultiplier: z.number().finite().min(0).max(2),
  manufacturingTimePercentage: z.number().finite().min(-100).max(100),
  reactionMaterialMultiplier: z.number().finite().min(0).max(2),
  reactionMaterialPercentage: z.number().finite().min(-100).max(100),
  reactionTimeMultiplier: z.number().finite().min(0).max(2),
  reactionTimePercentage: z.number().finite().min(-100).max(100),
});

const simulationSchema = z
  .object({
    version: z.literal(1).default(1),
    simulateSurplus: z.boolean().default(false),
    blockInterStockpileHauling: z.boolean().default(false),
    haulingAllocationMode: z.enum(["greedy", "local-first"]).default("local-first"),
    characters: z
      .array(
        z.object({
          characterId: positiveSafeInteger,
          freeSlots: z.object({
            manufacturing: nonNegativeInteger,
            reactions: nonNegativeInteger,
            science: nonNegativeInteger,
          }),
          timeMultipliers: z.object({
            manufacturing: multiplier,
            reactions: multiplier,
            copying: multiplier,
            invention: multiplier,
          }),
          skillLevels: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(5)),
        }),
      )
      .max(100)
      .default([]),
    scienceProfiles: z
      .array(
        z.object({
          locationId: positiveSafeInteger,
          copyingDurationMultiplier: multiplier,
          copyingMaterialMultiplier: multiplier,
          inventionDurationMultiplier: multiplier,
          inventionMaterialMultiplier: multiplier,
        }),
      )
      .max(500)
      .default([]),
    policy: z
      .object({
        inventionExpectedOutputFactor: z.number().finite().min(1).max(10).default(1.2),
        fallbackInventionSkillLevel: z.number().int().min(0).max(5).default(3),
        decryptorTypeIdByProductBlueprintTypeId: z
          .record(z.string().regex(/^\d+$/), positiveSafeInteger)
          .default({}),
        maxGraphNodes: z.number().int().min(1).max(100000).default(10000),
        maxGraphDepth: z.number().int().min(1).max(1000).default(100),
      })
      .default(defaultSimulationPolicy),
  })
  .default(defaultSimulationOptions);

/** Strict runtime schema for the version-one simulator request. */
export const simulatorRequestSchema = z
  .object({
    language: z.enum(["de", "en", "es", "fr", "ja", "ko", "ru", "zh"]).optional(),
    stockpiles: z.array(stockpileSchema).min(1).max(100),
    assets: z
      .union([
        z.array(planStockItemSchema).max(100000),
        z.object({
          items: z.array(categorizedItemSchema).max(100000),
          blueprints: z.array(categorizedBlueprintSchema).max(100000),
          industry: z.array(categorizedIndustrySchema).max(100000),
          market: z.array(categorizedItemSchema).max(100000),
        }),
      ])
      .optional(),
    reprocessingEfficiencies: z.record(z.string().regex(/^\d+$/), percentage).optional(),
    facilityTimeMultipliers: z
      .object({ manufacturing: multiplier, reactions: multiplier })
      .optional(),
    facilityProfiles: z
      .array(
        z.object({
          locationId: positiveSafeInteger,
          sizeId: z.number().finite().nonnegative(),
          buildTypeGroups: z.record(z.string(), facilityBonusSchema),
        }),
      )
      .max(500)
      .optional(),
    skillTimeMultipliers: z.object({ manufacturing: multiplier, reactions: multiplier }).optional(),
    haulExclusions: z
      .array(
        z.object({
          typeId: positiveSafeInteger,
          fromLocationId: positiveSafeInteger,
          toLocationId: positiveSafeInteger,
        }),
      )
      .max(5000)
      .optional(),
    settings: z.object({
      includeCorporationAssets: z.boolean(),
      personalSellOrdersAsStock: z.boolean(),
      allCorporationSellOrdersAsStock: z.boolean(),
      myCorporationSellOrdersAsStock: z.boolean(),
      buildBlacklist: z.array(positiveSafeInteger).max(100000),
      buyBlacklist: z.array(positiveSafeInteger).max(100000),
      fallbackT1Me: percentage.max(10).optional(),
      fallbackT1Te: percentage.max(20).optional(),
      fallbackT2OrT3Me: percentage.max(10).optional(),
      fallbackT2OrT3Te: percentage.max(20).optional(),
    }),
    simulation: simulationSchema,
  })
  .superRefine((request, context) => {
    const buyBlacklist = new Set(request.settings.buyBlacklist);
    for (const typeId of request.settings.buildBlacklist) {
      if (buyBlacklist.has(typeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["settings", "buildBlacklist"],
          message: `Type ${typeId} cannot be present in both build and buy blacklists.`,
        });
      }
    }
  });

/** Validates and defaults an unknown simulator request. */
export function parseSimulatorRequest(input: unknown): SimulationRequestV1 {
  return simulatorRequestSchema.parse(input) as SimulationRequestV1;
}
