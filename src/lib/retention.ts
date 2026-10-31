import { config } from "./config";
import type { Db } from "./db";

export interface PruneResult {
  cutoff: string | null;
  deleted: Record<string, number>;
}

/**
 * Delete history older than the retention window so the database stops growing without limit.
 * Price, constraint and generator history beyond `retentionDays` is dropped (and so is the
 * matching file coverage, so an older hour someone asks for is simply downloaded again).
 * Ingest log rows are kept for `logRetentionDays`.
 */
export async function pruneOldData(
  db: Db,
  now = new Date(),
  retentionDays = config.retentionDays,
  logRetentionDays = config.logRetentionDays,
): Promise<PruneResult> {
  const deleted: Record<string, number> = {};
  const run = async (label: string, sql: string, params: unknown[]) => {
    const rows = await db.query<{ n: number }>(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`, params);
    deleted[label] = rows[0]?.n ?? 0;
  };

  if (logRetentionDays > 0) {
    // Keep the newest row of each kind: freshness checks read it to decide when to poll next.
    await run(
      "ingest_log",
      `DELETE FROM ingest_log WHERE at < $1 AND id NOT IN (SELECT max(id) FROM ingest_log GROUP BY kind)`,
      [new Date(now.getTime() - logRetentionDays * 86_400_000).toISOString()],
    );
  }
  // Never prune inside the backfill window, or the backfill would download the same days again.
  const days = retentionDays > 0 ? Math.max(retentionDays, config.backfillDays + 2, config.status.referenceWindowDays + 2) : 0;
  if (days <= 0) return { cutoff: null, deleted };

  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const cutoffIso = cutoff.toISOString();
  // market_files periods start with the market date ("YYYY-MM-DD" or "YYYY-MM-DD HH"), so a string compare works.
  const cutoffDate = cutoffIso.slice(0, 10);
  for (const table of ["lmp_hourly", "intertie_lmp_hourly", "constraint_hourly", "observations"]) {
    await run(table, `DELETE FROM ${table} WHERE ts_utc < $1`, [cutoffIso]);
  }
  await run("market_files", `DELETE FROM market_files WHERE period < $1`, [cutoffDate]);
  return { cutoff: cutoffIso, deleted };
}
