import {
  getStockRootLocationId,
  isAvailableIndustryProductionOutput,
  isUsableIndustryProductionOutput,
} from "@/lib/planning/stockPolicies";
import type {
  PlanBlueprintInput,
  PlanIndustryInput,
  PlanItemInput,
  PlanMarketInput,
  PlanStockItem,
  StockOwnerType,
  IndustryJobStatus,
} from "@/lib/planning/types";
import type { SimulationContext } from "./context";
import type { SimulationSourceLot } from "./ledger";
import type { SimulationRequestV1 } from "./types";

/** Physical or committed ordinary stock available to the simulator. */
export interface SimulationItemLot extends SimulationSourceLot {
  name: string;
  unitVolume: number;
  horizon: "now" | "after-upstream";
  source: "asset" | "market-order" | "industry-output";
  activity?: "manufacturing" | "reaction";
  industryJobId?: number;
  industryJobStatus?: IndustryJobStatus;
  industryJobEndDate?: string;
  eligibleForReprocessing: boolean;
}

/** One blueprint print or reusable reaction formula. */
export interface SimulatorBlueprintLot {
  lotId: string;
  itemId?: number;
  typeId: number;
  name: string;
  kind: "bpo" | "bpc" | "formula";
  runs: number;
  materialEfficiency: number;
  timeEfficiency: number;
  locationId?: number;
  ownerType?: StockOwnerType;
  ownerId?: number;
  inUse: boolean;
  horizon: "now" | "after-upstream";
}

/** Canonical inventory registry consumed by every simulation phase. */
export interface SimulatorInventory {
  itemLots: readonly SimulationItemLot[];
  blueprintLots: readonly SimulatorBlueprintLot[];
  unresolvedLotCount: number;
}

type CategorizedAssets = Exclude<SimulationRequestV1["assets"], PlanStockItem[] | undefined>;

function localizedTypeName(context: SimulationContext, typeId: number, language = "en"): string {
  const name = context.types.get(typeId)?.name;
  return name?.[language as keyof typeof name] ?? name?.en ?? `Type ${typeId}`;
}

function unitVolume(context: SimulationContext, typeId: number): number {
  const type = context.types.get(typeId);
  return type?.packagedVolume ?? type?.volume ?? 0;
}

/** Narrows an external industry activity name to a production activity. */
function productionActivity(activityName?: string): SimulationItemLot["activity"] {
  const normalizedActivity = activityName?.toLowerCase();
  if (normalizedActivity === "manufacturing") return "manufacturing";
  if (normalizedActivity === "reaction" || normalizedActivity === "reactions") {
    return "reaction";
  }
  return undefined;
}

/** Returns the only type IDs the simulator may ever select for reprocessing. */
export function getEligibleReprocessingTypeIds(
  context: Pick<SimulationContext, "compressibleTypes" | "typeMaterials">,
): ReadonlySet<number> {
  const eligible = new Set<number>([15331, 30497]);
  for (const [rawTypeId, compressedTypeId] of context.compressibleTypes) {
    eligible.add(compressedTypeId);
    if (context.typeMaterials.has(rawTypeId)) eligible.add(rawTypeId);
  }
  return eligible;
}

/** Checks the simulator's deliberately narrow reprocessing eligibility policy. */
export function isSimulatorReprocessingType(
  context: Pick<SimulationContext, "compressibleTypes" | "typeMaterials">,
  typeId: number,
): boolean {
  return getEligibleReprocessingTypeIds(context).has(typeId);
}

function categorizedStockItem(
  item: PlanItemInput | PlanMarketInput,
  context: SimulationContext,
  source?: "marketOrder",
): PlanStockItem {
  return {
    typeId: item.typeId,
    name: localizedTypeName(context, item.typeId),
    quantity: item.quantity,
    locationId: item.locationId,
    rootLocationId: item.rootLocationId,
    category: "item",
    ...(source ? { source } : {}),
  };
}

function categorizedBlueprintItem(
  item: PlanBlueprintInput,
  context: SimulationContext,
): PlanStockItem {
  const itemId = item.itemId ?? item.typeId * 1_000_000 + item.rootLocationId;
  return {
    typeId: item.typeId,
    name: localizedTypeName(context, item.typeId),
    quantity: item.quantity,
    locationId: item.locationId,
    rootLocationId: item.rootLocationId,
    category: context.blueprints.byBlueprintId.get(item.typeId)?.activities.reaction
      ? "reactionformula"
      : "blueprint",
    blueprintPrints: [
      {
        itemId,
        runs: item.type === "bpo" ? -1 : item.runs,
        type: item.type,
        me: item.me,
        te: item.te,
      },
    ],
  };
}

function industryOutputItem(
  job: PlanIndustryInput,
  context: SimulationContext,
): PlanStockItem | undefined {
  const blueprint =
    (job.blueprintTypeId === undefined
      ? undefined
      : context.blueprints.byBlueprintId.get(job.blueprintTypeId))
    ?? context.blueprints.byBlueprintId.get(job.typeId);
  if (!blueprint) return undefined;
  const normalizedActivity = job.activity.toLowerCase();
  if (normalizedActivity === "copying" || normalizedActivity === "invention") {
    const productTypeId =
      normalizedActivity === "copying"
        ? (job.blueprintTypeId ?? blueprint._key)
        : (blueprint.activities.invention?.products?.[0]?.typeID ?? job.typeId);
    const runsPerCopy =
      normalizedActivity === "copying"
        ? (job.licensedRuns ?? 1)
        : (blueprint.activities.invention?.products?.[0]?.quantity ?? 1);
    return {
      typeId: productTypeId,
      name: localizedTypeName(context, productTypeId),
      quantity: job.quantity,
      locationId: job.locationId,
      rootLocationId: job.rootLocationId,
      category: "blueprint",
      inBuild: true,
      jobId: job.jobId,
      industryJobStatus: job.status,
      activityName: job.activity,
      blueprintPrints: [
        {
          itemId: job.jobId,
          runs: Math.max(0, job.runs * runsPerCopy),
          type: "bpc",
          activity: job.activity,
        },
      ],
    };
  }
  const activity = normalizedActivity.startsWith("reaction")
    ? blueprint.activities.reaction
    : blueprint.activities.manufacturing;
  const product =
    activity?.products?.find((candidate) => candidate.typeID === job.typeId)
    ?? activity?.products?.[0];
  if (!product) return undefined;
  return {
    typeId: product.typeID,
    name: localizedTypeName(context, product.typeID),
    quantity: Math.max(job.quantity, job.runs * product.quantity),
    locationId: job.locationId,
    rootLocationId: job.rootLocationId,
    category: "item",
    inBuild: true,
    jobId: job.jobId,
    industryJobStatus: job.status,
    activityName: job.activity,
  };
}

function normalizeCategorizedAssets(
  assets: CategorizedAssets,
  context: SimulationContext,
): PlanStockItem[] {
  return [
    ...assets.items.map((item) => categorizedStockItem(item, context)),
    ...assets.market.map((item) => categorizedStockItem(item, context, "marketOrder")),
    ...assets.blueprints.map((item) => categorizedBlueprintItem(item, context)),
    ...assets.industry.flatMap((job) => {
      const output = industryOutputItem(job, context);
      return output ? [output] : [];
    }),
  ];
}

/** Converts request assets into immutable ordinary and blueprint source lots. */
export function normalizeSimulatorInventory(
  request: SimulationRequestV1,
  context: SimulationContext,
): SimulatorInventory {
  const assets = request.assets ?? [];
  const stock = (Array.isArray(assets) ? assets : normalizeCategorizedAssets(assets, context))
    .slice()
    .sort(
      (left, right) =>
        left.typeId - right.typeId
        || (getStockRootLocationId(left) ?? Number.MAX_SAFE_INTEGER)
          - (getStockRootLocationId(right) ?? Number.MAX_SAFE_INTEGER)
        || (left.ownerType ?? "").localeCompare(right.ownerType ?? "")
        || (left.ownerId ?? 0) - (right.ownerId ?? 0)
        || left.quantity - right.quantity
        || JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const eligibleTypeIds = getEligibleReprocessingTypeIds(context);
  const itemLots: SimulationItemLot[] = [];
  const blueprintLots: SimulatorBlueprintLot[] = [];

  for (const [stockIndex, item] of stock.entries()) {
    const locationId = getStockRootLocationId(item);
    if (item.category === "blueprint" || item.category === "reactionformula") {
      const prints = [...(item.blueprintPrints ?? [])].sort(
        (left, right) =>
          left.itemId - right.itemId
          || left.runs - right.runs
          || left.type.localeCompare(right.type),
      );
      if (prints.length > 0) {
        for (const [printIndex, print] of prints.entries()) {
          blueprintLots.push({
            lotId: `blueprint:${stockIndex}:${print.itemId}:${printIndex}`,
            itemId: print.itemId,
            typeId: item.typeId,
            name: item.name || localizedTypeName(context, item.typeId, request.language),
            kind: item.category === "reactionformula" ? "formula" : print.type,
            runs: print.type === "bpo" ? Number.MAX_SAFE_INTEGER : Math.max(0, print.runs),
            materialEfficiency: print.me ?? item.me ?? 0,
            timeEfficiency: print.te ?? item.te ?? 0,
            locationId,
            ownerType: item.ownerType,
            ownerId: item.ownerId,
            inUse: item.inUse === true,
            horizon: isUsableIndustryProductionOutput(item) ? "now" : "after-upstream",
          });
        }
      }
      else {
        for (let index = 0; index < Math.max(0, item.quantity); index += 1) {
          blueprintLots.push({
            lotId: `blueprint:${stockIndex}:${index}`,
            typeId: item.typeId,
            name: item.name || localizedTypeName(context, item.typeId, request.language),
            kind: item.category === "reactionformula" ? "formula" : (item.blueprintType ?? "bpc"),
            runs:
              item.category === "reactionformula" || item.blueprintType === "bpo"
                ? Number.MAX_SAFE_INTEGER
                : Math.max(0, item.licensedRuns ?? item.quantity),
            materialEfficiency: item.me ?? 0,
            timeEfficiency: item.te ?? 0,
            locationId,
            ownerType: item.ownerType,
            ownerId: item.ownerId,
            inUse: item.inUse === true,
            horizon: isUsableIndustryProductionOutput(item) ? "now" : "after-upstream",
          });
        }
      }
      continue;
    }
    if (!isAvailableIndustryProductionOutput(item) || item.quantity <= 0) continue;
    itemLots.push({
      lotId: `item:${stockIndex}`,
      typeId: item.typeId,
      name: item.name || localizedTypeName(context, item.typeId, request.language),
      quantity: item.quantity,
      locationId,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      unitVolume: unitVolume(context, item.typeId),
      horizon: isUsableIndustryProductionOutput(item) ? "now" : "after-upstream",
      source:
        item.source === "marketOrder" ? "market-order" : item.inBuild ? "industry-output" : "asset",
      activity: productionActivity(item.activityName),
      industryJobId: item.jobId,
      industryJobStatus: item.industryJobStatus,
      industryJobEndDate: item.industryJobEndDate,
      eligibleForReprocessing: eligibleTypeIds.has(item.typeId),
    });
  }

  return Object.freeze({
    itemLots: Object.freeze(itemLots),
    blueprintLots: Object.freeze(blueprintLots),
    unresolvedLotCount:
      itemLots.filter((lot) => lot.locationId === undefined).length
      + blueprintLots.filter((lot) => lot.locationId === undefined).length,
  });
}
