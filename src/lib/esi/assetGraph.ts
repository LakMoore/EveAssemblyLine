/** Retains accessible assets and every ancestor needed to resolve their locations. */
export function retainAssetAncestors<T extends { itemId: number; locationId: number }>(
  assets: readonly T[],
  accessibleItemIds: ReadonlySet<number>,
) {
  const assetsByItemId = new Map(assets.map((asset) => [asset.itemId, asset]));
  const retainedItemIds = new Set(accessibleItemIds);

  for (const itemId of accessibleItemIds) {
    const visited = new Set<number>();
    let locationId = assetsByItemId.get(itemId)?.locationId;
    while (locationId !== undefined && !visited.has(locationId)) {
      visited.add(locationId);
      const parent = assetsByItemId.get(locationId);
      if (!parent) break;
      retainedItemIds.add(parent.itemId);
      locationId = parent.locationId;
    }
  }

  return assets.filter((asset) => retainedItemIds.has(asset.itemId));
}
