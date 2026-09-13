import type { MarketOrderRecord } from "@/lib/auth/model";

/** Adds open buy-order quantities while ignoring the same order seen through another owner scope. */
export function addMarketBuyOrderQuantities(
  quantities: Map<number, number>,
  orders: readonly MarketOrderRecord[],
  seenOrderIds: Set<number>,
  options: { includeCorporationOrders?: boolean } = {},
) {
  const includeCorporationOrders = options.includeCorporationOrders ?? true;
  for (const order of orders) {
    if (
      !order.isBuyOrder
      || order.volumeRemain <= 0
      || (!includeCorporationOrders && order.isCorporation === true)
      || seenOrderIds.has(order.orderId)
    ) continue;
    seenOrderIds.add(order.orderId);
    quantities.set(order.typeId, (quantities.get(order.typeId) ?? 0) + order.volumeRemain);
  }
}
