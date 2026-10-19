import { NextResponse } from "next/server";
import { pollServerless } from "@/lib/server";

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
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
