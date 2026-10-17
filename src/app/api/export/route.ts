import { ensureInitialized } from "@/lib/server";
import { getObservationsForExport } from "@/lib/state";
import { toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/export?ids=a,b&range=7d — hourly generation observations as CSV (with provenance). */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const range = sp.get("range") ?? "24h";
  const db = await ensureInitialized();
  const rows = await getObservationsForExport(db, ids.length ? ids : null, range, sp.get("end"));
  const csv = toCsv(
    rows.map((r) => ({ ...r, ts_utc: new Date(r.ts_utc as string).toISOString() })),
    [
      "ts_utc", "report_date", "hour_ending_est", "facility_id", "facility_name", "ieso_name", "ieso_fuel",
      "output_mw", "capability_mw", "forecast_mw", "avail_capacity_mw", "source_url", "created_at_est",
    ],
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ieso_generation_${range}.csv"`,
    },
  });
}
