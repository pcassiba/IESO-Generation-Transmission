import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { Db } from "./db";
import { readFacilitiesFromDb } from "./facilities";
import { describeConstraint } from "./ieso/market";
import { hourEndingToUtc } from "./time";
import type { FacilityMeta } from "./types";

/**
 * Turns stored nodal prices and constraint shadow prices into a congestion picture.
 *
 * Pricing locations ("BRUCEB-LT.G5", "ADELAIDE-LT.AG_T1", "CHATHAM-LT.VOLTUS_DRA") are linked to
 * facilities so they can be drawn on the map:
 *   1. a facility resource whose name *is* a pricing location ("HALTONHILLS-LT.G1"), else
 *   2. generator locations whose node (text before the first '-' or ':') equals the resource
 *      name with spaces and unit suffixes removed ("BRUCEB-G5" → "BRUCEB"), plus
 *   3. manual node links in data/transmission/pricing-locations.json.
 * Load and demand-response locations have no coordinates and are listed but not mapped.
 */

const HOUR = 3_600_000;

export const nodeOf = (location: string) => location.toUpperCase().split(/[-:]/)[0];

/** Generator / storage-injection locations, as opposed to loads (…_LF), demand response (…_DRA) and hubs. */
export function isGeneratorLocation(location: string): boolean {
  const m = /-LT\.(.+)$/i.exec(location);
  if (!m) return false;
  const suffix = m[1].toUpperCase();
  if (/_LF|LF_|_DRA|LOAD/.test(suffix)) return false;
  return /^(AG|G\d|G_|SG\d|APG\d|BATT_TG)/.test(suffix);
}

export function resourceBase(resource: string): string {
  return resource
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-LT[._].*$/, "")
    .replace(/-G\d.*$/, "")
    .replace(/-T\d+$/, "");
}

export function overridesPath(): string {
  return path.join(process.cwd(), "data", "transmission", "pricing-locations.json");
}

export function loadOverrides(file = overridesPath()): Record<string, string[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_") && Array.isArray(v)) out[k] = v.map((x) => String(x).toUpperCase());
    return out;
  } catch {
    return {};
  }
}

/** facility id → pricing locations. */
export function matchLocations(facilities: Pick<FacilityMeta, "id" | "resources">[], locations: string[], overrides: Record<string, string[]> = {}): Map<string, string[]> {
  const exact = new Set(locations.map((l) => l.toUpperCase()));
  const genByNode = new Map<string, string[]>();
  for (const l of locations) {
    if (!isGeneratorLocation(l)) continue;
    const n = nodeOf(l);
    genByNode.set(n, [...(genByNode.get(n) ?? []), l]);
  }
  const out = new Map<string, string[]>();
  for (const f of facilities) {
    const found = new Set<string>();
    for (const r of f.resources) {
      const name = r.ieso.toUpperCase();
      if (exact.has(name)) {
        found.add(locations.find((l) => l.toUpperCase() === name)!);
        continue;
      }
      for (const l of genByNode.get(resourceBase(name)) ?? []) found.add(l);
    }
    for (const node of overrides[f.id] ?? []) for (const l of genByNode.get(node) ?? []) found.add(l);
    if (found.size) out.set(f.id, [...found].sort());
  }
  return out;
}

export interface FacilityCongestion {
  facilityId: string;
  locations: string[];
  /** Mean congestion component across the facility's locations for the selected hour ($/MWh). */
  congestion: number | null;
  lmp: number | null;
  /** Mean congestion over the 24 hours ending at the selected hour. */
  congestion24h: number | null;
  /** Hours (of the last 24) with |congestion| at or above the threshold. */
  congestedHours24h: number;
}

export interface LocationPrice {
  location: string;
  facilityId: string | null;
  generator: boolean;
  lmp: number | null;
  congestion: number | null;
}

export interface ConstraintSummary {
  name: string;
  interfaceCode: string | null;
  interfaceName: string | null;
  area: string | null;
  hoursBinding: number;
  avgShadowPrice: number | null;
  peakShadowPrice: number | null;
  lastBindingUtc: string;
}

export interface CongestionResponse {
  hourTsUtc: string | null;
  latestTsUtc: string | null;
  thresholdPerMWh: number;
  /** Median LMP across all locations for the hour, a reference for the map colours. */
  medianLmp: number | null;
  facilities: FacilityCongestion[];
  mostNegative: LocationPrice[];
  mostPositive: LocationPrice[];
  constraints: ConstraintSummary[];
  constraintWindow: { fromUtc: string; toUtc: string } | null;
  constraintDataThroughUtc: string | null;
  coverage: { locations: number; generatorLocations: number; matchedGeneratorLocations: number; unmatchedGeneratorNodes: string[] };
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
};

export async function getCongestion(db: Db, requestedTs?: string | null, constraintDays = 7): Promise<CongestionResponse> {
  const threshold = config.congestion.thresholdPerMWh;
  const latest = iso((await db.query<{ mx: string | null }>("SELECT max(ts_utc) AS mx FROM lmp_hourly"))[0]?.mx);
  let hour = latest;
  if (requestedTs) {
    const r = await db.query<{ ts: string | null }>("SELECT max(ts_utc) AS ts FROM lmp_hourly WHERE ts_utc <= $1", [new Date(requestedTs).toISOString()]);
    hour = iso(r[0]?.ts);
  }

  const facilities = await readFacilitiesFromDb(db);
  const rows = hour
    ? await db.query<{ location: string; lmp: number | null; congestion: number | null }>("SELECT location, lmp, congestion FROM lmp_hourly WHERE ts_utc = $1", [hour])
    : [];
  const locations = rows.map((r) => r.location);
  const matches = matchLocations(facilities, locations, loadOverrides());
  const facilityOf = new Map<string, string>();
  for (const [id, locs] of matches) for (const l of locs) facilityOf.set(l, id);

  const byLoc = new Map(rows.map((r) => [r.location, r]));
  const dayRows = hour
    ? await db.query<{ location: string; c: number | null; n: number }>(
        `SELECT location, avg(congestion) AS c, count(*) FILTER (WHERE abs(congestion) >= $2)::int AS n FROM lmp_hourly
         WHERE ts_utc > $1::timestamptz - interval '24 hours' AND ts_utc <= $1::timestamptz GROUP BY location`,
        [hour, threshold],
      )
    : [];
  const day = new Map(dayRows.map((r) => [r.location, r]));

  const facOut: FacilityCongestion[] = [];
  for (const [facilityId, locs] of matches) {
    facOut.push({
      facilityId,
      locations: locs,
      congestion: mean(locs.map((l) => byLoc.get(l)?.congestion ?? null)),
      lmp: mean(locs.map((l) => byLoc.get(l)?.lmp ?? null)),
      congestion24h: mean(locs.map((l) => (day.get(l)?.c === undefined ? null : Number(day.get(l)!.c)))),
      congestedHours24h: Math.max(0, ...locs.map((l) => day.get(l)?.n ?? 0)),
    });
  }

  const priced: LocationPrice[] = rows
    .filter((r) => r.congestion !== null)
    .map((r) => ({ location: r.location, facilityId: facilityOf.get(r.location) ?? null, generator: isGeneratorLocation(r.location), lmp: r.lmp, congestion: r.congestion }));
  const sorted = [...priced].sort((a, b) => a.congestion! - b.congestion!);
  const lmps = rows.map((r) => r.lmp).filter((x): x is number => x !== null).sort((a, b) => a - b);

  // Constraint reports lag real time by several days, so the window ends at the newer of
  // the selected hour and the last day with data, whichever is earlier.
  const lastDay = (await db.query<{ mx: string | null }>("SELECT max(period) AS mx FROM market_files WHERE report = 'constraints'"))[0]?.mx ?? null;
  // End of that market day: HE 24 EST.
  const through = lastDay ? hourEndingToUtc(lastDay, 24) : null;
  let constraints: ConstraintSummary[] = [];
  let constraintWindow: CongestionResponse["constraintWindow"] = null;
  const endMs = Math.min(hour ? new Date(hour).getTime() : Date.now(), through ? new Date(through).getTime() : Date.now());
  if (through) {
    const from = new Date(endMs - constraintDays * 24 * HOUR).toISOString();
    const to = new Date(endMs).toISOString();
    constraintWindow = { fromUtc: from, toUtc: to };
    const c = await db.query<{ constraint_name: string; hours: number; avgp: number | null; peak: number | null; last: string }>(
      `SELECT constraint_name, count(*)::int AS hours, avg(avg_shadow_price) AS avgp,
         (array_agg(peak_shadow_price ORDER BY abs(peak_shadow_price) DESC NULLS LAST))[1] AS peak, max(ts_utc) AS last
       FROM constraint_hourly WHERE ts_utc > $1 AND ts_utc <= $2 GROUP BY constraint_name ORDER BY hours DESC, abs(avg(avg_shadow_price)) DESC LIMIT 25`,
      [from, to],
    );
    constraints = c.map((r) => ({
      name: r.constraint_name,
      ...describeConstraint(r.constraint_name),
      hoursBinding: r.hours,
      avgShadowPrice: r.avgp === null ? null : Math.round(Number(r.avgp) * 100) / 100,
      peakShadowPrice: r.peak === null ? null : Number(r.peak),
      lastBindingUtc: iso(r.last)!,
    }));
  }

  const gen = locations.filter(isGeneratorLocation);
  const unmatchedNodes = [...new Set(gen.filter((l) => !facilityOf.has(l)).map(nodeOf))].sort();
  return {
    hourTsUtc: hour,
    latestTsUtc: latest,
    thresholdPerMWh: threshold,
    medianLmp: lmps.length ? lmps[Math.floor(lmps.length / 2)] : null,
    facilities: facOut,
    mostNegative: sorted.filter((p) => p.congestion! <= -threshold).slice(0, 15),
    mostPositive: sorted.reverse().filter((p) => p.congestion! >= threshold).slice(0, 10),
    constraints,
    constraintWindow,
    constraintDataThroughUtc: through,
    coverage: { locations: locations.length, generatorLocations: gen.length, matchedGeneratorLocations: gen.filter((l) => facilityOf.has(l)).length, unmatchedGeneratorNodes: unmatchedNodes },
  };
}
