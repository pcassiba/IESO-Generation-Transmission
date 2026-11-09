import { NextResponse } from "next/server";
import { pruneOldData } from "@/lib/retention";
import { ensureInitialized, pollServerless } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/cron — scheduled poll for serverless hosts (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const r = await pollServerless({ minIntervalMinutes: 0 });
    // Once a day, drop history older than the retention window so the database doesn't keep growing.
    const pruned = await pruneOldData(await ensureInitialized()).catch((e) => ({ error: (e as Error).message }));
    return NextResponse.json({ ok: true, ...r, pruned });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
