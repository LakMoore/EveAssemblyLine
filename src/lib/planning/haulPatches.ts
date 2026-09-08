import type { ClientCharacterStatus } from "@/lib/client/requestCache";
import type { HaulPatch, PlanResult, PlanStockItem, StockOwnerType } from "./types";
import { getStockRootLocationId } from "./stockPolicies";

export function createHaulPatchKey(
  fromLocationId: number,
  toLocationId: number,
  itemTypeId: number,
  ownerType: StockOwnerType,
  ownerId: number,
) {
  return `${fromLocationId}:${toLocationId}:${itemTypeId}:${ownerType}:${ownerId}`;
}

/** Returns an owner identity only when the haul task can be safely attributed to one owner. */
export function getHaulTaskOwner(
  task: PlanResult["lists"]["haulingTasks"][number],
): { ownerType: StockOwnerType; ownerId: number } | null {
  const ownerId = task.ownerId;
  if (
    (task.ownerType !== "character" && task.ownerType !== "corporation")
    || typeof ownerId !== "number"
    || !Number.isInteger(ownerId)
  ) {
    return null;
  }
  return { ownerType: task.ownerType, ownerId };
}

/** Creates a persisted patch from a single-owner haul task and its current asset freshness. */
export function createHaulPatch(
  task: PlanResult["lists"]["haulingTasks"][number],
  assetsLastModified?: string,
): HaulPatch | null {
  const owner = getHaulTaskOwner(task);
  if (!owner || task.quantity <= 0) return null;
  return {
    key: createHaulPatchKey(
      task.fromLocationId,
      task.toLocationId,
      task.itemTypeId,
      owner.ownerType,
      owner.ownerId,
    ),
    itemTypeId: task.itemTypeId,
    name: task.name,
    quantity: task.quantity,
    volume: task.volume,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    ...owner,
    assetsLastModified,
  };
}

/** Creates owner-specific movements for a haul task whose plan row combines owners. */
export function createHaulPatchesForTask(
  task: PlanResult["lists"]["haulingTasks"][number],
  stock: PlanStockItem[],
  statuses: ClientCharacterStatus[],
): HaulPatch[] {
  const owner = getHaulTaskOwner(task);
  if (owner) {
    const patch = createHaulPatch(
      task,
      getOwnerAssetsLastModified(statuses, owner.ownerType, owner.ownerId),
    );
    return patch ? [patch] : [];
  }

  const availableByOwner = new Map<
    string,
    {
      ownerType: StockOwnerType;
      ownerId: number;
      quantity: number;
    }
  >();
  for (const item of stock) {
    if (
      item.typeId !== task.itemTypeId
      || getStockRootLocationId(item) !== task.fromLocationId
      || item.category === "blueprint"
      || item.category === "reactionformula"
      || item.quantity <= 0
      || (item.ownerType !== "character" && item.ownerType !== "corporation")
      || typeof item.ownerId !== "number"
    ) {
      continue;
    }
    const key = `${item.ownerType}:${item.ownerId}`;
    const current = availableByOwner.get(key) ?? {
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      quantity: 0,
    };
    current.quantity += item.quantity;
    availableByOwner.set(key, current);
  }

  let remaining = task.quantity;
  const patches: HaulPatch[] = [];
  for (const available of [...availableByOwner.values()].sort(
    (left, right) => left.ownerType.localeCompare(right.ownerType) || left.ownerId - right.ownerId,
  )) {
    if (remaining <= 0) break;
    const quantity = Math.min(available.quantity, remaining);
    const patch = createHaulPatch(
      {
        ...task,
        quantity,
        volume: task.volume * (quantity / task.quantity),
        ownerType: available.ownerType,
        ownerId: available.ownerId,
      },
      getOwnerAssetsLastModified(statuses, available.ownerType, available.ownerId),
    );
    if (patch) patches.push(patch);
    remaining -= quantity;
  }
  return patches;
}

/** Returns whether a persisted patch belongs to the given haul task route and item. */
export function isHaulPatchForTask(
  task: PlanResult["lists"]["haulingTasks"][number],
  patch: HaulPatch,
) {
  return (
    patch.itemTypeId === task.itemTypeId
    && patch.fromLocationId === task.fromLocationId
    && patch.toLocationId === task.toLocationId
    && (
      getHaulTaskOwner(task) === null
      || (patch.ownerType === task.ownerType && patch.ownerId === task.ownerId)
    )
  );
}

/** Returns whether any owner-specific patch has moved stock for the given haul task. */
export function isHaulTaskPatched(
  task: PlanResult["lists"]["haulingTasks"][number],
  patches: ReadonlyMap<string, HaulPatch>,
) {
  return [...patches.values()].some((patch) => isHaulPatchForTask(task, patch));
}

function sameOwner(item: PlanStockItem, patch: HaulPatch) {
  return item.ownerType === patch.ownerType && item.ownerId === patch.ownerId;
}

/** Applies persisted movements to planning stock without allowing source quantities below zero. */
export function applyHaulPatches(
  stock: PlanStockItem[],
  patches: readonly HaulPatch[],
): PlanStockItem[] {
  const workingStock = stock.map((item) => ({ ...item }));
  for (const patch of patches) {
    let remaining = patch.quantity;
    const sourceItems = workingStock.filter(
      (item) =>
        item.typeId === patch.itemTypeId
        && getStockRootLocationId(item) === patch.fromLocationId
        && sameOwner(item, patch)
        && item.category !== "blueprint"
        && item.category !== "reactionformula"
        && item.quantity > 0,
    );
    for (const sourceItem of sourceItems) {
      if (remaining <= 0) break;
      const moved = Math.min(sourceItem.quantity, remaining);
      sourceItem.quantity -= moved;
      remaining -= moved;

      const destinationItem = workingStock.find(
        (item) =>
          item !== sourceItem
          && item.typeId === patch.itemTypeId
          && getStockRootLocationId(item) === patch.toLocationId
          && sameOwner(item, patch)
          && item.category === sourceItem.category,
      );
      if (destinationItem) {
        destinationItem.quantity += moved;
      }
      else {
        workingStock.push({
          ...sourceItem,
          quantity: moved,
          locationId: patch.toLocationId,
          rootLocationId: patch.toLocationId,
          sourceLocationId: patch.toLocationId,
          sourceLocationName: undefined,
          sourceLocationKind: undefined,
          sourceSystemId: undefined,
          sourceSystemName: undefined,
        });
      }
    }
  }
  return workingStock.filter((item) => item.quantity > 0);
}

function getOwnerAssetsLastModified(
  statuses: ClientCharacterStatus[],
  ownerType: StockOwnerType,
  ownerId: number,
) {
  if (ownerType === "character") {
    return statuses.find((status) => status.characterId === ownerId)?.assets?.lastModified;
  }
  const modified = statuses.flatMap((status) =>
    (status.corporations ?? [])
      .filter((corporation) => corporation.corporationId === ownerId)
      .flatMap((corporation) => corporation.assets?.lastModified ?? []),
  );
  return modified.sort().at(-1);
}

/** Drops patches only after the owner asset endpoint reports a newer snapshot. */
export function invalidateHaulPatches(
  patches: readonly HaulPatch[],
  statuses: ClientCharacterStatus[],
): HaulPatch[] {
  return patches.filter((patch) => {
    const currentLastModified = getOwnerAssetsLastModified(
      statuses,
      patch.ownerType,
      patch.ownerId,
    );
    return (
      currentLastModified === undefined
      || patch.assetsLastModified === undefined
      || currentLastModified <= patch.assetsLastModified
    );
  });
}

/** Returns the current owner asset freshness used when persisting a new haul patch. */
export function getHaulOwnerAssetsLastModified(
  statuses: ClientCharacterStatus[],
  ownerType: StockOwnerType,
  ownerId: number,
) {
  return getOwnerAssetsLastModified(statuses, ownerType, ownerId);
}
