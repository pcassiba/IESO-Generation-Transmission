import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { getDb, type Db } from "./db";
import { facilitiesDir, loadFacilityFiles, seedFacilities, validateFacilities, type MetadataIssue } from "./facilities";
import { syncCongestion } from "./ieso/congestion-ingest";
import { backfill, ingestDaily, ingestLatest, missingDailyDates } from "./ieso/ingest";

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
  if (!fs.existsSync(dir)) return "none";
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`)
    .join("|");
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
  await seedFacilities(db, list);
  rt.metaSignature = sig;
}

export async function ensureInitialized(): Promise<Db> {
  const rt = runtime();
  if (!rt.init) {
    rt.init = (async () => {
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
}
