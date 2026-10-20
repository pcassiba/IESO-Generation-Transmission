import { NextResponse } from "next/server";
import { getCongestion } from "@/lib/congestion";
import { config } from "@/lib/config";
import { ensureLmpHour } from "@/lib/ieso/congestion-ingest";
import { ensureInitialized } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/congestion?ts=… — nodal congestion and binding constraints for the hour at or before ts. */
export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const ts = new URL(req.url).searchParams.get("ts");
    // Hours older than the backfill window are fetched from the IESO archive the first time they're asked for.
    if (ts && config.congestion.enabled) {
      try {
        await ensureLmpHour(db, ts);
      } catch (e) {
        console.warn(`[congestion] on-demand price fetch for ${ts} failed: ${(e as Error).message}`);
      }
    }
    return NextResponse.json(await getCongestion(db, ts), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load congestion: ${(e as Error).message}` }, { status: 500 });
  }
}
