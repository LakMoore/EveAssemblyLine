import { NextResponse } from "next/server";
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

/** Runs the version-one industry simulator without authentication or ESI side effects. */
export async function POST(request: Request) {
  const profiler = createRequestProfiler("plan-simulator");
  try {
    let body: unknown;
    try {
      body = await profiler.measure("parse-json", () => request.json());
    }
    catch {
      return NextResponse.json(
        { code: "invalid-json", error: "The simulator request was not valid JSON." },
        { status: 400, ...noStoreResponseInit },
      );
    }
    const parsed = simulatorRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "invalid-request",
          error: "The simulator request failed validation.",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400, ...noStoreResponseInit },
      );
    }
    const result = await profiler.measure("simulate", () => simulateIndustry(parsed.data));
    return NextResponse.json(presentationResult(result), noStoreResponseInit);
  }
  catch (error) {
    console.error("Industry simulation failed.", error);
    return NextResponse.json(
      { code: "simulation-failed", error: "Could not run the industry simulation." },
      { status: 500, ...noStoreResponseInit },
    );
  }
  finally {
    profiler.finish();
  }
}
