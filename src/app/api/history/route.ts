import { NextResponse } from "next/server";
import { ensureInitialized } from "@/lib/server";
import { getFuelHistory, getHistory } from "@/lib/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const db = await ensureInitialized();
    const sp = new URL(req.url).searchParams;
    const range = sp.get("range") ?? "24h";
    const end = sp.get("end");
    if (sp.get("fuel") === "1") {
      return NextResponse.json({ range, points: await getFuelHistory(db, range, end) });
    }
    const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
    if (!ids.length) return NextResponse.json({ error: "ids parameter required" }, { status: 400 });
    return NextResponse.json({ range, facilities: await getHistory(db, ids, range, end) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
