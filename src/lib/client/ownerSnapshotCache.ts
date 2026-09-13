import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
import type { PlanStockItem } from "@/lib/planning/types";
import { getPlanningDatabase, ownerSnapshotStoreName } from "@/lib/planning/planningDatabase";

export type ClientOwner = {
  kind: "character" | "corporation";
  id: number;
};

type ClientOwnerSnapshotLocation = AssetLocation;
type ClientOwnerSnapshotSourceLocation = ClientOwnerSnapshotLocation & {
  name?: string;
  systemName?: string;
};
type ClientOwnerSnapshotAsset = Omit<
  AssetRecord,
  "name" | "rootLocation" | "containerId" | "rootLocationId" | "hangarId"
> & {
  containerId: number;
  rootLocationId: number | null;
  hangarId: number | null;
  rootLocation?: ClientOwnerSnapshotAsset | ClientOwnerSnapshotLocation;
};
type ClientOwnerSnapshotStockItem = Omit<PlanStockItem, "name">;
type ClientOwnerSnapshotJob = {
  jobId: number;
  characterId: number;
  ownerId: number;
  ownerType: "character" | "corporation";
  activityId: number;
  status: string;
  runs: number;
  outputQuantity: number;
  outputRunsPerCopy?: number;
  usesBpo?: boolean;
  startDate: string;
  endDate: string;
  facilityId: number;
  outputLocationId: number;
  blueprintTypeId: number;
  productTypeId?: number;
};
type ClientOwnerSnapshotShip = {
  itemId: number;
  typeId: number;
  systemId?: number;
  isInSpace?: boolean;
  pilotId?: number;
};

export type ClientOwnerSnapshot = {
  schemaVersion: 1;
  owner: ClientOwner;
  assets: ClientOwnerSnapshotAsset[];
  industryJobs: IndustryJobRecord[];
  blueprintInstances: BlueprintInstanceRecord[];
  rootLocations: Array<{ itemId: number; location: ClientOwnerSnapshotLocation }>;
  corporationSources: Array<{
    corporationId: number;
    rootLocationId: number;
    locationFlag: string;
    label?: string;
    rootLocation?: ClientOwnerSnapshotSourceLocation;
    canTake: boolean;
    canQuery: boolean;
    selected: boolean;
    containerItemIds: number[];
    containers?: Array<{
      itemId: number;
      name?: string;
      locationId: number;
      rootLocationId: number;
      selected: boolean;
    }>;
  }>;
  jobs: {
    slotUsage: Record<
      string,
      {
        slots: Record<string, number>;
        availableSlots: Record<string, number>;
      }
    >;
    jobs: ClientOwnerSnapshotJob[];
  };
  marketOrders: {
    marketOrderStock: ClientOwnerSnapshotStockItem[] | null;
    marketBuyOrderQuantities: Record<string, number> | null;
  };
  ships: {
    assets: ClientOwnerSnapshotAsset[];
    ships: ClientOwnerSnapshotShip[];
  };
};

type OwnerSnapshotRecord = {
  key: string;
  scope: string;
  snapshot: ClientOwnerSnapshot;
  savedAt: string;
};

export type LoadedOwnerSnapshot = {
  snapshot: ClientOwnerSnapshot;
  savedAt: string;
  stale: boolean;
};

const ownerSnapshotMaxAgeMs = 15 * 60 * 1000;

export function ownerSnapshotScope(characterIds: readonly number[]) {
  return [...new Set(characterIds)].sort((left, right) => left - right).join(",") || "none";
}

export function ownerSnapshotKey(owner: ClientOwner, scope: string) {
  return `${scope}:${owner.kind}:${owner.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptional(value: unknown, predicate: (candidate: unknown) => boolean) {
  return value === undefined || predicate(value);
}

function isSnapshotLocation(value: unknown): value is ClientOwnerSnapshotLocation {
  return (
    isRecord(value)
    && isPositiveInteger(value.locationId)
    && ["station", "structure", "solar_system"].includes(String(value.kind))
    && typeof value.resolved === "boolean"
    && isOptional(value.name, (name) => typeof name === "string")
    && (value.typeId === undefined || isPositiveInteger(value.typeId))
    && (value.systemId === undefined || isPositiveInteger(value.systemId))
    && (value.regionId === undefined || isPositiveInteger(value.regionId))
  );
}

function isSnapshotSourceLocation(value: unknown): value is ClientOwnerSnapshotSourceLocation {
  const location = value as ClientOwnerSnapshotSourceLocation;
  return (
    isSnapshotLocation(value)
    && isOptional(location.name, (name) => typeof name === "string")
    && isOptional(location.systemName, (name) => typeof name === "string")
  );
}

function isSnapshotAsset(value: unknown, depth = 0): value is ClientOwnerSnapshotAsset {
  if (!isRecord(value) || depth > 20) return false;
  return (
    isPositiveInteger(value.itemId)
    && isPositiveInteger(value.typeId)
    && isNonNegativeNumber(value.quantity)
    && isPositiveInteger(value.locationId)
    && isPositiveInteger(value.containerId)
    && (value.rootLocationId === null || isPositiveInteger(value.rootLocationId))
    && (value.hangarId === null || isPositiveInteger(value.hangarId))
    && ["facility", "station", "solar_system", "item", "structure", "container", "other"].includes(
      String(value.locationType),
    )
    && typeof value.locationFlag === "string"
    && typeof value.isSingleton === "boolean"
    && (value.ownerType === "character" || value.ownerType === "corporation")
    && isPositiveInteger(value.ownerId)
    && isOptional(value.inUse, (candidate) => typeof candidate === "boolean")
    && isOptional(value.runCount, (candidate) => Number.isSafeInteger(candidate))
    && isOptional(value.me, isNonNegativeNumber)
    && isOptional(value.te, isNonNegativeNumber)
    && (
      value.rootLocation === undefined
      || isSnapshotLocation(value.rootLocation)
      || isSnapshotAsset(value.rootLocation, depth + 1)
    )
  );
}

function isIndustryJob(value: unknown): value is IndustryJobRecord {
  return (
    isRecord(value)
    && isPositiveInteger(value.activityId)
    && isPositiveInteger(value.blueprintId)
    && isPositiveInteger(value.blueprintLocationId)
    && isPositiveInteger(value.blueprintTypeId)
    && typeof value.endDate === "string"
    && isPositiveInteger(value.facilityId)
    && isPositiveInteger(value.installerId)
    && isPositiveInteger(value.jobId)
    && isPositiveInteger(value.locationId)
    && isPositiveInteger(value.outputLocationId)
    && (value.ownerType === "character" || value.ownerType === "corporation")
    && isPositiveInteger(value.ownerId)
    && isNonNegativeNumber(value.runs)
    && typeof value.startDate === "string"
    && typeof value.status === "string"
    && isOptional(value.installedRuns, isNonNegativeNumber)
    && isOptional(value.licensedRuns, isNonNegativeNumber)
    && isOptional(value.probability, isFiniteNumber)
    && isOptional(value.productTypeId, isPositiveInteger)
    && isOptional(value.successfulRuns, isNonNegativeNumber)
  );
}

function isBlueprintInstance(value: unknown): value is BlueprintInstanceRecord {
  return (
    isRecord(value)
    && isPositiveInteger(value.itemId)
    && isPositiveInteger(value.typeId)
    && isPositiveInteger(value.locationId)
    && typeof value.locationFlag === "string"
    && typeof value.quantity === "number"
    && Number.isSafeInteger(value.quantity)
    && typeof value.runs === "number"
    && Number.isSafeInteger(value.runs)
    && isNonNegativeNumber(value.me)
    && isNonNegativeNumber(value.te)
    && isOptional(value.runsBeforeJobAdjustments, (candidate) => Number.isSafeInteger(candidate))
    && isOptional(value.inUse, (candidate) => typeof candidate === "boolean")
    && (value.ownerType === "character" || value.ownerType === "corporation")
    && isPositiveInteger(value.ownerId)
  );
}

function isNumberRecord(value: unknown) {
  return (
    isRecord(value)
    && Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isSnapshotJob(value: unknown) {
  return (
    isRecord(value)
    && isPositiveInteger(value.jobId)
    && isPositiveInteger(value.characterId)
    && isPositiveInteger(value.ownerId)
    && (value.ownerType === "character" || value.ownerType === "corporation")
    && isPositiveInteger(value.activityId)
    && typeof value.status === "string"
    && isNonNegativeNumber(value.runs)
    && isNonNegativeNumber(value.outputQuantity)
    && typeof value.startDate === "string"
    && typeof value.endDate === "string"
    && isPositiveInteger(value.facilityId)
    && isPositiveInteger(value.outputLocationId)
    && isPositiveInteger(value.blueprintTypeId)
    && (value.productTypeId === undefined || isPositiveInteger(value.productTypeId))
  );
}

function isSnapshotStockItem(value: unknown) {
  return (
    isRecord(value)
    && isPositiveInteger(value.typeId)
    && isNonNegativeNumber(value.quantity)
    && (
      value.ownerType === undefined
      || value.ownerType === "character"
      || value.ownerType === "corporation"
    )
    && (value.ownerId === undefined || isPositiveInteger(value.ownerId))
    && isOptional(value.locationId, isPositiveInteger)
    && isOptional(value.rootLocationId, isPositiveInteger)
    && isOptional(value.isPackaged, (candidate) => typeof candidate === "boolean")
    && isOptional(value.inBuild, (candidate) => typeof candidate === "boolean")
    && isOptional(value.inUse, (candidate) => typeof candidate === "boolean")
    && isOptional(value.jobId, isPositiveInteger)
    && isOptional(
      value.industryJobStatus,
      (candidate) =>
        ["active", "cancelled", "delivered", "paused", "ready", "reverted"].includes(
          String(candidate),
        ),
    )
    && isOptional(value.blueprintRunsAtInstall, isNonNegativeNumber)
    && isOptional(value.licensedRuns, isNonNegativeNumber)
    && isOptional(value.blueprintType, (candidate) => candidate === "bpo" || candidate === "bpc")
    && isOptional(value.activityName, (candidate) => typeof candidate === "string")
    && isOptional(value.jobRuns, isNonNegativeNumber)
    && isOptional(value.me, isNonNegativeNumber)
    && isOptional(value.te, isNonNegativeNumber)
    && isOptional(value.sourceLocationId, isPositiveInteger)
    && isOptional(
      value.sourceLocationKind,
      (candidate) => ["station", "structure", "anchored"].includes(String(candidate)),
    )
    && isOptional(value.sourceSystemId, isPositiveInteger)
    && isOptional(
      value.category,
      (candidate) => ["blueprint", "reactionformula", "item"].includes(String(candidate)),
    )
    && isOptional(value.inBuildQuantity, isNonNegativeNumber)
    && isOptional(value.source, (candidate) => candidate === "marketOrder")
    && isOptional(
      value.blueprintPrints,
      (candidate) =>
        Array.isArray(candidate)
        && candidate.every(
          (print) =>
            isRecord(print)
            && isPositiveInteger(print.itemId)
            && isNonNegativeNumber(print.runs)
            && (print.type === "bpo" || print.type === "bpc")
            && isOptional(print.me, isNonNegativeNumber)
            && isOptional(print.te, isNonNegativeNumber)
            && isOptional(print.activity, (activity) => typeof activity === "string"),
        ),
    )
    && isOptional(
      value.corporationSource,
      (candidate) =>
        isRecord(candidate)
        && isPositiveInteger(candidate.rootLocationId)
        && typeof candidate.locationFlag === "string"
        && Array.isArray(candidate.containerItemIds)
        && candidate.containerItemIds.every((itemId) => isPositiveInteger(itemId)),
    )
  );
}

export function isCompleteClientOwnerSnapshot(value: unknown): value is ClientOwnerSnapshot {
  if (!isRecord(value)) return false;
  const owner = value.owner;
  const jobs = value.jobs;
  const marketOrders = value.marketOrders;
  const ships = value.ships;
  return (
    value.schemaVersion === 1
    && isRecord(owner)
    && isPositiveInteger(owner.id)
    && (owner.kind === "character" || owner.kind === "corporation")
    && Array.isArray(value.assets)
    && value.assets.every((asset) => isSnapshotAsset(asset))
    && Array.isArray(value.industryJobs)
    && value.industryJobs.every((job) => isIndustryJob(job))
    && Array.isArray(value.blueprintInstances)
    && value.blueprintInstances.every((blueprint) => isBlueprintInstance(blueprint))
    && Array.isArray(value.rootLocations)
    && value.rootLocations.every(
      (entry) =>
        isRecord(entry) && isPositiveInteger(entry.itemId) && isSnapshotLocation(entry.location),
    )
    && Array.isArray(value.corporationSources)
    && value.corporationSources.every(
      (source) =>
        isRecord(source)
        && isPositiveInteger(source.corporationId)
        && isPositiveInteger(source.rootLocationId)
        && typeof source.locationFlag === "string"
        && isOptional(source.label, (candidate) => typeof candidate === "string")
        && isOptional(source.rootLocation, isSnapshotSourceLocation)
        && typeof source.canTake === "boolean"
        && typeof source.canQuery === "boolean"
        && typeof source.selected === "boolean"
        && Array.isArray(source.containerItemIds)
        && source.containerItemIds.every((itemId) => isPositiveInteger(itemId))
        && isOptional(
          source.containers,
          (containers) =>
            Array.isArray(containers)
            && containers.every(
              (container) =>
                isRecord(container)
                && isPositiveInteger(container.itemId)
                && isOptional(container.name, (name) => typeof name === "string")
                && isPositiveInteger(container.locationId)
                && isPositiveInteger(container.rootLocationId)
                && typeof container.selected === "boolean",
            ),
        ),
    )
    && isRecord(jobs)
    && isRecord(jobs.slotUsage)
    && Object
      .values(jobs.slotUsage)
      .every(
        (usage) =>
          isRecord(usage) && isNumberRecord(usage.slots) && isNumberRecord(usage.availableSlots),
      )
    && Array.isArray(jobs.jobs)
    && jobs.jobs.every((job) => isSnapshotJob(job))
    && isRecord(marketOrders)
    && (
      marketOrders.marketOrderStock === null
      || (
        Array.isArray(marketOrders.marketOrderStock)
        && marketOrders.marketOrderStock.every((item) => isSnapshotStockItem(item))
      )
    )
    && (
      marketOrders.marketBuyOrderQuantities === null
      || isNumberRecord(marketOrders.marketBuyOrderQuantities)
    )
    && isRecord(ships)
    && Array.isArray(ships.assets)
    && ships.assets.every((asset) => isSnapshotAsset(asset))
    && Array.isArray(ships.ships)
    && ships.ships.every(
      (ship) =>
        isRecord(ship)
        && isPositiveInteger(ship.itemId)
        && isPositiveInteger(ship.typeId)
        && (ship.systemId === undefined || isPositiveInteger(ship.systemId))
        && (ship.isInSpace === undefined || typeof ship.isInSpace === "boolean")
        && (ship.pilotId === undefined || isPositiveInteger(ship.pilotId)),
    )
  );
}

function readRecord(key: string) {
  return getPlanningDatabase().then(
    (database) =>
      new Promise<OwnerSnapshotRecord | undefined>((resolve, reject) => {
        const request = database
          .transaction(ownerSnapshotStoreName, "readonly")
          .objectStore(ownerSnapshotStoreName)
          .get(key);
        request.onsuccess = () => resolve(request.result as OwnerSnapshotRecord | undefined);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read owner snapshot cache."));
      }),
  );
}

/** Loads the last complete snapshot for one owner without falling back to another owner. */
export async function loadOwnerSnapshot(owner: ClientOwner, scope: string) {
  const record = await readRecord(ownerSnapshotKey(owner, scope));
  if (!record || record.scope !== scope || !isCompleteClientOwnerSnapshot(record.snapshot)) {
    return null;
  }
  const savedAt = Date.parse(record.savedAt);
  return {
    snapshot: record.snapshot,
    savedAt: record.savedAt,
    stale: !Number.isFinite(savedAt) || Date.now() - savedAt > ownerSnapshotMaxAgeMs,
  };
}

/** Loads every complete owner snapshot available for one collection scope. */
export async function loadOwnerSnapshots(
  owners: readonly ClientOwner[],
  scope: string,
): Promise<LoadedOwnerSnapshot[]> {
  const records = await Promise.all(owners.map((owner) => loadOwnerSnapshot(owner, scope)));
  return records.filter((record): record is LoadedOwnerSnapshot => record !== null);
}

/** Replaces one owner snapshot atomically after a successful complete refresh. */
export async function saveOwnerSnapshot(snapshot: ClientOwnerSnapshot, scope: string) {
  if (!isCompleteClientOwnerSnapshot(snapshot)) {
    throw new Error("Cannot cache an incomplete owner snapshot.");
  }
  const record: OwnerSnapshotRecord = {
    key: ownerSnapshotKey(snapshot.owner, scope),
    scope,
    snapshot,
    savedAt: new Date().toISOString(),
  };
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ownerSnapshotStoreName, "readwrite");
    transaction.objectStore(ownerSnapshotStoreName).put(record, record.key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save owner snapshot cache."));
  });
}
