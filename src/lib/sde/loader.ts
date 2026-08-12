import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BlueprintsRecord,
  BlueprintsRecordActivitiesManufacturingMaterialsItem,
  BlueprintsRecordActivitiesManufacturingProductsItem,
  BlueprintsRecordActivitiesReactionMaterialsItem,
  BlueprintsRecordActivitiesReactionProductsItem,
  CompressibleTypesRecord,
  DogmaAttributesRecord,
  DogmaEffectsRecord,
  GroupsRecord,
  MapSolarSystemsRecord,
  MarketGroupsRecord,
  NpcStationsRecord,
  TypeDogmaRecord,
  TypeBonusRecord,
  TypesRecord,
  TypeMaterialsRecord,
} from "./generated";

const processedDir = resolve("sde/processed");
export type LoadedType = TypesRecord & { packagedVolume?: number };
let sdeBuildNumber = "unknown";
const typeById = new Map<number, LoadedType>();
const marketGroupById = new Map<number, MarketGroupsRecord>();
const blueprintByBuildProductTypeId = new Map<
  number,
  { activity: "manufacturing" | "reaction"; blueprint: BlueprintsRecord }
>();
const blueprintById = new Map<number, BlueprintsRecord>();
const blueprintByInventionProductId = new Map<number, BlueprintsRecord[]>();
const productByTypeId = new Map<number, BlueprintsRecordActivitiesManufacturingProductsItem[]>();
const materialsByBlueprintId = new Map<
  number,
  BlueprintsRecordActivitiesManufacturingMaterialsItem[]
>();
const reactionMaterialsByBlueprintId = new Map<
  number,
  BlueprintsRecordActivitiesReactionMaterialsItem[]
>();
const activityInputTypeIds = new Set<number>();
const reactionProductByTypeId = new Map<number, BlueprintsRecordActivitiesReactionProductsItem[]>();
const compressibleTypeByTypeId = new Map<number, number>();
const typeMaterialsByTypeId = new Map<number, TypeMaterialsRecord>();
const dogmaEffectById = new Map<number, DogmaEffectsRecord>();
const groupById = new Map<number, GroupsRecord>();
const typeBonusById = new Map<number, TypeBonusRecord>();
const systemById = new Map<number, MapSolarSystemsRecord>();
const stationById = new Map<number, NpcStationsRecord>();
const rigDogmaByTypeId = new Map<number, TypeDogmaRecord>();
const typeDogmaByTypeId = new Map<number, TypeDogmaRecord>();
const bonusDogmaAttributesById = new Map<number, DogmaAttributesRecord>();
const dogmaAttributeById = new Map<number, DogmaAttributesRecord>();
const loadPromises = new Map<string, Promise<unknown>>();

function records<T>(file: string) {
  const path = join(processedDir, file);
  if (!existsSync(path)) return [] as T[];
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(value) ? (value as T[]) : [];
}

function packagedVolumes() {
  const path = join(processedDir, "repackagedvolumes.json");
  if (!existsSync(path)) return new Map<number, number>();
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map<number, number>();
  return new Map(
    Object.entries(value).flatMap(([typeId, volume]) =>
      /^\d+$/.test(typeId) && typeof volume === "number" && Number.isFinite(volume) && volume >= 0
        ? [[Number(typeId), volume] as const]
        : [],
    ),
  );
}

function requireProcessedSde() {
  if (!existsSync(processedDir))
    throw new Error("SDE is not prepared. Run npm run sde:prepare before using SDE-backed routes.");
}

function getOnce<T>(name: string, get: () => T) {
  const cached = loadPromises.get(name);
  if (cached) return cached as Promise<T>;
  const promise = Promise.resolve()
    .then(() => {
      requireProcessedSde();
      return get();
    })
    .catch((error) => {
      loadPromises.delete(name);
      throw error;
    });
  loadPromises.set(name, promise);
  return promise;
}

export function getTypes() {
  return getOnce("types", () => {
    const packagedVolumeByTypeId = packagedVolumes();
    for (const record of records<TypesRecord>("types.json")) {
      const packagedVolume = packagedVolumeByTypeId.get(record._key);
      typeById.set(record._key, packagedVolume === undefined ? record : { ...record, packagedVolume });
    }
    return typeById;
  });
}

export function getMarketGroups() {
  return getOnce("marketGroups", () => {
    for (const record of records<MarketGroupsRecord>("marketGroups.json"))
      marketGroupById.set(record._key, record);
    return marketGroupById;
  });
}

export function getBlueprints() {
  return getOnce("blueprints", () => {
    for (const record of records<BlueprintsRecord>("blueprints.json")) {
      blueprintById.set(record._key, record);
      const manufacturing = record.activities.manufacturing;
      if (manufacturing?.materials)
        materialsByBlueprintId.set(record._key, manufacturing.materials);
      if (manufacturing?.products) {
        for (const product of manufacturing.products) {
          blueprintByBuildProductTypeId.set(product.typeID, {
            activity: "manufacturing",
            blueprint: record,
          });
        }
        for (const product of manufacturing.products) {
          productByTypeId.set(product.typeID, [
            ...(productByTypeId.get(product.typeID) ?? []),
            product,
          ]);
        }
      }
      const reaction = record.activities.reaction;
      if (reaction?.materials) reactionMaterialsByBlueprintId.set(record._key, reaction.materials);
      if (reaction?.products) {
        for (const product of reaction.products) {
          blueprintByBuildProductTypeId.set(product.typeID, {
            activity: "reaction",
            blueprint: record,
          });
          reactionProductByTypeId.set(product.typeID, [
            ...(reactionProductByTypeId.get(product.typeID) ?? []),
            product,
          ]);
        }
      }
      const invention = record.activities.invention;
      for (const product of invention?.products ?? []) {
        blueprintByInventionProductId.set(product.typeID, [
          ...(blueprintByInventionProductId.get(product.typeID) ?? []),
          record,
        ]);
      }
    }
    return {
      byBuildProductTypeId: blueprintByBuildProductTypeId,
      byBlueprintId: blueprintById,
      byInventionProductId: blueprintByInventionProductId,
      productByTypeId,
      materialsByBlueprintId,
      reactionMaterialsByBlueprintId,
      reactionProductByTypeId,
    };
  });
}

export function getCompressibleTypes() {
  return getOnce("compressibleTypes", () => {
    const typeNames = new Map(
      records<TypesRecord>("types.json").map((record) => [record._key, record.name.en] as const),
    );
    for (const record of records<CompressibleTypesRecord>("compressibleTypes.json")) {
      if (typeNames.get(record.compressedTypeID)?.startsWith("Batch Compressed ")) continue;
      compressibleTypeByTypeId.set(record._key, record.compressedTypeID);
    }
    return compressibleTypeByTypeId;
  });
}

export function getTypeMaterials() {
  return getOnce("typeMaterials", () => {
    for (const record of records<TypeMaterialsRecord>("typeMaterials.json")) {
      typeMaterialsByTypeId.set(record._key, record);
    }
    return typeMaterialsByTypeId;
  });
}

export function getActivityInputTypeIds() {
  return getOnce("activityInputTypeIds", async () => {
    const indexes = await getBlueprints();
    for (const materials of indexes.materialsByBlueprintId.values()) {
      for (const material of materials) activityInputTypeIds.add(material.typeID);
    }
    for (const materials of indexes.reactionMaterialsByBlueprintId.values()) {
      for (const material of materials) activityInputTypeIds.add(material.typeID);
    }
    for (const blueprint of records<BlueprintsRecord>("blueprints.json")) {
      for (const material of blueprint.activities.invention?.materials ?? [])
        activityInputTypeIds.add(material.typeID);
    }
    return activityInputTypeIds;
  });
}

export function getSystems() {
  return getOnce("systems", () => {
    for (const record of records<MapSolarSystemsRecord>("mapSolarSystems.json"))
      systemById.set(record._key, record);
    return systemById;
  });
}

export function getStations() {
  return getOnce("stations", () => {
    for (const record of records<NpcStationsRecord>("npcStations.json"))
      stationById.set(record._key, record);
    return stationById;
  });
}

export function getRigDogma() {
  return getOnce("rigDogma", () => {
    for (const record of records<TypeDogmaRecord>("typeDogma.json"))
      rigDogmaByTypeId.set(record._key, record);
    return rigDogmaByTypeId;
  });
}

export function getTypeDogma() {
  return getOnce("typeDogma", () => {
    for (const record of records<TypeDogmaRecord>("typeDogma.json"))
      typeDogmaByTypeId.set(record._key, record);
    return typeDogmaByTypeId;
  });
}

export function getBonusDogmaAttributes() {
  return getOnce("bonusDogmaAttributes", () => {
    for (const record of records<DogmaAttributesRecord>("dogmaAttributes.json"))
      if (record.attributeCategoryID === 37) bonusDogmaAttributesById.set(record._key, record);
    return bonusDogmaAttributesById;
  });
}

export function getDogmaAttributes() {
  return getOnce("dogmaAttributes", () => {
    for (const record of records<DogmaAttributesRecord>("dogmaAttributes.json"))
      dogmaAttributeById.set(record._key, record);
    return dogmaAttributeById;
  });
}

export function getDogmaEffects() {
  return getOnce("dogmaEffects", () => {
    for (const record of records<DogmaEffectsRecord>("dogmaEffects.json"))
      dogmaEffectById.set(record._key, record);
    return dogmaEffectById;
  });
}

export function getGroups() {
  return getOnce("groups", () => {
    for (const record of records<GroupsRecord>("groups.json")) groupById.set(record._key, record);
    return groupById;
  });
}

export function getTypeBonuses() {
  return getOnce("typeBonuses", () => {
    for (const record of records<TypeBonusRecord>("typeBonus.json"))
      typeBonusById.set(record._key, record);
    return typeBonusById;
  });
}

export function getSdeBuildNumber() {
  return getOnce("metadata", () => {
    const metadata = records<{ buildNumber?: unknown }>("_sde.json")[0];
    sdeBuildNumber =
      typeof metadata?.buildNumber === "number" ? String(metadata.buildNumber) : "unknown";
    return sdeBuildNumber;
  });
}
