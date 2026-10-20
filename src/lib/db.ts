import path from "node:path";
import fs from "node:fs";

/**
 * Database access.
 *
 * Default: PGlite — a full PostgreSQL engine compiled to WASM, persisted under
 * ./data/pglite. No install needed, free for local development.
 * Set DATABASE_URL to use an external PostgreSQL / Supabase instance via `pg` instead.
 * The SQL used throughout is plain PostgreSQL, so both back-ends behave identically.
 */

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Pick<Db, "query" | "exec">) => Promise<T>): Promise<T>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  technology TEXT NOT NULL,
  subtype TEXT,
  operator TEXT,
  owner TEXT,
  municipality TEXT,
  region TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  geocode_confidence TEXT NOT NULL,
  geocode_source TEXT,
  installed_capacity_mw DOUBLE PRECISION,
  capacity_source TEXT,
  commissioning_year INTEGER,
  source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  review_flag BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resource_map (
  ieso_name TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  units TEXT
);

CREATE TABLE IF NOT EXISTS ieso_resources (
  ieso_name TEXT PRIMARY KEY,
  ieso_fuel TEXT NOT NULL,
  first_seen_report DATE,
  last_seen_report DATE
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  source_url TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at_est TEXT,
  created_at_utc TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  etag TEXT,
  last_modified TEXT,
  sha256 TEXT NOT NULL,
  resource_count INTEGER,
  max_hour INTEGER,
  observation_count INTEGER,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  cache_file TEXT,
  UNIQUE (sha256)
);

CREATE TABLE IF NOT EXISTS observations (
  ieso_name TEXT NOT NULL,
  ts_utc TIMESTAMPTZ NOT NULL,
  report_date DATE NOT NULL,
  hour SMALLINT NOT NULL,
  output_mw DOUBLE PRECISION,
  capability_mw DOUBLE PRECISION,
  forecast_mw DOUBLE PRECISION,
  avail_capacity_mw DOUBLE PRECISION,
  ieso_fuel TEXT NOT NULL,
  report_id INTEGER REFERENCES reports(id),
  PRIMARY KEY (ieso_name, ts_utc)
);
CREATE INDEX IF NOT EXISTS observations_ts_idx ON observations (ts_utc);

CREATE TABLE IF NOT EXISTS ingest_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  message TEXT
);

-- Transmission congestion (IESO renewed-market reports, see src/lib/ieso/market.ts).
CREATE TABLE IF NOT EXISTS market_files (
  report TEXT NOT NULL,
  period TEXT NOT NULL,
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  complete BOOLEAN NOT NULL,
  row_count INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report, period)
);

CREATE TABLE IF NOT EXISTS lmp_hourly (
  location TEXT NOT NULL,
  ts_utc TIMESTAMPTZ NOT NULL,
  intervals SMALLINT NOT NULL,
  lmp DOUBLE PRECISION,
  loss DOUBLE PRECISION,
  congestion DOUBLE PRECISION,
  congestion_min DOUBLE PRECISION,
  congestion_max DOUBLE PRECISION,
  PRIMARY KEY (location, ts_utc)
);
CREATE INDEX IF NOT EXISTS lmp_hourly_ts_idx ON lmp_hourly (ts_utc);

-- Intertie prices (RealTimeIntertieLMP), one row per intertie pricing location and hour.
CREATE TABLE IF NOT EXISTS intertie_lmp_hourly (
  location TEXT NOT NULL,
  ts_utc TIMESTAMPTZ NOT NULL,
  intervals SMALLINT NOT NULL,
  lmp DOUBLE PRECISION,
  loss DOUBLE PRECISION,
  congestion DOUBLE PRECISION,
  external_congestion DOUBLE PRECISION,
  nisl DOUBLE PRECISION,
  PRIMARY KEY (location, ts_utc)
);
CREATE INDEX IF NOT EXISTS intertie_lmp_hourly_ts_idx ON intertie_lmp_hourly (ts_utc);

-- Only hours in which a constraint was binding are stored; market_files records coverage.
CREATE TABLE IF NOT EXISTS constraint_hourly (
  constraint_name TEXT NOT NULL,
  ts_utc TIMESTAMPTZ NOT NULL,
  binding_intervals SMALLINT NOT NULL,
  avg_shadow_price DOUBLE PRECISION,
  peak_shadow_price DOUBLE PRECISION,
  PRIMARY KEY (constraint_name, ts_utc)
);
CREATE INDEX IF NOT EXISTS constraint_hourly_ts_idx ON constraint_hourly (ts_utc);

-- Authoritative outage evidence (manually curated, each row must cite a source).
CREATE TABLE IF NOT EXISTS outage_evidence (
  id SERIAL PRIMARY KEY,
  facility_id TEXT REFERENCES facilities(id) ON DELETE CASCADE,
  ieso_name TEXT,
  start_utc TIMESTAMPTZ NOT NULL,
  end_utc TIMESTAMPTZ,
  description TEXT NOT NULL,
  source_url TEXT NOT NULL
);
`;

type Global = typeof globalThis & { __ogeDb?: Promise<Db> };

async function createPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), "data", "pglite");
  if (dir !== "memory://") fs.mkdirSync(dir, { recursive: true });
  const pg = dir === "memory://" ? new PGlite() : new PGlite(dir);
  await pg.waitReady;
  // PGlite is single-connection; serialise access to keep transactions isolated.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const rawQuery = async <T>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows;
  const db: Db = {
    query: (sql, params) => serial(() => rawQuery(sql, params)),
    exec: (sql) => serial(async () => void (await pg.exec(sql))),
    transaction: (fn) =>
      serial(() =>
        pg.transaction(async (tx) =>
          fn({
            query: async <T>(sql: string, params?: unknown[]) => (await tx.query<T>(sql, params)).rows,
            exec: async (sql: string) => void (await tx.exec(sql)),
          }),
        ),
      ),
  };
  return db;
}

async function createPg(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 5 });
  const db: Db = {
    query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
    exec: async (sql) => void (await pool.query(sql)),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await fn({
          query: async (sql, params) => (await client.query(sql, params as unknown[])).rows,
          exec: async (sql) => void (await client.query(sql)),
        });
        await client.query("COMMIT");
        return r;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
  return db;
}

export function getDb(): Promise<Db> {
  const g = globalThis as Global;
  if (!g.__ogeDb) {
    g.__ogeDb = (async () => {
      // Vercel's Neon/Postgres integrations may expose the connection string as POSTGRES_URL.
      const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
      if (!url && process.env.VERCEL) throw new Error("No database configured: on Vercel, connect a Postgres database (e.g. Neon) so DATABASE_URL is set.");
      const db = url ? await createPg(url) : await createPglite();
      await db.exec(SCHEMA);
      return db;
    })();
    g.__ogeDb.catch(() => {
      g.__ogeDb = undefined;
    });
  }
  return g.__ogeDb;
}

/** Test helper: fresh in-memory database. */
export async function createMemoryDb(): Promise<Db> {
  const prev = process.env.PGLITE_DIR;
  process.env.PGLITE_DIR = "memory://";
  try {
    const db = await createPglite();
    await db.exec(SCHEMA);
    return db;
  } finally {
    process.env.PGLITE_DIR = prev;
  }
}
