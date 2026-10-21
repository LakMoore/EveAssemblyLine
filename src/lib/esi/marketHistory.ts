import { requestCachedEsi } from "./client";
import { z } from "zod";
import type { TaxPriceResponse } from "@/lib/market/taxes";
import { globalPlexMarket } from "@/lib/reference/marketHubs";
import { getSystemJumpDistance } from "./routes";

type MarketHistoryEntry = { date: string; average: number; volume: number };
const marketHistoryEntrySchema = z.looseObject({
  date: z.string(),
  average: z.number(),
  volume: z.number().nonnegative(),
});
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
export type RegionalAppraisalPriceType = "buy" | "split" | "sell";
export type RegionalMarketOrder = {
  orderId?: number;
  price: number;
  volumeRemain: number;
  isBuyOrder: boolean;
  locationId?: number;
  systemId?: number;
  range?: z.infer<typeof marketOrderRangeSchema>;
};
const marketOrderRangeSchema = z.enum([
  "station",
  "solarsystem",
  "region",
  "1",
  "2",
  "3",
  "4",
  "5",
  "10",
  "20",
  "30",
  "40",
]);
const esiMarketOrderSchema = z.looseObject({
  order_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  price: z.number().nonnegative(),
  volume_remain: z.number().int().nonnegative(),
  is_buy_order: z.boolean(),
  location_id: z.number().int().positive(),
  system_id: z.number().int().positive(),
  range: marketOrderRangeSchema,
});

/** Station and solar-system identity of the hub where the item can be sold. */
type MarketHubLocation = { stationId: number; systemId: number };

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

/** Selects the configured regional order-book side for an appraisal. */
export function selectRegionalAppraisalPrice(
  prices: RegionalAppraisalPrices,
  priceType: RegionalAppraisalPriceType,
) {
  if (priceType === "buy") return prices.maxBuyPrice;
  if (priceType === "sell") return prices.minSellPrice;
  return prices.splitPrice;
}

/** Loads cached ESI history and calculates seven-day average price and daily volume. */
export async function getSevenDayMarketMetrics(
  regionId: number,
  typeId: number,
): Promise<SevenDayMarketMetrics> {
  if (typeId === globalPlexMarket.typeId) regionId = globalPlexMarket.regionId;
  const response = await requestCachedEsi(
    `/markets/${regionId}/history/?type_id=${typeId}`,
    z.array(marketHistoryEntrySchema),
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
export async function getRegionalMarketOrders(
  regionId: number,
  typeId: number,
): Promise<RegionalMarketOrder[]> {
  return (await getRegionalMarketOrderBook(regionId, typeId)).orders;
}

/** Loads every order-book page and retains the oldest source time and earliest expiry. */
async function getRegionalMarketOrderBook(regionId: number, typeId: number) {
  if (typeId === globalPlexMarket.typeId) regionId = globalPlexMarket.regionId;
  const first = await requestCachedEsi(
    `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=1`,
    z.array(esiMarketOrderSchema),
  );
  const pages = Number(first.headers.get("x-pages") ?? "1");
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) {
    throw new Error("ESI returned an invalid order-book page count.");
  }
  const responses = [first];
  const orders = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const response = await requestCachedEsi(
      `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=${page}`,
      z.array(esiMarketOrderSchema),
    );
    responses.push(response);
    orders.push(...(response.data ?? []));
  }
  const now = Date.now();
  return {
    orders: orders.map((order) => ({
      orderId: order.order_id,
      price: order.price,
      volumeRemain: order.volume_remain,
      isBuyOrder: order.is_buy_order,
      locationId: order.location_id,
      systemId: order.system_id,
      range: order.range,
    })),
    fetchedAt: new Date(
      Math.min(
        ...responses.map((response) => Date.parse(response.headers.get("date") ?? "") || now),
      ),
    ).toISOString(),
    expiresAt: new Date(
      Math.min(
        ...responses.map((response) => Date.parse(response.headers.get("expires") ?? "") || now),
      ),
    ).toISOString(),
    status: responses.every((response) => response.fromCache)
      ? ("cached" as const)
      : ("fresh" as const),
  };
}

/** Returns station-only prices as the baseline before considering ranged buy orders. */
export function calculateStationOrderPrices(
  orders: RegionalMarketOrder[],
  stationId: number,
): { lowestSell: number | null; highestBuy: number | null } {
  const prices = calculateRegionalAppraisalPrices(
    orders.filter((order) => order.locationId === stationId),
  );
  return { lowestSell: prices.minSellPrice, highestBuy: prices.maxBuyPrice };
}

/**
 * Checks coverage that needs no route lookup; the order book already scopes orders to the region.
 * @param order Active regional buy order.
 * @param market Target hub station and system.
 * @returns Whether location or range proves the order covers the hub.
 */
function buyOrderCoversHubWithoutRoute(
  order: RegionalMarketOrder,
  market: MarketHubLocation,
): boolean {
  return (
    order.locationId === market.stationId
    || order.range === "region"
    || (
      order.systemId === market.systemId
      && order.range !== undefined
      && order.range !== "station"
    )
  );
}

/**
 * Prices station sells and regional buys that can actually be filled from the hub.
 * @param orders Complete regional order book, including range and system metadata.
 * @param market Target hub station and system.
 * @returns Lowest station sell and highest buy covering the hub; absent sides remain null.
 */
export async function calculateHubOrderPrices(
  orders: RegionalMarketOrder[],
  market: MarketHubLocation,
): Promise<{ lowestSell: number | null; highestBuy: number | null }> {
  const prices = calculateStationOrderPrices(orders, market.stationId);
  const buyOrders = orders.filter(
    (order) =>
      order.isBuyOrder && order.volumeRemain > 0 && Number.isFinite(order.price) && order.price > 0,
  );
  for (const order of buyOrders) {
    if (buyOrderCoversHubWithoutRoute(order, market)) {
      prices.highestBuy = Math.max(prices.highestBuy ?? 0, order.price);
    }
  }
  // Prove the cheapest coverage first, then stop at the highest-priced reachable candidate.
  const candidates = buyOrders
    .filter(
      (order) =>
        order.price > (prices.highestBuy ?? 0)
        && order.systemId !== market.systemId
        && Number.isSafeInteger(Number(order.range))
        && Number(order.range) > 0,
    )
    .sort((left, right) => right.price - left.price);
  for (const order of candidates) {
    if (order.systemId === undefined) continue;
    const distance = await getSystemJumpDistance(market.systemId, order.systemId);
    if (distance !== null && distance <= Number(order.range)) {
      return { lowestSell: prices.lowestSell, highestBuy: order.price };
    }
  }
  return prices;
}

/** Loads a cached hub-station quote, or the complete global order book for PLEX. */
export async function getStationTaxPrices(
  market: MarketHubLocation & { id: TaxPriceResponse["marketId"]; regionId: number },
  typeId: number,
): Promise<TaxPriceResponse> {
  const { orders, ...metadata } = await getRegionalMarketOrderBook(market.regionId, typeId);
  const prices =
    typeId === globalPlexMarket.typeId ? calculateRegionalAppraisalPrices(orders) : null;
  return {
    typeId,
    marketId: market.id,
    ...(prices
      ? { lowestSell: prices.minSellPrice, highestBuy: prices.maxBuyPrice }
      : await calculateHubOrderPrices(orders, market)),
    ...metadata,
  };
}

/** Returns the five appraisal prices for one regional item order book. */
export async function getRegionalAppraisalPrices(
  regionId: number,
  typeId: number,
  sellStationId?: number,
): Promise<RegionalAppraisalPrices> {
  return calculateRegionalAppraisalPrices(
    await getRegionalMarketOrders(regionId, typeId),
    typeId === globalPlexMarket.typeId ? undefined : sellStationId,
  );
}

export async function getMarketSellOrders(
  regionId: number,
  typeId: number,
): Promise<MarketSellOrder[]> {
  if (typeId === globalPlexMarket.typeId) regionId = globalPlexMarket.regionId;
  const first = await requestCachedEsi(
    `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=1`,
    z.array(esiMarketOrderSchema),
  );
  const pages = Number(first.headers.get("x-pages") ?? "1");
  const orders = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const response = await requestCachedEsi(
      `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=${page}`,
      z.array(esiMarketOrderSchema),
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

/** Returns active buy orders placed at the selected station, with actual fillable quantities. */
export async function getStationBuyOrders(
  regionId: number,
  typeId: number,
  stationId: number,
): Promise<Array<{ price: number; volumeRemain: number }>> {
  const orders = await getRegionalMarketOrders(regionId, typeId);
  return orders
    .filter(
      (order) =>
        order.isBuyOrder
        && order.locationId === stationId
        && order.volumeRemain > 0
        && Number.isFinite(order.price)
        && order.price > 0,
    )
    .map((order) => ({ price: order.price, volumeRemain: order.volumeRemain }));
}
