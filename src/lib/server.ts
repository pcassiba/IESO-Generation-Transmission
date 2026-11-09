import crypto from "node:crypto";
import path from "node:path";
import { config } from "./config";
import { getDb, type Db } from "./db";
import { facilitiesDir, loadFacilityFiles, seedFacilities, validateFacilities, type MetadataIssue } from "./facilities";
import { pollPricesIfDue, syncCongestion } from "./ieso/congestion-ingest";
import { backfill, ingestDaily, ingestLatest, missingDailyDates } from "./ieso/ingest";
import { listProjectJsonFiles, loadBundledProjectFiles, projectFileVersion } from "./project-files";
import { refreshAll as refreshTxRisk } from "./txrisk/store";

/**
 * Process-wide bootstrap: DB schema, facility metadata seeding, and the polling
 * scheduler. Safe to call repeatedly (idempotent, cached on globalThis so it survives
 * Next.js dev hot-reloads).
 */

interface Runtime {
  init?: Promise<Db>;
  metaSignature?: string;
  metadataIssues: MetadataIssue[];
  schedulerStarted: boolean;
  backfillRunning: boolean;
  backfillProgress: string | null;
  congestionRunning: boolean;
  lastPollAt: string | null;
  lastPollError: string | null;
  timer?: ReturnType<typeof setInterval>;
  priceTimer?: ReturnType<typeof setInterval>;
}

type G = typeof globalThis & { __ogeRuntime?: Runtime };

export function runtime(): Runtime {
  const g = globalThis as G;
  if (!g.__ogeRuntime) {
    g.__ogeRuntime = { metadataIssues: [], schedulerStarted: false, backfillRunning: false, backfillProgress: null, congestionRunning: false, lastPollAt: null, lastPollError: null };
  }
  return g.__ogeRuntime;
}

function metadataSignature(): string {
  const dir = facilitiesDir();
  const files = listProjectJsonFiles(dir);
  if (!files.length) return "none";
  return files.map((f) => `${f}:${projectFileVersion(path.join(dir, f))}`).join("|");
}

/** Re-seed facility metadata if the JSON files changed since last seed. */
export async function syncMetadata(db: Db, force = false): Promise<void> {
  const rt = runtime();
  const sig = metadataSignature();
  if (!force && rt.metaSignature === sig) return;
  const list = loadFacilityFiles();
  const { issues } = validateFacilities(list);
  rt.metadataIssues = issues;
  for (const i of issues.filter((x) => x.level === "error")) console.warn(`[metadata] ${i.facilityId ?? ""}: ${i.message}`);
  // Every new server instance (each serverless cold start) gets here. Re-writing ~350 rows each time is slow
  // over a long network path and makes instances wait on each other's locks, so skip it when the database
  // already holds exactly this metadata.
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex");
  const stored = await db.query<{ value: string }>("SELECT value FROM app_meta WHERE key = 'facilities_sha256'").catch(() => []);
  if (stored[0]?.value !== fingerprint) {
    await seedFacilities(db, list);
    await db.query(
      "INSERT INTO app_meta (key, value, updated_at) VALUES ('facilities_sha256', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [fingerprint],
    );
  }
  rt.metaSignature = sig;
}

export async function ensureInitialized(): Promise<Db> {
  const rt = runtime();
  if (!rt.init) {
    rt.init = (async () => {
      await loadBundledProjectFiles();
      const db = await getDb();
      await syncMetadata(db, true);
      return db;
    })();
    rt.init.catch(() => {
      rt.init = undefined;
    });
  }
  const db = await rt.init;
  await syncMetadata(db);
  return db;
}

export async function pollOnce(db: Db): Promise<void> {
  const rt = runtime();
  rt.lastPollAt = new Date().toISOString();
  try {
    await ingestLatest(db);
    rt.lastPollError = null;
  } catch (e) {
    rt.lastPollError = (e as Error).message;
    console.warn(`[ingest] latest report failed: ${rt.lastPollError}`);
  }
  // Finalise the previous market day from the daily archive once it is complete.
  try {
    const missing = await missingDailyDates(db, 1);
    if (missing.length && !rt.backfillRunning) await ingestDaily(db, missing[0]).catch(() => undefined);
  } catch {
    /* non-fatal */
  }
  void pollCongestion(db);
  // Transmission outage and limit reports; each is re-checked on its own publication cadence.
  if (process.env.TXRISK_ENABLED !== "0") void refreshTxRisk(false, db).catch((e) => console.warn(`[txrisk] ${(e as Error).message}`));
}

/** Price and constraint reports: runs in the background, never blocks the generator poll. */
export async function pollCongestion(db: Db): Promise<void> {
  const rt = runtime();
  if (!config.congestion.enabled || rt.congestionRunning) return;
  rt.congestionRunning = true;
  try {
    const r = await syncCongestion(db, (m) => console.log(`[congestion] ${m}`));
    if (r.lmpHours || r.constraintDays) console.log(`[congestion] loaded ${r.lmpHours} price hours, ${r.constraintDays} constraint days`);
    if (r.errors.length) console.warn(`[congestion] ${r.errors.length} errors, first: ${r.errors[0]}`);
  } catch (e) {
    console.warn(`[congestion] sync failed: ${(e as Error).message}`);
  } finally {
    rt.congestionRunning = false;
  }
}

export function startScheduler(): void {
  const rt = runtime();
  if (rt.schedulerStarted || process.env.OGE_DISABLE_SCHEDULER === "1") return;
  rt.schedulerStarted = true;
  (async () => {
    const db = await ensureInitialized();
    await pollOnce(db);
    if (config.backfillDays > 0) {
      rt.backfillRunning = true;
      try {
        const r = await backfill(db, config.backfillDays, (m) => (rt.backfillProgress = m));
        rt.backfillProgress = `Backfill complete: ${r.ok.length} days loaded, ${r.failed.length} failed`;
        console.log(`[ingest] ${rt.backfillProgress}`);
      } catch (e) {
        rt.backfillProgress = `Backfill error: ${(e as Error).message}`;
      } finally {
        rt.backfillRunning = false;
      }
    }
  })().catch((e) => console.error("[scheduler] startup failed", e));
  rt.timer = setInterval(async () => {
    try {
      await pollOnce(await ensureInitialized());
    } catch (e) {
      console.error("[scheduler] poll failed", e);
    }
  }, config.pollMinutes * 60_000);
  rt.priceTimer = setInterval(async () => {
    try {
      await pollPricesIfDue(await ensureInitialized());
    } catch (e) {
      console.error("[scheduler] price poll failed", e);
    }
  }, config.congestion.pricePollMinutes * 60_000);
}

/**
 * Serverless (Vercel) polling: there is no long-running process, so each call does one bounded
 * slice of work and awaits it all. Repeated calls fill the backfill a few days at a time.
 */
export async function pollServerless(opts: { minIntervalMinutes?: number; dailyPerRun?: number } = {}): Promise<{ skipped: boolean }> {
  const db = await ensureInitialized();
  // Current-hour prices change every 5 minutes, more often than the generator report.
  await pollPricesIfDue(db).catch((e) => console.warn(`[prices] ${(e as Error).message}`));
  const minutes = opts.minIntervalMinutes ?? config.pollMinutes;
  const missing = await missingDailyDates(db, Math.max(config.backfillDays, 1));
  if (minutes > 0 && missing.length === 0) {
    const last = await db.query<{ at: string }>("SELECT at FROM ingest_log WHERE kind = 'latest' ORDER BY id DESC LIMIT 1");
    if (last[0] && Date.now() - new Date(last[0].at).getTime() < minutes * 60_000) return { skipped: true };
  }
  await ingestLatest(db).catch((e) => console.warn(`[ingest] latest report failed: ${(e as Error).message}`));
  for (const d of missing.slice(0, opts.dailyPerRun ?? 2)) await ingestDaily(db, d).catch(() => undefined);
  if (process.env.TXRISK_ENABLED !== "0") await refreshTxRisk(false, db).catch((e) => console.warn(`[txrisk] ${(e as Error).message}`));
  await pollCongestion(db);
  return { skipped: false };
}
