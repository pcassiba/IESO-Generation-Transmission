import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db";
import { readFacilitiesFromDb } from "../facilities";
import { fetchReport } from "../ieso/ingest";
import { describeConstraint } from "../ieso/market";
import { hourEndingToUtc } from "../time";
import { classify, REPORT_URL, type BindingHour, type GenSite } from "./classify";
import { projectFileVersion } from "../project-files";
import { loadInterfaces } from "./interfaces";
import { loadNetworkIndex, type NetworkIndex } from "./network";
import { parseTxLimits, parseTxOutages } from "./parse";
import type { ParsedLimits, ParsedOutages, ReportStatus, TxReportKind, TxRiskResponse } from "./types";
import { isServerless } from "../platform";

/**
 * Server-side retrieval and caching of the four transmission reports.
 *
 *  - Fetches the latest undated file of each report through the app's backend (no browser CORS).
 *  - Conditional requests (ETag / Last-Modified); each report is re-checked on its own cadence,
 *    matched to how often IESO publishes it.
 *  - The raw XML of the last successfully *parsed* download is stored in the database (tx_reports)
 *    with its ETag and the time it was last checked. Every server instance (each serverless copy on
 *    Vercel or Cloudflare, or a restarted Node server) re-uses it, and the check cadence is shared, so
 *    IESO is asked at most once per cadence and only downloads a changed file. When no database is
 *    passed (tests, CLI) the copy is kept under data/cache/txrisk/ instead.
 *    A failed download or parse never replaces the stored copy, and is reported.
 *  - A report is stale when its own CreatedAt is older than the threshold below.
 */

interface ReportDef {
  kind: TxReportKind;
  label: string;
  docId: string;
  /** Minutes between checks. */
  refreshMinutes: number;
  /** Hours after publication before the report counts as stale. */
  staleAfterHours: number;
}

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const REPORTS: ReportDef[] = [
  // Published hourly (IESO help file).
  { kind: "outages", label: "Transmission outages today", docId: "TxOutagesTodayAll", refreshMinutes: num("TXRISK_OUTAGES_MIN", 30), staleAfterHours: num("TXRISK_OUTAGES_STALE_H", 3) },
  { kind: "limits0to2", label: "Outage limits, days 0–2", docId: "TxLimitsOutage0to2Days", refreshMinutes: num("TXRISK_LIMITS02_MIN", 60), staleAfterHours: num("TXRISK_LIMITS02_STALE_H", 36) },
  // Observed publication roughly weekly (CreatedAt 2026-10-09 still current on 2026-10-17).
  { kind: "limits3to34", label: "Outage limits, days 3–34", docId: "TxLimitsOutage3to34Days", refreshMinutes: num("TXRISK_LIMITS334_MIN", 360), staleAfterHours: num("TXRISK_LIMITS334_STALE_H", 9 * 24) },
  // Published daily just after midnight (dated archive files show 00:08–00:09).
  { kind: "allInService", label: "All-in-service limits", docId: "TxLimitsAllInService0to34Days", refreshMinutes: num("TXRISK_AIS_MIN", 360), staleAfterHours: num("TXRISK_AIS_STALE_H", 48) },
];

interface Slot {
  parsed: ParsedOutages | ParsedLimits | null;
  etag: string | null;
  lastModified: string | null;
  lastAttemptUtc: string | null;
  lastSuccessUtc: string | null;
  lastError: string | null;
  /** fetched_at of the stored copy that `parsed` came from (to skip re-reading an unchanged body). */
  storedFetchedAt?: string | null;
}

interface TxRuntime {
  slots: Map<TxReportKind, Slot>;
  loadedFromDisk: boolean;
  running: Promise<void> | null;
  network?: { idx: NetworkIndex; sig: string };
}

type G = typeof globalThis & { __ogeTxRisk?: TxRuntime };
function rt(): TxRuntime {
  const g = globalThis as G;
  g.__ogeTxRisk ??= { slots: new Map(), loadedFromDisk: false, running: null };
  return g.__ogeTxRisk;
}

const cacheDir = () => {
  const d = path.join(process.env.IESO_CACHE_DIR ?? (isServerless() ? path.join(os.tmpdir(), "oge-cache") : path.join(process.cwd(), "data", "cache")), "txrisk");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export function parseReport(def: ReportDef, body: string): ParsedOutages | ParsedLimits {
  return def.kind === "outages" ? parseTxOutages(body) : parseTxLimits(body, def.docId);
}

function slot(kind: TxReportKind): Slot {
  const r = rt();
  if (!r.slots.has(kind)) r.slots.set(kind, { parsed: null, etag: null, lastModified: null, lastAttemptUtc: null, lastSuccessUtc: null, lastError: null });
  return r.slots.get(kind)!;
}

function loadFromDisk() {
  const r = rt();
  if (r.loadedFromDisk) return;
  r.loadedFromDisk = true;
  for (const def of REPORTS) {
    try {
      const dir = cacheDir();
      const body = fs.readFileSync(path.join(dir, `${def.kind}.xml`), "utf8");
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${def.kind}.meta.json`), "utf8"));
      const s = slot(def.kind);
      s.parsed = parseReport(def, body);
      s.etag = meta.etag ?? null;
      s.lastModified = meta.lastModified ?? null;
      s.lastSuccessUtc = meta.fetchedAtUtc ?? null;
    } catch {
      /* no cache yet */
    }
  }
}

const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

/**
 * Bring this instance's copies up to date with the database: check times and errors always, the
 * report body only when the stored copy is newer than the one already parsed here.
 */
export async function syncTxReports(db: Db): Promise<void> {
  const rows = await db.query<{ kind: string; fetched_at: string | Date; checked_at: string | Date; etag: string | null; last_modified: string | null; last_error: string | null }>(
    "SELECT kind, fetched_at, checked_at, etag, last_modified, last_error FROM tx_reports",
  );
  for (const row of rows) {
    const def = REPORTS.find((d) => d.kind === row.kind);
    if (!def) continue;
    const s = slot(def.kind);
    const fetchedAt = iso(row.fetched_at);
    const checkedAt = iso(row.checked_at);
    if (s.storedFetchedAt !== fetchedAt) {
      const body = (await db.query<{ body: string }>("SELECT body FROM tx_reports WHERE kind = $1", [def.kind]))[0]?.body;
      if (body === undefined) continue;
      try {
        s.parsed = parseReport(def, body);
        s.storedFetchedAt = fetchedAt;
        s.etag = row.etag;
        s.lastModified = row.last_modified;
      } catch {
        continue; /* stored copy no longer parses; the next check downloads a fresh one */
      }
    }
    // Another instance may have checked more recently than this one.
    if (checkedAt && (!s.lastAttemptUtc || checkedAt > s.lastAttemptUtc)) {
      s.lastAttemptUtc = checkedAt;
      s.lastError = row.last_error;
      if (!row.last_error) s.lastSuccessUtc = checkedAt;
    }
  }
}

async function saveCheck(db: Db | undefined, def: ReportDef, s: Slot): Promise<void> {
  if (!db || !s.storedFetchedAt) return;
  await db
    .query("UPDATE tx_reports SET checked_at = $2, last_error = $3 WHERE kind = $1", [def.kind, s.lastAttemptUtc, s.lastError])
    .catch((e) => console.warn(`[txrisk] could not save check time: ${(e as Error).message}`));
}

/** Fetch one report if due (or forced). Keeps the previous parsed copy on any failure. */
export async function refreshReport(def: ReportDef, force = false, fetcher = fetchReport, db?: Db): Promise<void> {
  const s = slot(def.kind);
  if (!force && s.lastAttemptUtc && Date.now() - Date.parse(s.lastAttemptUtc) < def.refreshMinutes * 60_000) return;
  s.lastAttemptUtc = new Date().toISOString();
  try {
    const res = await fetcher(REPORT_URL[def.kind], s.parsed ? { etag: s.etag, lastModified: s.lastModified, timeoutMs: 60_000 } : { timeoutMs: 60_000 });
    if (res.kind === "not-modified") {
      s.lastSuccessUtc = s.lastAttemptUtc;
      s.lastError = null;
      await saveCheck(db, def, s);
      return;
    }
    const parsed = parseReport(def, res.body);
    s.parsed = parsed;
    s.etag = res.etag;
    s.lastModified = res.lastModified;
    s.lastSuccessUtc = s.lastAttemptUtc;
    s.lastError = null;
    if (db) {
      await db
        .query(
          `INSERT INTO tx_reports (kind, url, body, etag, last_modified, fetched_at, checked_at, last_error) VALUES ($1,$2,$3,$4,$5,$6,$6,NULL)
           ON CONFLICT (kind) DO UPDATE SET url = EXCLUDED.url, body = EXCLUDED.body, etag = EXCLUDED.etag, last_modified = EXCLUDED.last_modified,
             fetched_at = EXCLUDED.fetched_at, checked_at = EXCLUDED.checked_at, last_error = NULL`,
          [def.kind, res.url, res.body, res.etag, res.lastModified, s.lastAttemptUtc],
        )
        .then(() => (s.storedFetchedAt = s.lastAttemptUtc))
        .catch((e) => console.warn(`[txrisk] could not store ${def.kind}: ${(e as Error).message}`));
      return;
    }
    try {
      const dir = cacheDir();
      fs.writeFileSync(path.join(dir, `${def.kind}.xml`), res.body);
      fs.writeFileSync(path.join(dir, `${def.kind}.meta.json`), JSON.stringify({ etag: res.etag, lastModified: res.lastModified, fetchedAtUtc: s.lastSuccessUtc, url: res.url }));
    } catch {
      /* cache is best effort */
    }
  } catch (e) {
    s.lastError = (e as Error).message;
    await saveCheck(db, def, s);
  }
}

/** True once every report has been tried at least once in this process. */
export function allAttempted(): boolean {
  return REPORTS.every((d) => slot(d.kind).lastAttemptUtc !== null);
}

export async function refreshAll(force = false, db?: Db): Promise<void> {
  const r = rt();
  if (r.running) return r.running;
  if (db) await syncTxReports(db).catch((e) => console.warn(`[txrisk] could not read stored reports: ${(e as Error).message}`));
  else loadFromDisk();
  if (r.running) return r.running;
  r.running = Promise.all(REPORTS.map((d) => refreshReport(d, force, fetchReport, db)))
    .then(() => undefined)
    .finally(() => {
      r.running = null;
    });
  return r.running;
}

export function reportStatus(def: ReportDef, s: Slot, now = Date.now()): ReportStatus {
  const created = s.parsed?.header.createdAtUtc ?? null;
  let stale = false;
  let staleReason: string | null = null;
  if (!s.parsed) {
    stale = true;
    staleReason = s.lastError ? `Unavailable: ${s.lastError}` : "Not downloaded yet";
  } else if (created && now - Date.parse(created) > def.staleAfterHours * 3_600_000) {
    stale = true;
    staleReason = `Published more than ${def.staleAfterHours} h ago`;
  } else if (s.lastError) {
    staleReason = `Latest download failed (${s.lastError}); showing the last good copy`;
  }
  return {
    kind: def.kind,
    label: def.label,
    url: REPORT_URL[def.kind],
    publishedUtc: created,
    publishedRaw: s.parsed?.header.createdAtRaw ?? null,
    lastAttemptUtc: s.lastAttemptUtc,
    lastSuccessUtc: s.lastSuccessUtc,
    lastError: s.lastError,
    stale,
    staleReason,
    records: s.parsed ? ("outages" in s.parsed ? s.parsed.outages.length : s.parsed.limits.length) : 0,
    warnings: s.parsed?.warnings.slice(0, 20) ?? [],
  };
}

function network(): NetworkIndex {
  const r = rt();
  const sig = ["public/geo/transmission.geojson", "public/geo/substations.geojson", "data/transmission/station-aliases.json"]
    .map((p) => projectFileVersion(path.join(process.cwd(), p)))
    .join("|");
  if (!r.network || r.network.sig !== sig) r.network = { idx: loadNetworkIndex(), sig };
  return r.network.idx;
}

async function bindingHours(db: Db): Promise<{ rows: BindingHour[]; through: string | null }> {
  const lastDay = (await db.query<{ mx: string | null }>("SELECT max(period) AS mx FROM market_files WHERE report = 'constraints'"))[0]?.mx ?? null;
  if (!lastDay) return { rows: [], through: null };
  const through = hourEndingToUtc(lastDay, 24);
  const rows = await db.query<{ constraint_name: string; ts_utc: string; avg_shadow_price: number | null }>(
    "SELECT constraint_name, ts_utc, avg_shadow_price FROM constraint_hourly WHERE ts_utc > $1::timestamptz - interval '14 days' ORDER BY ts_utc",
    [through],
  );
  return {
    through,
    rows: rows.map((r) => ({
      constraintName: r.constraint_name,
      tsUtc: new Date(r.ts_utc).toISOString(),
      avgShadowPrice: r.avg_shadow_price === null ? null : Number(r.avg_shadow_price),
      interfaceCode: describeConstraint(r.constraint_name).interfaceCode,
    })),
  };
}

export async function getTxRisk(db: Db, tIso: string | null): Promise<TxRiskResponse> {
  const now = Date.now();
  let t = tIso ? Date.parse(tIso) : now;
  if (!Number.isFinite(t)) t = now;
  const slots = new Map(REPORTS.map((d) => [d.kind, slot(d.kind)]));
  const net = network();
  const facilities = await readFacilitiesFromDb(db);
  const generation: GenSite[] = facilities.map((f) => ({ id: f.id, name: f.name, lat: f.lat, lon: f.lon, mw: f.installedCapacityMW ?? null, region: f.region ?? null }));
  const binding = await bindingHours(db).catch(() => ({ rows: [], through: null }));
  const items = classify({
    t,
    now,
    outages: slots.get("outages")!.parsed as ParsedOutages | null,
    limits0to2: slots.get("limits0to2")!.parsed as ParsedLimits | null,
    limits3to34: slots.get("limits3to34")!.parsed as ParsedLimits | null,
    allInService: slots.get("allInService")!.parsed as ParsedLimits | null,
    network: net,
    interfaces: loadInterfaces(),
    generation,
    binding: binding.rows,
    bindingDataThroughUtc: binding.through,
  });
  const notes: string[] = [];
  if (!net.loaded) notes.push("Transmission line data is not built, so nothing can be drawn. Run npm run build:transmission.");
  if (t > now + 3_600_000) notes.push("IESO's public outage report lists only outages occurring today. Outages that begin on later days are not published there, so the future view relies on the limits reports.");
  return {
    tUtc: new Date(t).toISOString(),
    nowUtc: new Date(now).toISOString(),
    mode: Math.abs(t - now) <= 3_600_000 ? "current" : t > now ? "future" : "past",
    reports: REPORTS.map((d) => reportStatus(d, slots.get(d.kind)!, now)),
    items,
    networkLoaded: net.loaded,
    bindingDataThroughUtc: binding.through,
    notes,
  };
}

/** Status of each transmission report as last downloaded, without fetching anything (call syncTxReports first). */
export function txReportStatuses(now = Date.now()): ReportStatus[] {
  return REPORTS.map((d) => reportStatus(d, slot(d.kind), now));
}
