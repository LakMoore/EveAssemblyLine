import assert from "node:assert/strict";
import test from "node:test";
import { presentationResult, withSimulationId } from "./route";
import type { SimulationResultWithDiagnostics } from "@/lib/planning/simulator/types";

const testEnvironment = process.env as unknown as Record<string, string | undefined>;

/** Builds the smallest valid internal simulator result for response-boundary tests. */
function diagnosticResult(): SimulationResultWithDiagnostics {
  return {
    metadata: {
      simulatorVersion: 1,
      policyVersion: 1,
      generatedAt: "2026-09-20T00:00:00.000Z",
      sdeRevision: "test",
      normalizedInputHash: "test",
      elapsedMilliseconds: 0,
      warningCount: 0,
      invariantViolationCount: 0,
      unresolvedAssetCount: 0,
    },
    lists: {
      warnings: [],
      planItems: [],
      surplusItems: [],
      haulingTasks: [],
      materialsToBuy: [],
      bpoToBuy: [],
      reprocessingJobs: [],
      bpcToCopy: [],
      inventionJobs: [],
      reactionJobs: [],
      manufacturingJobs: [],
      skillsRequired: [],
    },
    ledgers: [],
  };
}

/** Restores NODE_ENV after a response-shape test changes it. */
function restoreNodeEnvironment(previous: string | undefined): void {
  if (previous === undefined) {
    delete testEnvironment.NODE_ENV;
  }
  else {
    testEnvironment.NODE_ENV = previous;
  }
}

void test("includes diagnostic ledgers in development responses", () => {
  const previous = process.env.NODE_ENV;
  testEnvironment.NODE_ENV = "development";
  try {
    assert.equal("ledgers" in presentationResult(diagnosticResult()), true);
  }
  finally {
    restoreNodeEnvironment(previous);
  }
});

void test("omits diagnostic ledgers outside development responses", () => {
  const previous = process.env.NODE_ENV;
  testEnvironment.NODE_ENV = "production";
  try {
    assert.equal("ledgers" in presentationResult(diagnosticResult()), false);
  }
  finally {
    restoreNodeEnvironment(previous);
  }
});

void test("returns the simulator ID in success metadata and errors", () => {
  const simulationId = "simulation-test-id";
  const success = withSimulationId(diagnosticResult(), simulationId) as {
    metadata: { simulationId: string };
  };
  const error = withSimulationId({ error: "failed" }, simulationId) as {
    simulationId: string;
  };
  assert.equal(success.metadata.simulationId, simulationId);
  assert.equal(error.simulationId, simulationId);
});
