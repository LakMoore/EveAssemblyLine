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
let loaded = false;
let sdeBuildNumber = "unknown";
const typeById = new Map<number, TypesRecord>();
const marketGroupById = new Map<number, MarketGroupsRecord>();
const blueprintByProductTypeId = new Map<number, BlueprintsRecord[]>();
const blueprintByReactionProductTypeId = new Map<number, BlueprintsRecord[]>();
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

function records<T>(file: string) {
  const path = join(processedDir, file);
  if (!existsSync(path)) return [] as T[];
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(value) ? (value as T[]) : [];
}

export function ensureSdeLoaded() {
  if (loaded) return;
  if (!existsSync(processedDir))
    throw new Error("SDE is not prepared. Run npm run sde:prepare before using SDE-backed routes.");
  const metadata = records<{ buildNumber?: unknown }>("_sde.json")[0];
  if (typeof metadata?.buildNumber === "number") sdeBuildNumber = String(metadata.buildNumber);
  for (const record of records<TypesRecord>("types.json")) {
    typeById.set(record._key, record);
  }
  for (const record of records<MarketGroupsRecord>("marketGroups.json"))
    marketGroupById.set(record._key, record);
  for (const record of records<BlueprintsRecord>("blueprints.json")) {
    const manufacturing = record.activities.manufacturing;
    if (manufacturing?.materials) materialsByBlueprintId.set(record._key, manufacturing.materials);
    if (manufacturing?.products) {
      for (const product of manufacturing.products) {
        blueprintByProductTypeId.set(product.typeID, [
          ...(blueprintByProductTypeId.get(product.typeID) ?? []),
          record,
        ]);
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
        blueprintByReactionProductTypeId.set(product.typeID, [
          ...(blueprintByReactionProductTypeId.get(product.typeID) ?? []),
          record,
        ]);
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
  for (const record of records<MapSolarSystemsRecord>("mapSolarSystems.json"))
    systemById.set(record._key, record);
  for (const record of records<NpcStationsRecord>("npcStations.json"))
    stationById.set(record._key, record);
  for (const record of records<TypeDogmaRecord>("typeDogma.json"))
    rigDogmaByTypeId.set(record._key, record);
  for (const record of records<DogmaAttributesRecord>("dogmaAttributes.json"))
    if (record.attributeCategoryID === 37) bonusDogmaAttributesById.set(record._key, record);
  loaded = true;
}

export {
  blueprintByProductTypeId,
  blueprintByReactionProductTypeId,
  blueprintByInventionProductId,
  typeById,
  marketGroupById,
  productByTypeId,
  materialsByBlueprintId,
  reactionMaterialsByBlueprintId,
  reactionProductByTypeId,
  systemById,
  stationById,
  rigDogmaByTypeId,
  bonusDogmaAttributesById,
  sdeBuildNumber,
};
