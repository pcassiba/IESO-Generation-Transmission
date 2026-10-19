import { after, NextResponse } from "next/server";
import { ensureInitialized, pollServerless } from "@/lib/server";
import { getState } from "@/lib/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const ts = new URL(req.url).searchParams.get("ts");
    const state = await getState(db, ts);
    // On Vercel nothing polls in the background, so page views keep the data fresh (after the response is sent).
    if (process.env.VERCEL) after(() => pollServerless().catch((e) => console.warn(`[poll] ${(e as Error).message}`)));
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Failed to load state: ${(e as Error).message}` }, { status: 500 });
  }
}
