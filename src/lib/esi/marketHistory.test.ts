import assert from "node:assert/strict";
import test from "node:test";
import { calculateRegionalAppraisalPrices } from "./marketHistory";

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
