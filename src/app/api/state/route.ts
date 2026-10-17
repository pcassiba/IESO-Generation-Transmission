import { NextResponse } from "next/server";
import { ensureInitialized } from "@/lib/server";
import { getState } from "@/lib/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const ts = new URL(req.url).searchParams.get("ts");
    const state = await getState(db, ts);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load state: ${(e as Error).message}` }, { status: 500 });
  }
}
