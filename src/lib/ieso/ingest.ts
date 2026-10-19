import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import type { Db } from "../db";
import { addDays, compactDate, marketDateNow } from "../time";
import { parseGenOutputCapability, type ParsedReport } from "./parser";

/**
 * Server-side ingestion of the IESO Generator Output and Capability report.
 *
 *  - Latest report: polled every few minutes using conditional requests
 *    (If-None-Match / If-Modified-Since). A 304 or unchanged SHA-256 means nothing is
 *    re-parsed or re-written.
 *  - Daily archive files (PUB_GenOutputCapability_YYYYMMDD.xml) are used to backfill
 *    history and to finalise the previous market day.
 *  - Every successfully downloaded report is cached under data/cache/ for provenance.
 *  - Observations are upserted by (resource, hour), so later report versions that revise
 *    an hour replace the earlier value; the report id that supplied it is recorded.
 */

export type FetchOutcome =
  | { kind: "not-modified"; url: string }
  | { kind: "ok"; url: string; body: string; etag: string | null; lastModified: string | null };

export class IesoFetchError extends Error {
  constructor(message: string, public url: string, public httpStatus?: number) {
    super(message);
  }
}

export async function fetchReport(
  url: string,
  opts: { etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {},
): Promise<FetchOutcome> {
  const headers: Record<string, string> = { "User-Agent": "OntarioGenerationExplorer/1.0 (+local)" };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? config.fetchTimeoutMs), cache: "no-store" });
  } catch (e) {
    const err = e as Error;
    const reason = err.name === "TimeoutError" ? "request timed out" : err.message;
    throw new IesoFetchError(`IESO endpoint unreachable (${reason})`, url);
  }
  if (res.status === 304) return { kind: "not-modified", url };
  if (res.status === 404) throw new IesoFetchError("Report not found on IESO server (404)", url, 404);
  if (!res.ok) throw new IesoFetchError(`IESO server returned HTTP ${res.status}`, url, res.status);
  const body = await res.text();
  return { kind: "ok", url, body, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
}

function cacheDir(): string {
  const d = process.env.IESO_CACHE_DIR ?? (process.env.VERCEL ? path.join(os.tmpdir(), "oge-cache") : path.join(process.cwd(), "data", "cache"));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export interface StoreResult {
  stored: boolean;
  reason?: string;
  reportId?: number;
  reportDate?: string;
  maxHour?: number | null;
  observations?: number;
  warnings?: string[];
}

/** Persist a parsed report and its observations. Idempotent on SHA-256. */
export async function storeReport(
  db: Db,
  parsed: ParsedReport,
  meta: { url: string; kind: "latest" | "daily" | "file"; sha: string; etag?: string | null; lastModified?: string | null; cacheFile?: string | null },
): Promise<StoreResult> {
  const existing = await db.query<{ id: number }>("SELECT id FROM reports WHERE sha256 = $1", [meta.sha]);
  if (existing.length) return { stored: false, reason: "duplicate content (already ingested)", reportId: existing[0].id };

  return db.transaction(async (tx) => {
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO reports (report_date, source_url, kind, created_at_est, created_at_utc, etag, last_modified, sha256,
         resource_count, max_hour, observation_count, warnings, cache_file)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING id`,
      [
        parsed.reportDate, meta.url, meta.kind, parsed.createdAtEst, parsed.createdAtUtc, meta.etag ?? null,
        meta.lastModified ?? null, meta.sha, parsed.resourceCount, parsed.maxHour, parsed.observations.length,
        JSON.stringify(parsed.warnings.slice(0, 500)), meta.cacheFile ?? null,
      ],
    );
    const reportId = ins[0].id;

    for (const r of parsed.resources) {
      await tx.query(
        `INSERT INTO ieso_resources (ieso_name, ieso_fuel, first_seen_report, last_seen_report) VALUES ($1,$2,$3,$3)
         ON CONFLICT (ieso_name) DO UPDATE SET ieso_fuel = EXCLUDED.ieso_fuel,
           first_seen_report = LEAST(ieso_resources.first_seen_report, EXCLUDED.first_seen_report),
           last_seen_report = GREATEST(ieso_resources.last_seen_report, EXCLUDED.last_seen_report)`,
        [r.name, r.fuel, parsed.reportDate],
      );
    }

    const CHUNK = 400;
    const obs = parsed.observations;
    for (let i = 0; i < obs.length; i += CHUNK) {
      const slice = obs.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((o, j) => {
        const b = j * 10;
        values.push(o.iesoName, o.tsUtc, o.reportDate, o.hour, o.outputMW, o.capabilityMW, o.forecastMW, o.availCapacityMW, o.iesoFuel, reportId);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
      });
      await tx.query(
        `INSERT INTO observations (ieso_name, ts_utc, report_date, hour, output_mw, capability_mw, forecast_mw, avail_capacity_mw, ieso_fuel, report_id)
         VALUES ${tuples.join(",")}
         ON CONFLICT (ieso_name, ts_utc) DO UPDATE SET
           output_mw = COALESCE(EXCLUDED.output_mw, observations.output_mw),
           capability_mw = COALESCE(EXCLUDED.capability_mw, observations.capability_mw),
           forecast_mw = COALESCE(EXCLUDED.forecast_mw, observations.forecast_mw),
           avail_capacity_mw = COALESCE(EXCLUDED.avail_capacity_mw, observations.avail_capacity_mw),
           ieso_fuel = EXCLUDED.ieso_fuel, report_id = EXCLUDED.report_id`,
        values,
      );
    }
    return { stored: true, reportId, reportDate: parsed.reportDate, maxHour: parsed.maxHour, observations: obs.length, warnings: parsed.warnings };
  });
}

async function log(db: Db, kind: string, ok: boolean, message: string) {
  try {
    await db.query("INSERT INTO ingest_log (kind, ok, message) VALUES ($1,$2,$3)", [kind, ok, message.slice(0, 2000)]);
  } catch {
    /* logging must never break ingestion */
  }
}

/** Ingest an XML body that has already been downloaded (also used by tests & CLI). */
export async function ingestXml(
  db: Db,
  xml: string,
  meta: { url: string; kind: "latest" | "daily" | "file"; etag?: string | null; lastModified?: string | null },
): Promise<StoreResult> {
  const sha = sha256(xml);
  const parsed = parseGenOutputCapability(xml);
  let cacheFile: string | null = null;
  try {
    cacheFile = path.join(cacheDir(), `GenOutputCapability_${compactDate(parsed.reportDate)}_${sha.slice(0, 12)}.xml`);
    if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, xml);
  } catch {
    cacheFile = null;
  }
  return storeReport(db, parsed, { ...meta, sha, cacheFile });
}

let latestInFlight: Promise<StoreResult & { notModified?: boolean }> | null = null;

/** Poll the latest report (conditional GET). Concurrent callers share one request. */
export function ingestLatest(db: Db): Promise<StoreResult & { notModified?: boolean }> {
  if (latestInFlight) return latestInFlight;
  latestInFlight = (async () => {
    const url = config.iesoBaseUrl + config.latestFile;
    const prev = await db.query<{ etag: string | null; last_modified: string | null }>(
      "SELECT etag, last_modified FROM reports WHERE kind = 'latest' ORDER BY id DESC LIMIT 1",
    );
    try {
      const res = await fetchReport(url, { etag: prev[0]?.etag, lastModified: prev[0]?.last_modified });
      if (res.kind === "not-modified") {
        await log(db, "latest", true, "Not modified (HTTP 304)");
        return { stored: false, reason: "not modified", notModified: true };
      }
      const r = await ingestXml(db, res.body, { url, kind: "latest", etag: res.etag, lastModified: res.lastModified });
      await log(db, "latest", true, r.stored ? `Stored report ${r.reportDate} through HE${r.maxHour} (${r.observations} obs, ${r.warnings?.length ?? 0} warnings)` : `Unchanged: ${r.reason}`);
      return r;
    } catch (e) {
      await log(db, "latest", false, (e as Error).message);
      throw e;
    }
  })().finally(() => {
    latestInFlight = null;
  });
  return latestInFlight;
}

/** Ingest one daily archive file for a market date (YYYY-MM-DD). */
export async function ingestDaily(db: Db, reportDate: string): Promise<StoreResult> {
  const url = `${config.iesoBaseUrl}PUB_GenOutputCapability_${compactDate(reportDate)}.xml`;
  try {
    const res = await fetchReport(url);
    if (res.kind !== "ok") return { stored: false, reason: "not modified" };
    const r = await ingestXml(db, res.body, { url, kind: "daily", etag: res.etag, lastModified: res.lastModified });
    await log(db, "daily", true, `${reportDate}: ${r.stored ? `stored ${r.observations} obs` : r.reason}`);
    return r;
  } catch (e) {
    await log(db, "daily", false, `${reportDate}: ${(e as Error).message}`);
    throw e;
  }
}

/** Dates (market days) that do not yet have a complete 24-hour daily archive ingested. */
export async function missingDailyDates(db: Db, days: number, now = new Date()): Promise<string[]> {
  const today = marketDateNow(now);
  const have = await db.query<{ d: string }>(
    "SELECT DISTINCT to_char(report_date, 'YYYY-MM-DD') AS d FROM reports WHERE kind = 'daily' AND max_hour = 24",
  );
  const haveSet = new Set(have.map((h) => h.d));
  const out: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, -i);
    if (!haveSet.has(d)) out.push(d);
  }
  return out;
}

export async function backfill(
  db: Db,
  days = config.backfillDays,
  onProgress?: (msg: string) => void,
): Promise<{ ok: string[]; failed: { date: string; error: string }[] }> {
  const dates = await missingDailyDates(db, days);
  const ok: string[] = [];
  const failed: { date: string; error: string }[] = [];
  const CONCURRENCY = 3;
  let idx = 0;
  async function worker() {
    while (idx < dates.length) {
      const d = dates[idx++];
      try {
        await ingestDaily(db, d);
        ok.push(d);
        onProgress?.(`backfilled ${d}`);
      } catch (e) {
        failed.push({ date: d, error: (e as Error).message });
        onProgress?.(`failed ${d}: ${(e as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker));
  return { ok, failed };
}
