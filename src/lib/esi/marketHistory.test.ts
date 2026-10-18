import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  calculateHubOrderPrices,
  calculateRegionalAppraisalPrices,
  calculateStationOrderPrices,
  type RegionalMarketOrder,
} from "./marketHistory";
import {
  getMarketSellOrders,
  getRegionalAppraisalPrices,
  getRegionalOrderPrices,
  getSevenDayMarketMetrics,
  getStationTaxPrices,
  selectRegionalAppraisalPrice,
} from "./marketHistory";
import { clearEsiRequestLogTimer } from "./logger";
import { globalPlexMarket, marketHubs } from "@/lib/reference/marketHubs";

after(() => {
  clearEsiRequestLogTimer();
});

void test("calculates five appraisal prices from weighted buy and sell books", () => {
  assert.deepEqual(
    calculateRegionalAppraisalPrices([
      { price: 100, volumeRemain: 100, isBuyOrder: false },
      { price: 110, volumeRemain: 100, isBuyOrder: false },
      { price: 90, volumeRemain: 100, isBuyOrder: true },
      { price: 80, volumeRemain: 100, isBuyOrder: true },
    ]),
    {
      fivePercentSellPrice: 100,
      minSellPrice: 100,
      splitPrice: 95,
      maxBuyPrice: 90,
      fivePercentBuyPrice: 90,
    },
  );
});

void test("returns null for unavailable sides of the order book", () => {
  assert.deepEqual(
    calculateRegionalAppraisalPrices([{ price: 100, volumeRemain: 100, isBuyOrder: false }]),
    {
      fivePercentSellPrice: 100,
      minSellPrice: 100,
      splitPrice: null,
      maxBuyPrice: null,
      fivePercentBuyPrice: null,
    },
  );
});

void test("limits sell prices to the selected trade hub station", () => {
  assert.deepEqual(
    calculateRegionalAppraisalPrices(
      [
        { price: 1, volumeRemain: 100, isBuyOrder: false, locationId: 1 },
        { price: 2, volumeRemain: 100, isBuyOrder: false, locationId: 2 },
        { price: 3, volumeRemain: 100, isBuyOrder: true, locationId: 3 },
      ],
      2,
    ),
    {
      fivePercentSellPrice: 2,
      minSellPrice: 2,
      splitPrice: 2.5,
      maxBuyPrice: 3,
      fivePercentBuyPrice: 3,
    },
  );
});

void test("selects buy, split, and sell appraisal prices", () => {
  const prices = calculateRegionalAppraisalPrices([
    { price: 100, volumeRemain: 100, isBuyOrder: false },
    { price: 90, volumeRemain: 100, isBuyOrder: true },
  ]);

  assert.equal(selectRegionalAppraisalPrice(prices, "buy"), 90);
  assert.equal(selectRegionalAppraisalPrice(prices, "split"), 95);
  assert.equal(selectRegionalAppraisalPrice(prices, "sell"), 100);
});

void test("tax quotes exclude remote buy orders and remote or inactive sell orders", () => {
  assert.deepEqual(
    calculateStationOrderPrices(
      [
        { price: 100, volumeRemain: 10, isBuyOrder: false, locationId: 1 },
        { price: 90, volumeRemain: 10, isBuyOrder: true, locationId: 1 },
        { price: 1, volumeRemain: 10, isBuyOrder: false, locationId: 2 },
        { price: 999, volumeRemain: 10, isBuyOrder: true, locationId: 2 },
        { price: 1, volumeRemain: 0, isBuyOrder: false, locationId: 1 },
      ],
      1,
    ),
    { lowestSell: 100, highestBuy: 90 },
  );
  assert.deepEqual(calculateStationOrderPrices([], 1), { lowestSell: null, highestBuy: null });
});

void test("PLEX overrides every hub and station, including all global pages and history", async (context) => {
  const requests: URL[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url);
      const secondPage = url.searchParams.get("page") === "2";
      const data = url.pathname.includes("/history/")
        ? []
        : [
            {
              order_id: secondPage ? 2 : 1,
              type_id: globalPlexMarket.typeId,
              price: secondPage ? 8 : 10,
              volume_remain: 100,
              is_buy_order: false,
              location_id: secondPage ? 60004462 : 60012553,
            },
            {
              order_id: secondPage ? 4 : 3,
              type_id: globalPlexMarket.typeId,
              price: secondPage ? 7 : 6,
              volume_remain: 100,
              is_buy_order: true,
              location_id: secondPage ? 60004462 : 60012553,
            },
          ];
      return Promise.resolve(
        Response.json(
          data.map((order) => ({ ...order, system_id: 30000144, range: "region" })),
          { headers: { "x-pages": "2", "cache-control": "max-age=300" } },
        ),
      );
    },
  );
  for (const hub of marketHubs) {
    const quote = await getStationTaxPrices(hub, globalPlexMarket.typeId);
    assert.equal(quote.marketId, hub.id);
    assert.equal(quote.lowestSell, 8);
    assert.equal(quote.highestBuy, 7);
    const appraisal = await getRegionalAppraisalPrices(
      hub.regionId,
      globalPlexMarket.typeId,
      hub.stationId,
    );
    assert.equal(appraisal.minSellPrice, 8);
    assert.equal(appraisal.maxBuyPrice, 7);
  }
  assert.deepEqual(
    await getRegionalOrderPrices(marketHubs[0].regionId, globalPlexMarket.typeId),
    { minSellPrice: 8, maxBuyPrice: 7 },
  );
  assert.equal(
    (await getMarketSellOrders(marketHubs[0].regionId, globalPlexMarket.typeId)).length,
    2,
  );
  await getSevenDayMarketMetrics(marketHubs[0].regionId, globalPlexMarket.typeId);
  assert.ok(requests.some((url) => url.searchParams.get("page") === "2"));
  assert.ok(requests.some((url) => url.pathname.includes("/history/")));
  assert.ok(
    requests.every((url) => url.pathname.includes(`/markets/${globalPlexMarket.regionId}/`)),
  );
});

void test("ordinary types retain their requested hub region and station filtering", async (context) => {
  const market = marketHubs[0];
  const requests: URL[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url);
      return Promise.resolve(
        Response.json([
          {
            order_id: 1,
            type_id: 34,
            price: 4,
            volume_remain: 100,
            is_buy_order: false,
            location_id: market.stationId,
            system_id: market.systemId,
            range: "station",
          },
          {
            order_id: 2,
            type_id: 34,
            price: 3,
            volume_remain: 100,
            is_buy_order: true,
            location_id: market.stationId,
            system_id: market.systemId,
            range: "station",
          },
          {
            order_id: 3,
            type_id: 34,
            price: 1,
            volume_remain: 100,
            is_buy_order: false,
            location_id: 60004462,
            system_id: 30000144,
            range: "station",
          },
          {
            order_id: 4,
            type_id: 34,
            price: 9,
            volume_remain: 100,
            is_buy_order: true,
            location_id: 60004462,
            system_id: 30000144,
            range: "station",
          },
        ]),
      );
    },
  );
  const quote = await getStationTaxPrices(market, 34);
  assert.equal(quote.lowestSell, 4);
  assert.equal(quote.highestBuy, 3);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].pathname.includes(`/markets/${market.regionId}/`));
});

/** Creates active regional buy-order fixtures with explicitly chosen coverage metadata. */
function buyOrder(price: number, options: Partial<RegionalMarketOrder> = {}): RegionalMarketOrder {
  return { price, volumeRemain: 100, isBuyOrder: true, ...options };
}

void test("hub coverage resolves station, same-system and region ranges without routing", async (context) => {
  const market = marketHubs[0];
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    () => Promise.reject(new Error("Unexpected route request")),
  );
  const prices = await calculateHubOrderPrices(
    [
      { price: 100, volumeRemain: 100, isBuyOrder: false, locationId: market.stationId },
      { price: 1, volumeRemain: 100, isBuyOrder: false, locationId: 2 },
      buyOrder(90, { locationId: market.stationId, systemId: market.systemId, range: "station" }),
      buyOrder(200, { locationId: 2, systemId: market.systemId, range: "station" }),
      buyOrder(93, { locationId: 2, systemId: market.systemId, range: "solarsystem" }),
      buyOrder(95, { locationId: 2, systemId: market.systemId, range: "1" }),
      buyOrder(300, { locationId: 3, systemId: 30000144, range: "station" }),
      buyOrder(400, { locationId: 3, systemId: 30000144, range: "solarsystem" }),
      buyOrder(96, { locationId: 3, systemId: 30000144, range: "region" }),
      buyOrder(95, { locationId: 3, systemId: 30000144, range: "40" }),
      buyOrder(10000, { range: "region", volumeRemain: 0 }),
      buyOrder(Infinity, { range: "region" }),
      buyOrder(0, { range: "region" }),
    ],
    market,
  );
  assert.deepEqual(prices, { lowestSell: 100, highestBuy: 96 });
  assert.equal(fetchMock.mock.callCount(), 0);
});

void test("each immediate coverage rule independently accepts or rejects the higher bid", async (context) => {
  const market = marketHubs[0];
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    () => Promise.reject(new Error("Unexpected route request")),
  );
  const coverageCases: { order: RegionalMarketOrder; expected: number }[] = [
    { order: buyOrder(100, { locationId: market.stationId, range: "station" }), expected: 100 },
    {
      order: buyOrder(100, { locationId: 2, systemId: market.systemId, range: "station" }),
      expected: 90,
    },
    {
      order: buyOrder(100, { locationId: 2, systemId: market.systemId, range: "solarsystem" }),
      expected: 100,
    },
    {
      order: buyOrder(100, { locationId: 2, systemId: market.systemId, range: "1" }),
      expected: 100,
    },
    { order: buyOrder(100, { locationId: 2, systemId: 30000144, range: "station" }), expected: 90 },
    {
      order: buyOrder(100, { locationId: 2, systemId: 30000144, range: "solarsystem" }),
      expected: 90,
    },
    { order: buyOrder(100, { locationId: 2, systemId: 30000144, range: "region" }), expected: 100 },
  ];
  for (const { order, expected } of coverageCases) {
    assert.equal(
      (
        await calculateHubOrderPrices(
          [buyOrder(90, { locationId: market.stationId }), order],
          market,
        )
      ).highestBuy,
      expected,
      JSON.stringify(order),
    );
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

void test("buy candidates are price-ordered, include the exact jump boundary and reuse system distances", async (context) => {
  const market = marketHubs[0];
  const requests: string[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      requests.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      return Promise.resolve(Response.json([market.systemId, 31001001, 31001002]));
    },
  );
  const orders = [
    buyOrder(90, { locationId: market.stationId }),
    buyOrder(300, { systemId: 31001003, range: "40" }),
    buyOrder(350, { systemId: 31001002, range: "2" }),
    buyOrder(400, { systemId: 31001002, range: "1" }),
  ];
  assert.deepEqual(
    await calculateHubOrderPrices(orders, market),
    { lowestSell: null, highestBuy: 350 },
  );
  assert.deepEqual(
    await calculateHubOrderPrices(orders, market),
    { lowestSell: null, highestBuy: 350 },
  );
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes(`/route/${market.systemId}/31001002/`));
});

void test("a covering remote buy can supply the price when no station buy exists", async (context) => {
  const market = marketHubs[0];
  context.mock.method(
    globalThis,
    "fetch",
    () => Promise.resolve(Response.json([market.systemId, 31001101])),
  );
  assert.deepEqual(
    await calculateHubOrderPrices([buyOrder(50, { systemId: 31001101, range: "1" })], market),
    { lowestSell: null, highestBuy: 50 },
  );
  assert.deepEqual(
    await calculateHubOrderPrices([], market),
    { lowestSell: null, highestBuy: null },
  );
});

void test("unreachable candidates are excluded but route outages do not silently return a lower quote", async (context) => {
  const market = marketHubs[0];
  let attempts = 0;
  context.mock.method(
    globalThis,
    "fetch",
    () => {
      attempts += 1;
      return Promise.resolve(
        Response.json({ error: "No route" }, { status: attempts === 1 ? 404 : 503 }),
      );
    },
  );
  assert.deepEqual(
    await calculateHubOrderPrices(
      [
        buyOrder(90, { locationId: market.stationId }),
        buyOrder(100, { systemId: 31001201, range: "40" }),
      ],
      market,
    ),
    { lowestSell: null, highestBuy: 90 },
  );
  await assert.rejects(
    calculateHubOrderPrices(
      [
        buyOrder(90, { locationId: market.stationId }),
        buyOrder(100, { systemId: 31001202, range: "40" }),
      ],
      market,
    ),
  );
});

void test("tax requests retain range metadata across pages and reject malformed ESI coverage", async (context) => {
  const market = marketHubs[0];
  const routeRequests: string[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.includes("/route/")) {
        routeRequests.push(url.pathname);
        return Promise.resolve(Response.json([market.systemId, 31001301]));
      }
      const secondPage = url.searchParams.get("page") === "2";
      const typeId = Number(url.searchParams.get("type_id"));
      return Promise.resolve(
        Response.json(
          [
            {
              order_id: secondPage ? 2 : 1,
              type_id: typeId,
              price: secondPage ? 99 : 90,
              volume_remain: 100,
              is_buy_order: true,
              location_id: secondPage ? 2 : market.stationId,
              system_id: secondPage ? 31001301 : market.systemId,
              range: typeId === 35 ? (secondPage ? "1" : "station") : "unknown-range",
            },
          ],
          { headers: { "x-pages": "2" } },
        ),
      );
    },
  );
  assert.equal((await getStationTaxPrices(market, 35)).highestBuy, 99);
  assert.equal(routeRequests.length, 1);
  await assert.rejects(getStationTaxPrices(market, 36));
});
