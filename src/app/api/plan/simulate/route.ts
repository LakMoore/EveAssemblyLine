import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionFromRequest } from "@/lib/auth/session";
import { logSimulationRequest } from "@/lib/planning/planRequestLogger";
import { simulatorRequestSchema } from "@/lib/planning/simulator/schema";
import { simulateIndustry } from "@/lib/planning/simulator/simulate";
import type {
  SimulationResultV1,
  SimulationResultWithDiagnostics,
} from "@/lib/planning/simulator/types";
import { createRequestProfiler } from "@/lib/server/profiling";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreResponseInit: ResponseInit = {
  headers: { "Cache-Control": "no-store" },
};

/** Removes diagnostic ledger projections from non-development responses. */
export function presentationResult(result: SimulationResultWithDiagnostics): SimulationResultV1 {
  if (process.env.NODE_ENV === "development") return result;
  const { ledgers: _ledgers, ...publicResult } = result;
  return publicResult;
}

/** Adds the retained simulator request ID to a response without changing its result lists. */
export function withSimulationId(body: unknown, simulationId: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { simulationId, error: "The simulator request was not valid JSON." };
  }
  const record = body as Record<string, unknown>;
  if (record.error) return { ...record, simulationId };
  const metadata = record.metadata;
  return {
    ...record,
    metadata: {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      simulationId,
    },
  };
}

/** Runs the version-one industry simulator without authentication or ESI side effects. */
export async function POST(request: Request) {
  const simulationId = randomUUID();
  const requestedAt = new Date().toISOString();
  const profiler = createRequestProfiler("plan-simulator", { simulationId });
  const session = await getSessionFromRequest(request).catch(() => null);
  let rawRequestBody = "";

  function logResponse(rawResponseBody: string, responseStatus: number) {
    logSimulationRequest({
      id: simulationId,
      requestedAt,
      sessionCollectionId: session?.collectionId,
      rawRequestBody,
      rawResponseBody,
      responseStatus,
    });
  }

  try {
    let body: unknown;
    try {
      rawRequestBody = await profiler.measure("read-body", () => request.text());
      body = await profiler.measure("parse-json", () => JSON.parse(rawRequestBody));
    }
    catch {
      const responseBody = withSimulationId(
        {
          code: "invalid-json",
          error: "The simulator request was not valid JSON.",
        },
        simulationId,
      );
      logResponse(JSON.stringify(responseBody), 400);
      return NextResponse.json(responseBody, { status: 400, ...noStoreResponseInit });
    }
    const parsed = simulatorRequestSchema.safeParse(body);
    if (!parsed.success) {
      const responseBody = withSimulationId(
        {
          code: "invalid-request",
          error: "The simulator request failed validation.",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        simulationId,
      );
      logResponse(JSON.stringify(responseBody), 400);
      return NextResponse.json(responseBody, { status: 400, ...noStoreResponseInit });
    }
    const result = await profiler.measure(
      "simulate",
      () => simulateIndustry(parsed.data, profiler),
    );
    const responseBody = withSimulationId(presentationResult(result), simulationId);
    logResponse(JSON.stringify(responseBody), 200);
    return NextResponse.json(responseBody, noStoreResponseInit);
  }
  catch (error) {
    console.error("Industry simulation failed.", error);
    const responseBody = withSimulationId(
      {
        code: "simulation-failed",
        error: "Could not run the industry simulation.",
      },
      simulationId,
    );
    logResponse(JSON.stringify(responseBody), 500);
    return NextResponse.json(responseBody, { status: 500, ...noStoreResponseInit });
  }
  finally {
    profiler.finish();
  }
}
