import type { GroupsRecord, IndustryTargetFiltersRecord, TypesRecord } from "@/lib/sde/generated";
import type { SdeLanguage } from "@/lib/reference/languages";

export const productionGroupDefinitions = [
  {
    key: "smallShips",
    label: "Small T1 Ships",
    targetFilterId: 5,
    modifierTargetFilterIds: [3, 5],
    activity: "manufacturing",
  },
  {
    key: "advancedSmallShips",
    label: "Small T2 Ships",
    targetFilterId: 6,
    modifierTargetFilterIds: [3, 6],
    activity: "manufacturing",
  },
  {
    key: "mediumShips",
    label: "Medium T1 Ships",
    targetFilterId: 7,
    modifierTargetFilterIds: [3, 7],
    activity: "manufacturing",
  },
  {
    key: "advancedMediumShips",
    label: "Medium T2 Ships",
    targetFilterId: 8,
    modifierTargetFilterIds: [3, 8],
    activity: "manufacturing",
  },
  {
    key: "largeShips",
    label: "Large T1 Ships",
    targetFilterId: 9,
    modifierTargetFilterIds: [3, 9],
    activity: "manufacturing",
  },
  {
    key: "advancedLargeShips",
    label: "Large T2 Ships",
    targetFilterId: 10,
    modifierTargetFilterIds: [3, 10],
    activity: "manufacturing",
  },
  {
    key: "capitalShips",
    label: "Capital Ships",
    targetFilterId: 11,
    modifierTargetFilterIds: [3, 11],
    activity: "manufacturing",
  },
  {
    key: "capitalComponents",
    label: "Capital Components",
    targetFilterId: 13,
    activity: "manufacturing",
  },
  {
    key: "components",
    label: "Components",
    targetFilterId: 14,
    activity: "manufacturing",
  },
  {
    key: "advancedCapitalComponents",
    label: "Advanced Capital Components",
    targetFilterId: 15,
    activity: "manufacturing",
  },
  { key: "equipment", label: "Equipment", targetFilterId: 2, activity: "manufacturing" },
  { key: "charges", label: "Charges", targetFilterId: 4, activity: "manufacturing" },
  { key: "drones", label: "Drones/Fighters", targetFilterId: 1, activity: "manufacturing" },
  { key: "structures", label: "Structures", targetFilterId: 12, activity: "manufacturing" },
  {
    key: "compositeReactions",
    label: "Composite Reactions",
    targetFilterId: 18,
    activity: "reaction",
  },
  { key: "hybridReactions", label: "Hybrid Reactions", targetFilterId: 16, activity: "reaction" },
  {
    key: "biochemicalReactions",
    label: "Bio and Gas-Phase Reactions",
    targetFilterId: 17,
    activity: "reaction",
  },
] as const;

export type ProductionGroupKey = (typeof productionGroupDefinitions)[number]["key"];
export type ProductionActivity = "manufacturing" | "reaction";

export type ProductionGroupReference = {
  key: ProductionGroupKey;
  label: string;
  targetFilterId: number;
  modifierTargetFilterIds?: readonly number[];
  activity: ProductionActivity;
  groupIds: number[];
  categoryIds: number[];
  localizedGroupNames: Record<string, string>;
};

/** Resolves the SDE target-filter memberships used by each planner group. */
export function getProductionGroupReferences(
  targetFilters: Map<number, IndustryTargetFiltersRecord>,
  groups: Map<number, GroupsRecord>,
  language: SdeLanguage = "en",
): ProductionGroupReference[] {
  return productionGroupDefinitions.map((definition) => {
    const filter = targetFilters.get(definition.targetFilterId);
    const groupIds = filter?.groupIDs ?? [];
    return {
      ...definition,
      groupIds,
      categoryIds: filter?.categoryIDs ?? [],
      localizedGroupNames: Object.fromEntries(
        groupIds.flatMap((groupId) => {
          const name = groups.get(groupId)?.name[language] ?? groups.get(groupId)?.name.en;
          return name ? [[String(groupId), name]] : [];
        }),
      ),
    };
  });
}

/** Finds the planner group matching an SDE product type. */
export function productionGroupForType(
  type: Pick<TypesRecord, "groupID"> | undefined,
  groups: Map<number, GroupsRecord>,
  references: readonly ProductionGroupReference[],
): ProductionGroupReference | undefined {
  if (!type) return undefined;
  const group = groups.get(type.groupID);
  return references.find(
    (reference) =>
      reference.groupIds.includes(type.groupID)
      || (group?.categoryID !== undefined && reference.categoryIds.includes(group.categoryID)),
  );
}
