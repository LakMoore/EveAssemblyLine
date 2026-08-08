import { cache } from "../cache";
import { sdeKey } from "../keys";
import {
  getBonusDogmaAttributes as loadBonusDogmaAttributes,
  getDogmaEffects as loadDogmaEffects,
  getGroups as loadGroups,
  getTypeBonuses as loadTypeBonuses,
  getBlueprints as loadBlueprints,
  getActivityInputTypeIds as loadActivityInputTypeIds,
  getMarketGroups as loadMarketGroups,
  getRigDogma as loadRigDogma,
  getSdeBuildNumber as loadSdeBuildNumber,
  getStations as loadStations,
  getSystems as loadSystems,
  getTypes as loadTypes,
} from "@/lib/sde/loader";
import type {
  BlueprintsRecord,
  BlueprintsRecordActivitiesManufacturingMaterialsItem,
  BlueprintsRecordActivitiesManufacturingProductsItem,
  BlueprintsRecordActivitiesReactionMaterialsItem,
  BlueprintsRecordActivitiesReactionProductsItem,
  DogmaAttributesRecord,
  MapSolarSystemsRecord,
  MarketGroupsRecord,
  NpcStationsRecord,
  GroupsRecord,
  TypeDogmaRecord,
  TypesRecord,
} from "@/lib/sde/generated";

export type SdeType = TypesRecord & { packagedVolume?: number };
export type SdeGroup = GroupsRecord;

export type SdeBlueprintIndexes = Awaited<ReturnType<typeof loadBlueprints>>;
export type SdeBuildBlueprint = {
  activity: "manufacturing" | "reaction";
  blueprint: BlueprintsRecord;
};

type CacheableMap<T> = Map<number, T>;

async function versionedSdeKey(namespace: string, id: string | number): Promise<string> {
  const version = await loadSdeBuildNumber();
  return sdeKey(`${version}:${namespace}`, id);
}

async function getMap<T>(load: () => Promise<CacheableMap<T>>): Promise<CacheableMap<T>> {
  return load();
}

async function getMapValue<T>(
  namespace: string,
  id: number,
  load: () => Promise<CacheableMap<T>>,
): Promise<T | null> {
  const key = await versionedSdeKey(namespace, id);
  const cached = await cache.get<T>(key);
  if (cached !== null) return cached;

  const loaded = await getMap(load);
  const value = loaded.get(id) ?? null;
  if (value !== null) await cache.set(key, value);
  return value;
}

async function getDerivedMapValue<T>(
  namespace: string,
  id: number,
  load: () => Promise<SdeBlueprintIndexes>,
  select: (indexes: SdeBlueprintIndexes) => Map<number, T>,
): Promise<T | null> {
  const key = await versionedSdeKey("blueprint", `${namespace}:${id}`);
  const cached = await cache.get<T>(key);
  if (cached !== null) return cached;

  const value = select(await load()).get(id) ?? null;
  if (value !== null) await cache.set(key, value);
  return value;
}

export function getSdeType(typeId: number): Promise<SdeType | null> {
  return getType(typeId);
}

export function getTypes() {
  return getMap(loadTypes);
}

export function getGroups() {
  return getMap(loadGroups);
}

export function getMarketGroups() {
  return getMap(loadMarketGroups);
}

export function getType(typeId: number): Promise<SdeType | null> {
  return getMapValue("type", typeId, loadTypes);
}

export async function getTypesByIds(typeIds: readonly number[]): Promise<Map<number, SdeType>> {
  if (typeIds.length === 0) return new Map();
  const version = await loadSdeBuildNumber();
  const keys = typeIds.map((typeId) => sdeKey(`${version}:type`, typeId));
  const values = await cache.getMany<SdeType>(keys);
  const isUsableType = (value: SdeType | null): value is SdeType =>
    value !== null && typeof value === "object" && typeof value.name === "object";
  const missingTypeIds = typeIds.filter((_, index) => !isUsableType(values[index]));
  if (missingTypeIds.length === 0) {
    return new Map(
      typeIds.flatMap((typeId, index) => {
        const value = values[index];
        return isUsableType(value) ? [[typeId, value] as const] : [];
      }),
    );
  }

  const loadedTypes = await getTypes();
  const resolvedEntries = typeIds.flatMap((typeId, index) => {
    const value = isUsableType(values[index]) ? values[index] : loadedTypes.get(typeId);
    return value ? [[typeId, value] as const] : [];
  });
  await cache.setMany(
    missingTypeIds.flatMap((typeId) => {
      const value = loadedTypes.get(typeId);
      return value ? [{ key: keys[typeIds.indexOf(typeId)], value }] : [];
    }),
  );
  return new Map(resolvedEntries);
}

let shipTypeIdsPromise: Promise<Set<number>> | undefined;
let haulerShipTypeIdsPromise: Promise<Set<number>> | undefined;
let structureTypeIdsPromise: Promise<Set<number>> | undefined;

export function getShipTypeIds(): Promise<Set<number>> {
  shipTypeIdsPromise ??= Promise.all([getTypes(), getGroups()])
    .then(
      ([types, groups]) =>
        new Set(
          [...types.values()]
            .filter(
              (type) =>
                groups.get(type.groupID)?.categoryID === 6,
            )
            .map((type) => type._key),
        ),
    )
    .catch((error) => {
      shipTypeIdsPromise = undefined;
      throw error;
    });
  return shipTypeIdsPromise;
}

export function getHaulerShipTypeIds(): Promise<Set<number>> {
  haulerShipTypeIdsPromise ??= Promise.all([getTypes(), getMarketGroups(), getShipTypeIds()])
    .then(([types, marketGroups, shipTypeIds]) => {
      return new Set(
        [...types.values()]
          .filter((type) => {
            if (!shipTypeIds.has(type._key) || type.marketGroupID === undefined) return false;
            let descendsFromShips = false;
            let descendsFromIndustrialOrFreighter = false;
            let group = type.marketGroupID === undefined ? undefined : marketGroups.get(type.marketGroupID);
            while (group) {
              const name = group.name.en.toLocaleLowerCase("en");
              if (name === "ships") descendsFromShips = true;
              if (name.includes("industrial") || name.includes("freighter")) {
                descendsFromIndustrialOrFreighter = true;
              }
              group = group.parentGroupID === undefined ? undefined : marketGroups.get(group.parentGroupID);
            }
            return descendsFromShips && descendsFromIndustrialOrFreighter;
          })
          .map((type) => type._key),
      );
    })
    .catch((error) => {
      haulerShipTypeIdsPromise = undefined;
      throw error;
    });
  return haulerShipTypeIdsPromise;
}

export function getStructureTypeIds(): Promise<Set<number>> {
  structureTypeIdsPromise ??= Promise.all([getTypes(), getGroups()])
    .then(
      ([types, groups]) =>
        new Set(
          [...types.values()]
            .filter((type) => groups.get(type.groupID)?.categoryID === 65)
            .map((type) => type._key),
        ),
    )
    .catch((error) => {
      structureTypeIdsPromise = undefined;
      throw error;
    });
  return structureTypeIdsPromise;
}

export function getMarketGroup(marketGroupId: number): Promise<MarketGroupsRecord | null> {
  return getMapValue("marketGroup", marketGroupId, loadMarketGroups);
}

export async function getBlueprintIndexes(): Promise<SdeBlueprintIndexes> {
  return loadBlueprints();
}

export async function getActivityInputTypeIds(): Promise<Set<number>> {
  return loadActivityInputTypeIds();
}

export async function getBuildBlueprintByProductTypeId(
  typeId: number,
): Promise<SdeBuildBlueprint | null> {
  return (
    (await getDerivedMapValue(
      "byBuildProductType",
      typeId,
      getBlueprintIndexes,
      (indexes) => indexes.byBuildProductTypeId,
    )) ?? null
  );
}

export async function getBlueprintsByInventionProductId(typeId: number) {
  return (
    (await getDerivedMapValue(
      "byInventionProduct",
      typeId,
      getBlueprintIndexes,
      (indexes) => indexes.byInventionProductId,
    )) ?? []
  );
}

export async function getProductsByTypeId(typeId: number) {
  return (
    (await getDerivedMapValue(
      "productsByType",
      typeId,
      getBlueprintIndexes,
      (indexes) => indexes.productByTypeId,
    )) ?? []
  );
}

export async function getMaterialsByBlueprintId(blueprintId: number) {
  return (
    (await getDerivedMapValue(
      "materialsByBlueprint",
      blueprintId,
      getBlueprintIndexes,
      (indexes) => indexes.materialsByBlueprintId,
    )) ?? []
  );
}

export async function getReactionMaterialsByBlueprintId(blueprintId: number) {
  return (
    (await getDerivedMapValue(
      "reactionMaterialsByBlueprint",
      blueprintId,
      getBlueprintIndexes,
      (indexes) => indexes.reactionMaterialsByBlueprintId,
    )) ?? []
  );
}

export async function getReactionProductsByTypeId(typeId: number) {
  return (
    (await getDerivedMapValue(
      "reactionProductsByType",
      typeId,
      getBlueprintIndexes,
      (indexes) => indexes.reactionProductByTypeId,
    )) ?? []
  );
}

export function getSystems() {
  return getMap(loadSystems);
}

export function getSystem(systemId: number): Promise<MapSolarSystemsRecord | null> {
  return getMapValue("solarSystem", systemId, loadSystems);
}

export function getStations() {
  return getMap(loadStations);
}

export function getStation(stationId: number): Promise<NpcStationsRecord | null> {
  return getMapValue("station", stationId, loadStations);
}

export function getRigDogma() {
  return getMap(loadRigDogma);
}

export function getRigDogmaByTypeId(typeId: number): Promise<TypeDogmaRecord | null> {
  return getMapValue("rigDogma", typeId, loadRigDogma);
}

export function getBonusDogmaAttributes() {
  return getMap(loadBonusDogmaAttributes);
}

export function getDogmaEffects() {
  return getMap(loadDogmaEffects);
}

export function getTypeBonuses() {
  return getMap(loadTypeBonuses);
}

export function getBonusDogmaAttribute(attributeId: number): Promise<DogmaAttributesRecord | null> {
  return getMapValue("bonusDogmaAttribute", attributeId, loadBonusDogmaAttributes);
}

export async function getSdeBuildNumber(): Promise<string> {
  return loadSdeBuildNumber();
}

export type {
  BlueprintsRecord,
  BlueprintsRecordActivitiesManufacturingMaterialsItem,
  BlueprintsRecordActivitiesManufacturingProductsItem,
  BlueprintsRecordActivitiesReactionMaterialsItem,
  BlueprintsRecordActivitiesReactionProductsItem,
};
export function setSdeType(typeId: number, data: SdeType, ttlMs?: number | null): Promise<void> {
  return versionedSdeKey("type", typeId).then((key) => cache.set(key, data, ttlMs));
}
