"use client";

import type { ReactNode } from "react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { groupFittingItems, type FittingDisplayItem } from "@/lib/fittings/display";

/** Shared slot/loadout layout; callers retain ownership filtering and any nested-ship actions. */
type FittingContentsProps = {
  items: readonly FittingDisplayItem[];
  typeNames: ReadonlyMap<number, string>;
  linkPath?: string | null;
  renderItemAction?: (item: FittingDisplayItem) => ReactNode;
};

/** Renders one module, loaded charge or bay stack using the common type identity display. */
function FittingItem({
  item,
  typeNames,
  linkPath,
}: {
  item: FittingDisplayItem;
  typeNames: ReadonlyMap<number, string>;
  linkPath?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TypeIdentity
        name={item.name ?? typeNames.get(item.typeId) ?? `Type ${item.typeId}`}
        typeId={item.typeId}
        imageSize={32}
        linkPath={linkPath}
        className="min-w-0 flex-1"
      />
      {item.quantity > 1 && <span className="shrink-0">×{item.quantity.toLocaleString()}</span>}
    </div>
  );
}

/** Shows slot groups with loaded ammo alongside modules and spare ammunition in its own hold. */
export default function FittingContents({
  items,
  typeNames,
  linkPath,
  renderItemAction,
}: FittingContentsProps) {
  const groups = groupFittingItems(items);
  if (groups.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>No contained assets.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="grid min-w-0 gap-5" data-slot="fitting-contents">
      {groups.map((group) => (
        <section key={group.key} className="flex min-w-0 flex-col gap-2" aria-label={group.label}>
          <Separator />
          <h3 className="text-sm font-medium">{group.label}</h3>
          <div className="flex min-w-0 flex-col">
            {group.rows.map(({ item, ammunition }) => (
              <div
                key={item.itemId}
                className="flex min-w-0 flex-wrap items-center gap-3 border-t py-2"
              >
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
                  <FittingItem item={item} typeNames={typeNames} linkPath={linkPath} />
                  {ammunition.map((ammo) => (
                    <FittingItem
                      key={ammo.itemId}
                      item={ammo}
                      typeNames={typeNames}
                      linkPath={linkPath}
                    />
                  ))}
                </div>
                {renderItemAction?.(item)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
