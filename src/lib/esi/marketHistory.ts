import { requestEsi } from "./client";

type MarketHistoryEntry = { date: string; volume: number };
export type MarketSellOrder = {
  orderId: number;
  typeId: number;
  price: number;
  volumeRemain: number;
  locationId: number;
};
type EsiMarketOrder = {
  order_id: number;
  type_id: number;
  price: number;
  volume_remain: number;
  is_buy_order: boolean;
  location_id: number;
};

export async function getSevenDayAverageVolume(regionId: number, typeId: number) {
  const response = await requestEsi<MarketHistoryEntry[]>(
    `/markets/${regionId}/history/?type_id=${typeId}`,
  );
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const firstDate = new Date(today);
  firstDate.setUTCDate(firstDate.getUTCDate() - 6);
  const recent = (response.data ?? []).filter((entry) => {
    const date = new Date(`${entry.date}T00:00:00Z`);
    return date >= firstDate && date <= today && Number.isFinite(entry.volume) && entry.volume >= 0;
  });
  if (recent.length === 0) return 0;
  return recent.reduce((total, entry) => total + entry.volume, 0) / recent.length;
}

export async function getMarketSellOrders(
  regionId: number,
  typeId: number,
): Promise<MarketSellOrder[]> {
  const first = await requestEsi<EsiMarketOrder[]>(
    `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=1`,
  );
  const pages = Number(first.headers.get("x-pages") ?? "1");
  const orders = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const response = await requestEsi<EsiMarketOrder[]>(
      `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=${page}`,
    );
    orders.push(...(response.data ?? []));
  }
  return orders
    .filter(
      (order) =>
        !order.is_buy_order
        && order.volume_remain > 0
        && Number.isFinite(order.price)
        && order.price >= 0,
    )
    .map((order) => ({
      orderId: order.order_id,
      typeId: order.type_id,
      price: order.price,
      volumeRemain: order.volume_remain,
      locationId: order.location_id,
    }));
}
