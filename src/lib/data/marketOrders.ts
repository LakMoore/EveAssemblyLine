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

export type OwnerMarketOrdersResponse = {
  marketOrderStock: PlanStockItem[] | null;
  marketBuyOrderQuantities: Record<string, number> | null;
};

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
  return { marketOrderStock, marketBuyOrderQuantities };
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
  return { marketOrderStock, marketBuyOrderQuantities };
}
