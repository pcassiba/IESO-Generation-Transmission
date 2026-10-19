import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db";
import { readFacilitiesFromDb } from "../facilities";
import { fetchReport } from "../ieso/ingest";
import { describeConstraint } from "../ieso/market";
import { hourEndingToUtc } from "../time";
import { classify, REPORT_URL, type BindingHour, type GenSite } from "./classify";
import { loadInterfaces } from "./interfaces";
import { loadNetworkIndex, type NetworkIndex } from "./network";
import { parseTxLimits, parseTxOutages } from "./parse";
import type { ParsedLimits, ParsedOutages, ReportStatus, TxReportKind, TxRiskResponse } from "./types";

/**
 * Server-side retrieval and caching of the four transmission reports.
 *
 *  - Fetches the latest undated file of each report through the app's backend (no browser CORS).
 *  - Conditional requests (ETag / Last-Modified); each report is re-checked on its own cadence,
 *    matched to how often IESO publishes it.
 *  - The raw XML of the last successfully *parsed* download is kept under data/cache/txrisk/ and
 *    re-used after a restart. A failed download or parse never replaces it, and is reported.
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
  const d = path.join(process.env.IESO_CACHE_DIR ?? (process.env.VERCEL ? path.join(os.tmpdir(), "oge-cache") : path.join(process.cwd(), "data", "cache")), "txrisk");
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

/** Fetch one report if due (or forced). Keeps the previous parsed copy on any failure. */
export async function refreshReport(def: ReportDef, force = false, fetcher = fetchReport): Promise<void> {
  const s = slot(def.kind);
  if (!force && s.lastAttemptUtc && Date.now() - Date.parse(s.lastAttemptUtc) < def.refreshMinutes * 60_000) return;
  s.lastAttemptUtc = new Date().toISOString();
  try {
    const res = await fetcher(REPORT_URL[def.kind], s.parsed ? { etag: s.etag, lastModified: s.lastModified, timeoutMs: 60_000 } : { timeoutMs: 60_000 });
    if (res.kind === "not-modified") {
      s.lastSuccessUtc = s.lastAttemptUtc;
      s.lastError = null;
      return;
    }
    const parsed = parseReport(def, res.body);
    s.parsed = parsed;
    s.etag = res.etag;
    s.lastModified = res.lastModified;
    s.lastSuccessUtc = s.lastAttemptUtc;
    s.lastError = null;
    try {
      const dir = cacheDir();
      fs.writeFileSync(path.join(dir, `${def.kind}.xml`), res.body);
      fs.writeFileSync(path.join(dir, `${def.kind}.meta.json`), JSON.stringify({ etag: res.etag, lastModified: res.lastModified, fetchedAtUtc: s.lastSuccessUtc, url: res.url }));
    } catch {
      /* cache is best effort */
    }
  } catch (e) {
    s.lastError = (e as Error).message;
  }
}

/** True once every report has been tried at least once in this process. */
export function allAttempted(): boolean {
  return REPORTS.every((d) => slot(d.kind).lastAttemptUtc !== null);
}

export async function refreshAll(force = false): Promise<void> {
  loadFromDisk();
  const r = rt();
  if (r.running) return r.running;
  r.running = Promise.all(REPORTS.map((d) => refreshReport(d, force)))
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
    .map((p) => {
      try {
        return fs.statSync(path.join(process.cwd(), p)).mtimeMs;
      } catch {
        return 0;
      }
    })
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
  loadFromDisk();
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
