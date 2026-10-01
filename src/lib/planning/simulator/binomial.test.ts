import assert from "node:assert/strict";
import test from "node:test";
import { inventionSuccessConfidence, minimumAttemptsForSuccesses } from "./binomial";

/** Calculates a small binomial tail directly for independent test assertions. */
function probabilityOfAtLeastSuccesses(
  attempts: number,
  requiredSuccesses: number,
  successProbability: number,
): number {
  const failureProbability = 1 - successProbability;
  let termProbability = failureProbability ** attempts;
  let belowGoalProbability = termProbability;
  for (let successes = 1; successes < requiredSuccesses; successes += 1) {
    termProbability
      *= ((attempts - successes + 1) / successes) * (successProbability / failureProbability);
    belowGoalProbability += termProbability;
  }
  return 1 - belowGoalProbability;
}

void test("finds the minimum attempts for one success at 43 percent", () => {
  const attempts = minimumAttemptsForSuccesses(1, 0.43);

  assert.equal(attempts, 6);
  assert.ok(probabilityOfAtLeastSuccesses(attempts, 1, 0.43) >= inventionSuccessConfidence);
  assert.ok(probabilityOfAtLeastSuccesses(attempts - 1, 1, 0.43) < inventionSuccessConfidence);
});

void test("finds the minimum attempts for four successes at 43.35 percent", () => {
  const successProbability = 0.4335;
  const attempts = minimumAttemptsForSuccesses(4, successProbability);

  assert.equal(attempts, 16);
  assert.ok(
    probabilityOfAtLeastSuccesses(attempts, 4, successProbability) >= inventionSuccessConfidence,
  );
  assert.ok(
    probabilityOfAtLeastSuccesses(attempts - 1, 4, successProbability) < inventionSuccessConfidence,
  );
});

void test("uses one attempt per required success when success is certain", () => {
  assert.equal(minimumAttemptsForSuccesses(4, 1), 4);
});
