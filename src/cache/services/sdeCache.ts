import { cache } from "../cache";
import { sdeKey } from "../keys";
import {
  getBonusDogmaAttributes as loadBonusDogmaAttributes,
  getBlueprints as loadBlueprints,
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
  TypeDogmaRecord,
  TypesRecord,
} from "@/lib/sde/generated";

export type SdeType = TypesRecord;

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

export function getType(typeId: number): Promise<TypesRecord | null> {
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

export function getMarketGroups() {
  return getMap(loadMarketGroups);
}

export function getMarketGroup(marketGroupId: number): Promise<MarketGroupsRecord | null> {
  return getMapValue("marketGroup", marketGroupId, loadMarketGroups);
}

export async function getBlueprintIndexes(): Promise<SdeBlueprintIndexes> {
  return loadBlueprints();
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
