import type { ClientPlanStockpile, PlanHaulExclusion, PlanStockItem } from "@/lib/planning/types";
import type { ClientCharacterStatus, ClientJobsResponse } from "@/lib/client/requestCache";
import type {
  ActivityLocationOption,
  StockLocationOption,
} from "@/components/PlannerStockpileEditor";
import type { FacilityGroupBonus } from "@/lib/planning/facilityBonuses";
import type { ProductionGroupKey } from "@/lib/planning/productionGroups";
import type { KnownStructure, PlannerSettings } from "@/lib/planning/preferences";
import type { SdeLanguage } from "@/lib/reference/languages";
import { facilitySettingsName } from "@/lib/planning/facilities";
import type { SimulationAsset, SimulationIndustryOutputMarker } from "./types";
import { filterSimulationAssetsByTakeAccess, prepareSimulationAssets } from "./requestAssets";
import {
  createSimulationCharacterProfiles,
  createSimulationSlotMap,
  simulationTimeMultipliers,
} from "./requestProfiles";

/** Planner facility settings used to construct a simulator request. */
export type PlanLocationOption = {
  id: string;
  locationId: number;
  systemId: number;
  systemName?: string;
  name: string;
  locationType: "station" | "structure";
  baseYield: number;
  baseManufacturingMe: number;
  manufacturingTimeMultiplier: number;
  reactionTimeMultiplier: number;
  sizeId: number;
  activities: {
    manufacturing: boolean;
    reactions: boolean;
  };
  buildTypeGroups: Partial<Record<ProductionGroupKey, FacilityGroupBonus>>;
};

/** Large request inputs that change independently of the simulator switches. */
export type PlannerSimulationRequestBase = {
  stockpiles: readonly ClientPlanStockpile[];
  stock: readonly PlanStockItem[];
  requestReady: boolean;
  settings: PlannerSettings;
  characterStatuses: readonly ClientCharacterStatus[];
  language: SdeLanguage;
  locationOptions: readonly PlanLocationOption[];
  cachedAssetLocations: readonly StockLocationOption[];
  knownStructures: readonly KnownStructure[];
  haulExclusions: readonly PlanHaulExclusion[];
  planningCharacterId?: number;
  jobs: ClientJobsResponse | null;
};

/** Combines planner, cached asset, and saved structure facilities without duplicate locations. */
export function getSharedLocationOptions(
  locationOptions: readonly PlanLocationOption[],
  cachedAssetLocations: readonly StockLocationOption[],
  knownStructures: readonly KnownStructure[],
): ActivityLocationOption[] {
  return [
    ...locationOptions.map((location) => ({
      locationId: location.locationId,
      systemId: location.systemId,
      systemName: location.systemName,
      name: location.name,
      kind: location.locationType,
      baseYield: location.baseYield,
      baseManufacturingMe: location.baseManufacturingMe,
    })),
    ...cachedAssetLocations,
    ...knownStructures.flatMap((structure) => {
      const locationId = structure.esiStructureId ?? structure.plannerLocationId;
      return locationId === undefined
        ? []
        : [
            {
              locationId,
              systemId: structure.systemId,
              systemName: structure.systemName,
              name: facilitySettingsName(structure.systemName, structure.name),
              kind: "structure" as const,
              baseYield: 0,
              baseManufacturingMe: 0,
            },
          ];
    }),
  ].filter(
    (location, index, allLocations) =>
      allLocations.findIndex((candidate) => candidate.locationId === location.locationId) === index,
  );
}

/** Boolean simulator settings that are cheap to message separately to the worker. */
export type PlannerSimulationRequestOptions = {
  includeStock: boolean;
  simulateSurplus: boolean;
  allowInterStockpileHauling: boolean;
  onlyIncludeTakeAccessAssets: boolean;
};

/** Removes owner-specific metadata and de-duplicates simulator haul exclusions by route. */
function toSimulationHaulExclusions(
  exclusions: readonly PlanHaulExclusion[],
): Array<Pick<PlanHaulExclusion, "typeId" | "fromLocationId" | "toLocationId">> {
  const routeExclusions = new Map<
    string,
    Pick<PlanHaulExclusion, "typeId" | "fromLocationId" | "toLocationId">
  >();
  for (const exclusion of exclusions) {
    const routeOnly = {
      typeId: exclusion.typeId,
      fromLocationId: exclusion.fromLocationId,
      toLocationId: exclusion.toLocationId,
    };
    routeExclusions.set(
      `${routeOnly.typeId}:${routeOnly.fromLocationId}:${routeOnly.toLocationId}`,
      routeOnly,
    );
  }
  return [...routeExclusions.values()];
}

type PlannerAssetWithPresentation = PlanStockItem & {
  assembledVolume?: number;
  assemblyLineGroup?: string;
  packagedVolume?: number;
  techLevel?: number;
};

/** Removes presentation metadata before sending assets to the simulator. */
function toSimulationAsset(item: PlanStockItem): SimulationAsset {
  const normalizedActivity = item.activityName?.toLowerCase();
  const isBlueprintOutput =
    item.category === "blueprint"
    && item.inUse !== true
    && (normalizedActivity === "copying" || normalizedActivity === "invention");
  const industryOutput: SimulationIndustryOutputMarker | undefined =
    item.inBuild === true
    && (item.category === "item" || isBlueprintOutput)
    && (
      normalizedActivity === "manufacturing"
      || normalizedActivity === "reaction"
      || normalizedActivity === "reactions"
      || normalizedActivity === "copying"
      || normalizedActivity === "invention"
    )
      ? {
          activity:
            normalizedActivity === "manufacturing"
              ? "manufacturing"
              : normalizedActivity === "reaction" || normalizedActivity === "reactions"
                ? "reaction"
                : normalizedActivity,
          state:
            item.industryJobStatus === "cancelled" || item.industryJobStatus === "reverted"
              ? "excluded"
              : item.industryJobStatus === "active" || item.industryJobStatus === "paused"
                ? item.industryJobStatus
                : "available",
          ...(item.jobId !== undefined ? { sourceJobId: item.jobId } : {}),
          ...(item.industryJobEndDate ? { completionAt: item.industryJobEndDate } : {}),
        }
      : undefined;
  const {
    assembledVolume: _assembledVolume,
    assemblyLineGroup: _assemblyLineGroup,
    category: _category,
    name: _name,
    packagedVolume: _packagedVolume,
    blueprintType: _blueprintType,
    sourceLocationName: _sourceLocationName,
    sourceLocationKind: _sourceLocationKind,
    sourceSystemName: _sourceSystemName,
    techLevel: _techLevel,
    marketOrderIssuerId: _marketOrderIssuerId,
    inBuild: _inBuild,
    jobId: _jobId,
    industryJobStatus: _industryJobStatus,
    industryJobEndDate: _industryJobEndDate,
    activityName: _activityName,
    isCargoContainer: _isCargoContainer,
    isPackaged: _isPackaged,
    isContainedByShip: _isContainedByShip,
    isShip: _isShip,
    locationFlag: _locationFlag,
    ...simulationAsset
  } = item as PlannerAssetWithPresentation;
  return {
    ...simulationAsset,
    ...(industryOutput ? { industryOutput } : {}),
  };
}

/** Builds the exact simulator request from planner state in a worker-compatible module. */
export function createPlannerSimulationRequest(
  input: PlannerSimulationRequestBase & PlannerSimulationRequestOptions,
) {
  const populatedStockpiles = input.stockpiles
    .filter((stockpile) => stockpile.isActive !== false)
    .map((stockpile) => ({
      ...stockpile,
      items: stockpile.items.filter((item) => item.isIncluded !== false),
    }))
    .filter((stockpile) => stockpile.items.length > 0);
  if (populatedStockpiles.length === 0) return null;
  if (input.includeStock && !input.requestReady) return null;

  const stock = input.includeStock ? input.stock : [];
  const simulationAssets = input.onlyIncludeTakeAccessAssets
    ? filterSimulationAssetsByTakeAccess(stock)
    : stock;
  const requestStock = prepareSimulationAssets(simulationAssets);
  const primaryStockpileLocations = populatedStockpiles[0].locations;
  const selectedManufacturingFacility = input.locationOptions.find(
    (location) => location.locationId === primaryStockpileLocations.manufacturing,
  );
  const selectedReactionFacility = input.locationOptions.find(
    (location) => location.locationId === primaryStockpileLocations.reactions,
  );
  const planningCharacter = input.characterStatuses.find(
    (character) => character.characterId === input.planningCharacterId,
  );
  const planningTimeMultipliers = simulationTimeMultipliers(
    planningCharacter?.skills?.body ?? undefined,
  );
  const sharedLocationOptions = getSharedLocationOptions(
    input.locationOptions,
    input.cachedAssetLocations,
    input.knownStructures,
  );

  return {
    language: input.language,
    stockpiles: populatedStockpiles.map((stockpile) => ({
      ...stockpile,
      items: stockpile.items.map(({ typeId, quantity, me, te, fromCompression }) => ({
        typeId,
        quantity,
        me,
        te,
        fromCompression,
      })),
    })),
    facilityProfiles: sharedLocationOptions.flatMap((location) => {
      if (location.systemId === undefined) return [];
      const facility = input.locationOptions.find(
        (candidate) => candidate.locationId === location.locationId,
      );
      return [
        {
          locationId: location.locationId,
          systemId: location.systemId,
          sizeId: facility?.sizeId ?? 0,
          buildTypeGroups: facility?.buildTypeGroups ?? {},
        },
      ];
    }),
    haulExclusions: toSimulationHaulExclusions(input.haulExclusions),
    assets: requestStock.map(toSimulationAsset),
    facilityTimeMultipliers: {
      manufacturing: selectedManufacturingFacility?.manufacturingTimeMultiplier ?? 1,
      reactions: selectedReactionFacility?.reactionTimeMultiplier ?? 1,
    },
    skillTimeMultipliers: {
      manufacturing: planningTimeMultipliers.manufacturing,
      reactions: planningTimeMultipliers.reactions,
    },
    settings: {
      includeCorporationAssets: input.settings.includeCorporationAssets,
      buildBlacklist: input.settings.buildBlacklist.map((item) => item.typeId),
      buyBlacklist: [],
      fallbackT1Me: input.settings.fallbackT1Me,
      fallbackT1Te: input.settings.fallbackT1Te,
      fallbackT2OrT3Me: input.settings.fallbackT2OrT3Me,
      fallbackT2OrT3Te: input.settings.fallbackT2OrT3Te,
    },
    simulation: {
      version: 1,
      simulateSurplus: input.simulateSurplus,
      blockInterStockpileHauling: !input.allowInterStockpileHauling,
      maxReactionJobDurationHours: input.settings.maxReactionJobDurationHours,
      characters: createSimulationCharacterProfiles(input.characterStatuses),
      slots: createSimulationSlotMap(input.characterStatuses, input.jobs),
    },
  };
}
