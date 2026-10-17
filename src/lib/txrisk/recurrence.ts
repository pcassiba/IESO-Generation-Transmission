import { EST_OFFSET_HOURS } from "../time";

/**
 * Outage recurrence codes from the IESO TxOutagesTodayAll help file
 * (https://reports-public.ieso.ca/docrefs/helpfile/TxOutagesTodayAll_h1.pdf).
 *
 * IESO publishes only the code, not the daily switching times. The rules below are the
 * narrowest reading of each code; anything they cannot settle is returned as "unknown"
 * with a note rather than assumed continuous.
 *
 *   C   Continuous                  out for the whole planned window
 *   NC  Non-continuous              out at times inside the window that are not published → unknown
 *   RE  Return Evenings             out each day between the start and end times of day
 *   REW Return Evenings & Weekends  as RE, Monday–Friday only
 *   RSS Return Saturday–Sunday      out except on Sat and Sun
 *   RSM Return Saturday–Monday      out except Sat, Sun, Mon
 *   RFS Return Friday–Sunday        out except Fri, Sat, Sun
 *   RFM Return Friday–Monday        out except Fri–Mon
 *
 * Days and times of day are EST (the IESO market clock), not Toronto local time.
 */

export const RECURRENCE_LABEL: Record<string, string> = {
  C: "Continuous",
  NC: "Non-continuous",
  RE: "Return evenings",
  REW: "Return evenings and weekends",
  RSS: "Return Saturday–Sunday",
  RSM: "Return Saturday–Monday",
  RFS: "Return Friday–Sunday",
  RFM: "Return Friday–Monday",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Days returned to service (0 = Sunday … 6 = Saturday, EST). */
const RETURN_DAYS: Record<string, number[]> = { RSS: [6, 0], RSM: [6, 0, 1], RFS: [5, 6, 0], RFM: [5, 6, 0, 1] };

export interface Occurrence {
  /** true/false when the schedule settles it; "unknown" when IESO does not publish enough. */
  active: boolean | "unknown";
  note: string | null;
}

export interface OutageWindowInput {
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  recurrence: string | null;
}

const estMs = (t: number) => t - EST_OFFSET_HOURS * HOUR;
const estDow = (t: number) => new Date(estMs(t)).getUTCDay();
const estMinuteOfDay = (t: number) => {
  const d = new Date(estMs(t));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** Is the outage in effect at instant t (UTC ms or ISO)? */
export function occurrenceAt(o: OutageWindowInput, t: number | string): Occurrence {
  const ts = typeof t === "string" ? Date.parse(t) : t;
  if (!o.plannedStartUtc || !o.plannedEndUtc) return { active: "unknown", note: "Planned start or end not published" };
  const start = Date.parse(o.plannedStartUtc);
  const end = Date.parse(o.plannedEndUtc);
  if (ts < start || ts >= end) return { active: false, note: null };
  const code = (o.recurrence ?? "").toUpperCase();
  if (code === "C") return { active: true, note: null };
  if (code === "NC") return { active: "unknown", note: "Non-continuous outage: IESO does not publish which periods inside the window it is out" };
  if (code === "RE" || code === "REW") {
    const from = estMinuteOfDay(start);
    const to = estMinuteOfDay(end);
    if (to <= from) return { active: "unknown", note: "Daily return times cannot be derived from the planned start/end times of day" };
    if (code === "REW" && [0, 6].includes(estDow(ts))) return { active: false, note: "Returned to service at weekends" };
    const m = estMinuteOfDay(ts);
    return m >= from && m < to
      ? { active: true, note: `Out daily ${fmtMin(from)}–${fmtMin(to)} EST (derived from planned start/end times)` }
      : { active: false, note: `Returned to service outside ${fmtMin(from)}–${fmtMin(to)} EST` };
  }
  const ret = RETURN_DAYS[code];
  if (ret) {
    if (ret.includes(estDow(ts))) return { active: false, note: `${RECURRENCE_LABEL[code]}: returned to service on this day (exact return times not published)` };
    return { active: true, note: `${RECURRENCE_LABEL[code]}: exact return and removal times not published; return days excluded whole` };
  }
  return { active: "unknown", note: code ? `Unrecognised recurrence code "${code}"` : "Recurrence not published" };
}

const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * In-effect periods between from and to, sampled at `stepMs` and merged. Used for the timeline
 * (start/end markers); "unknown" periods are returned separately.
 */
export function windowsBetween(o: OutageWindowInput, from: number, to: number, stepMs = 15 * 60_000): { active: [number, number][]; unknown: [number, number][] } {
  const active: [number, number][] = [];
  const unknown: [number, number][] = [];
  if (!o.plannedStartUtc || !o.plannedEndUtc) return { active, unknown: [[from, to]] };
  const s = Math.max(from, Date.parse(o.plannedStartUtc));
  const e = Math.min(to, Date.parse(o.plannedEndUtc));
  if (e <= s) return { active, unknown };
  if ((o.recurrence ?? "").toUpperCase() === "C") return { active: [[s, e]], unknown };
  if (e - s > 40 * DAY) stepMs = Math.max(stepMs, HOUR);
  let cur: { kind: "a" | "u"; from: number } | null = null;
  const push = (k: "a" | "u", a: number, b: number) => (k === "a" ? active : unknown).push([a, b]);
  for (let t = s; t < e; t += stepMs) {
    const occ = occurrenceAt(o, t).active;
    const k = occ === true ? "a" : occ === "unknown" ? "u" : null;
    if (cur && cur.kind !== k) {
      push(cur.kind, cur.from, t);
      cur = null;
    }
    if (k && !cur) cur = { kind: k, from: t };
  }
  if (cur) push(cur.kind, cur.from, e);
  return { active, unknown };
}
