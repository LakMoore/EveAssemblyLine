import type { AssetRecord } from "@/lib/auth/model";
import {
  getRegionalOrderPrices,
  getSevenDayMarketMetrics,
  type RegionalOrderPrices,
  type SevenDayMarketMetrics,
} from "@/lib/esi/marketHistory";

const historyConcurrency = 8;

/** Identifies a configured market location and its containing region. */
export type MarketStation = {
  stationId: number;
  name: string;
  systemId: number;
  regionId: number;
};

/** Represents saleable cached stock grouped by station and item type. */
export type StationStock = {
  stationId: number;
  regionId: number;
  typeId: number;
  quantity: number;
};

/** Describes one item with a favorable regional buy/sell spread. */
export type MarketSignal = StationStock & {
  averagePrice: number;
  averagePriceSource: "regional-history";
  dailyVolume: number;
  maxBuyPrice: number;
  minSellPrice: number;
  priceStandardDeviation: number;
  percentageOverAverage: number;
  totalPriceAfterTax: number;
};

/** Creates a stable map key for one station/type or region/type pair. */
function marketKey(locationId: number, typeId: number) {
  return `${locationId}:${typeId}`;
}

/** Runs asynchronous work with a fixed upper bound on concurrent requests. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

/** Groups positive cached stock quantities held directly in configured market locations. */
export function groupMarketStationStock(
  assets: AssetRecord[],
  stations: MarketStation[],
): StationStock[] {
  const stationById = new Map(stations.map((station) => [station.stationId, station]));
  const quantities = new Map<string, StationStock>();
  for (const asset of assets) {
    if (asset.quantity <= 0 || !asset.rootLocation || !("kind" in asset.rootLocation)) continue;
    const station = stationById.get(asset.rootLocation.locationId);
    if (
      !station
      || (asset.rootLocation.kind !== "station" && asset.rootLocation.kind !== "structure")
    ) continue;
    const key = marketKey(station.stationId, asset.typeId);
    const current = quantities.get(key);
    quantities.set(
      key,
      current
        ? { ...current, quantity: current.quantity + asset.quantity }
        : {
            stationId: station.stationId,
            regionId: station.regionId,
            typeId: asset.typeId,
            quantity: asset.quantity,
          },
    );
  }
  return [...quantities.values()];
}

/** Loads recent regional metrics once for each unique region/type pair. */
async function loadRegionalMetrics(stock: StationStock[]) {
  const pairs = [
    ...new Map(stock.map((item) => [marketKey(item.regionId, item.typeId), item])).values(),
  ];
  const entries = await mapWithConcurrency(
    pairs,
    historyConcurrency,
    async (item) => {
      const metrics = await getSevenDayMarketMetrics(item.regionId, item.typeId).catch(
        (): SevenDayMarketMetrics => ({
          averagePrice: null,
          dailyVolume: 0,
          priceStandardDeviation: null,
        }),
      );
      return [marketKey(item.regionId, item.typeId), metrics] as const;
    },
  );
  return new Map(entries);
}

/** Loads the best active buy and sell prices once for each unique region/type pair. */
async function loadRegionalOrderPrices(stock: StationStock[]) {
  const pairs = [
    ...new Map(stock.map((item) => [marketKey(item.regionId, item.typeId), item])).values(),
  ];
  const entries = await mapWithConcurrency(
    pairs,
    historyConcurrency,
    async (item) => {
      const prices = await getRegionalOrderPrices(item.regionId, item.typeId).catch(
        (): RegionalOrderPrices => ({ maxBuyPrice: null, minSellPrice: null }),
      );
      return [marketKey(item.regionId, item.typeId), prices] as const;
    },
  );
  return new Map(entries);
}

/** Applies the sell threshold and calculates tax-adjusted proceeds for available market data. */
export function buildMarketSignals(
  stock: StationStock[],
  regionalMetrics: ReadonlyMap<string, SevenDayMarketMetrics>,
  regionalOrderPrices: ReadonlyMap<string, RegionalOrderPrices>,
  salesTaxPercent: number,
  thresholdIsk: number,
): MarketSignal[] {
  const taxMultiplier = 1 - salesTaxPercent / 100;
  return stock.flatMap((item) => {
    const regionKey = marketKey(item.regionId, item.typeId);
    const orderPrices = regionalOrderPrices.get(regionKey);
    const minSellPrice = orderPrices?.minSellPrice;
    const maxBuyPrice = orderPrices?.maxBuyPrice;
    const metrics = regionalMetrics.get(regionKey);
    const averagePrice = metrics?.averagePrice ?? null;
    const priceStandardDeviation = metrics?.priceStandardDeviation ?? null;
    if (
      minSellPrice === undefined
      || minSellPrice === null
      || averagePrice === null
      || averagePrice <= 0
      || priceStandardDeviation === null
      || maxBuyPrice === undefined
      || maxBuyPrice === null
      || minSellPrice <= maxBuyPrice
      || averagePrice <= maxBuyPrice + priceStandardDeviation
    ) return [];
    const dailyMarketValue = (metrics?.dailyVolume ?? 0) * averagePrice;
    const onHandSellValue = item.quantity * minSellPrice;
    if (dailyMarketValue < thresholdIsk || onHandSellValue < thresholdIsk) return [];
    const percentageOverAverage = ((minSellPrice - averagePrice) / averagePrice) * 100;
    return [
      {
        ...item,
        averagePrice,
        averagePriceSource: "regional-history" as const,
        dailyVolume: metrics?.dailyVolume ?? 0,
        maxBuyPrice,
        minSellPrice,
        priceStandardDeviation,
        percentageOverAverage,
        totalPriceAfterTax: item.quantity * minSellPrice * taxMultiplier,
      },
    ];
  });
}

/** Builds market sale signals for cached assets at the configured stations. */
export async function getMarketSignals(
  assets: AssetRecord[],
  stations: MarketStation[],
  salesTaxPercent: number,
  thresholdIsk: number,
) {
  const stock = groupMarketStationStock(assets, stations);
  if (stock.length === 0) return [];
  const [regionalMetrics, regionalOrderPrices] = await Promise.all([
    loadRegionalMetrics(stock),
    loadRegionalOrderPrices(stock),
  ]);
  return buildMarketSignals(
    stock,
    regionalMetrics,
    regionalOrderPrices,
    salesTaxPercent,
    thresholdIsk,
  );
}
