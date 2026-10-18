import { NextResponse } from "next/server";
import { ensureInitialized } from "@/lib/server";
import { allAttempted, getTxRisk, refreshAll } from "@/lib/txrisk/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let lastManual = 0;

/** GET /api/txrisk?t=ISO — transmission outages, limits and risk classification at instant t (default now). */
export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const t = new URL(req.url).searchParams.get("t");
    // First request after start-up waits for one attempt at each report; later ones refresh in the background.
    if (!allAttempted()) await refreshAll(false);
    else void refreshAll(false);
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
    await refreshAll(true);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
  }
}
