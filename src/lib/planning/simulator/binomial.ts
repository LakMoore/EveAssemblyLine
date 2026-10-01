/** The default probability that invention attempts must reach for the requested output. */
export const inventionSuccessConfidence = 0.95;

/** Returns the fewest independent attempts that meet a binomial success-confidence target. */
export function minimumAttemptsForSuccesses(
  requiredSuccesses: number,
  successProbability: number,
  targetConfidence = inventionSuccessConfidence,
): number {
  if (!Number.isSafeInteger(requiredSuccesses) || requiredSuccesses < 1) {
    throw new RangeError("Required successes must be a positive safe integer.");
  }
  if (!Number.isFinite(successProbability) || successProbability <= 0 || successProbability > 1) {
    throw new RangeError("Success probability must be greater than zero and at most one.");
  }
  if (!Number.isFinite(targetConfidence) || targetConfidence <= 0 || targetConfidence >= 1) {
    throw new RangeError("Target confidence must be greater than zero and less than one.");
  }
  if (successProbability === 1) return requiredSuccesses;

  const failureProbabilityLimit = 1 - targetConfidence;
  let lowerAttemptCount = requiredSuccesses - 1;
  let upperAttemptCount = requiredSuccesses;

  while (
    !meetsSuccessConfidence(
      upperAttemptCount,
      requiredSuccesses,
      successProbability,
      failureProbabilityLimit,
    )
  ) {
    lowerAttemptCount = upperAttemptCount;
    upperAttemptCount = Math.min(Number.MAX_SAFE_INTEGER, upperAttemptCount * 2);
    if (upperAttemptCount <= lowerAttemptCount) {
      throw new RangeError("Could not reach the target confidence with a safe attempt count.");
    }
  }

  while (upperAttemptCount - lowerAttemptCount > 1) {
    const middleAttemptCount =
      lowerAttemptCount + Math.floor((upperAttemptCount - lowerAttemptCount) / 2);
    if (
      meetsSuccessConfidence(
        middleAttemptCount,
        requiredSuccesses,
        successProbability,
        failureProbabilityLimit,
      )
    ) {
      upperAttemptCount = middleAttemptCount;
    }
    else {
      lowerAttemptCount = middleAttemptCount;
    }
  }

  return upperAttemptCount;
}

/** Tests the lower binomial tail, summing downward from the largest failure count. */
function meetsSuccessConfidence(
  attempts: number,
  requiredSuccesses: number,
  successProbability: number,
  failureProbabilityLimit: number,
): boolean {
  if (attempts < requiredSuccesses) return false;
  const failureChance = 1 - successProbability;
  const largestFailureCount = requiredSuccesses - 1;
  let termProbability = Math.exp(
    logBinomialCoefficient(attempts, largestFailureCount)
      + largestFailureCount * Math.log(successProbability)
      + (attempts - largestFailureCount) * Math.log(failureChance),
  );
  let lowerTailProbability = termProbability;
  if (lowerTailProbability > failureProbabilityLimit) return false;

  for (let successes = largestFailureCount; successes > 0; successes -= 1) {
    const nextTermRatio =
      (successes / (attempts - successes + 1)) * (failureChance / successProbability);
    termProbability *= nextTermRatio;
    lowerTailProbability += termProbability;
    if (lowerTailProbability > failureProbabilityLimit) return false;
    if (termProbability === 0) return true;

    const nextSuccesses = successes - 1;
    if (nextSuccesses === 0) return true;
    const remainingTermRatio =
      (nextSuccesses / (attempts - nextSuccesses + 1)) * (failureChance / successProbability);
    if (remainingTermRatio < 1) {
      const remainingTailUpperBound =
        (termProbability * remainingTermRatio) / (1 - remainingTermRatio);
      if (lowerTailProbability + remainingTailUpperBound <= failureProbabilityLimit) return true;
    }
  }

  return true;
}

/** Calculates a log binomial coefficient without factorial overflow. */
function logBinomialCoefficient(attempts: number, successes: number): number {
  const factors = Math.min(successes, attempts - successes);
  let logarithm = 0;
  for (let factor = 1; factor <= factors; factor += 1) {
    logarithm += Math.log(attempts - factors + factor) - Math.log(factor);
  }
  return logarithm;
}
