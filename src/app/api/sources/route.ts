import { NextResponse } from "next/server";
import { ensureInitialized } from "@/lib/server";
import { getSources } from "@/lib/sources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/sources?ts=… — the IESO report, file and hour behind each dataset shown for that hour. */
export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const body = await getSources(db, new URL(req.url).searchParams.get("ts"));
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load data sources: ${(e as Error).message}` }, { status: 500 });
  }
}
