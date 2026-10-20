import { NextResponse } from "next/server";
import { getCongestion } from "@/lib/congestion";
import { config } from "@/lib/config";
import { ensureIntertieHour, ensureLmpHour, ensureRecentInterties } from "@/lib/ieso/congestion-ingest";
import { IesoFetchError } from "@/lib/ieso/ingest";
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
    let intertieError: string | undefined;
    if (config.congestion.enabled) {
      if (ts) {
        try {
          await ensureLmpHour(db, ts);
        } catch (e) {
          console.warn(`[congestion] on-demand price fetch for ${ts} failed: ${(e as Error).message}`);
        }
      }
      try {
        // Latest view: fetch the rolling intertie file if nothing recent is stored yet.
        await (ts ? ensureIntertieHour(db, ts) : ensureRecentInterties(db));
      } catch (e) {
        intertieError = e instanceof IesoFetchError ? `${e.message} — ${e.url}` : (e as Error).message;
        console.warn(`[congestion] intertie price fetch${ts ? ` for ${ts}` : ""} failed: ${intertieError}`);
      }
    }
    const body = await getCongestion(db, ts);
    if (intertieError && !body.interties.points.length) body.interties.fetchError = intertieError;
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load congestion: ${(e as Error).message}` }, { status: 500 });
  }
}
