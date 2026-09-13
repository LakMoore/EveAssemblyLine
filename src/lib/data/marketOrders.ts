import type { PlanStockItem } from "@/lib/planning/types";
import { getMarketOrderBuyQuantities, getMarketOrderStock } from "@/lib/esi/cache";
import {
  assertCharacterOwner,
  assertCorporationOwner,
  getCorporationPolicy,
  type OwnerDataContext,
} from "./types";

export type MarketOrderOptions = {
  personalSellOrdersAsStock: boolean;
  allCorporationSellOrdersAsStock: boolean;
  myCorporationSellOrdersAsStock: boolean;
};

export type OwnerMarketOrder = {
  typeId: number;
  locationId: number;
  buyOrderQuantity: number;
  sellOrderQuantity: number;
};

export type OwnerMarketOrdersResponse = OwnerMarketOrder[];

function combineMarketOrders(
  sellOrders: PlanStockItem[] | null,
  buyOrders: Awaited<ReturnType<typeof getMarketOrderBuyQuantities>>,
): OwnerMarketOrdersResponse {
  const orders = new Map<string, OwnerMarketOrder>();
  const getOrder = (typeId: number, locationId: number) => {
    const key = `${typeId}:${locationId}`;
    const existing = orders.get(key);
    if (existing) return existing;
    const order = { typeId, locationId, buyOrderQuantity: 0, sellOrderQuantity: 0 };
    orders.set(key, order);
    return order;
  };

  for (const item of sellOrders ?? []) {
    if (item.sourceLocationId === undefined) continue;
    getOrder(item.typeId, item.sourceLocationId).sellOrderQuantity += item.quantity;
  }
  for (const item of buyOrders ?? []) {
    getOrder(item.typeId, item.locationId).buyOrderQuantity += item.quantity;
  }
  return [...orders.values()];
}

/** Builds market-order stock for one attached character. */
export async function getMarketOrdersForCharacter(
  characterId: number,
  context: OwnerDataContext,
  options: MarketOrderOptions,
): Promise<OwnerMarketOrdersResponse> {
  assertCharacterOwner(characterId, context);
  const [marketOrderStock, marketBuyOrderQuantities] = await Promise.all([
    getMarketOrderStock(
      [characterId],
      {
        ...options,
        allCorporationSellOrdersAsStock: false,
        myCorporationSellOrdersAsStock: false,
      },
      context.sessionId,
      [],
    ),
    getMarketOrderBuyQuantities(
      [characterId],
      context.sessionId,
      [],
      { includeCorporationOrders: false },
    ),
  ]);
  return combineMarketOrders(marketOrderStock, marketBuyOrderQuantities);
}

/** Builds source-filtered market-order stock for one authorized corporation. */
export async function getMarketOrdersForCorporation(
  corporationId: number,
  context: OwnerDataContext,
  options: MarketOrderOptions,
): Promise<OwnerMarketOrdersResponse> {
  assertCorporationOwner(corporationId, context);
  const policy = getCorporationPolicy(corporationId, context);
  const corporationPolicies = policy ? [policy] : [];
  const [marketOrderStock, marketBuyOrderQuantities] = await Promise.all([
    getMarketOrderStock(
      [...context.characterIds],
      {
        ...options,
        personalSellOrdersAsStock: false,
      },
      context.sessionId,
      corporationPolicies,
    ),
    getMarketOrderBuyQuantities(
      [...context.characterIds],
      context.sessionId,
      corporationPolicies,
      { includePersonalOrders: false },
    ),
  ]);
  return combineMarketOrders(marketOrderStock, marketBuyOrderQuantities);
}
