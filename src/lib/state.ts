import { buildFacilityStates, computeCoverage, type ObsLite, type OutageLite, type ReferenceLite } from "./aggregate";
import { config } from "./config";
import type { Db } from "./db";
import { readFacilitiesFromDb, validateFacilities } from "./facilities";
import { runtime } from "./server";
import { effectiveCapability } from "./status";
import type { DataMeta, StateResponse, Technology } from "./types";
import { utcToMarketHour } from "./time";

const HOUR = 3_600_000;
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export async function getTimeBounds(db: Db): Promise<{ earliest: string | null; latest: string | null }> {
  const r = await db.query<{ mn: string | null; mx: string | null }>(
    "SELECT min(ts_utc) AS mn, max(ts_utc) AS mx FROM observations WHERE output_mw IS NOT NULL",
  );
  return { earliest: iso(r[0]?.mn), latest: iso(r[0]?.mx) };
}

export async function getState(db: Db, requestedTs?: string | null): Promise<StateResponse> {
  const rt = runtime();
  const facilities = await readFacilitiesFromDb(db);
  const { duplicateResources } = validateFacilities(facilities);
  const bounds = await getTimeBounds(db);

  let selected: string | null = bounds.latest;
  let mode: DataMeta["mode"] = "latest";
  if (requestedTs) {
    const r = await db.query<{ ts: string | null }>(
      "SELECT max(ts_utc) AS ts FROM observations WHERE ts_utc <= $1 AND output_mw IS NOT NULL",
      [new Date(requestedTs).toISOString()],
    );
    const ts = iso(r[0]?.ts);
    if (ts) selected = ts;
    if (selected !== bounds.latest) mode = "historical";
  }

  const lastOk = await db.query<{ fetched_at: string; created_at_est: string | null; report_date: string }>(
    "SELECT fetched_at, created_at_est, to_char(report_date,'YYYY-MM-DD') AS report_date FROM reports WHERE kind='latest' ORDER BY id DESC LIMIT 1",
  );
  const lastSuccess = await db.query<{ at: string }>("SELECT at FROM ingest_log WHERE ok AND kind='latest' ORDER BY id DESC LIMIT 1");
  const lastAttempt = await db.query<{ at: string; ok: boolean; message: string }>(
    "SELECT at, ok, message FROM ingest_log WHERE kind='latest' ORDER BY id DESC LIMIT 1",
  );

  const now = Date.now();
  const ageHours = bounds.latest ? (now - new Date(bounds.latest).getTime()) / HOUR : Infinity;
  const stale = mode === "latest" && ageHours > config.status.staleAfterHours;
  let staleReason: string | null = null;
  if (!bounds.latest) staleReason = "No IESO data has been ingested yet.";
  else if (stale) staleReason = `Latest reported hour is ${ageHours.toFixed(1)} h old (threshold ${config.status.staleAfterHours} h).`;
  if (lastAttempt[0] && !lastAttempt[0].ok) staleReason = `${staleReason ? staleReason + " " : ""}Last fetch failed: ${lastAttempt[0].message}`;

  const obsRows = selected
    ? await db.query<{
        ieso_name: string;
        ieso_fuel: string;
        output_mw: number | null;
        capability_mw: number | null;
        forecast_mw: number | null;
        avail_capacity_mw: number | null;
      }>("SELECT ieso_name, ieso_fuel, output_mw, capability_mw, forecast_mw, avail_capacity_mw FROM observations WHERE ts_utc = $1", [selected])
    : [];
  const obs = new Map<string, ObsLite>(
    obsRows.map((o) => [
      o.ieso_name,
      { iesoName: o.ieso_name, iesoFuel: o.ieso_fuel, outputMW: o.output_mw, capabilityMW: o.capability_mw, forecastMW: o.forecast_mw, availCapacityMW: o.avail_capacity_mw },
    ]),
  );

  const windowDays = config.status.referenceWindowDays;
  const refRows = selected
    ? await db.query<{ ieso_name: string; mc: number | null; ma: number | null }>(
        `SELECT ieso_name, max(capability_mw) AS mc, max(avail_capacity_mw) AS ma FROM observations
         WHERE ts_utc > $1::timestamptz - make_interval(days => $2) AND ts_utc <= $1::timestamptz GROUP BY ieso_name`,
        [selected, windowDays],
      )
    : [];
  const refs = new Map<string, ReferenceLite>(refRows.map((r) => [r.ieso_name, { maxCapabilityMW: r.mc, maxAvailCapacityMW: r.ma }]));

  const outageRows = selected
    ? await db.query<{ facility_id: string | null; ieso_name: string | null; description: string; source_url: string }>(
        "SELECT facility_id, ieso_name, description, source_url FROM outage_evidence WHERE start_utc <= $1 AND (end_utc IS NULL OR end_utc > $1)",
        [selected],
      )
    : [];
  const outages: OutageLite[] = outageRows.map((o) => ({ facilityId: o.facility_id, iesoName: o.ieso_name, description: o.description, sourceUrl: o.source_url }));

  const states = buildFacilityStates(facilities, obs, refs, outages, { stale, windowDays });
  const coverage = computeCoverage(facilities, [...obs.keys()], duplicateResources);
  const unmatched = coverage.unmatchedResources.map((n) => {
    const o = obs.get(n)!;
    return { iesoName: n, iesoFuel: o.iesoFuel, outputMW: o.outputMW, capabilityMW: o.capabilityMW ?? o.availCapacityMW };
  });

  const mh = selected ? utcToMarketHour(selected) : null;
  return {
    meta: {
      mode,
      selectedTsUtc: selected,
      latestTsUtc: bounds.latest,
      earliestTsUtc: bounds.earliest,
      reportDate: mh?.reportDate ?? null,
      hourEnding: mh?.hour ?? null,
      reportCreatedAt: lastOk[0]?.created_at_est ? `${lastOk[0].created_at_est} EST` : null,
      lastSuccessfulFetch: iso(lastSuccess[0]?.at),
      lastAttempt: iso(lastAttempt[0]?.at) ?? rt.lastPollAt,
      lastError: lastAttempt[0] && !lastAttempt[0].ok ? lastAttempt[0].message : null,
      stale: stale || !bounds.latest,
      staleReason,
      source: config.iesoBaseUrl + config.latestFile,
    },
    facilities: states,
    coverage,
    unmatched,
  };
}

export interface HistoryPoint {
  ts: string;
  outputMW: number | null;
  capabilityMW: number | null;
  forecastMW: number | null;
  availCapacityMW: number | null;
}

export interface FacilityHistory {
  facilityId: string;
  technology: Technology;
  points: HistoryPoint[];
  resources: Record<string, HistoryPoint[]>;
}

export const RANGE_HOURS: Record<string, number> = { "24h": 24, "7d": 168, "30d": 720 };

/** Hourly history for one or more facilities, ending at `endTs` (default: latest). */
export async function getHistory(db: Db, facilityIds: string[], range: string, endTs?: string | null): Promise<FacilityHistory[]> {
  const hours = RANGE_HOURS[range] ?? 24;
  const bounds = await getTimeBounds(db);
  const end = endTs ? new Date(endTs).toISOString() : bounds.latest;
  if (!end) return [];
  const facs = await db.query<{ id: string; technology: Technology }>("SELECT id, technology FROM facilities WHERE id = ANY($1::text[])", [facilityIds]);
  const rows = await db.query<{
    facility_id: string;
    ieso_name: string;
    ts_utc: string;
    output_mw: number | null;
    capability_mw: number | null;
    forecast_mw: number | null;
    avail_capacity_mw: number | null;
  }>(
    `SELECT m.facility_id, o.ieso_name, o.ts_utc, o.output_mw, o.capability_mw, o.forecast_mw, o.avail_capacity_mw
     FROM observations o JOIN resource_map m ON m.ieso_name = o.ieso_name
     WHERE m.facility_id = ANY($1::text[]) AND o.ts_utc > $2::timestamptz - make_interval(hours => $3) AND o.ts_utc <= $2::timestamptz
     ORDER BY o.ts_utc`,
    [facilityIds, end, hours],
  );
  return facs.map((f) => {
    const mine = rows.filter((r) => r.facility_id === f.id);
    const byTs = new Map<string, HistoryPoint>();
    const resources: Record<string, HistoryPoint[]> = {};
    const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
    for (const r of mine) {
      const ts = new Date(r.ts_utc).toISOString();
      const cap = effectiveCapability(f.technology, { capabilityMW: r.capability_mw, availCapacityMW: r.avail_capacity_mw });
      const p: HistoryPoint = { ts, outputMW: r.output_mw, capabilityMW: cap, forecastMW: r.forecast_mw, availCapacityMW: r.avail_capacity_mw };
      (resources[r.ieso_name] ??= []).push(p);
      const agg = byTs.get(ts) ?? { ts, outputMW: null, capabilityMW: null, forecastMW: null, availCapacityMW: null };
      agg.outputMW = add(agg.outputMW, p.outputMW);
      agg.capabilityMW = add(agg.capabilityMW, p.capabilityMW);
      agg.forecastMW = add(agg.forecastMW, p.forecastMW);
      agg.availCapacityMW = add(agg.availCapacityMW, p.availCapacityMW);
      byTs.set(ts, agg);
    }
    return { facilityId: f.id, technology: f.technology, points: [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts)), resources };
  });
}

/** Province-level hourly totals of mapped + unmapped reported resources by IESO fuel. */
export async function getFuelHistory(db: Db, range: string, endTs?: string | null) {
  const hours = RANGE_HOURS[range] ?? 24;
  const bounds = await getTimeBounds(db);
  const end = endTs ? new Date(endTs).toISOString() : bounds.latest;
  if (!end) return [];
  const rows = await db.query<{ ts_utc: string; ieso_fuel: string; mw: number | null }>(
    `SELECT ts_utc, ieso_fuel, sum(output_mw) AS mw FROM observations
     WHERE ts_utc > $1::timestamptz - make_interval(hours => $2) AND ts_utc <= $1::timestamptz AND output_mw IS NOT NULL
     GROUP BY ts_utc, ieso_fuel ORDER BY ts_utc`,
    [end, hours],
  );
  const byTs = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const ts = new Date(r.ts_utc).toISOString();
    const rec = byTs.get(ts) ?? { ts };
    rec[r.ieso_fuel] = Number(r.mw ?? 0);
    byTs.set(ts, rec);
  }
  return [...byTs.values()];
}

/** Raw observations for CSV export. */
export async function getObservationsForExport(db: Db, facilityIds: string[] | null, range: string, endTs?: string | null) {
  const hours = RANGE_HOURS[range] ?? 24;
  const bounds = await getTimeBounds(db);
  const end = endTs ? new Date(endTs).toISOString() : bounds.latest;
  if (!end) return [];
  const params: unknown[] = [end, hours];
  let filter = "";
  if (facilityIds && facilityIds.length) {
    params.push(facilityIds);
    filter = "AND m.facility_id = ANY($3::text[])";
  }
  return db.query<Record<string, unknown>>(
    `SELECT o.ts_utc, to_char(o.report_date,'YYYY-MM-DD') AS report_date, o.hour AS hour_ending_est, m.facility_id, f.name AS facility_name,
            o.ieso_name, o.ieso_fuel, o.output_mw, o.capability_mw, o.forecast_mw, o.avail_capacity_mw, r.source_url, r.created_at_est
     FROM observations o
     LEFT JOIN resource_map m ON m.ieso_name = o.ieso_name
     LEFT JOIN facilities f ON f.id = m.facility_id
     LEFT JOIN reports r ON r.id = o.report_id
     WHERE o.ts_utc > $1::timestamptz - make_interval(hours => $2) AND o.ts_utc <= $1::timestamptz ${filter}
     ORDER BY o.ts_utc, o.ieso_name`,
    params,
  );
}
