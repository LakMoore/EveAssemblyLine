import { NextResponse } from "next/server";
import { z } from "zod";
import { getBlueprints, getMarketGroups, getTypes } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import type { BlueprintsRecord, MarketGroupsRecord, TypesRecord } from "@/lib/sde/generated";

const RESEARCH_EQUIPMENT_MARKET_GROUP_ID = 1872;

/** Classifies blueprint types using the SDE meta groups, which cover types without a tech level. */
function blueprintTechCategory(
  blueprint: BlueprintsRecord,
  type: TypesRecord | undefined,
  isResearchEquipment: boolean,
): "tech1" | "tech2" | "tech3" | "faction" | "reaction" {
  if (isResearchEquipment) return "tech3";
  if (blueprint.activities.reaction) return "reaction";
  if (type?.metaGroupID === 4 || type?.metaGroupID === 52) return "faction";
  if (type?.metaGroupID === 14) return "tech3";
  if (type?.metaGroupID === 2 || type?.metaGroupID === 53) return "tech2";
  if (type?.metaGroupID !== undefined) return "tech1";
  if (type?.techLevel === 3) return "tech3";
  if (type?.techLevel === 2) return "tech2";
  return "tech1";
}

/** Uses the product's SDE market category when a blueprint type is not itself marketed. */
function blueprintMarketGroupId(
  blueprint: BlueprintsRecord,
  types: ReadonlyMap<number, TypesRecord>,
): number | undefined {
  const blueprintGroupId = types.get(blueprint.blueprintTypeID)?.marketGroupID;
  if (blueprintGroupId !== undefined) return blueprintGroupId;
  const products = [
    ...(blueprint.activities.manufacturing?.products ?? []),
    ...(blueprint.activities.reaction?.products ?? []),
  ];
  for (const product of products) {
    const productGroupId = types.get(product.typeID)?.marketGroupID;
    if (productGroupId !== undefined) return productGroupId;
  }
  return undefined;
}

/** Names the reaction's output market group for finer formula browsing. */
function reactionProductGroupName(
  blueprint: BlueprintsRecord,
  types: ReadonlyMap<number, TypesRecord>,
  groups: ReadonlyMap<number, MarketGroupsRecord>,
  language: SdeLanguage,
): string | undefined {
  const productTypeId = blueprint.activities.reaction?.products[0]?.typeID;
  const groupId = productTypeId === undefined ? undefined : types.get(productTypeId)?.marketGroupID;
  const group = groupId === undefined ? undefined : groups.get(groupId);
  return group?.name[language] ?? group?.name.en;
}

/** Recognizes the Research Equipment market branch regardless of display language. */
function isResearchEquipmentGroup(
  marketGroupId: number | undefined,
  groups: ReadonlyMap<number, MarketGroupsRecord>,
): boolean {
  const visited = new Set<number>();
  let groupId = marketGroupId;
  while (groupId !== undefined && !visited.has(groupId)) {
    if (groupId === RESEARCH_EQUIPMENT_MARKET_GROUP_ID) return true;
    visited.add(groupId);
    groupId = groups.get(groupId)?.parentGroupID;
  }
  return false;
}

const requestSchema = z.object({
  language: z
    .custom<SdeLanguage>((value) => typeof value === "string" && isSdeLanguage(value))
    .default("en"),
});

/** Returns the localized market-group ancestry for a blueprint type. */
function marketGroupPath(
  marketGroupId: number | undefined,
  groups: ReadonlyMap<number, MarketGroupsRecord>,
  language: SdeLanguage,
): string {
  const path: string[] = [];
  const visited = new Set<number>();
  let groupId = marketGroupId;
  while (groupId !== undefined && !visited.has(groupId)) {
    visited.add(groupId);
    const group = groups.get(groupId);
    if (!group) break;
    if (group.parentGroupID !== undefined || group.name.en !== "Blueprints & Reactions") {
      path.unshift(group.name[language] ?? group.name.en);
    }
    groupId = group.parentGroupID;
  }
  return path.length ? path.join(" / ") : "Uncategorized";
}

/** Lists every SDE blueprint type grouped by its market category, without owner data. */
export async function GET(request: Request) {
  const parsed = requestSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Unsupported language." }, { status: 400 });
  }
  try {
    const { language } = parsed.data;
    const [blueprints, types, marketGroups] = await Promise.all([
      getBlueprints(),
      getTypes(),
      getMarketGroups(),
    ]);
    const grouped = new Map<
      string,
      Array<{
        typeId: number;
        name: string;
        techCategory: ReturnType<typeof blueprintTechCategory>;
        imageVariation?: "relic";
      }>
    >();
    for (const blueprint of blueprints.byBlueprintId.values()) {
      const type = types.get(blueprint.blueprintTypeID);
      const marketGroupId = blueprintMarketGroupId(blueprint, types);
      const isResearchEquipment = isResearchEquipmentGroup(marketGroupId, marketGroups);
      const marketPath = marketGroupPath(marketGroupId, marketGroups, language);
      const productGroupName = reactionProductGroupName(blueprint, types, marketGroups, language);
      const groupName = productGroupName ? `${marketPath} / ${productGroupName}` : marketPath;
      const items = grouped.get(groupName) ?? [];
      items.push({
        typeId: blueprint.blueprintTypeID,
        name: type?.name[language] ?? type?.name.en ?? `Type ${blueprint.blueprintTypeID}`,
        techCategory: blueprintTechCategory(blueprint, type, isResearchEquipment),
        ...(isResearchEquipment ? { imageVariation: "relic" as const } : {}),
      });
      grouped.set(groupName, items);
    }
    const groups = [...grouped]
      .map(([name, items]) => ({
        name,
        items: items.sort((left, right) => left.name.localeCompare(right.name, language)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, language));
    return NextResponse.json({ groups });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE blueprint data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
