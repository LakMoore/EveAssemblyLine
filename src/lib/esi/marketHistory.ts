import { requestCachedEsi } from "./client";

type MarketHistoryEntry = { date: string; average: number; volume: number };
export type SevenDayMarketMetrics = {
  averagePrice: number | null;
  dailyVolume: number;
  priceStandardDeviation: number | null;
};
export type MarketSellOrder = {
  orderId: number;
  typeId: number;
  price: number;
  volumeRemain: number;
  locationId: number;
};
export type RegionalOrderPrices = {
  maxBuyPrice: number | null;
  minSellPrice: number | null;
};
export type RegionalAppraisalPrices = {
  fivePercentSellPrice: number | null;
  minSellPrice: number | null;
  splitPrice: number | null;
  maxBuyPrice: number | null;
  fivePercentBuyPrice: number | null;
};
export type RegionalMarketOrder = {
  price: number;
  volumeRemain: number;
  isBuyOrder: boolean;
  locationId?: number;
};
type EsiMarketOrder = {
  order_id: number;
  type_id: number;
  price: number;
  volume_remain: number;
  is_buy_order: boolean;
  location_id: number;
};

/** Calculates recent market metrics across the latest seven UTC calendar days. */
export function calculateSevenDayMarketMetrics(
  history: MarketHistoryEntry[],
  currentDate = new Date(),
): SevenDayMarketMetrics {
  const today = new Date(currentDate);
  today.setUTCHours(0, 0, 0, 0);
  const firstDate = new Date(today);
  firstDate.setUTCDate(firstDate.getUTCDate() - 6);
  const recent = history.filter((entry) => {
    const date = new Date(`${entry.date}T00:00:00Z`);
    return (
      date >= firstDate
      && date <= today
      && Number.isFinite(entry.average)
      && entry.average >= 0
      && Number.isFinite(entry.volume)
      && entry.volume >= 0
    );
  });
  const totalVolume = recent.reduce((total, entry) => total + entry.volume, 0);
  const weightedValue = recent.reduce((total, entry) => total + entry.average * entry.volume, 0);
  const averagePrice = totalVolume > 0 ? weightedValue / totalVolume : null;
  const weightedVariance =
    averagePrice === null
      ? null
      : recent.reduce(
          (total, entry) => total + entry.volume * (entry.average - averagePrice) ** 2,
          0,
        ) / totalVolume;
  return {
    averagePrice,
    dailyVolume: totalVolume / 7,
    priceStandardDeviation: weightedVariance === null ? null : Math.sqrt(weightedVariance),
  };
}

function priceAtVolumePercentile(
  orders: RegionalMarketOrder[],
  percentile: number,
  isBuyOrder: boolean,
) {
  if (orders.length === 0) return null;
  const sortedOrders = [...orders].sort((left, right) =>
    isBuyOrder ? right.price - left.price : left.price - right.price,
  );
  const targetVolume =
    sortedOrders.reduce((total, order) => total + order.volumeRemain, 0) * percentile;
  let accumulatedVolume = 0;
  for (const order of sortedOrders) {
    accumulatedVolume += order.volumeRemain;
    if (accumulatedVolume >= targetVolume) return order.price;
  }
  return sortedOrders.at(-1)?.price ?? null;
}

/** Calculates the five appraisal prices from an active regional order book. */
export function calculateRegionalAppraisalPrices(
  orders: RegionalMarketOrder[],
  sellStationId?: number,
): RegionalAppraisalPrices {
  const activeOrders = orders.filter(
    (order) => order.volumeRemain > 0 && Number.isFinite(order.price) && order.price > 0,
  );
  const buyOrders = activeOrders.filter((order) => order.isBuyOrder);
  const sellOrders = activeOrders.filter(
    (order) =>
      !order.isBuyOrder && (sellStationId === undefined || order.locationId === sellStationId),
  );
  const minSellPrice =
    sellOrders.length > 0 ? Math.min(...sellOrders.map((order) => order.price)) : null;
  const maxBuyPrice =
    buyOrders.length > 0 ? Math.max(...buyOrders.map((order) => order.price)) : null;
  return {
    fivePercentSellPrice: priceAtVolumePercentile(sellOrders, 0.05, false),
    minSellPrice,
    splitPrice:
      minSellPrice !== null && maxBuyPrice !== null ? (minSellPrice + maxBuyPrice) / 2 : null,
    maxBuyPrice,
    fivePercentBuyPrice: priceAtVolumePercentile(buyOrders, 0.05, true),
  };
}

/** Loads cached ESI history and calculates seven-day average price and daily volume. */
export async function getSevenDayMarketMetrics(
  regionId: number,
  typeId: number,
): Promise<SevenDayMarketMetrics> {
  const response = await requestCachedEsi<MarketHistoryEntry[]>(
    `/markets/${regionId}/history/?type_id=${typeId}`,
  );
  return calculateSevenDayMarketMetrics(response.data ?? []);
}

/** Returns the seven-day average regional trade volume for one type. */
export async function getSevenDayAverageVolume(regionId: number, typeId: number) {
  return (await getSevenDayMarketMetrics(regionId, typeId)).dailyVolume;
}

/** Returns the best active buy and sell prices in a regional order book. */
export async function getRegionalOrderPrices(
  regionId: number,
  typeId: number,
): Promise<RegionalOrderPrices> {
  const orders = await getRegionalMarketOrders(regionId, typeId);
  const prices = calculateRegionalAppraisalPrices(orders);
  return { maxBuyPrice: prices.maxBuyPrice, minSellPrice: prices.minSellPrice };
}

/** Loads active buy and sell orders for one regional item order book. */
async function getRegionalMarketOrders(
  regionId: number,
  typeId: number,
): Promise<RegionalMarketOrder[]> {
  const first = await requestCachedEsi<EsiMarketOrder[]>(
    `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=1`,
  );
  const pages = Number(first.headers.get("x-pages") ?? "1");
  const orders = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const response = await requestCachedEsi<EsiMarketOrder[]>(
      `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=${page}`,
    );
    orders.push(...(response.data ?? []));
  }
  return orders.map((order) => ({
    price: order.price,
    volumeRemain: order.volume_remain,
    isBuyOrder: order.is_buy_order,
    locationId: order.location_id,
  }));
}

/** Returns the five appraisal prices for one regional item order book. */
export async function getRegionalAppraisalPrices(
  regionId: number,
  typeId: number,
  sellStationId?: number,
): Promise<RegionalAppraisalPrices> {
  return calculateRegionalAppraisalPrices(
    await getRegionalMarketOrders(regionId, typeId),
    sellStationId,
  );
}

export async function getMarketSellOrders(
  regionId: number,
  typeId: number,
): Promise<MarketSellOrder[]> {
  const first = await requestCachedEsi<EsiMarketOrder[]>(
    `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=1`,
  );
  const pages = Number(first.headers.get("x-pages") ?? "1");
  const orders = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const response = await requestCachedEsi<EsiMarketOrder[]>(
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
