/**
 * Time handling for IESO market data.
 *
 * The IESO-administered market runs on Eastern Standard Time (UTC−5) all year: every
 * market day has exactly 24 hours (no 23/25-hour days) and "Hour N" means the hour
 * ENDING at N:00 EST. Report header timestamps (<CreatedAt>) are also EST.
 * (Verified against the live report: CreatedAt 20:16:16 matched an HTTP Last-Modified
 * of 01:18:22 GMT.)
 *
 * For display we convert to Ontario local time (America/Toronto), which shifts to EDT
 * (UTC−4) in summer — so during daylight time "HE 20 EST" is shown as 21:00 EDT.
 */

export const EST_OFFSET_HOURS = 5;
const HOUR_MS = 3_600_000;

/** Convert an IESO market date (YYYY-MM-DD) + hour ending (1..24, EST) to a UTC ISO string. */
export function hourEndingToUtc(reportDate: string, hour: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reportDate);
  if (!m) throw new Error(`Invalid report date: ${reportDate}`);
  if (!Number.isInteger(hour) || hour < 1 || hour > 24) throw new Error(`Invalid hour ending: ${hour}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour + EST_OFFSET_HOURS);
  return new Date(ms).toISOString();
}

/** Inverse of hourEndingToUtc: UTC instant → IESO market date + hour ending (EST). */
export function utcToMarketHour(tsUtc: string | Date): { reportDate: string; hour: number } {
  const t = typeof tsUtc === "string" ? new Date(tsUtc).getTime() : tsUtc.getTime();
  const est = new Date(t - EST_OFFSET_HOURS * HOUR_MS);
  let hour = est.getUTCHours();
  let day = est;
  if (hour === 0) {
    hour = 24;
    day = new Date(est.getTime() - 24 * HOUR_MS);
  }
  const reportDate = day.toISOString().slice(0, 10);
  return { reportDate, hour };
}

/** Parse an IESO local (EST) timestamp like "2026-10-14T20:16:16" into a UTC ISO string. */
export function parseIesoEst(local: string | null | undefined): string | null {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + EST_OFFSET_HOURS, +m[5], m[6] ? +m[6] : 0);
  return new Date(ms).toISOString();
}

/** Format a UTC instant in Ontario local time, e.g. "Oct 14, 21:00 EDT". */
export function formatOntario(tsUtc: string | null | undefined, opts: { date?: boolean; seconds?: boolean } = {}): string {
  if (!tsUtc) return "—";
  const d = new Date(tsUtc);
  if (Number.isNaN(d.getTime())) return "—";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    month: opts.date === false ? undefined : "short",
    day: opts.date === false ? undefined : "numeric",
    year: undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: opts.seconds ? "2-digit" : undefined,
    hour12: false,
    timeZoneName: "short",
  });
  return fmt.format(d).replace(",", "");
}

/** Label for a reporting hour: "HE 20 EST (Oct 14, 21:00 EDT)". */
export function hourEndingLabel(tsUtc: string | null | undefined): string {
  if (!tsUtc) return "—";
  const { reportDate, hour } = utcToMarketHour(tsUtc);
  return `${reportDate} HE ${String(hour).padStart(2, "0")} EST`;
}

/** YYYYMMDD for archive filenames. */
export function compactDate(reportDate: string): string {
  return reportDate.replaceAll("-", "");
}

/** Current IESO market date (EST) for a given instant. */
export function marketDateNow(now: Date = new Date()): string {
  return new Date(now.getTime() - EST_OFFSET_HOURS * HOUR_MS).toISOString().slice(0, 10);
}

export function addDays(reportDate: string, days: number): string {
  const [y, m, d] = reportDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
