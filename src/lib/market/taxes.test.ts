import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMarketTaxes,
  marketHubStandings,
  taxPriceRequestSchema,
  tradingFeeRates,
} from "./taxes";
import { marketHubs } from "@/lib/reference/marketHubs";
import type { CharacterStandingRecord } from "@/lib/esi/client";

const profile = { accounting: 0, brokerRelations: 0, factionStanding: 0, corporationStanding: 0 };

void test("hub standings select the correct NPC corporation and faction for all five stations", () => {
  assert.deepEqual(
    marketHubs.map((hub) => [hub.id, hub.corporationId, hub.factionId]),
    [
      ["jita", 1000035, 500001],
      ["amarr", 1000086, 500003],
      ["hek", 1000057, 500002],
      ["dodixie", 1000120, 500004],
      ["rens", 1000049, 500002],
    ],
  );
  const standings: CharacterStandingRecord[] = marketHubs.flatMap((hub) => [
    { from_id: hub.corporationId, from_type: "agent", standing: 9 },
    { from_id: hub.corporationId, from_type: "npc_corp", standing: -hub.corporationId / 1_000_000 },
    { from_id: hub.factionId, from_type: "faction", standing: hub.factionId / 1_000_000 },
  ]);
  for (const hub of marketHubs) {
    assert.deepEqual(
      marketHubStandings(standings, hub.id),
      {
        factionStanding: hub.factionId / 1_000_000,
        corporationStanding: -hub.corporationId / 1_000_000,
      },
    );
  }
});

void test("missing standings are neutral only after a successful ESI response", () => {
  assert.equal(marketHubStandings(null, "jita"), null);
  assert.equal(marketHubStandings(undefined, "jita"), null);
  assert.deepEqual(marketHubStandings([], "jita"), { factionStanding: 0, corporationStanding: 0 });
  assert.deepEqual(
    marketHubStandings(
      [
        { from_id: 500001, from_type: "faction", standing: -3.123456789 },
        { from_id: 1000120, from_type: "npc_corp", standing: 8 },
      ],
      "jita",
    ),
    { factionStanding: -3.123456789, corporationStanding: 0 },
  );
});

void test("full-precision hub standings reach the broker fee calculation unchanged", () => {
  const standings = marketHubStandings(
    [
      { from_id: 500001, from_type: "faction", standing: 3.19 },
      { from_id: 1000035, from_type: "npc_corp", standing: 7.260038298328329 },
    ],
    "jita",
  );
  assert.ok(standings);
  const result = calculateMarketTaxes(
    { lowestSell: 7_000_000_000, highestBuy: 6_460_000_000 },
    1,
    { accounting: 5, brokerRelations: 4, ...standings },
  );
  assert.equal(result.sellOrder?.brokerFee, 109_121_355.39);
});

void test("NPC fees match CCP's current rates, skills and unmodified standings", () => {
  assert.deepEqual(tradingFeeRates(profile), { salesTax: 0.075, brokerFee: 0.03 });
  const trained = tradingFeeRates({ ...profile, accounting: 5, brokerRelations: 5 });
  assert.ok(Math.abs(trained.salesTax - 0.03375) < 1e-10);
  assert.equal(trained.brokerFee, 0.015);
  const perfect = tradingFeeRates({
    ...profile,
    brokerRelations: 5,
    factionStanding: 10,
    corporationStanding: 10,
  });
  assert.equal(perfect.brokerFee, 0.01);
});

void test("four scenarios charge broker fees only for orders and sales tax only to sellers", () => {
  const result = calculateMarketTaxes({ lowestSell: 10000, highestBuy: 8000 }, 10, profile);
  assert.deepEqual(
    result.sellOrder,
    {
      unitPrice: 9999,
      gross: 99990,
      brokerFee: 2999.7,
      sccSurcharge: 0,
      salesTax: 7499.25,
      total: 89491.05,
    },
  );
  assert.deepEqual(
    result.instantSell,
    { unitPrice: 8000, gross: 80000, brokerFee: 0, sccSurcharge: 0, salesTax: 6000, total: 74000 },
  );
  assert.deepEqual(
    result.instantBuy,
    { unitPrice: 10000, gross: 100000, brokerFee: 0, sccSurcharge: 0, salesTax: 0, total: 100000 },
  );
  assert.deepEqual(
    result.buyOrder,
    {
      unitPrice: 8001,
      gross: 80010,
      brokerFee: 2400.3,
      sccSurcharge: 0,
      salesTax: 0,
      total: 82410.3,
    },
  );
  assert.equal(result.splitUnitPrice, 9000);
  assert.equal(result.splitBeforeFees, 90000);
  assert.equal(result.splitAfterFees, 85950.68);
  assert.equal(result.splitUsingOrders, 85950.68);
  assert.equal(result.splitImmediate, 87000);
});

void test("after-fee splits choose the highest receipt and lowest payment independently", () => {
  const small = calculateMarketTaxes({ lowestSell: 10, highestBuy: 8 }, 1, profile);
  assert.equal(small.splitAfterFees, 8.7);
  assert.equal(small.splitImmediate, 8.7);
  assert.equal(small.splitUsingOrders, 8.63);
  const mixed = calculateMarketTaxes(
    { lowestSell: 10000, highestBuy: 9800 },
    1,
    profile,
    { playerOwnedStructure: true, ownerBrokerFeePercent: 0 },
  );
  assert.equal(mixed.splitAfterFees, 9507.51);
  assert.equal(mixed.splitUsingOrders, 9449.56);
  assert.equal(mixed.splitImmediate, 9532.5);
});

void test("quantity recalculation applies the 100 ISK broker minimum per order, not per unit", () => {
  const prices = { lowestSell: 10, highestBuy: 8 };
  const single = calculateMarketTaxes(prices, 1, profile);
  const bulk = calculateMarketTaxes(prices, 1000, profile);
  assert.equal(single.sellOrder?.brokerFee, 100);
  assert.equal(single.buyOrder?.brokerFee, 100);
  assert.equal(single.sellOrder.total, -90.76);
  assert.equal(bulk.sellOrder?.brokerFee, 299.7);
  assert.equal(bulk.buyOrder?.brokerFee, 240.3);
});

void test("missing orders leave affected scenarios and split prices unavailable", () => {
  const result = calculateMarketTaxes({ lowestSell: null, highestBuy: 8 }, 10, profile);
  assert.equal(result.sellOrder, null);
  assert.equal(result.instantBuy, null);
  assert.notEqual(result.instantSell, null);
  assert.equal(result.splitBeforeFees, null);
  assert.equal(result.splitAfterFees, 127.05);
  assert.equal(result.splitUsingOrders, null);
  assert.equal(result.splitImmediate, null);
  const empty = calculateMarketTaxes({ lowestSell: null, highestBuy: null }, 10, profile);
  assert.equal(empty.splitAfterFees, null);
  assert.equal(empty.splitUsingOrders, null);
  assert.equal(empty.splitImmediate, null);
});

void test("split unit prices preserve fractional cents before quantity expansion", () => {
  const result = calculateMarketTaxes({ lowestSell: 10.01, highestBuy: 10 }, 2, profile);
  assert.ok(result.splitUnitPrice !== null && Math.abs(result.splitUnitPrice - 10.005) < 1e-10);
  assert.equal(result.splitBeforeFees, 20.01);
});

void test("sales tax rounds half-cent ties without binary floating-point under-rounding", () => {
  const result = calculateMarketTaxes(
    { lowestSell: 3.92, highestBuy: 3.71 },
    2000,
    {
      ...profile,
      accounting: 5,
      brokerRelations: 5,
    },
  );
  assert.equal(result.instantSell?.salesTax, 250.43);
  assert.equal(result.instantSell.total, 7169.57);
});

void test("player-structure buy orders separate SCC from the owner broker fee without changing other scenarios", () => {
  const prices = { lowestSell: 10000, highestBuy: 8000 };
  const npc = calculateMarketTaxes(prices, 10, profile);
  const structure = calculateMarketTaxes(
    prices,
    10,
    profile,
    { playerOwnedStructure: true, ownerBrokerFeePercent: 0 },
  );
  assert.equal(structure.buyOrderBrokerRate, 0);
  assert.equal(structure.buyOrderSccSurchargeRate, 0.005);
  assert.deepEqual(
    structure.buyOrder,
    {
      unitPrice: 8001,
      gross: 80010,
      brokerFee: 100,
      sccSurcharge: 400.05,
      salesTax: 0,
      total: 80510.05,
    },
  );
  assert.deepEqual(structure.sellOrder, npc.sellOrder);
  assert.deepEqual(structure.instantSell, npc.instantSell);
  assert.deepEqual(structure.instantBuy, npc.instantBuy);
  assert.equal(structure.splitImmediate, npc.splitImmediate);
  assert.equal(structure.splitBeforeFees, npc.splitBeforeFees);
  assert.equal(structure.splitAfterFees, 85000.55);
  assert.equal(structure.splitUsingOrders, 85000.55);
  const ownerFee = calculateMarketTaxes(
    prices,
    10,
    profile,
    { playerOwnedStructure: true, ownerBrokerFeePercent: 1 },
  );
  assert.equal(ownerFee.buyOrderBrokerRate, 0.01);
  assert.equal(ownerFee.buyOrderSccSurchargeRate, 0.005);
  assert.equal(ownerFee.buyOrder?.brokerFee, 800.1);
  assert.equal(ownerFee.buyOrder.sccSurcharge, 400.05);
  assert.equal(ownerFee.buyOrder.total, 81210.15);
});

void test("structure fees ignore skills and NPC standings and retain the per-order 100 ISK minimum", () => {
  const settings = { playerOwnedStructure: true, ownerBrokerFeePercent: 0 };
  const trained = {
    accounting: 5,
    brokerRelations: 5,
    factionStanding: 10,
    corporationStanding: 10,
  };
  const prices = { lowestSell: 10, highestBuy: 8 };
  const small = calculateMarketTaxes(prices, 1, trained, settings);
  assert.equal(small.buyOrder?.brokerFee, 100);
  assert.equal(small.buyOrder.sccSurcharge, 0.04);
  assert.equal(small.buyOrder.total, 108.05);
  const bulk = calculateMarketTaxes(prices, 10000, trained, settings);
  const untrained = calculateMarketTaxes(prices, 10000, profile, settings);
  assert.equal(bulk.buyOrder?.brokerFee, 100);
  assert.equal(bulk.buyOrder.sccSurcharge, 400.5);
  assert.equal(bulk.buyOrder.total, 80600.5);
  assert.deepEqual(bulk.buyOrder, untrained.buyOrder);
  const reverted = calculateMarketTaxes(
    prices,
    10000,
    trained,
    { ...settings, playerOwnedStructure: false },
  );
  assert.equal(reverted.buyOrder?.brokerFee, 801);
  assert.equal(reverted.buyOrder.sccSurcharge, 0);
  assert.equal(reverted.buyOrderSccSurchargeRate, 0);
});

void test("SCC and owner broker fees round independently before being added to the buy total", () => {
  const result = calculateMarketTaxes(
    { lowestSell: 2, highestBuy: 0.99 },
    20001,
    profile,
    { playerOwnedStructure: true, ownerBrokerFeePercent: 0.5 },
  );
  assert.equal(result.buyOrder?.gross, 20001);
  assert.equal(result.buyOrder.brokerFee, 100.01);
  assert.equal(result.buyOrder.sccSurcharge, 100.01);
  assert.equal(result.buyOrder.total, 20201.02);
});

void test("placed orders undercut or outbid by the nearest four-significant-figure market tick", () => {
  const cases = [
    { quote: 735800000, sell: 735700000, buy: 735900000 },
    { quote: 703200000, sell: 703100000, buy: 703300000 },
    { quote: 1000000, sell: 999900, buy: 1001000 },
    { quote: 999900, sell: 999800, buy: 1000000 },
    { quote: 10000, sell: 9999, buy: 10010 },
    { quote: 1000, sell: 999.9, buy: 1001 },
    { quote: 100, sell: 99.99, buy: 100.1 },
    { quote: 10, sell: 9.99, buy: 10.01 },
    { quote: 3.92, sell: 3.91, buy: 3.93 },
    { quote: 32.33, sell: 32.32, buy: 32.34 },
    { quote: 0.02, sell: 0.01, buy: 0.03 },
    { quote: 0.01, sell: null, buy: 0.02 },
    { quote: 735850000, sell: 735800000, buy: 735900000 },
    { quote: 9999.9, sell: 9999, buy: 10000 },
  ];
  for (const { quote, sell, buy } of cases) {
    const result = calculateMarketTaxes({ lowestSell: quote, highestBuy: quote }, 1, profile);
    assert.equal(result.sellOrder?.unitPrice ?? null, sell, `sell at ${quote}`);
    assert.equal(result.buyOrder?.unitPrice, buy, `buy at ${quote}`);
    assert.equal(result.instantBuy?.unitPrice, quote);
    assert.equal(result.instantSell?.unitPrice, quote);
    assert.equal(result.splitUnitPrice, quote);
    for (const order of [result.sellOrder, result.buyOrder]) {
      if (!order) continue;
      assert.equal(Number(order.unitPrice.toPrecision(4)), order.unitPrice);
      assert.equal(order.gross, order.unitPrice);
    }
  }
});

void test("an un-undercuttable one-cent quote leaves immediate trades and raw split available", () => {
  const result = calculateMarketTaxes({ lowestSell: 0.01, highestBuy: 0.01 }, 100, profile);
  assert.equal(result.sellOrder, null);
  assert.equal(result.instantBuy?.gross, 1);
  assert.equal(result.instantSell?.gross, 1);
  assert.equal(result.splitBeforeFees, 1);
  assert.equal(result.splitAfterFees, 0.96);
  assert.equal(result.splitUsingOrders, null);
  assert.equal(result.splitImmediate, 0.96);
  assert.equal(result.buyOrder?.gross, 2);
  const missingBuy = calculateMarketTaxes({ lowestSell: 0.01, highestBuy: null }, 100, profile);
  assert.equal(missingBuy.instantBuy?.gross, 1);
  assert.equal(missingBuy.instantSell, null);
  assert.equal(missingBuy.splitUnitPrice, null);
  assert.equal(missingBuy.splitBeforeFees, null);
  assert.equal(missingBuy.splitAfterFees, null);
  assert.equal(missingBuy.splitUsingOrders, null);
  assert.equal(missingBuy.splitImmediate, null);
});

void test("structure owner fee input is validated and unavailable buy prices stay unavailable", () => {
  for (const ownerBrokerFeePercent of [-1, 101, NaN, Infinity]) {
    assert.throws(() =>
      calculateMarketTaxes(
        { lowestSell: 10, highestBuy: 8 },
        1,
        profile,
        { playerOwnedStructure: true, ownerBrokerFeePercent },
      ),
    );
  }
  const result = calculateMarketTaxes(
    { lowestSell: 10, highestBuy: null },
    1,
    profile,
    { playerOwnedStructure: true, ownerBrokerFeePercent: 0 },
  );
  assert.equal(result.buyOrder, null);
  assert.equal(result.splitUsingOrders, null);
  assert.equal(result.splitImmediate, null);
});

void test("invalid quantities and unsupported public price requests are rejected", () => {
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateMarketTaxes({ lowestSell: 10, highestBuy: 8 }, quantity, profile));
  }
  assert.equal(taxPriceRequestSchema.safeParse({ typeId: 34, marketId: "jita" }).success, true);
  for (const request of [
    { typeId: -1, marketId: "jita" },
    { typeId: 34, marketId: "unknown" },
    { typeId: "34", marketId: "jita" },
  ]) {
    assert.equal(taxPriceRequestSchema.safeParse(request).success, false);
  }
});
