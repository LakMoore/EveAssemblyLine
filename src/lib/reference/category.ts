import type { GroupsRecord, MarketGroupsRecord } from "@/lib/sde/generated";
import type { SdeLanguage } from "./languages";

export type ItemCategory = "blueprint" | "reaction" | "item";

type CategorizedType = {
  name: { en?: string };
  groupID?: number;
  marketGroupID?: number;
};

const blueprintCategoryId = 9;
const reactionFormulaGroupIds = new Set([1888, 1889, 1890, 4097]);

function categoryName(group: MarketGroupsRecord | undefined, language: SdeLanguage) {
  return group?.name[language] ?? group?.name.en;
}

function marketGroupPath(
  marketGroupId: number | undefined,
  marketGroupById: Map<number, MarketGroupsRecord>,
) {
  const path: MarketGroupsRecord[] = [];
  let current = marketGroupId === undefined ? undefined : marketGroupById.get(marketGroupId);
  while (current) {
    path.unshift(current);
    current =
      current.parentGroupID === undefined
        ? undefined
        : marketGroupById.get(current.parentGroupID);
  }
  return path;
}

export function categorizeType(
  type: CategorizedType,
  language: SdeLanguage,
  marketGroupById: Map<number, MarketGroupsRecord>,
  groupById: Map<number, GroupsRecord>,
) {
  const categoryId = type.groupID === undefined ? undefined : groupById.get(type.groupID)?.categoryID;
  const path = marketGroupPath(type.marketGroupID, marketGroupById);
  const root = path[0];
  const rootName = categoryName(root, language);

  let marketCategory = rootName;
  if (type.groupID !== undefined && reactionFormulaGroupIds.has(type.groupID)) {
    marketCategory = "Reaction Formulas";
  } else if (categoryId === blueprintCategoryId) {
    marketCategory = "Blueprints";
  } else if (categoryName(root, "en") === "Manufacture & Research") {
    marketCategory = categoryName(path[2], language) ?? rootName;
  }

  let category: ItemCategory = "item";
  if (marketCategory === "Reaction Formulas") category = "reaction";
  else if (categoryId === blueprintCategoryId) category = "blueprint";

  return { category, marketCategory };
}