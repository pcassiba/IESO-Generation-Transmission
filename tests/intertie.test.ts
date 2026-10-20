import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getCongestion } from "../src/lib/congestion";
import { createMemoryDb, type Db } from "../src/lib/db";
import { normaliseFacility, seedFacilities } from "../src/lib/facilities";
import { storeIntertieLmp, storeLmp } from "../src/lib/ieso/congestion-ingest";
import { parseRealtimeIntertieLmp, parseRealtimeLmpCsv } from "../src/lib/ieso/market";
import { groupIntertiePrices, loadIntertieLocations, pointFor } from "../src/lib/interties";
import { INTERTIE_HEAT_STOPS, intertieMarkers, lmpScale } from "../src/lib/lmp";

// Built in the RealTimeIntertieLMP XML layout (12 intervals, five price components per location, HE15).
const XML = fs.readFileSync(path.join(__dirname, "fixtures", "intertie", "PUB_RealTimeIntertieLMP_2026101915.xml"), "utf8");
const LMP_CSV = fs.readFileSync(path.join(__dirname, "fixtures", "lmp", "PUB_RealtimeEnergyLMP_2026101915.csv"), "utf8");

describe("intertie LMP report", () => {
  it("averages each location's 12 intervals and strips the :LMP suffix", () => {
    const p = parseRealtimeIntertieLmp(XML);
    expect(p.deliveryDate).toBe("2026-10-19");
    expect(p.hour).toBe(15);
    expect(p.createdAt).toBe("2026-10-19T15:04:11");
    const mi = p.rows.find((r) => r.location === "MI.LUDINGTON_MISI")!;
    expect(mi).toMatchObject({ intervals: 12, lmp: 80, loss: 0.5, congestion: 1, externalCongestion: 0, nisl: 0 });
    expect(mi.tsUtc).toBe("2026-10-19T20:00:00.000Z");
    expect(p.rows.find((r) => r.location === "NY.ROSETON_NYSI")!.nisl).toBe(-3);
  });

  it("rejects a document without a delivery hour", () => {
    expect(() => parseRealtimeIntertieLmp(XML.replace("<DeliveryHour>15</DeliveryHour>", ""))).toThrow(/delivery hour/);
  });
});

describe("intertie map points", () => {
  const defs = loadIntertieLocations();

  it("places listed locations, then falls back to the interface suffix", () => {
    expect(pointFor("NY.ROSETON_NYSI", defs)).toBe("new-york");
    expect(pointFor("ZZ.NEWPROXY_MISI", defs)).toBe("michigan");
    expect(pointFor("XX.SOMEWHERE_ZZZZ", defs)).toBeNull();
    for (const p of defs.points) {
      expect(p.lat).toBeGreaterThan(41);
      expect(p.lat).toBeLessThan(57);
      expect(p.lon).toBeGreaterThan(-96);
      expect(p.lon).toBeLessThan(-74);
      expect(p.neighbour).toBeTruthy();
      expect(typeof p.bearing).toBe("number");
    }
  });

  it("uses the first listed location as the headline price and keeps the rest", () => {
    const rows = parseRealtimeIntertieLmp(XML).rows.map((r) => ({ ...r }));
    const g = groupIntertiePrices(rows, defs);
    const mi = g.points.find((p) => p.id === "michigan")!;
    expect(mi.location).toBe("MI.LUDINGTON_MISI");
    expect(mi.lmp).toBe(80);
    expect(mi.prices.map((p) => p.location)).toEqual(["MI.LUDINGTON_MISI", "MD.CALVERTCLIFF_MISI"]);
    expect(mi.neighbour).toBe("MISO (Michigan)");
    expect(g.unplaced).toEqual(["XX.SOMEWHERE_ZZZZ"]);
  });
});

describe("intertie prices for the selected hour", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createMemoryDb();
    await seedFacilities(db, [
      normaliseFacility({ id: "bruce-b-ngs", name: "Bruce B", technology: "nuclear", lat: 44.33, lon: -81.6, geocodeConfidence: "high", sourceUrls: [], resources: ["G5", "G6", "G7", "G8"].map((g) => ({ ieso: `BRUCEB-${g}` })) }),
      normaliseFacility({ id: "darlington-ngs", name: "Darlington", technology: "nuclear", lat: 43.87, lon: -78.72, geocodeConfidence: "high", sourceUrls: [], resources: [{ ieso: "DARLINGTON-G1" }, { ieso: "DARLINGTON-G2" }] }),
      normaliseFacility({ id: "kenora", name: "Abitibi Kenora", technology: "hydro", lat: 49.77, lon: -94.48, geocodeConfidence: "high", sourceUrls: [], resources: [{ ieso: "ABKENORA" }] }),
    ]);
    await storeLmp(db, parseRealtimeLmpCsv(LMP_CSV), "fixture", "sha");
    await storeIntertieLmp(db, parseRealtimeIntertieLmp(XML), "fixture", "sha");
  }, 60_000);

  it("comes back with the congestion response for the same hour", async () => {
    const c = await getCongestion(db, "2026-10-19T20:00:00.000Z");
    expect(c.interties.hourTsUtc).toBe(c.hourTsUtc);
    expect(c.interties.points.map((p) => p.id).sort()).toEqual(["michigan", "new-york", "quebec-beauharnois"]);
    const later = await getCongestion(db, "2026-10-19T23:00:00.000Z");
    expect(later.interties.hourTsUtc).toBe("2026-10-19T20:00:00.000Z");
    const before = await getCongestion(db, "2026-10-18T00:00:00.000Z");
    expect(before.interties.points).toEqual([]);
  });

  it("is more intense the higher it sits against facility prices", async () => {
    const c = await getCongestion(db);
    const scale = lmpScale(c.facilities.map((f) => f.lmp))!;
    const m = new Map(intertieMarkers(c.interties.points, scale).map((x) => [x.point.id, x]));
    // Facilities run about −$9 … $61: Michigan at $80 is fully intense, New York at $30 sits in between.
    expect(m.get("michigan")!.heat).toBe(1);
    expect(m.get("michigan")!.color).toBe(INTERTIE_HEAT_STOPS.at(-1)![1]);
    expect(m.get("new-york")!.heat).toBeGreaterThan(0);
    expect(m.get("new-york")!.heat).toBeLessThan(m.get("quebec-beauharnois")!.heat);
    expect(intertieMarkers(c.interties.points, null)).toEqual([]);
  });
});
