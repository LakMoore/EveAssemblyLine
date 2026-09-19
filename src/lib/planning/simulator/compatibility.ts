import type {
  PlanJobInput,
  PlanJobInputs,
  PlanResponse,
  PlanWarning,
  ResponseMaterial,
  ResponseMaterialBuy,
  ResponsePlanItem,
} from "@/lib/planning/types";
import { AssemblyLineGroups } from "@/lib/reference/assemblyLineGroups";
import type { SimulationContext } from "./context";
import type {
  SimulationIndustryJob,
  SimulationJobInput,
  SimulationMaterialBalance,
  SimulationResultV1,
  SimulatorRequestV1,
} from "./types";

type ManufacturingResponse = PlanResponse["lists"]["manufacturingJobs"][number]["items"][number];
type InventionResponse = PlanResponse["lists"]["inventionJobs"][number]["items"][number];
type ReprocessingResponse = PlanResponse["lists"]["reprocessingJobs"][number]["items"][number];

/** Resolves a localized type name for compatibility rows. */
function typeName(context: SimulationContext, request: SimulatorRequestV1, typeId: number): string {
  const names = context.types.get(typeId)?.name;
  return names?.[request.language ?? "en"] ?? names?.en ?? `Type ${typeId}`;
}

/** Resolves a stable legacy grouping label from the type's SDE group. */
function assemblyLineGroup(
  context: SimulationContext,
  request: SimulatorRequestV1,
  typeId: number,
): string {
  const groupId = context.types.get(typeId)?.groupID;
  if (groupId === undefined) return "Unknown";
  const names = context.groups.get(groupId)?.name;
  return names?.[request.language ?? "en"] ?? names?.en ?? `Group ${groupId}`;
}

/** Groups rows by their activity location using the legacy response shape. */
function byLocation<T>(
  rows: readonly T[],
  locationFor: (row: T) => number | undefined,
): Array<{ locationId?: number; items: T[] }> {
  const buckets = new Map<string, { locationId?: number; items: T[] }>();
  for (const row of rows) {
    const locationId = locationFor(row);
    const key = locationId === undefined ? "unlocated" : String(locationId);
    const bucket = buckets.get(key) ?? {
      ...(locationId === undefined ? {} : { locationId }),
      items: [],
    };
    bucket.items.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort(
    (left, right) =>
      (left.locationId ?? Number.MAX_SAFE_INTEGER) - (right.locationId ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Converts native demand provenance into the compact legacy representation. */
function demandSources(balance: SimulationMaterialBalance) {
  return balance.demandSources.map((source) => ({
    typeId: source.typeId,
    quantity: source.quantity,
    headlineQuantity: source.quantity,
  }));
}

/** Maps one native material equation to the legacy plan-row semantics. */
function planItem(balance: SimulationMaterialBalance): ResponsePlanItem {
  const physicalSupply = balance.availableNow + balance.availableAfterHauling;
  const upstreamSupply =
    balance.availableFromProduction
    + balance.availableFromCopying
    + balance.availableFromInvention
    + balance.availableFromReprocessing;
  return {
    kind: "material",
    typeId: balance.typeId,
    typeName: balance.typeName,
    unitVolume: balance.unitVolume,
    neededQuantity: balance.unsatisfied + upstreamSupply,
    inBuildQuantity: upstreamSupply,
    demandSources: demandSources(balance),
    requiredQuantity: balance.required,
    availableQuantity: physicalSupply,
    surplusQuantity: balance.surplus,
    haulingQuantity: balance.availableAfterHauling,
  };
}

/** Computes the legacy status once from one horizon's complete-kit reservation. */
function jobInput(
  input: SimulationJobInput,
  availableQuantity = input.availableAfterHauling,
): PlanJobInput {
  const completionPercent =
    input.requiredQuantity === 0
      ? 100
      : Math.min(100, (availableQuantity / input.requiredQuantity) * 100);
  return {
    kind: "material",
    typeId: input.typeId,
    name: input.typeName,
    availableQuantity,
    inBuildQuantity: Math.max(0, input.availableAfterUpstream - input.availableAfterHauling),
    requiredQuantity: input.requiredQuantity,
    completionPercent,
    status: completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked",
  };
}

/** Converts the simulator's exact blueprint/material allocation into legacy job inputs. */
function jobInputs(
  context: SimulationContext,
  request: SimulatorRequestV1,
  job: SimulationIndustryJob,
): PlanJobInputs {
  const availableBlueprintRuns =
    job.blueprint.blueprintKind === "fallback" ? 0 : job.blueprint.runs;
  const blueprintCompletion = Math.min(100, (availableBlueprintRuns / job.requiredRuns) * 100);
  const blueprint: PlanJobInput = {
    kind: "blueprint",
    typeId: job.blueprint.blueprintTypeId,
    name: typeName(context, request, job.blueprint.blueprintTypeId),
    availableQuantity: availableBlueprintRuns,
    requiredQuantity: job.requiredRuns,
    completionPercent: blueprintCompletion,
    status: blueprintCompletion >= 100 ? "ready" : blueprintCompletion > 0 ? "partial" : "blocked",
  };
  const materials = job.inputs.map((input) => jobInput(input));
  const completionPercent = Math.min(
    blueprint.completionPercent,
    ...materials.map((material) => material.completionPercent),
  );
  return {
    blueprint,
    materials,
    bpoCount:
      job.blueprint.blueprintKind === "bpo" || job.blueprint.blueprintKind === "formula" ? 1 : 0,
    bpcRuns: job.blueprint.blueprintKind === "bpc" ? job.blueprint.runs : 0,
    completionPercent,
    status: completionPercent >= 100 ? "ready" : completionPercent > 0 ? "partial" : "blocked",
  };
}

/** Maps a native industry job to the existing manufacturing/reaction row. */
function manufacturingResponse(
  context: SimulationContext,
  request: SimulatorRequestV1,
  job: SimulationIndustryJob,
): ManufacturingResponse & { locationId: number } {
  return {
    typeId: job.productTypeId,
    name: job.productName,
    countNeeded: job.requiredRuns,
    inputs: jobInputs(context, request, job),
    runsAvailable: job.readyAfterHaulingRuns,
    totalTime: job.durationPerRunSeconds * job.requiredRuns,
    locationId: job.locationId,
  };
}

/** Adapts a native simulator result for the unchanged ten-tab planner UI contract. */
export function toCompatiblePlanResponse(
  request: SimulatorRequestV1,
  context: SimulationContext,
  result: SimulationResultV1,
): PlanResponse {
  const planItemEntries = result.lists.planItems.map((balance) => ({
    item: planItem(balance),
    locationId: balance.locationId,
  }));
  const planItems = planItemEntries.map((entry) => entry.item);
  const materialsToBuy = result.lists.materialsToBuy.map(
    (purchase): ResponseMaterialBuy & { assemblyLineGroup: string } => ({
      typeId: purchase.typeId,
      typeName: purchase.typeName,
      unitVolume: purchase.unitVolume,
      neededQuantity: purchase.quantity,
      assemblyLineGroup: assemblyLineGroup(context, request, purchase.typeId),
    }),
  );
  const bpoToBuy = result.lists.bpoToBuy.map((purchase) => ({
    typeId: purchase.typeId,
    typeName: purchase.typeName,
    unitVolume: purchase.unitVolume,
    neededQuantity: purchase.quantity,
    bpoCount: purchase.quantity,
    bposInUse: 0,
    assemblyLineGroup: assemblyLineGroup(context, request, purchase.typeId),
  }));
  const inventionJobs = result.lists.inventionJobs.map(
    (job): InventionResponse & { locationId: number } => ({
      typeId: job.outputBlueprintTypeId,
      name: typeName(context, request, job.outputBlueprintTypeId),
      countNeeded: job.attempts,
      locationId: job.locationId,
    }),
  );
  const manufacturingJobs = result.lists.manufacturingJobs.map((job) =>
    manufacturingResponse(context, request, job),
  );
  const reactionJobs = result.lists.reactionJobs.map((job) =>
    manufacturingResponse(context, request, job),
  );
  const reprocessingJobs = result.lists.reprocessingJobs.map(
    (job): ReprocessingResponse & { locationId: number } => ({
      typeId: job.sourceTypeId,
      name: job.sourceTypeName,
      countNeeded: job.sourceQuantity,
      efficiency: job.efficiency,
      locationId: job.locationId,
    }),
  );
  const warningRows: Array<PlanWarning & { locationId?: number }> = result.lists.manufacturingJobs
    .filter((job) => job.blueprint.blueprintKind === "fallback")
    .map((job) => ({
      code: "manufacturing-bpc-runs-insufficient",
      typeId: job.productTypeId,
      locationId: job.locationId,
    }));
  const haulBuckets = new Map<string, PlanResponse["lists"]["haulingTasks"][number]>();
  for (const task of result.lists.haulingTasks) {
    const key = `${task.fromLocationId}:${task.toLocationId}:${task.ownerType ?? ""}:${task.ownerId ?? ""}`;
    const bucket = haulBuckets.get(key) ?? {
      fromLocationId: task.fromLocationId,
      toLocationId: task.toLocationId,
      ownerType: task.ownerType,
      ownerId: task.ownerId,
      items: [],
    };
    const item: ResponseMaterial = {
      typeId: task.typeId,
      typeName: task.typeName,
      unitVolume: task.unitVolume,
      neededQuantity: task.quantity,
    };
    bucket.items.push(item);
    haulBuckets.set(key, bucket);
  }
  return {
    metadata: {
      generatedAt: result.metadata.generatedAt,
      unresolvedAssetCount: result.metadata.unresolvedAssetCount,
    },
    lists: {
      warnings: byLocation(warningRows, (warning) => warning.locationId),
      planItems: {
        all: planItems,
        byActivityLocation: byLocation(planItemEntries, (entry) => entry.locationId).map(
          (bucket) => ({
            locationId: bucket.locationId,
            items: bucket.items.map((entry) => entry.item),
          }),
        ),
      },
      materialsToBuy: AssemblyLineGroups.groupBy(materialsToBuy, (item) => item.assemblyLineGroup),
      bpcToCopy: byLocation(
        result.lists.bpcToCopy.map((job) => ({
          typeId: job.blueprintTypeId,
          typeName: typeName(context, request, job.blueprintTypeId),
          unitVolume: context.types.get(job.blueprintTypeId)?.volume ?? 0,
          neededQuantity: job.totalLicensedRuns,
          bpoCount: job.sourceBlueprintItemId === undefined ? 0 : 1,
          bposInUse: 0,
          locationId: job.locationId,
        })),
        (job) => job.locationId,
      ),
      bpoToBuy: AssemblyLineGroups.groupBy(bpoToBuy, (item) => item.assemblyLineGroup),
      inventionJobs: byLocation(inventionJobs, (job) => job.locationId),
      reactionJobs: byLocation(reactionJobs, (job) => job.locationId),
      manufacturingJobs: byLocation(manufacturingJobs, (job) => job.locationId),
      reprocessingJobs: byLocation(reprocessingJobs, (job) => job.locationId),
      haulingTasks: [...haulBuckets.values()],
      skillsRequired: result.lists.skillsRequired.map(({ skillId, name, requiredLevel }) => ({
        skillId,
        name,
        requiredLevel,
      })),
    },
  };
}
