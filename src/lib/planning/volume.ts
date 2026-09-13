import type { StockItemBase } from "./types";

export type VolumeItem = Pick<StockItemBase, "quantity" | "isPackaged"> & {
  assembledVolume?: number;
  packagedVolume?: number;
  isShip?: boolean;
  isCargoContainer?: boolean;
};

/** Returns whether an item represents a haulable volume contribution. */
export function isHaulableVolumeItem(item: VolumeItem) {
  return !(item.isPackaged === false && (item.isShip === true || item.isCargoContainer === true));
}

/** Calculates stock volume while excluding assembled ships and cargo containers. */
export function volumeForItem(item: VolumeItem) {
  if (!isHaulableVolumeItem(item)) return 0;
  const unitVolume = item.isPackaged
    ? (item.packagedVolume ?? item.assembledVolume ?? 0)
    : (item.assembledVolume ?? 0);
  return item.quantity * unitVolume;
}
