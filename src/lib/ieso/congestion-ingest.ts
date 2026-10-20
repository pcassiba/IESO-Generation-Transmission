import { config } from "../config";
import type { Db } from "../db";
import { addDays, compactDate, hourEndingToUtc, marketDateNow, utcToMarketHour } from "../time";
import { fetchReport, IesoFetchError, sha256 } from "./ingest";
import { parseConstraintShadowPrices, parseRealtimeIntertieLmp, parseRealtimeLmpCsv, type ParsedConstraints, type ParsedIntertieLmp, type ParsedLmp } from "./market";

/**
 * Ingestion of the congestion reports (nodal LMP components and constraint shadow prices).
 *
 *  - LMP: one archived CSV per delivery hour (PUB_RealtimeEnergyLMP_YYYYMMDDHH.csv) plus a
 *    rolling file for the hour in progress. Each hour is stored once complete (12 intervals).
 *  - Intertie LMP: one archived XML per delivery hour (PUB_RealTimeIntertieLMP_YYYYMMDDHH.xml)
 *    plus a rolling file, handled the same way as the nodal prices.
 *  - Constraints: one archived XML per delivery day (PUB_RealtimeConstrShadowPrices_YYYYMMDD.xml).
 *    IESO publishes these several days after the fact, so recent days 404 for a while; a missing
 *    day is retried at most once an hour.
 *
 * Coverage is tracked in market_files so nothing complete is fetched twice.
 */

const HOUR = 3_600_000;
const LMP = "lmp";
const CONSTRAINTS = "constraints";
const INTERTIE = "intertie";

const hourPeriod = (date: string, hour: number) => `${date} ${String(hour).padStart(2, "0")}`;

async function log(db: Db, kind: string, ok: boolean, message: string) {
  try {
    await db.query("INSERT INTO ingest_log (kind, ok, message) VALUES ($1,$2,$3)", [kind, ok, message.slice(0, 2000)]);
  } catch {
    /* logging must never break ingestion */
  }
}

async function markFile(db: Pick<Db, "query">, report: string, period: string, url: string, sha: string, complete: boolean, rows: number) {
  await db.query(
    `INSERT INTO market_files (report, period, url, sha256, complete, row_count) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (report, period) DO UPDATE SET url = EXCLUDED.url, sha256 = EXCLUDED.sha256,
       complete = market_files.complete OR EXCLUDED.complete, row_count = EXCLUDED.row_count, fetched_at = now()`,
    [report, period, url, sha, complete, rows],
  );
}

/** Store parsed LMP rows (upsert by location + hour) and record each hour's coverage. */
export async function storeLmp(db: Db, parsed: ParsedLmp, url: string, sha: string): Promise<{ hours: string[]; rows: number }> {
  const byHour = new Map<number, number>();
  for (const r of parsed.rows) byHour.set(r.hour, Math.max(byHour.get(r.hour) ?? 0, r.intervals));
  await db.transaction(async (tx) => {
    const CHUNK = 500;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const slice = parsed.rows.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((r, j) => {
        const b = j * 8;
        values.push(r.location, r.tsUtc, r.intervals, r.lmp, r.loss, r.congestion, r.congestionMin, r.congestionMax);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      });
      await tx.query(
        `INSERT INTO lmp_hourly (location, ts_utc, intervals, lmp, loss, congestion, congestion_min, congestion_max)
         VALUES ${tuples.join(",")}
         ON CONFLICT (location, ts_utc) DO UPDATE SET intervals = EXCLUDED.intervals, lmp = EXCLUDED.lmp, loss = EXCLUDED.loss,
           congestion = EXCLUDED.congestion, congestion_min = EXCLUDED.congestion_min, congestion_max = EXCLUDED.congestion_max
         WHERE EXCLUDED.intervals >= lmp_hourly.intervals`,
        values,
      );
    }
    for (const [hour, ints] of byHour) await markFile(tx, LMP, hourPeriod(parsed.deliveryDate, hour), url, sha, ints >= 12, parsed.rows.filter((r) => r.hour === hour).length);
  });
  return { hours: [...byHour.keys()].map((h) => hourPeriod(parsed.deliveryDate, h)), rows: parsed.rows.length };
}

/** Store one hour of intertie prices and record its coverage. */
export async function storeIntertieLmp(db: Db, parsed: ParsedIntertieLmp, url: string, sha: string): Promise<{ rows: number }> {
  const ints = Math.max(0, ...parsed.rows.map((r) => r.intervals));
  await db.transaction(async (tx) => {
    for (const r of parsed.rows) {
      await tx.query(
        `INSERT INTO intertie_lmp_hourly (location, ts_utc, intervals, lmp, loss, congestion, external_congestion, nisl) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (location, ts_utc) DO UPDATE SET intervals = EXCLUDED.intervals, lmp = EXCLUDED.lmp, loss = EXCLUDED.loss,
           congestion = EXCLUDED.congestion, external_congestion = EXCLUDED.external_congestion, nisl = EXCLUDED.nisl
         WHERE EXCLUDED.intervals >= intertie_lmp_hourly.intervals`,
        [r.location, r.tsUtc, r.intervals, r.lmp, r.loss, r.congestion, r.externalCongestion, r.nisl],
      );
    }
    await markFile(tx, INTERTIE, hourPeriod(parsed.deliveryDate, parsed.hour), url, sha, ints >= 12, parsed.rows.length);
  });
  return { rows: parsed.rows.length };
}

export async function storeConstraints(db: Db, parsed: ParsedConstraints, url: string, sha: string): Promise<{ binding: number }> {
  const binding = parsed.rows.filter((r) => r.bindingIntervals > 0);
  const hours = new Set(parsed.rows.map((r) => r.hour));
  await db.transaction(async (tx) => {
    for (const r of binding) {
      await tx.query(
        `INSERT INTO constraint_hourly (constraint_name, ts_utc, binding_intervals, avg_shadow_price, peak_shadow_price) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (constraint_name, ts_utc) DO UPDATE SET binding_intervals = EXCLUDED.binding_intervals,
           avg_shadow_price = EXCLUDED.avg_shadow_price, peak_shadow_price = EXCLUDED.peak_shadow_price`,
        [r.constraint, r.tsUtc, r.bindingIntervals, r.avgShadowPrice, r.peakShadowPrice],
      );
    }
    await markFile(tx, CONSTRAINTS, parsed.deliveryDate, url, sha, hours.has(24), parsed.rows.length);
  });
  return { binding: binding.length };
}

export async function ingestLmpHour(db: Db, date: string, hour: number): Promise<{ rows: number }> {
  const url = `${config.congestion.lmpBaseUrl}PUB_RealtimeEnergyLMP_${compactDate(date)}${String(hour).padStart(2, "0")}.csv`;
  const res = await fetchReport(url);
  if (res.kind !== "ok") return { rows: 0 };
  return storeLmp(db, parseRealtimeLmpCsv(res.body, date), url, sha256(res.body));
}

export async function ingestIntertieHour(db: Db, date: string, hour: number): Promise<{ rows: number }> {
  const url = `${config.congestion.intertieLmpBaseUrl}PUB_RealTimeIntertieLMP_${compactDate(date)}${String(hour).padStart(2, "0")}.xml`;
  const res = await fetchReport(url, { timeoutMs: INTERTIE_TIMEOUT_MS });
  if (res.kind !== "ok") return { rows: 0 };
  return storeIntertieLmp(db, parseRealtimeIntertieLmp(res.body), url, sha256(res.body));
}

/** Intertie files are small; a short timeout keeps a slow IESO server from using up a serverless call. */
const INTERTIE_TIMEOUT_MS = 30_000;

let lastIntertieSha: string | null = null;

export async function ingestIntertieLatest(db: Db): Promise<{ rows: number; skipped?: boolean }> {
  const url = `${config.congestion.intertieLmpBaseUrl}PUB_RealTimeIntertieLMP.xml`;
  const res = await fetchReport(url, { timeoutMs: INTERTIE_TIMEOUT_MS });
  if (res.kind !== "ok") return { rows: 0, skipped: true };
  const sha = sha256(res.body);
  if (sha === lastIntertieSha) return { rows: 0, skipped: true };
  const r = await storeIntertieLmp(db, parseRealtimeIntertieLmp(res.body), url, sha);
  lastIntertieSha = sha;
  return r;
}

let lastRollingSha: string | null = null;

/** The rolling file holds the delivery hour in progress. */
export async function ingestLmpLatest(db: Db): Promise<{ rows: number; skipped?: boolean }> {
  const url = `${config.congestion.lmpBaseUrl}PUB_RealtimeEnergyLMP.csv`;
  const res = await fetchReport(url);
  if (res.kind !== "ok") return { rows: 0, skipped: true };
  const sha = sha256(res.body);
  if (sha === lastRollingSha) return { rows: 0, skipped: true };
  const r = await storeLmp(db, parseRealtimeLmpCsv(res.body), url, sha);
  lastRollingSha = sha;
  return r;
}

export async function ingestConstraintsDay(db: Db, date: string): Promise<{ binding: number }> {
  const url = `${config.congestion.constraintsBaseUrl}PUB_RealtimeConstrShadowPrices_${compactDate(date)}.xml`;
  const res = await fetchReport(url);
  if (res.kind !== "ok") return { binding: 0 };
  return storeConstraints(db, parseConstraintShadowPrices(res.body), url, sha256(res.body));
}

/** Completed market hours in the last `hours` hours without a complete file of `report`, newest first. */
export async function missingLmpHours(db: Db, hours: number, now = new Date(), report = LMP): Promise<{ date: string; hour: number }[]> {
  const have = await db.query<{ period: string }>("SELECT period FROM market_files WHERE report = $1 AND complete", [report]);
  const haveSet = new Set(have.map((h) => h.period));
  const current = utcToMarketHour(new Date(Math.ceil(now.getTime() / HOUR) * HOUR));
  const currentTs = new Date(hourEndingToUtc(current.reportDate, current.hour)).getTime();
  const out: { date: string; hour: number }[] = [];
  for (let i = 1; i <= hours; i++) {
    const mh = utcToMarketHour(new Date(currentTs - i * HOUR));
    if (!haveSet.has(hourPeriod(mh.reportDate, mh.hour))) out.push({ date: mh.reportDate, hour: mh.hour });
  }
  return out;
}

export async function missingConstraintDays(db: Db, days: number, now = new Date()): Promise<string[]> {
  const have = await db.query<{ period: string }>("SELECT period FROM market_files WHERE report = $1 AND complete", [CONSTRAINTS]);
  const haveSet = new Set(have.map((h) => h.period));
  const today = marketDateNow(now);
  const out: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, -i);
    if (!haveSet.has(d)) out.push(d);
  }
  return out;
}

const lastTried = new Map<string, number>();

/** Try a fetch unless the same file 404'd within the last hour. 404 is expected for unpublished files. */
async function throttled(key: string, fn: () => Promise<unknown>): Promise<"ok" | "skipped" | "missing"> {
  const t = lastTried.get(key);
  if (t && Date.now() - t < HOUR) return "skipped";
  try {
    await fn();
    lastTried.delete(key);
    return "ok";
  } catch (e) {
    if (e instanceof IesoFetchError && e.httpStatus === 404) {
      lastTried.set(key, Date.now());
      return "missing";
    }
    throw e;
  }
}

/**
 * Make sure prices for one past hour are stored, fetching that hour's archive file on demand.
 * Used when someone picks an hour older than the backfill window. The hour in progress comes
 * from the rolling file instead, so it is left alone here.
 */
export async function ensureLmpHour(db: Db, tsUtc: string, now = new Date()): Promise<"stored" | "fetched" | "skipped" | "missing"> {
  const t = new Date(tsUtc);
  if (Number.isNaN(t.getTime())) return "skipped";
  const mh = utcToMarketHour(new Date(Math.ceil(t.getTime() / HOUR) * HOUR));
  if (new Date(hourEndingToUtc(mh.reportDate, mh.hour)).getTime() > now.getTime()) return "skipped";
  const period = hourPeriod(mh.reportDate, mh.hour);
  const have = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM market_files WHERE report = $1 AND period = $2 AND complete", [LMP, period]);
  if ((have[0]?.n ?? 0) > 0) return "stored";
  const r = await throttled(`lmp:${mh.reportDate}:${mh.hour}`, () => ingestLmpHour(db, mh.reportDate, mh.hour));
  return r === "ok" ? "fetched" : r;
}

/**
 * Fetch the rolling intertie file when nothing recent is stored, so the map does not have to wait
 * for the next background refresh. Errors propagate so the caller can show them.
 */
export async function ensureRecentInterties(db: Db, maxAgeMs = 2 * HOUR, now = new Date()): Promise<"fresh" | "fetched"> {
  const r = await db.query<{ ts: string | null }>("SELECT max(ts_utc) AS ts FROM intertie_lmp_hourly");
  const ts = r[0]?.ts ? new Date(r[0].ts).getTime() : 0;
  if (now.getTime() - ts < maxAgeMs) return "fresh";
  await ingestIntertieLatest(db);
  return "fetched";
}

/** Same as ensureLmpHour, for the intertie price report. */
export async function ensureIntertieHour(db: Db, tsUtc: string, now = new Date()): Promise<"stored" | "fetched" | "skipped" | "missing"> {
  const t = new Date(tsUtc);
  if (Number.isNaN(t.getTime())) return "skipped";
  const mh = utcToMarketHour(new Date(Math.ceil(t.getTime() / HOUR) * HOUR));
  if (new Date(hourEndingToUtc(mh.reportDate, mh.hour)).getTime() > now.getTime()) return "skipped";
  const period = hourPeriod(mh.reportDate, mh.hour);
  const have = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM market_files WHERE report = $1 AND period = $2 AND complete", [INTERTIE, period]);
  if ((have[0]?.n ?? 0) > 0) return "stored";
  const r = await throttled(`intertie:${mh.reportDate}:${mh.hour}`, () => ingestIntertieHour(db, mh.reportDate, mh.hour));
  return r === "ok" ? "fetched" : r;
}

async function pool<T>(items: T[], concurrency: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * Bring congestion data up to date. On first run this backfills the configured window; after
 * that each call fetches only the few newly completed hours, the rolling hour and any newly
 * published constraint days.
 */
export async function syncCongestion(db: Db, onProgress?: (msg: string) => void): Promise<{ lmpHours: number; constraintDays: number; errors: string[] }> {
  const errors: string[] = [];
  let lmpHours = 0;
  let constraintDays = 0;

  // The hour in progress first: on Vercel a call can run out of time partway through a backfill.
  for (const [what, fn] of [["LMP latest", () => ingestLmpLatest(db)], ["Intertie latest", () => ingestIntertieLatest(db)]] as const) {
    try {
      await fn();
    } catch (e) {
      errors.push(`${what}: ${(e as Error).message}`);
    }
  }

  const tieHours = await missingLmpHours(db, config.congestion.intertieBackfillDays * 24, new Date(), INTERTIE);
  await pool(tieHours, 3, async ({ date, hour }) => {
    try {
      await throttled(`intertie:${date}:${hour}`, () => ingestIntertieHour(db, date, hour));
    } catch (e) {
      errors.push(`Intertie ${hourPeriod(date, hour)}: ${(e as Error).message}`);
    }
  });

  const hours = await missingLmpHours(db, config.congestion.lmpBackfillDays * 24);
  await pool(hours, 3, async ({ date, hour }) => {
    try {
      const r = await throttled(`lmp:${date}:${hour}`, () => ingestLmpHour(db, date, hour));
      if (r === "ok") {
        lmpHours++;
        if (lmpHours % 24 === 0) onProgress?.(`congestion: ${lmpHours} price hours loaded`);
      }
    } catch (e) {
      errors.push(`LMP ${hourPeriod(date, hour)}: ${(e as Error).message}`);
    }
  });
  const days = await missingConstraintDays(db, config.congestion.constraintBackfillDays);
  await pool(days, 2, async (date) => {
    try {
      if ((await throttled(`constraints:${date}`, () => ingestConstraintsDay(db, date))) === "ok") constraintDays++;
    } catch (e) {
      errors.push(`Constraints ${date}: ${(e as Error).message}`);
    }
  });

  if (lmpHours || constraintDays || errors.length) {
    await log(db, "congestion", errors.length === 0, `${lmpHours} price hours, ${constraintDays} constraint days${errors.length ? `; ${errors.length} errors, first: ${errors[0]}` : ""}`);
  }
  return { lmpHours, constraintDays, errors };
}
