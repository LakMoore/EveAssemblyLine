import { cullPlanRequestLogs } from "../src/lib/planning/planRequestLogger";

const defaultRetentionDays = 30;

function parseRetentionDays(): number {
  const argument = process.argv.find((value) => value.startsWith("--days="));
  const days = Number(argument?.slice("--days=".length) ?? defaultRetentionDays);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("--days must be a positive integer.");
  }
  return days;
}

async function main(): Promise<void> {
  const retentionDays = parseRetentionDays();
  const apply = process.argv.includes("--apply");
  const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await cullPlanRequestLogs(before, apply);

  console.log(`Plan logs older than ${before.toISOString()}: ${result.eligible}`);
  console.log(
    `${apply ? "Deleted" : "Would delete"} ${apply ? result.deleted : result.eligible} plan logs.`,
  );
  if (result.failed > 0) console.log(`Failed to process ${result.failed} plan logs.`);
  if (!apply) console.log("Dry run only. Re-run with --apply to delete these logs.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
