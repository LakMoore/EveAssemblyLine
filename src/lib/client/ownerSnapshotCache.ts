import type {
  AssetLocation,
  AssetRecord,
  BlueprintInstanceRecord,
  CharacterSkillRecord,
  IndustryJobRecord,
} from "@/lib/auth/model";
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
type ClientOwnerSnapshotMarketOrder = {
  typeId: number;
  locationId: number;
  buyOrderQuantity: number;
  sellOrderQuantity: number;
};
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
  outputLocationName?: string;
  blueprintTypeId: number;
  productTypeId?: number;
};
type ClientOwnerSnapshotShipItem = Omit<
  ClientOwnerSnapshotAsset,
  "ownerType" | "ownerId" | "rootLocation"
> & {
  isAmmo: boolean;
};
type ClientOwnerSnapshotShip = {
  itemId: number;
  typeId: number;
  name?: string;
  systemId?: number;
  isInSpace?: boolean;
  pilotId?: number;
  ownerType: "character" | "corporation";
  ownerId: number;
  rootLocation?: ClientOwnerSnapshotLocation;
  items: ClientOwnerSnapshotShipItem[];
};

export type ClientOwnerSnapshotSlice<T extends readonly unknown[]> = {
  eTag: string;
  data: T;
  status: ClientOwnerSnapshotEndpointStatus;
};

export type ClientOwnerSnapshotEndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
  hasBody: boolean;
  lastModified?: string;
  lastUpdated?: string;
  expires?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
};

export type ClientOwnerSnapshotResponseSlice<T extends readonly unknown[]> = {
  eTag: string;
  isEmpty: boolean;
  isModified: boolean;
  status: ClientOwnerSnapshotEndpointStatus;
  data?: T;
};

export type ClientOwnerSnapshot = {
  schemaVersion: 6;
  owner: ClientOwner;
  industrySlots?: {
    Manufacturing: number;
    Reactions: number;
    Science: number;
  };
  assets: ClientOwnerSnapshotSlice<ClientOwnerSnapshotAsset[]>;
  industryJobs: ClientOwnerSnapshotSlice<IndustryJobRecord[]>;
  blueprintInstances: ClientOwnerSnapshotSlice<BlueprintInstanceRecord[]>;
  rootLocations: ClientOwnerSnapshotSlice<
    Array<{ itemId: number; location: ClientOwnerSnapshotLocation }>
  >;
  corporationSources: ClientOwnerSnapshotSlice<
    Array<{
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
    }>
  >;
  jobs: ClientOwnerSnapshotSlice<ClientOwnerSnapshotJob[]>;
  marketOrders: ClientOwnerSnapshotSlice<ClientOwnerSnapshotMarketOrder[]>;
  ships: ClientOwnerSnapshotSlice<ClientOwnerSnapshotShip[]>;
  skills: ClientOwnerSnapshotSlice<CharacterSkillRecord[]>;
};

export type ClientOwnerSnapshotResponse = {
  schemaVersion: 6;
  owner: ClientOwner;
  industrySlots?: ClientOwnerSnapshot["industrySlots"];
  assets: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["assets"]["data"]>;
  industryJobs: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["industryJobs"]["data"]>;
  blueprintInstances: ClientOwnerSnapshotResponseSlice<
    ClientOwnerSnapshot["blueprintInstances"]["data"]
  >;
  rootLocations: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["rootLocations"]["data"]>;
  corporationSources: ClientOwnerSnapshotResponseSlice<
    ClientOwnerSnapshot["corporationSources"]["data"]
  >;
  jobs: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["jobs"]["data"]>;
  marketOrders: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["marketOrders"]["data"]>;
  ships: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["ships"]["data"]>;
  skills: ClientOwnerSnapshotResponseSlice<ClientOwnerSnapshot["skills"]["data"]>;
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

function isAssetItemId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
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
    isAssetItemId(value.itemId)
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

function isSnapshotShipItem(value: unknown): value is ClientOwnerSnapshotShipItem {
  return (
    isRecord(value)
    && isPositiveInteger(value.itemId)
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
    && typeof value.isAmmo === "boolean"
    && isOptional(value.inUse, (candidate) => typeof candidate === "boolean")
    && isOptional(value.runCount, (candidate) => Number.isSafeInteger(candidate))
    && isOptional(value.me, isNonNegativeNumber)
    && isOptional(value.te, isNonNegativeNumber)
  );
}

function isSnapshotShip(value: unknown): value is ClientOwnerSnapshotShip {
  return (
    isRecord(value)
    && isPositiveInteger(value.itemId)
    && isPositiveInteger(value.typeId)
    && isOptional(value.name, (name) => typeof name === "string")
    && (value.systemId === undefined || isPositiveInteger(value.systemId))
    && (value.isInSpace === undefined || typeof value.isInSpace === "boolean")
    && (value.pilotId === undefined || isPositiveInteger(value.pilotId))
    && (value.ownerType === "character" || value.ownerType === "corporation")
    && isPositiveInteger(value.ownerId)
    && isOptional(value.rootLocation, isSnapshotLocation)
    && Array.isArray(value.items)
    && value.items.every((item) => isSnapshotShipItem(item))
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

function isCharacterSkill(value: unknown): value is CharacterSkillRecord {
  return (
    isRecord(value)
    && isPositiveInteger(value.skillId)
    && isNonNegativeNumber(value.activeSkillLevel)
  );
}

function isSnapshotSlice<T extends readonly unknown[]>(
  value: unknown,
  isData: (candidate: unknown) => candidate is T,
): value is ClientOwnerSnapshotSlice<T> {
  return (
    isRecord(value)
    && typeof value.eTag === "string"
    && isSnapshotEndpointStatus(value.status)
    && isData(value.data)
  );
}

function isSnapshotEndpointStatus(value: unknown): value is ClientOwnerSnapshotEndpointStatus {
  return (
    isRecord(value)
    && ["fresh", "cached", "stale", "rate_limited", "error"].includes(String(value.status))
    && typeof value.hasBody === "boolean"
    && isOptional(value.lastModified, (candidate) => typeof candidate === "string")
    && isOptional(value.lastUpdated, (candidate) => typeof candidate === "string")
    && isOptional(value.expires, (candidate) => typeof candidate === "string")
    && isOptional(value.rateLimitedUntil, (candidate) => typeof candidate === "string")
    && isOptional(value.error, (candidate) => typeof candidate === "string")
    && isOptional(value.reauthorizeRequired, (candidate) => typeof candidate === "boolean")
  );
}

function isSnapshotResponseSlice<T extends readonly unknown[]>(
  value: unknown,
  isData: (candidate: unknown) => candidate is T,
): value is ClientOwnerSnapshotResponseSlice<T> {
  return (
    isRecord(value)
    && typeof value.eTag === "string"
    && value.eTag.length > 0
    && typeof value.isEmpty === "boolean"
    && typeof value.isModified === "boolean"
    && isSnapshotEndpointStatus(value.status)
    && (value.isModified ? isData(value.data) : value.data === undefined)
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

function isSnapshotMarketOrder(value: unknown): value is ClientOwnerSnapshotMarketOrder {
  return (
    isRecord(value)
    && isPositiveInteger(value.typeId)
    && isPositiveInteger(value.locationId)
    && isNonNegativeNumber(value.buyOrderQuantity)
    && isNonNegativeNumber(value.sellOrderQuantity)
  );
}

function isIndustrySlots(value: unknown) {
  return (
    isRecord(value)
    && isNonNegativeNumber(value.Manufacturing)
    && isNonNegativeNumber(value.Reactions)
    && isNonNegativeNumber(value.Science)
  );
}

export function isCompleteClientOwnerSnapshot(value: unknown): value is ClientOwnerSnapshot {
  if (!isRecord(value)) return false;
  const owner = value.owner;
  const jobs = value.jobs;
  const marketOrders = value.marketOrders;
  const ships = value.ships;
  const skills = value.skills;
  return (
    value.schemaVersion === 6
    && isRecord(owner)
    && isPositiveInteger(owner.id)
    && (owner.kind === "character" || owner.kind === "corporation")
    && isOptional(value.industrySlots, isIndustrySlots)
    && isSnapshotSlice(
      value.assets,
      (data): data is ClientOwnerSnapshotAsset[] =>
        Array.isArray(data) && data.every((asset) => isSnapshotAsset(asset)),
    )
    && isSnapshotSlice(
      value.industryJobs,
      (data): data is IndustryJobRecord[] =>
        Array.isArray(data) && data.every((job) => isIndustryJob(job)),
    )
    && isSnapshotSlice(
      value.blueprintInstances,
      (data): data is BlueprintInstanceRecord[] =>
        Array.isArray(data) && data.every((blueprint) => isBlueprintInstance(blueprint)),
    )
    && isSnapshotSlice(
      value.rootLocations,
      (data): data is ClientOwnerSnapshot["rootLocations"]["data"] =>
        Array.isArray(data)
        && data.every(
          (entry) =>
            isRecord(entry)
            && isPositiveInteger(entry.itemId)
            && isSnapshotLocation(entry.location),
        ),
    )
    && isSnapshotSlice(
      value.corporationSources,
      (data): data is ClientOwnerSnapshot["corporationSources"]["data"] =>
        Array.isArray(data)
        && data.every(
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
        ),
    )
    && isSnapshotSlice(
      jobs,
      (data): data is ClientOwnerSnapshotJob[] =>
        Array.isArray(data) && data.every((job) => isSnapshotJob(job)),
    )
    && isSnapshotSlice(
      marketOrders,
      (data): data is ClientOwnerSnapshotMarketOrder[] =>
        Array.isArray(data) && data.every((order) => isSnapshotMarketOrder(order)),
    )
    && isSnapshotSlice(
      ships,
      (data): data is ClientOwnerSnapshotShip[] =>
        Array.isArray(data) && data.every((ship) => isSnapshotShip(ship)),
    )
    && isSnapshotSlice(
      skills,
      (data): data is CharacterSkillRecord[] =>
        Array.isArray(data) && data.every((skill) => isCharacterSkill(skill)),
    )
  );
}

/** Validates the partial per-slice response returned by an owner refresh. */
export function isCompleteClientOwnerSnapshotResponse(
  value: unknown,
): value is ClientOwnerSnapshotResponse {
  if (!isRecord(value)) return false;
  const owner = value.owner;
  return (
    value.schemaVersion === 6
    && isRecord(owner)
    && isPositiveInteger(owner.id)
    && (owner.kind === "character" || owner.kind === "corporation")
    && isOptional(value.industrySlots, isIndustrySlots)
    && isSnapshotResponseSlice(
      value.assets,
      (data): data is ClientOwnerSnapshot["assets"]["data"] =>
        Array.isArray(data) && data.every((asset) => isSnapshotAsset(asset)),
    )
    && isSnapshotResponseSlice(
      value.industryJobs,
      (data): data is ClientOwnerSnapshot["industryJobs"]["data"] =>
        Array.isArray(data) && data.every((job) => isIndustryJob(job)),
    )
    && isSnapshotResponseSlice(
      value.blueprintInstances,
      (data): data is ClientOwnerSnapshot["blueprintInstances"]["data"] =>
        Array.isArray(data) && data.every((blueprint) => isBlueprintInstance(blueprint)),
    )
    && isSnapshotResponseSlice(
      value.rootLocations,
      (data): data is ClientOwnerSnapshot["rootLocations"]["data"] =>
        Array.isArray(data)
        && data.every(
          (entry) =>
            isRecord(entry)
            && isPositiveInteger(entry.itemId)
            && isSnapshotLocation(entry.location),
        ),
    )
    && isSnapshotResponseSlice(
      value.corporationSources,
      (data): data is ClientOwnerSnapshot["corporationSources"]["data"] =>
        Array.isArray(data)
        && data.every(
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
            && source.containerItemIds.every((itemId) => isPositiveInteger(itemId)),
        ),
    )
    && isSnapshotResponseSlice(
      value.jobs,
      (data): data is ClientOwnerSnapshot["jobs"]["data"] =>
        Array.isArray(data) && data.every((job) => isSnapshotJob(job)),
    )
    && isSnapshotResponseSlice(
      value.marketOrders,
      (data): data is ClientOwnerSnapshot["marketOrders"]["data"] =>
        Array.isArray(data) && data.every((order) => isSnapshotMarketOrder(order)),
    )
    && isSnapshotResponseSlice(
      value.ships,
      (data): data is ClientOwnerSnapshot["ships"]["data"] =>
        Array.isArray(data) && data.every((ship) => isSnapshotShip(ship)),
    )
    && isSnapshotResponseSlice(
      value.skills,
      (data): data is ClientOwnerSnapshot["skills"]["data"] =>
        Array.isArray(data) && data.every((skill) => isCharacterSkill(skill)),
    )
  );
}

/** Returns the persisted etags that can be sent with the next owner refresh. */
export function getOwnerSnapshotETags(snapshot: ClientOwnerSnapshot) {
  return {
    assets: snapshot.assets.eTag,
    blueprintInstances: snapshot.blueprintInstances.eTag,
    corporationSources: snapshot.corporationSources.eTag,
    industryJobs: snapshot.industryJobs.eTag,
    jobs: snapshot.jobs.eTag,
    marketOrders: snapshot.marketOrders.eTag,
    rootLocations: snapshot.rootLocations.eTag,
    ships: snapshot.ships.eTag,
    skills: snapshot.skills.eTag,
  };
}

function mergeSnapshotSlice<T extends readonly unknown[]>(
  previous: ClientOwnerSnapshotSlice<T> | null,
  response: ClientOwnerSnapshotResponseSlice<T>,
) {
  if (!response.isModified) {
    if (!previous || previous.eTag !== response.eTag) {
      throw new Error("Refresh returned an unchanged slice without a matching cached snapshot.");
    }
    return { ...previous, status: response.status };
  }
  if (response.data === undefined) {
    throw new Error("Refresh returned a modified slice without data.");
  }
  return { eTag: response.eTag, data: response.data, status: response.status };
}

/** Merges a partial refresh response with the previously persisted owner snapshot. */
export function mergeOwnerSnapshot(
  previous: ClientOwnerSnapshot | null,
  response: ClientOwnerSnapshotResponse,
): ClientOwnerSnapshot {
  return {
    schemaVersion: 6,
    owner: response.owner,
    ...(response.industrySlots ? { industrySlots: response.industrySlots } : {}),
    assets: mergeSnapshotSlice(previous?.assets ?? null, response.assets),
    industryJobs: mergeSnapshotSlice(previous?.industryJobs ?? null, response.industryJobs),
    blueprintInstances: mergeSnapshotSlice(
      previous?.blueprintInstances ?? null,
      response.blueprintInstances,
    ),
    rootLocations: mergeSnapshotSlice(previous?.rootLocations ?? null, response.rootLocations),
    corporationSources: mergeSnapshotSlice(
      previous?.corporationSources ?? null,
      response.corporationSources,
    ),
    jobs: mergeSnapshotSlice(previous?.jobs ?? null, response.jobs),
    marketOrders: mergeSnapshotSlice(previous?.marketOrders ?? null, response.marketOrders),
    ships: mergeSnapshotSlice(previous?.ships ?? null, response.ships),
    skills: mergeSnapshotSlice(previous?.skills ?? null, response.skills),
  };
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
