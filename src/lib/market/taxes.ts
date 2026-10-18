import { z } from "zod";
import { marketHubs, type MarketHubId } from "@/lib/reference/marketHubs";
import type { CharacterStandingRecord } from "@/lib/esi/client";

/** Validated public price request; quantities and character data stay in the browser. */
export const taxPriceRequestSchema = z
  .object({
    typeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    marketId: z.enum(marketHubs.map((market) => market.id)),
  })
  .strict();

/** Public hub or global PLEX quote, including the upstream cache's freshness. */
export const taxPriceResponseSchema = z.object({
  typeId: z.number().int().positive(),
  marketId: z.enum(marketHubs.map((market) => market.id)),
  lowestSell: z.number().positive().nullable(),
  highestBuy: z.number().positive().nullable(),
  fetchedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["fresh", "cached", "stale", "rate_limited"]),
});

/** A validated market quote safe to use in client-side calculations. */
export type TaxPriceResponse = z.infer<typeof taxPriceResponseSchema>;

/** Skills and unmodified NPC standings used to calculate market fees. */
export type TradingProfile = {
  accounting: number;
  brokerRelations: number;
  factionStanding: number;
  corporationStanding: number;
};

/**
 * Selects the hub owner's unmodified standings without rounding or applying social skills.
 * @param standings Successful cached ESI body; null or undefined means unavailable.
 * @param marketId Supported hub whose station determines the corporation and faction.
 * @returns Exact faction/corporation standings; omitted entries are neutral only in a valid body.
 */
export function marketHubStandings(
  standings: readonly CharacterStandingRecord[] | null | undefined,
  marketId: MarketHubId,
): Pick<TradingProfile, "factionStanding" | "corporationStanding"> | null {
  if (!standings) return null;
  const hub = marketHubs.find((market) => market.id === marketId);
  if (!hub) return null;
  return {
    factionStanding:
      standings.find((entry) => entry.from_type === "faction" && entry.from_id === hub.factionId)
        ?.standing ?? 0,
    corporationStanding:
      standings.find(
        (entry) => entry.from_type === "npc_corp" && entry.from_id === hub.corporationId,
      )?.standing ?? 0,
  };
}

/** Buy-order placement settings; structure owner fees are additional to the mandatory SCC rate. */
export type BuyOrderSettings = {
  playerOwnedStructure: boolean;
  ownerBrokerFeePercent: number;
};

/** Mandatory Upwell market surcharge, confirmed against CCP's current guide on 2026-10-18.
 * @see https://support.eveonline.com/hc/en-us/articles/203218962
 * @see https://wiki.eveuniversity.org/Trading#Broker's_fee
 */
export const playerStructureSccSurchargeRate = 0.005;

/** Itemized order charges; brokerFee excludes the separately rounded SCC surcharge. */
export type TaxScenario = {
  unitPrice: number;
  gross: number;
  brokerFee: number;
  sccSurcharge: number;
  salesTax: number;
  total: number;
};

/** Rounds a monetary amount to the nearest ISK cent. */
function roundIsk(value: number): number {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value));
  return Math.round((value + tolerance) * 100) / 100;
}

/**
 * Returns the nearest valid price strictly under/over a quote, with four significant figures.
 * @param price Quoted unit price, or null when that side of the book is unavailable.
 * @param side Sell orders undercut; buy orders outbid.
 * @returns Competitive unit price, or null if no positive cent-denominated price exists.
 * @see https://www.eveonline.com/news/view/broker-relations
 */
function competitiveOrderPrice(price: number | null, side: "sell" | "buy"): number | null {
  if (price === null) return null;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Quoted prices must be positive finite amounts.");
  }
  const exponent = Number(price.toExponential().split("e")[1]);
  const crossesMagnitude = side === "sell" && price === 10 ** exponent;
  const tick = Math.max(0.01, 10 ** (exponent - (crossesMagnitude ? 4 : 3)));
  const scaledPrice = price / tick;
  const nearestTick = Math.round(scaledPrice);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaledPrice)) * 4;
  const tickPosition = Math.abs(scaledPrice - nearestTick) <= tolerance ? nearestTick : scaledPrice;
  const nextTick = side === "sell" ? Math.ceil(tickPosition) - 1 : Math.floor(tickPosition) + 1;
  const orderPrice = roundIsk(nextTick * tick);
  return orderPrice >= 0.01 ? orderPrice : null;
}

/**
 * Returns NPC market rates from skills and unmodified standings.
 * @see https://support.eveonline.com/hc/en-us/articles/203218962
 */
export function tradingFeeRates(profile: TradingProfile): { salesTax: number; brokerFee: number } {
  return {
    salesTax: 0.075 * (1 - 0.11 * profile.accounting),
    brokerFee:
      0.03
      - 0.003 * profile.brokerRelations
      - 0.0003 * profile.factionStanding
      - 0.0002 * profile.corporationStanding,
  };
}

/** Itemizes broker fees, an optional SCC surcharge and seller-only sales tax for one order. */
function scenario(
  unitPrice: number | null,
  quantity: number,
  rates: ReturnType<typeof tradingFeeRates>,
  selling: boolean,
  placingOrder: boolean,
  sccSurchargeRate = 0,
): TaxScenario | null {
  if (unitPrice === null) return null;
  const gross = roundIsk(unitPrice * quantity);
  const brokerFee = placingOrder ? roundIsk(Math.max(100, gross * rates.brokerFee)) : 0;
  const sccSurcharge = placingOrder ? roundIsk(gross * sccSurchargeRate) : 0;
  const salesTax = selling ? roundIsk(gross * rates.salesTax) : 0;
  return {
    unitPrice,
    gross,
    brokerFee,
    sccSurcharge,
    salesTax,
    total: roundIsk(
      selling ? gross - brokerFee - sccSurcharge - salesTax : gross + brokerFee + sccSurcharge,
    ),
  };
}

/** Averages two available amounts without inventing a quote when one order-book side is missing. */
function midpoint(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : roundIsk((left + right) / 2);
}

/** Expands quotes into four scenarios and before-fee, best-outcome, order and immediate splits. */
export function calculateMarketTaxes(
  prices: Pick<TaxPriceResponse, "lowestSell" | "highestBuy">,
  quantity: number,
  profile: TradingProfile,
  buyOrderSettings: BuyOrderSettings = { playerOwnedStructure: false, ownerBrokerFeePercent: 0 },
) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Quantity must be a positive safe integer.");
  }
  if (
    buyOrderSettings.playerOwnedStructure
    && (
      !Number.isFinite(buyOrderSettings.ownerBrokerFeePercent)
      || buyOrderSettings.ownerBrokerFeePercent < 0
      || buyOrderSettings.ownerBrokerFeePercent > 100
    )
  ) {
    throw new Error("Structure owner broker fee must be between 0% and 100%.");
  }
  const rates = tradingFeeRates(profile);
  const buyOrderBrokerRate = buyOrderSettings.playerOwnedStructure
    ? buyOrderSettings.ownerBrokerFeePercent / 100
    : rates.brokerFee;
  const buyOrderSccSurchargeRate = buyOrderSettings.playerOwnedStructure
    ? playerStructureSccSurchargeRate
    : 0;
  const sellOrder = scenario(
    competitiveOrderPrice(prices.lowestSell, "sell"),
    quantity,
    rates,
    true,
    true,
  );
  const instantSell = scenario(prices.highestBuy, quantity, rates, true, false);
  const instantBuy = scenario(prices.lowestSell, quantity, rates, false, false);
  const buyOrder = scenario(
    competitiveOrderPrice(prices.highestBuy, "buy"),
    quantity,
    { ...rates, brokerFee: buyOrderBrokerRate },
    false,
    true,
    buyOrderSccSurchargeRate,
  );
  const highestReceiveTotal =
    sellOrder && instantSell
      ? Math.max(sellOrder.total, instantSell.total)
      : (sellOrder?.total ?? instantSell?.total ?? null);
  const lowestPayTotal =
    buyOrder && instantBuy
      ? Math.min(buyOrder.total, instantBuy.total)
      : (buyOrder?.total ?? instantBuy?.total ?? null);
  return {
    rates,
    buyOrderBrokerRate,
    buyOrderSccSurchargeRate,
    sellOrder,
    instantSell,
    instantBuy,
    buyOrder,
    splitUnitPrice:
      prices.lowestSell === null || prices.highestBuy === null
        ? null
        : (prices.lowestSell + prices.highestBuy) / 2,
    splitBeforeFees: midpoint(instantBuy?.gross ?? null, instantSell?.gross ?? null),
    splitAfterFees: midpoint(highestReceiveTotal, lowestPayTotal),
    splitUsingOrders: midpoint(sellOrder?.total ?? null, buyOrder?.total ?? null),
    splitImmediate: midpoint(instantSell?.total ?? null, instantBuy?.total ?? null),
  };
}
