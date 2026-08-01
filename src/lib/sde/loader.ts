import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
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
} from "./generated";

const processedDir = resolve("sde/processed");
let sdeBuildNumber = "unknown";
const typeById = new Map<number, TypesRecord>();
const marketGroupById = new Map<number, MarketGroupsRecord>();
const blueprintByBuildProductTypeId = new Map<
  number,
  { activity: "manufacturing" | "reaction"; blueprint: BlueprintsRecord }
>();
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
const reactionProductByTypeId = new Map<number, BlueprintsRecordActivitiesReactionProductsItem[]>();
const systemById = new Map<number, MapSolarSystemsRecord>();
const stationById = new Map<number, NpcStationsRecord>();
const rigDogmaByTypeId = new Map<number, TypeDogmaRecord>();
const bonusDogmaAttributesById = new Map<number, DogmaAttributesRecord>();
const loadPromises = new Map<string, Promise<unknown>>();

function records<T>(file: string) {
  const path = join(processedDir, file);
  if (!existsSync(path)) return [] as T[];
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(value) ? (value as T[]) : [];
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
    for (const record of records<TypesRecord>("types.json")) typeById.set(record._key, record);
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
      byInventionProductId: blueprintByInventionProductId,
      productByTypeId,
      materialsByBlueprintId,
      reactionMaterialsByBlueprintId,
      reactionProductByTypeId,
    };
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

export function getBonusDogmaAttributes() {
  return getOnce("bonusDogmaAttributes", () => {
    for (const record of records<DogmaAttributesRecord>("dogmaAttributes.json"))
      if (record.attributeCategoryID === 37) bonusDogmaAttributesById.set(record._key, record);
    return bonusDogmaAttributesById;
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
