import { getStockRootLocationId } from "@/lib/planning/stockPolicies";
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
import type { SimulationAsset, SimulationIndustryOutputMarker, SimulationRequestV1 } from "./types";

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

type CategorizedAssets = Exclude<SimulationRequestV1["assets"], SimulationAsset[] | undefined>;
type NormalizedSimulationAsset = PlanStockItem & {
  industryOutput?: SimulationIndustryOutputMarker;
};

function localizedTypeName(context: SimulationContext, typeId: number, language = "en"): string {
  const name = context.types.get(typeId)?.name;
  return name?.[language as keyof typeof name] ?? name?.en ?? `Type ${typeId}`;
}

function unitVolume(context: SimulationContext, typeId: number): number {
  const type = context.types.get(typeId);
  return type?.packagedVolume ?? type?.volume ?? 0;
}

function assetCategory(
  item: SimulationAsset | NormalizedSimulationAsset,
  context: SimulationContext,
): "blueprint" | "reactionformula" | "item" {
  if (context.blueprints.byBlueprintId.get(item.typeId)?.activities.reaction) {
    return "reactionformula";
  }
  if (item.blueprintPrints?.length) return "blueprint";
  return "item";
}

function isUsableIndustryOutput(item: NormalizedSimulationAsset): boolean {
  return item.industryOutput?.state === undefined || item.industryOutput.state === "available";
}

function isAvailableIndustryOutput(item: NormalizedSimulationAsset): boolean {
  return item.industryOutput?.state !== "excluded";
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
): NormalizedSimulationAsset | undefined {
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
  const outputActivity = normalizedActivity.startsWith("reaction") ? "reaction" : "manufacturing";
  const outputState: SimulationIndustryOutputMarker["state"] =
    job.status === "active"
      ? "active"
      : job.status === "paused"
        ? "paused"
        : job.status === "cancelled" || job.status === "reverted"
          ? "excluded"
          : "available";
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
    industryOutput: { activity: outputActivity, state: outputState },
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
  const stock: NormalizedSimulationAsset[] = (
    Array.isArray(assets)
      ? assets.map((item) => ({
          ...item,
          name: localizedTypeName(context, item.typeId, request.language),
          category: assetCategory(item, context),
        }))
      : normalizeCategorizedAssets(assets, context)
  )
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
    const category = assetCategory(item, context);
    if (category === "blueprint" || category === "reactionformula") {
      const prints = [...(item.blueprintPrints ?? [])].sort(
        (left, right) =>
          left.itemId - right.itemId
          || left.runs - right.runs
          || left.type.localeCompare(right.type),
      );
      if (prints.length > 0) {
        for (const [printIndex, print] of prints.entries()) {
          const formulaCopies = category === "reactionformula" ? Math.max(0, item.quantity) : 1;
          for (let copyIndex = 0; copyIndex < formulaCopies; copyIndex += 1) {
            blueprintLots.push({
              lotId:
                category === "reactionformula"
                  ? `blueprint:${stockIndex}:${print.itemId}:${printIndex}:${copyIndex}`
                  : `blueprint:${stockIndex}:${print.itemId}:${printIndex}`,
              itemId: category === "reactionformula" ? undefined : print.itemId,
              typeId: item.typeId,
              name: localizedTypeName(context, item.typeId, request.language),
              kind: category === "reactionformula" ? "formula" : print.type,
              runs:
                category === "reactionformula" || print.type === "bpo"
                  ? Number.MAX_SAFE_INTEGER
                  : Math.max(0, print.runs),
              materialEfficiency: print.me ?? item.me ?? 0,
              timeEfficiency: print.te ?? item.te ?? 0,
              locationId,
              ownerType: item.ownerType,
              ownerId: item.ownerId,
              inUse: item.inUse === true,
              horizon: isUsableIndustryOutput(item) ? "now" : "after-upstream",
            });
          }
        }
      }
      else if (category === "reactionformula") {
        for (let index = 0; index < Math.max(0, item.quantity); index += 1) {
          blueprintLots.push({
            lotId: `blueprint:${stockIndex}:${index}`,
            typeId: item.typeId,
            name: localizedTypeName(context, item.typeId, request.language),
            kind: "formula",
            runs: Number.MAX_SAFE_INTEGER,
            materialEfficiency: item.me ?? 0,
            timeEfficiency: item.te ?? 0,
            locationId,
            ownerType: item.ownerType,
            ownerId: item.ownerId,
            inUse: item.inUse === true,
            horizon: isUsableIndustryOutput(item) ? "now" : "after-upstream",
          });
        }
      }
      continue;
    }
    if (!isAvailableIndustryOutput(item) || item.quantity <= 0) continue;
    itemLots.push({
      lotId: `item:${stockIndex}`,
      typeId: item.typeId,
      name: localizedTypeName(context, item.typeId, request.language),
      quantity: item.quantity,
      locationId,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      unitVolume: unitVolume(context, item.typeId),
      horizon: isUsableIndustryOutput(item) ? "now" : "after-upstream",
      source:
        item.source === "marketOrder"
          ? "market-order"
          : item.industryOutput
            ? "industry-output"
            : "asset",
      ...(item.industryOutput?.state === "active" || item.industryOutput?.state === "paused"
        ? { activity: item.industryOutput.activity }
        : {}),
      industryJobStatus:
        item.industryOutput?.state === "active" || item.industryOutput?.state === "paused"
          ? item.industryOutput.state
          : undefined,
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
