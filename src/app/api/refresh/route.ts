import { NextResponse } from "next/server";
import { ensureInitialized, runtime as rt } from "@/lib/server";
import { ingestLatest } from "@/lib/ieso/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let lastManual = 0;

/** POST /api/refresh — manually trigger a conditional fetch of the latest IESO report. */
export async function POST() {
  const now = Date.now();
  if (now - lastManual < 30_000) {
    return NextResponse.json({ ok: false, message: "Refresh rate-limited (30 s). The server also polls automatically." }, { status: 429 });
  }
  lastManual = now;
  try {
    const db = await ensureInitialized();
    const r = await ingestLatest(db);
    return NextResponse.json({
      ok: true,
      message: r.notModified ? "IESO report unchanged since last fetch (HTTP 304)." : r.stored ? `New report stored: ${r.reportDate} through HE${r.maxHour} EST.` : `No new data (${r.reason}).`,
      result: r,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, message: `IESO fetch failed: ${(e as Error).message}. Showing last stored data.` }, { status: 502 });
  }
}

/** GET /api/refresh — ingestion/scheduler status. */
export async function GET() {
  const r = rt();
  const db = await ensureInitialized();
  const log = await db.query("SELECT at, kind, ok, message FROM ingest_log ORDER BY id DESC LIMIT 25");
  const reports = await db.query(
    "SELECT id, to_char(report_date,'YYYY-MM-DD') AS report_date, kind, created_at_est, fetched_at, max_hour, observation_count, jsonb_array_length(warnings) AS warnings FROM reports ORDER BY id DESC LIMIT 25",
  );
  return NextResponse.json({
    scheduler: { started: r.schedulerStarted, lastPollAt: r.lastPollAt, lastPollError: r.lastPollError, backfillRunning: r.backfillRunning, backfillProgress: r.backfillProgress },
    metadataIssues: r.metadataIssues,
    log,
    reports,
  });
}
