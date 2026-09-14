export type IndustrySlotCategory = "Manufacturing" | "Science" | "Reactions";

export type SlotUsage = {
  slots: Readonly<Record<string, number>>;
  availableSlots: Readonly<Record<string, number>>;
};

export type SlotUsageTotals = {
  totalSlots: number;
  inUseSlots: number;
  availableSlots: number;
};

/** Returns the currently available slots for one activity and character. */
export function getAvailableSlotCount(
  usage: SlotUsage | undefined,
  activity: IndustrySlotCategory,
): number {
  if (!usage) return 0;
  const totalSlots = usage.availableSlots[activity] ?? 0;
  const inUseSlots = usage.slots[activity] ?? 0;
  return Math.max(0, totalSlots - inUseSlots);
}

/** Aggregates slot capacity and usage for the requested attached characters. */
export function getSlotUsageTotals(
  slotUsage: Readonly<Record<string, SlotUsage>>,
  activity: IndustrySlotCategory,
  characterIds: readonly number[],
): SlotUsageTotals {
  return characterIds.reduce(
    (summary, characterId) => {
      const usage = slotUsage[String(characterId)];
      const totalSlots = usage.availableSlots[activity] ?? 0;
      const inUseSlots = usage.slots[activity] ?? 0;
      return {
        totalSlots: summary.totalSlots + totalSlots,
        inUseSlots: summary.inUseSlots + inUseSlots,
        availableSlots: summary.availableSlots + getAvailableSlotCount(usage, activity),
      };
    },
    { totalSlots: 0, inUseSlots: 0, availableSlots: 0 },
  );
}
