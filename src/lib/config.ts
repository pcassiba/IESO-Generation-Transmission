/** Central, configurable thresholds and settings. Override via environment variables. */

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  iesoBaseUrl: process.env.IESO_BASE_URL ?? "https://reports-public.ieso.ca/public/GenOutputCapability/",
  latestFile: "PUB_GenOutputCapability.xml",
  /** Poll interval for the latest report (minutes). Only re-downloads when changed. */
  pollMinutes: num("IESO_POLL_MINUTES", 10),
  /** Days of history to backfill from IESO daily archive files on first start. */
  backfillDays: num("IESO_BACKFILL_DAYS", 30),
  fetchTimeoutMs: num("IESO_FETCH_TIMEOUT_MS", 180_000),

  status: {
    /** Output (MW) at or above which a resource is considered "generating". */
    generatingThresholdMW: num("STATUS_GENERATING_MW", 1),
    /** Capability (MW) at or below which capability is treated as zero. */
    zeroCapabilityMW: num("STATUS_ZERO_CAPABILITY_MW", 0.5),
    /** Derate flagged when capability is below reference by at least this fraction… */
    derateFraction: num("STATUS_DERATE_FRACTION", 0.1),
    /** …and by at least this many MW (avoids flagging tiny absolute swings). */
    derateMinMW: num("STATUS_DERATE_MIN_MW", 5),
    /** Trailing window (days) used for the observed reference capability. */
    referenceWindowDays: num("STATUS_REFERENCE_DAYS", 30),
    /** Data older than this many hours (vs. now) is flagged stale. */
    staleAfterHours: num("STATUS_STALE_HOURS", 3),
  },
};

export type AppConfig = typeof config;
