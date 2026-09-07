"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { PlanRequestLog } from "@/lib/planning/planRequestLogger";

type PlanRequestLogSummary = Omit<PlanRequestLog, "rawRequestBody" | "rawResponseBody">;
type PlanLogPage = {
  logs: PlanRequestLogSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
/** Loads and compares retained plan requests for the protected administration page. */
export default function PlanLogReview() {
  const [page, setPage] = useState<PlanLogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  async function loadLogs(nextPage = 1) {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/plan-logs?page=${nextPage}&pageSize=25`,
        {
          cache: "no-store",
        },
      );
      const body = (await response.json()) as PlanLogPage & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load plan logs.");
      setPage(body);
    }
    catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load plan logs.");
    }
    finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => loadLogs());
  }, []);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="plan-log-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="plan-log-heading" className="text-lg font-semibold">
            Plan request log
          </h2>
          <p className="text-muted-foreground text-sm">
            Retained request and response bodies for reproducing reported plans.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadLogs(page?.page ?? 1)}
          disabled={isLoading}
        >
          {isLoading ? <Spinner /> : <RefreshCw aria-hidden="true" />}
          Refresh log
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Plan log unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {page?.logs.length ? (
        <div className="overflow-x-auto border">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Plan ID</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {page.logs.map((log) => (
                <tr key={log.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-4 py-3">
                    {new Date(log.requestedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link
                      className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
                      href={`/admin/plans/${log.id}`}
                    >
                      {log.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{log.responseStatus}</td>
                  <td className="px-4 py-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.location.assign(`/admin/plans/${log.id}`)}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : isLoading ? (
        <div className="flex min-h-24 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <Empty>
          <EmptyDescription>No plan requests have been logged.</EmptyDescription>
        </Empty>
      )}
      {page && page.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{page.total.toLocaleString()} requests</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={page.page <= 1 || isLoading}
              onClick={() => void loadLogs(page.page - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page.page} of {page.totalPages}
            </span>
            <Button
              variant="outline"
              disabled={page.page >= page.totalPages || isLoading}
              onClick={() => void loadLogs(page.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
