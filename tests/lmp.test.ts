import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getCongestion } from "../src/lib/congestion";
import { createMemoryDb, type Db } from "../src/lib/db";
import { normaliseFacility, seedFacilities } from "../src/lib/facilities";
import { storeLmp } from "../src/lib/ieso/congestion-ingest";
import { parseRealtimeLmpCsv } from "../src/lib/ieso/market";
import { facilityLmps, formatLmpShort, heatColor, lmpHeat, lmpScale } from "../src/lib/lmp";

// Saved in the live PUB_RealtimeEnergyLMP_YYYYMMDDHH.csv layout (12 intervals per location, HE15).
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "lmp", "PUB_RealtimeEnergyLMP_2026101915.csv"), "utf8");

describe("LMP colour scale", () => {
  it("runs white at the 5th percentile to red at the 95th, clamped", () => {
    const s = lmpScale([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 1000, null])!;
    expect(s.low).toBeCloseTo(15);
    expect(s.high).toBeCloseTo(550);
    expect(lmpHeat(-50, s)).toBe(0);
    expect(lmpHeat(5000, s)).toBe(1);
    expect(heatColor(0)).toBe("#ffffff");
    expect(heatColor(1)).toBe("#991b1b");
    expect(heatColor(0.5)).toBe("#fca5a5");
  });

  it("handles empty and flat hours", () => {
    expect(lmpScale([])).toBeNull();
    expect(lmpScale([null, null])).toBeNull();
    const flat = lmpScale([42, 42, 42])!;
    expect(flat.high - flat.low).toBe(1);
    expect(lmpHeat(42, flat)).toBe(0);
  });

  it("formats short map labels", () => {
    expect(formatLmpShort(41.2)).toBe("$41");
    expect(formatLmpShort(-8.5)).toBe("−$9");
    expect(formatLmpShort(-0.2)).toBe("$0");
    expect(formatLmpShort(1234.4)).toBe("$1,234");
  });
});

describe("one LMP per facility from the saved report", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createMemoryDb();
    await seedFacilities(db, [
      normaliseFacility({
        id: "bruce-b-ngs",
        name: "Bruce B",
        technology: "nuclear",
        lat: 44.33,
        lon: -81.6,
        geocodeConfidence: "high",
        sourceUrls: [],
        resources: ["G5", "G6", "G7", "G8"].map((g) => ({ ieso: `BRUCEB-${g}` })),
      }),
      normaliseFacility({
        id: "darlington-ngs",
        name: "Darlington",
        technology: "nuclear",
        lat: 43.87,
        lon: -78.72,
        geocodeConfidence: "high",
        sourceUrls: [],
        resources: [{ ieso: "DARLINGTON-G1" }, { ieso: "DARLINGTON-G2" }],
      }),
      normaliseFacility({
        id: "kenora",
        name: "Abitibi Kenora",
        technology: "hydro",
        lat: 49.77,
        lon: -94.48,
        geocodeConfidence: "high",
        sourceUrls: [],
        resources: [{ ieso: "ABKENORA" }],
      }),
    ]);
    await storeLmp(db, parseRealtimeLmpCsv(FIXTURE), "fixture", "sha");
  }, 60_000);

  it("averages the units of a facility and keeps each unit for the tooltip", async () => {
    const c = await getCongestion(db);
    const bruce = c.facilities.find((f) => f.facilityId === "bruce-b-ngs")!;
    expect(bruce.units.map((u) => u.location)).toEqual(["BRUCEB-LT.G5", "BRUCEB-LT.G6", "BRUCEB-LT.G7", "BRUCEB-LT.G8"]);
    expect(bruce.units.map((u) => u.lmp)).toEqual([40.1, 40.3, 41.2, 42.4]);
    expect(bruce.lmp).toBe(41);
    expect(bruce.loss).toBe(-1);
    expect(c.facilities.find((f) => f.facilityId === "darlington-ngs")!.lmp).toBe(61);
  });

  it("colours the cheapest facility white and the dearest red", async () => {
    const c = await getCongestion(db);
    const scale = lmpScale(c.facilities.map((f) => f.lmp))!;
    const m = facilityLmps(c.facilities, scale);
    expect(m.size).toBe(3);
    expect(m.get("kenora")!.color).toBe("#ffffff");
    expect(m.get("kenora")!.label).toBe("−$9");
    expect(m.get("darlington-ngs")!.color).toBe("#991b1b");
    expect(m.get("darlington-ngs")!.textColor).toBe("#ffffff");
    const bruce = m.get("bruce-b-ngs")!;
    expect(bruce.heat).toBeGreaterThan(0.5);
    expect(bruce.heat).toBeLessThan(1);
  });
});
