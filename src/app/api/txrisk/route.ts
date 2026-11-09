import { after, NextResponse } from "next/server";
import { ensureInitialized } from "@/lib/server";
import { allAttempted, getTxRisk, refreshAll, syncTxReports } from "@/lib/txrisk/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let lastManual = 0;

/** GET /api/txrisk?t=ISO — transmission outages, limits and risk classification at instant t (default now). */
export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const t = new URL(req.url).searchParams.get("t");
    // Stored copies (shared by every server instance) first; only a report never checked anywhere is waited for.
    await syncTxReports(db).catch(() => undefined);
    if (!allAttempted()) await refreshAll(false, db);
    // after() keeps the background refresh alive on serverless hosts once the response is sent.
    else after(() => refreshAll(false, db).catch(() => undefined));
    return NextResponse.json(await getTxRisk(db, t), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load transmission outages: ${(e as Error).message}` }, { status: 500 });
  }
}

/** POST /api/txrisk — manual "Refresh IESO data": re-checks all four reports now (conditional requests). */
export async function POST() {
  const now = Date.now();
  if (now - lastManual < 30_000) return NextResponse.json({ ok: false, message: "Refreshed less than 30 s ago; try again shortly." }, { status: 429 });
  lastManual = now;
  try {
    await refreshAll(true, await ensureInitialized());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
  }
}
