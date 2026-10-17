import { NextResponse } from "next/server";
import { getCongestion } from "@/lib/congestion";
import { ensureInitialized } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/congestion?ts=… — nodal congestion and binding constraints for the hour at or before ts. */
export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const ts = new URL(req.url).searchParams.get("ts");
    return NextResponse.json(await getCongestion(db, ts), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load congestion: ${(e as Error).message}` }, { status: 500 });
  }
}
