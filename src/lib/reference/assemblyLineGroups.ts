/** A single custom AssemblyLine grouping bucket and its grouped items. */
export interface AssemblyLineGroup<T> {
  assemblyLineGroup: string;
  items: T[];
}

/** The ordered grouping buckets used by assets, planning, and other item views. */
export type AssemblyLineGroups<T> = AssemblyLineGroup<T>[];

/** Shared grouping operations for the custom AssemblyLine item taxonomy. */
export const AssemblyLineGroups = {
  /** Groups items by their already-resolved AssemblyLine group label. */
  groupBy<T>(
    items: readonly T[],
    getGroup: (item: T) => string | undefined,
  ): AssemblyLineGroups<T> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const assemblyLineGroup = getGroup(item);
      if (!assemblyLineGroup) continue;
      const groupItems = groups.get(assemblyLineGroup) ?? [];
      groupItems.push(item);
      groups.set(assemblyLineGroup, groupItems);
    }
    return [...groups].map(([assemblyLineGroup, groupItems]) => ({
      assemblyLineGroup,
      items: groupItems,
    }));
  },
};
