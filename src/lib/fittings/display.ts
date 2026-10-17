import type { FittingInput } from "./model";

/** Common display shape for live ship assets and saved fitting items. */
export type FittingDisplayItem = {
  itemId: number;
  typeId: number;
  quantity: number;
  locationFlag: string;
  name?: string;
  isAmmo?: boolean;
};

/** A module or bay item, with any loaded ammunition displayed alongside it. */
export type FittingDisplayRow = { item: FittingDisplayItem; ammunition: FittingDisplayItem[] };

/** Ordered slot group shared by both fitting dialogs. */
export type FittingDisplayGroup = { key: string; label: string; rows: FittingDisplayRow[] };

const slotGroups = [
  { prefix: "HiSlot", label: "High Slots", base: 27 },
  { prefix: "MedSlot", label: "Medium Slots", base: 19 },
  { prefix: "LoSlot", label: "Low Slots", base: 11 },
  { prefix: "RigSlot", label: "Rig Slots", base: 92 },
  { prefix: "SubSystemSlot", label: "Subsystem Slots", base: 125 },
  { prefix: "ServiceSlot", label: "Service Slots", base: 164 },
];

/** Converts stored numeric fitting flags to the symbolic flags used by ship assets. */
function locationFlag(flag: number): string {
  const group = slotGroups.find((candidate) => flag >= candidate.base && flag < candidate.base + 8);
  if (group) return `${group.prefix}${flag - group.base}`;
  return flag === 5
    ? "Cargo"
    : flag === 87
      ? "DroneBay"
      : flag === 158
        ? "FighterBay"
        : `Flag ${flag}`;
}

/** Adapts saved fitting items without treating their list positions as durable asset identifiers. */
export function fittingDisplayItems(
  items: FittingInput["items"],
  ammunitionTypeIds: ReadonlySet<number>,
): FittingDisplayItem[] {
  return items.map((item, index) => ({
    itemId: index,
    typeId: item.type_id,
    quantity: item.quantity,
    locationFlag: locationFlag(item.flag),
    isAmmo: ammunitionTypeIds.has(item.type_id),
  }));
}

/** Identifies a slot group while keeping other holds separately named and ordered. */
function groupDetails(flag: string) {
  const match = flag.match(/^(HiSlot|MedSlot|LoSlot|RigSlot|SubSystemSlot|ServiceSlot)(\d+)$/);
  const order = slotGroups.findIndex((group) => group.prefix === match?.[1]);
  return order >= 0 && match
    ? { key: match[1], label: slotGroups[order].label, order, slot: Number(match[2]) }
    : {
        key: flag,
        label: flag.replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
        order: slotGroups.length,
        slot: Number.MAX_SAFE_INTEGER,
      };
}

/** Groups modules by slot and pairs only charges loaded into the same high/medium/low slot. */
export function groupFittingItems(items: readonly FittingDisplayItem[]): FittingDisplayGroup[] {
  const modules = new Map(
    items
      .filter((item) => !item.isAmmo && /^(HiSlot|MedSlot|LoSlot)\d+$/.test(item.locationFlag))
      .map((item) => [item.locationFlag, item]),
  );
  const ammunition = new Map<number, FittingDisplayItem[]>();
  const pairedIds = new Set<number>();
  for (const item of items) {
    const fittedModule = item.isAmmo ? modules.get(item.locationFlag) : undefined;
    if (!fittedModule) continue;
    ammunition.set(fittedModule.itemId, [...(ammunition.get(fittedModule.itemId) ?? []), item]);
    pairedIds.add(item.itemId);
  }
  const groups = new Map<string, FittingDisplayGroup & { order: number }>();
  for (const item of items) {
    if (pairedIds.has(item.itemId)) continue;
    const details = groupDetails(item.locationFlag);
    const group = groups.get(details.key) ?? {
      key: details.key,
      label: details.label,
      order: details.order,
      rows: [],
    };
    group.rows.push({ item, ammunition: ammunition.get(item.itemId) ?? [] });
    groups.set(details.key, group);
  }
  return [...groups.values()]
    .sort((first, second) => first.order - second.order || first.label.localeCompare(second.label))
    .map(({ key, label, rows }) => ({
      key,
      label,
      rows: rows.sort(
        (first, second) =>
          groupDetails(first.item.locationFlag).slot - groupDetails(second.item.locationFlag).slot
          || first.item.itemId - second.item.itemId,
      ),
    }));
}
