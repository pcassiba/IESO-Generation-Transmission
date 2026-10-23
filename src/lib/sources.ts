import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { Db } from "./db";
import { CONSTRAINTS, hourPeriod, INTERTIE, LMP } from "./ieso/congestion-ingest";
import { compactDate, utcToMarketHour } from "./time";
import { txReportStatuses } from "./txrisk/store";

/**
 * "Where does this number come from?" — for the hour on screen, the exact IESO report and file
 * behind each dataset, when IESO created it and when the app downloaded it, plus a few example
 * values so they can be checked against the file by hand.
 */

export interface SourceExample {
  label: string;
  value: string;
}

export interface SourceEntry {
  id: string;
  dataset: string;
  /** Where the app shows it. */
  shownIn: string;
  report: string;
  /** IESO folder that lists every file of this report. */
  reportUrl: string;
  /** Delivery hour shown (UTC; display as IESO EST hour ending). Null for data that has no hour. */
  hourTsUtc: string | null;
  deliveryDate: string | null;
  hourEnding: number | null;
  /** The file the stored values were read from. */
  fileUrl: string | null;
  /** The dated IESO file for that hour/day, which stays published (the rolling file is overwritten). */
  archiveUrl: string | null;
  /** IESO's own creation stamp from the file header, EST. */
  publishedEst: string | null;
  fetchedAtUtc: string | null;
  /** False when the file held only part of the hour (fewer than 12 five-minute intervals). */
  complete: boolean | null;
  /** How the app turned the file into what's shown, and where to look in it. */
  howToCheck: string;
  examples: SourceExample[];
  note: string | null;
}

export interface SourcesResponse {
  requestedTsUtc: string | null;
  entries: SourceEntry[];
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const usd = (v: number | null) => (v === null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(Number(v)).toFixed(2)}/MWh`);
const mw = (v: number | null) => (v === null ? "—" : `${Math.round(Number(v) * 10) / 10} MW`);
const at = (ts: string | null) => (ts ? new Date(ts).toISOString() : null);

/** Hour at or before `requested` (latest when null) in a table with a ts_utc column. */
async function hourIn(db: Db, table: string, requested: string | null, where = "TRUE"): Promise<string | null> {
  const r = requested
    ? await db.query<{ ts: string | null }>(`SELECT max(ts_utc) AS ts FROM ${table} WHERE ${where} AND ts_utc <= $1`, [requested])
    : await db.query<{ ts: string | null }>(`SELECT max(ts_utc) AS ts FROM ${table} WHERE ${where}`);
  return iso(r[0]?.ts);
}

interface MarketFile {
  url: string;
  complete: boolean;
  row_count: number | null;
  fetched_at: string;
  created_at: string | null;
}

async function marketFile(db: Db, report: string, period: string): Promise<MarketFile | null> {
  const r = await db.query<MarketFile>("SELECT url, complete, row_count, fetched_at, created_at FROM market_files WHERE report = $1 AND period = $2", [report, period]);
  return r[0] ?? null;
}

async function generation(db: Db, requested: string | null): Promise<SourceEntry> {
  const hour = await hourIn(db, "observations", requested, "output_mw IS NOT NULL");
  const mh = hour ? utcToMarketHour(hour) : null;
  // The newest stored report version that supplied this hour's values.
  const rep = hour
    ? (
        await db.query<{ source_url: string; created_at_est: string | null; fetched_at: string; kind: string }>(
          `SELECT r.source_url, r.created_at_est, r.fetched_at, r.kind FROM observations o JOIN reports r ON r.id = o.report_id
           WHERE o.ts_utc = $1 GROUP BY r.id ORDER BY r.id DESC LIMIT 1`,
          [hour],
        )
      )[0]
    : undefined;
  const top = hour
    ? await db.query<{ ieso_name: string; output_mw: number | null; capability_mw: number | null; avail_capacity_mw: number | null }>(
        "SELECT ieso_name, output_mw, capability_mw, avail_capacity_mw FROM observations WHERE ts_utc = $1 AND output_mw IS NOT NULL ORDER BY output_mw DESC LIMIT 3",
        [hour],
      )
    : [];
  return {
    id: "generation",
    dataset: "Generator output and capability",
    shownIn: "Map icons, facility details, dashboard totals and trend",
    report: "Generator Output and Capability Report",
    reportUrl: config.iesoBaseUrl,
    hourTsUtc: hour,
    deliveryDate: mh?.reportDate ?? null,
    hourEnding: mh?.hour ?? null,
    fileUrl: rep?.source_url ?? null,
    archiveUrl: mh ? `${config.iesoBaseUrl}PUB_GenOutputCapability_${compactDate(mh.reportDate)}.xml` : null,
    publishedEst: rep?.created_at_est ?? null,
    fetchedAtUtc: at(rep?.fetched_at ?? null),
    complete: null,
    howToCheck: mh
      ? `Open the dated file, find the generator by name and read its Output (and Capability) for Hour ${mh.hour}. Values are used exactly as published, per IESO resource.`
      : "No generator data stored yet.",
    examples: top.map((t) => ({ label: t.ieso_name, value: `Output ${mw(t.output_mw)} · Capability ${mw(t.capability_mw ?? t.avail_capacity_mw)}` })),
    note: rep?.kind === "latest" ? "Read from the latest (undated) report, which IESO overwrites; the dated file for the day holds the same hour." : null,
  };
}

async function nodalPrices(db: Db, requested: string | null): Promise<SourceEntry> {
  const hour = await hourIn(db, "lmp_hourly", requested);
  const mh = hour ? utcToMarketHour(hour) : null;
  const file = mh ? await marketFile(db, LMP, hourPeriod(mh.reportDate, mh.hour)) : null;
  const rows = hour
    ? await db.query<{ location: string; lmp: number | null; intervals: number }>(
        "SELECT location, lmp, intervals FROM lmp_hourly WHERE ts_utc = $1 AND lmp IS NOT NULL ORDER BY lmp DESC, location",
        [hour],
      )
    : [];
  const pick = rows.length ? [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]] : [];
  const examples = [...new Map(pick.map((r) => [r.location, r])).values()].map((r, i, a) => ({
    label: `${r.location}${a.length === 3 ? ` (${["highest", "median", "lowest"][i]})` : ""}`,
    value: `${usd(r.lmp)} average of ${r.intervals} intervals`,
  }));
  return {
    id: "lmp",
    dataset: "Nodal prices (LMP) and congestion",
    shownIn: "LMP toggle (facility prices), Congestion panel",
    report: "Real-time Energy LMP (RealtimeEnergyLMP)",
    reportUrl: config.congestion.lmpBaseUrl,
    hourTsUtc: hour,
    deliveryDate: mh?.reportDate ?? null,
    hourEnding: mh?.hour ?? null,
    fileUrl: file?.url ?? null,
    archiveUrl: mh ? `${config.congestion.lmpBaseUrl}PUB_RealtimeEnergyLMP_${compactDate(mh.reportDate)}${String(mh.hour).padStart(2, "0")}.csv` : null,
    publishedEst: file?.created_at ?? null,
    fetchedAtUtc: at(file?.fetched_at ?? null),
    complete: file ? file.complete : null,
    howToCheck: mh
      ? `The file has 12 five-minute rows per pricing location for Delivery Hour ${mh.hour}. The app shows the plain average of those 12 LMP values (same for the loss and congestion parts). A facility's price is the average of its units' pricing locations.`
      : "No nodal prices stored yet.",
    examples,
    note: file && file.url.endsWith("PUB_RealtimeEnergyLMP.csv") ? "Read from the rolling file for the hour in progress, which IESO overwrites; check against the dated file instead." : null,
  };
}

async function intertiePrices(db: Db, requested: string | null): Promise<SourceEntry> {
  // The map pairs interties with the nodal price hour, falling back to the nearest earlier hour.
  const lmpHour = await hourIn(db, "lmp_hourly", requested);
  const hour = await hourIn(db, "intertie_lmp_hourly", lmpHour ?? requested);
  const mh = hour ? utcToMarketHour(hour) : null;
  const file = mh ? await marketFile(db, INTERTIE, hourPeriod(mh.reportDate, mh.hour)) : null;
  const rows = hour
    ? await db.query<{ location: string; lmp: number | null; intervals: number }>(
        "SELECT location, lmp, intervals FROM intertie_lmp_hourly WHERE ts_utc = $1 ORDER BY location LIMIT 3",
        [hour],
      )
    : [];
  return {
    id: "interties",
    dataset: "Intertie prices",
    shownIn: "Interties toggle (yellow circles)",
    report: "Real-time Intertie LMP (RealTimeIntertieLMP)",
    reportUrl: config.congestion.intertieLmpBaseUrl,
    hourTsUtc: hour,
    deliveryDate: mh?.reportDate ?? null,
    hourEnding: mh?.hour ?? null,
    fileUrl: file?.url ?? null,
    archiveUrl: mh ? `${config.congestion.intertieLmpBaseUrl}PUB_RealTimeIntertieLMP_${compactDate(mh.reportDate)}${String(mh.hour).padStart(2, "0")}.xml` : null,
    publishedEst: file?.created_at ?? null,
    fetchedAtUtc: at(file?.fetched_at ?? null),
    complete: file ? file.complete : null,
    howToCheck: mh
      ? `Each IntertieLMPrice block (IntertiePLName ending in :LMP) lists 12 interval values per component. The app shows the plain average of the 12 "Intertie LMP" values.`
      : "No intertie prices stored yet.",
    examples: rows.map((r) => ({ label: r.location, value: `${usd(r.lmp)} average of ${r.intervals} intervals` })),
    note: file && file.url.endsWith("PUB_RealTimeIntertieLMP.xml") ? "Read from the rolling file for the hour in progress, which IESO overwrites; check against the dated file instead." : null,
  };
}

async function constraints(db: Db): Promise<SourceEntry> {
  const last = (await db.query<{ period: string }>("SELECT period FROM market_files WHERE report = $1 ORDER BY period DESC LIMIT 1", [CONSTRAINTS]))[0]?.period ?? null;
  const file = last ? await marketFile(db, CONSTRAINTS, last) : null;
  const days = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM market_files WHERE report = $1", [CONSTRAINTS]))[0]?.n ?? 0;
  return {
    id: "constraints",
    dataset: "Binding transmission constraints",
    shownIn: "Congestion panel (constraints list), Outages & congestion risk",
    report: "Real-time Constraint Shadow Prices (RealtimeConstrShadowPrices)",
    reportUrl: config.congestion.constraintsBaseUrl,
    hourTsUtc: null,
    deliveryDate: last,
    hourEnding: null,
    fileUrl: file?.url ?? null,
    archiveUrl: last ? `${config.congestion.constraintsBaseUrl}PUB_RealtimeConstrShadowPrices_${compactDate(last)}.xml` : null,
    publishedEst: file?.created_at ?? null,
    fetchedAtUtc: at(file?.fetched_at ?? null),
    complete: file ? file.complete : null,
    howToCheck: "One file per delivery day. A constraint counts as binding in an hour when any of its 12 interval shadow prices is non-zero; the list covers the 7 days up to the shown hour or the newest day IESO has published, whichever is earlier.",
    examples: [],
    note: `IESO publishes these files several days late. ${days} day${days === 1 ? "" : "s"} stored; the date above is the newest.`,
  };
}

function transmissionMap(): SourceEntry {
  let builtAt: string | null = null;
  try {
    const head = fs.readFileSync(path.join(process.cwd(), "public", "geo", "transmission.geojson"), "utf8").slice(0, 400);
    builtAt = /"builtAt":"([^"]+)"/.exec(head)?.[1] ?? null;
  } catch {
    /* file missing */
  }
  return {
    id: "transmission-map",
    dataset: "Transmission lines and substations (map geometry)",
    shownIn: "Map lines coloured by voltage, substation dots",
    report: "OpenStreetMap power lines and substations (not an IESO report)",
    reportUrl: "https://www.openstreetmap.org/copyright",
    hourTsUtc: null,
    deliveryDate: null,
    hourEnding: null,
    fileUrl: null,
    archiveUrl: null,
    publishedEst: null,
    fetchedAtUtc: builtAt,
    complete: null,
    howToCheck: "Downloaded once from the OpenStreetMap Overpass API by `npm run build:transmission` and saved in public/geo. It does not change by hour.",
    examples: [],
    note: null,
  };
}

function transmissionReports(): SourceEntry[] {
  return txReportStatuses().map((s) => ({
    id: `tx-${s.kind}`,
    dataset: s.label,
    shownIn: "Outages & congestion risk",
    report: s.url.split("/").slice(-2, -1)[0] ?? s.label,
    reportUrl: s.url.slice(0, s.url.lastIndexOf("/") + 1),
    hourTsUtc: null,
    deliveryDate: null,
    hourEnding: null,
    fileUrl: s.url,
    archiveUrl: null,
    publishedEst: s.publishedRaw,
    fetchedAtUtc: s.lastSuccessUtc,
    complete: null,
    howToCheck: `Latest version of the report as IESO published it (${s.records} records). It is not tied to the hour on the map.`,
    examples: [],
    note: s.staleReason,
  }));
}

export async function getSources(db: Db, requestedTs?: string | null): Promise<SourcesResponse> {
  const t = requestedTs ? new Date(requestedTs) : null;
  const requested = t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
  const entries = [await generation(db, requested), await nodalPrices(db, requested), await intertiePrices(db, requested), await constraints(db), transmissionMap(), ...transmissionReports()];
  return { requestedTsUtc: requested, entries };
}
