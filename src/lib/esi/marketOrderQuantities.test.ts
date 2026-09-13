import assert from "node:assert/strict";
import test from "node:test";
import type { MarketOrderRecord } from "@/lib/auth/model";
import {
  addMarketBuyOrderQuantities,
  addMarketBuyOrderQuantitiesByLocation,
} from "./marketOrderQuantities";

function order(orderId: number, typeId: number, volumeRemain: number): MarketOrderRecord {
  return {
    orderId,
    typeId,
    locationId: 60000001,
    issuedAt: "2026-09-13T00:00:00.000Z",
    volumeRemain,
    volumeTotal: volumeRemain,
    isBuyOrder: true,
    ownerType: "character",
    ownerId: 123,
  };
}

void test("deduplicates an order repeated across owner scopes", () => {
  const quantities = new Map<number, number>();
  const seenOrderIds = new Set<number>();
  const sharedOrder = order(101, 62377, 2252);

  addMarketBuyOrderQuantities(quantities, [sharedOrder], seenOrderIds);
  addMarketBuyOrderQuantities(quantities, [sharedOrder, order(102, 62377, 100)], seenOrderIds);

  assert.deepEqual([...quantities], [[62377, 2352]]);
});

void test("keeps corporation orders out of the character-scoped quantity map", () => {
  const quantities = new Map<number, number>();
  const seenOrderIds = new Set<number>();
  const corporationOrder = { ...order(103, 62377, 2252), isCorporation: true };

  addMarketBuyOrderQuantities(
    quantities,
    [corporationOrder],
    seenOrderIds,
    {
      includeCorporationOrders: false,
    },
  );

  assert.deepEqual([...quantities], []);
});

void test("groups buy orders by type and location", () => {
  const quantities = new Map();
  const seenOrderIds = new Set<number>();

  addMarketBuyOrderQuantitiesByLocation(
    quantities,
    [
      order(104, 62377, 100),
      { ...order(105, 62377, 50), locationId: 60000002 },
      order(106, 62377, 25),
    ],
    seenOrderIds,
  );

  assert.deepEqual(
    [...quantities.values()],
    [
      { typeId: 62377, locationId: 60000001, quantity: 125 },
      { typeId: 62377, locationId: 60000002, quantity: 50 },
    ],
  );
});
