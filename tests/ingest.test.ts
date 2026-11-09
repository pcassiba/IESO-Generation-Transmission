import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryDb, type Db } from "../src/lib/db";
import { seedFacilities, normaliseFacility } from "../src/lib/facilities";
import { ingestXml } from "../src/lib/ieso/ingest";
import { getHistory, getState } from "../src/lib/state";

const REAL = fs.readFileSync(path.join(__dirname, "fixtures", "PUB_GenOutputCapability_20261014_HE20.xml"), "utf8");

describe("end-to-end ingestion into PostgreSQL (PGlite in-memory)", () => {
  let db: Db;
  beforeAll(async () => {
    process.env.IESO_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oge-cache-"));
    db = await createMemoryDb();
    await seedFacilities(db, [
      normaliseFacility({
        id: "portlands-energy-centre", name: "Portlands Energy Centre", technology: "gas", lat: 43.65, lon: -79.33,
        geocodeConfidence: "high", sourceUrls: [], resources: [{ ieso: "PORTLANDS-G1" }, { ieso: "PORTLANDS-G2" }, { ieso: "PORTLANDS-G3" }],
      }),
      normaliseFacility({
        id: "k2", name: "K2 Wind", technology: "wind", lat: 43.9, lon: -81.6, geocodeConfidence: "high", sourceUrls: [], resources: [{ ieso: "K2WIND" }],
      }),
      normaliseFacility({
        id: "oneida", name: "Oneida Energy Storage", technology: "storage", lat: 42.9, lon: -80.0, geocodeConfidence: "high", sourceUrls: [],
        resources: [{ ieso: "ONEIDA ENERGY STORAGE" }],
      }),
    ]);
  }, 60_000);

  it("stores the report once (idempotent on content hash)", async () => {
    const a = await ingestXml(db, REAL, { url: "fixture", kind: "file" });
    expect(a.stored).toBe(true);
    expect(a.maxHour).toBe(20);
    const b = await ingestXml(db, REAL, { url: "fixture", kind: "file" });
    expect(b.stored).toBe(false);
    const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM reports");
    expect(n[0].n).toBe(1);
  }, 60_000);

  it("latest state reflects HE20 EST with real values and coverage", async () => {
    const s = await getState(db);
    expect(s.meta.latestTsUtc).toBe("2026-10-15T01:00:00.000Z");
    expect(s.meta.hourEnding).toBe(20);
    const p = s.facilities.find((f) => f.id === "portlands-energy-centre")!;
    expect(p.resourceStates.map((r) => r.iesoName).sort()).toEqual(["PORTLANDS-G1", "PORTLANDS-G2", "PORTLANDS-G3"]);
    expect(p.resourceStates.find((r) => r.iesoName === "PORTLANDS-G1")!.outputMW).toBe(194);
    expect(s.coverage.reportResources).toBe(188);
    expect(s.coverage.matchedResources).toBe(5);
    expect(s.coverage.unmatchedResources).toHaveLength(183);
    const o = s.facilities.find((f) => f.id === "oneida")!;
    expect(o.storageMode).toBe("discharging");
    expect(o.outputMW).toBe(164);
  });

  it("historical mode snaps to a stored hour", async () => {
    const s = await getState(db, "2026-10-14T14:30:00.000Z"); // 09:30 EST → HE9
    expect(s.meta.mode).toBe("historical");
    expect(s.meta.hourEnding).toBe(9);
    const p = s.facilities.find((f) => f.id === "portlands-energy-centre")!;
    const g1 = p.resourceStates.find((r) => r.iesoName === "PORTLANDS-G1")!;
    expect(g1.capabilityMW).toBe(61);
    expect(g1.status).toBe("derated");
  });

  it("history returns 20 hourly points summed over resources", async () => {
    const [h] = await getHistory(db, ["portlands-energy-centre"], "24h");
    expect(h.points).toHaveLength(20);
    expect(Object.keys(h.resources)).toHaveLength(3);
    const last = h.points[h.points.length - 1];
    const sum = Object.values(h.resources).reduce((a, pts) => a + (pts[pts.length - 1].outputMW ?? 0), 0);
    expect(last.outputMW).toBe(sum);
  });

  it("gives the last reported output to facilities with no reading this hour (Output map view)", async () => {
    const he19 = await db.query<{ mw: number }>("SELECT output_mw AS mw FROM observations WHERE ieso_name='K2WIND' AND ts_utc='2026-10-15T00:00:00Z'");
    // Simulate K2 missing from the HE20 report's output column.
    await db.query("UPDATE observations SET output_mw = NULL WHERE ieso_name='K2WIND' AND ts_utc='2026-10-15T01:00:00Z'");
    const s = await getState(db);
    const k2 = s.facilities.find((f) => f.id === "k2")!;
    expect(k2.outputMW).toBeNull();
    expect(k2.lastOutput).toEqual({ mw: he19[0].mw, tsUtc: "2026-10-15T00:00:00.000Z" });
    // Facilities that did report this hour don't get one.
    expect(s.facilities.find((f) => f.id === "oneida")!.lastOutput).toBeUndefined();
  });
});
