import assert from "node:assert/strict";
import test from "node:test";
import { presentationResult, shouldRetainSimulationLog, withSimulationId } from "./route";
import type {
  SimulationResultV2,
  SimulationResultWithDiagnostics,
} from "@/lib/planning/simulator/types";

const testEnvironment = process.env as unknown as Record<string, string | undefined>;

/** Builds the smallest valid internal simulator result for response-boundary tests. */
function diagnosticResult(): SimulationResultWithDiagnostics {
  return {
    metadata: {
      simulatorVersion: 15,
      policyVersion: 1,
      generatedAt: "2026-09-20T00:00:00.000Z",
      sdeRevision: "test",
      normalizedInputHash: "test",
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
      bpcToCopy: [
        {
          jobId: "copy-job",
          depth: 1,
          stockpileId: "main",
          locationId: 60000001,
          blueprintTypeId: 787,
          copies: 1,
          licensedRunsPerCopy: 1,
          totalLicensedRuns: 1,
          durationSeconds: 3600,
          inputs: [],
          assignments: [
            {
              assignmentId: "science:copy-job",
              characterId: 7,
              slotIndex: 0,
              units: 1,
              startOffsetSeconds: 3600,
              endOffsetSeconds: 7200,
              durationSeconds: 3600,
            },
          ],
          unscheduledCopies: 0,
        },
      ],
      inventionJobs: [],
      reactionJobs: [],
      manufacturingJobs: [
        {
          jobId: "manufacturing-job",
          depth: 1,
          activity: "manufacturing",
          stockpileId: "main",
          locationId: 60000001,
          productTypeId: 587,
          productName: "Rifter",
          blueprint: {
            blueprintTypeId: 787,
            blueprintItemId: 100,
            blueprintKind: "bpo",
            runs: 1,
            materialEfficiency: 0,
            timeEfficiency: 0,
          },
          outputPerRun: 1,
          requiredRuns: 1,
          readyNowRuns: 1,
          readyAfterHaulingRuns: 1,
          readyAfterUpstreamRuns: 1,
          blockedRuns: 0,
          unscheduledRuns: 0,
          materialMultiplier: 1,
          timeMultiplier: 1,
          durationPerRunSeconds: 3600,
          inputs: [],
          installs: [
            {
              installId: "install:manufacturing-job",
              characterId: 7,
              slotIndex: 0,
              runs: 1,
              startOffsetSeconds: 0,
              endOffsetSeconds: 3600,
              durationSeconds: 3600,
              readiness: "now",
              inputs: [],
            },
          ],
          demandSources: [],
        },
      ],
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

void test("omits diagnostic ledgers from development responses", () => {
  const previous = process.env.NODE_ENV;
  testEnvironment.NODE_ENV = "development";
  try {
    assert.equal("ledgers" in presentationResult(diagnosticResult()), false);
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

void test("preserves simulated activity offsets in the serialized response", () => {
  const responseBody = JSON.parse(
    JSON.stringify(withSimulationId(presentationResult(diagnosticResult()), "simulation-id")),
  ) as SimulationResultV2 & { metadata: { simulationId: string } };
  const install = responseBody.lists.manufacturingJobs[0]?.installs[0];
  const assignment = responseBody.lists.bpcToCopy[0]?.assignments[0];

  assert.equal(responseBody.metadata.simulationId, "simulation-id");
  assert.equal(install.startOffsetSeconds, 0);
  assert.equal(install.endOffsetSeconds, 3600);
  assert.equal(assignment.startOffsetSeconds, 3600);
  assert.equal(assignment.endOffsetSeconds, 7200);
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

void test("does not retain bodyless conditional responses as simulation logs", () => {
  assert.equal(shouldRetainSimulationLog(200), true);
  assert.equal(shouldRetainSimulationLog(400), true);
  assert.equal(shouldRetainSimulationLog(304), false);
});
