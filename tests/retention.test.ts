import { describe, expect, it } from "vitest";
import { createMemoryDb } from "../src/lib/db";
import { pruneOldData } from "../src/lib/retention";

describe("pruneOldData", () => {
  it("deletes history older than the retention window and keeps recent rows", async () => {
    const db = await createMemoryDb();
    const now = new Date("2026-10-31T12:00:00Z");
    const old = "2026-07-01T05:00:00Z";
    const recent = "2026-10-30T05:00:00Z";
    for (const ts of [old, recent]) {
      await db.query("INSERT INTO lmp_hourly (location, ts_utc, intervals, lmp) VALUES ('A', $1, 12, 30)", [ts]);
      await db.query("INSERT INTO intertie_lmp_hourly (location, ts_utc, intervals, lmp) VALUES ('B', $1, 12, 30)", [ts]);
      await db.query("INSERT INTO constraint_hourly (constraint_name, ts_utc, binding_intervals) VALUES ('C', $1, 3)", [ts]);
      await db.query(
        "INSERT INTO observations (ieso_name, ts_utc, report_date, hour, output_mw, ieso_fuel) VALUES ('X', $1, $2, 1, 10, 'GAS')",
        [ts, ts.slice(0, 10)],
      );
    }
    await db.query("INSERT INTO market_files (report, period, url, sha256, complete) VALUES ('lmp', '2026-07-01 01', 'u', 's', true), ('lmp', '2026-10-30 01', 'u', 's', true)");
    await db.query("INSERT INTO ingest_log (at, kind, ok) VALUES ('2026-10-01T00:00:00Z', 'latest', true), ('2026-10-02T00:00:00Z', 'latest', true), ('2026-10-01T00:00:00Z', 'prices', true)");

    const r = await pruneOldData(db, now, 60, 7);
    expect(r.deleted).toMatchObject({ lmp_hourly: 1, intertie_lmp_hourly: 1, constraint_hourly: 1, observations: 1, market_files: 1, ingest_log: 1 });
    for (const t of ["lmp_hourly", "intertie_lmp_hourly", "constraint_hourly", "observations", "market_files"]) {
      const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      expect(n, t).toBe(1);
    }
    // The newest log row of each kind survives, even when it is old.
    const kinds = await db.query<{ kind: string }>("SELECT kind FROM ingest_log ORDER BY kind");
    expect(kinds.map((k) => k.kind)).toEqual(["latest", "prices"]);
  });

  it("keeps everything when retention is 0", async () => {
    const db = await createMemoryDb();
    await db.query("INSERT INTO lmp_hourly (location, ts_utc, intervals, lmp) VALUES ('A', '2020-01-01T00:00:00Z', 12, 30)");
    const r = await pruneOldData(db, new Date("2026-10-31T12:00:00Z"), 0, 0);
    expect(r.cutoff).toBeNull();
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM lmp_hourly");
    expect(n).toBe(1);
  });
});
