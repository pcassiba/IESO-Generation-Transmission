import { beforeAll, describe, expect, it } from "vitest";
import { getCongestion, isGeneratorLocation, matchLocations, nodeOf, resourceBase } from "../src/lib/congestion";
import { createMemoryDb, type Db } from "../src/lib/db";
import { normaliseFacility, seedFacilities } from "../src/lib/facilities";
import { missingConstraintDays, missingLmpHours, storeConstraints, storeLmp } from "../src/lib/ieso/congestion-ingest";
import { parseConstraintShadowPrices, parseRealtimeLmpCsv } from "../src/lib/ieso/market";

describe("pricing location matching", () => {
  it("separates generators from loads and demand response", () => {
    expect(isGeneratorLocation("BRUCEB-LT.G5")).toBe(true);
    expect(isGeneratorLocation("ADELAIDE-LT.AG_T1")).toBe(true);
    expect(isGeneratorLocation("ALMONTEBESS1-LT.BATT_TG1")).toBe(true);
    expect(isGeneratorLocation("ALMONTEBESS1-LT.BATT_LF1")).toBe(false);
    expect(isGeneratorLocation("BECK2PGS-LT.APG123_LF")).toBe(false);
    expect(isGeneratorLocation("CHATHAM-LT.VOLTUS_DRA")).toBe(false);
    expect(isGeneratorLocation("BUCHANAN-230:LMP")).toBe(false);
    expect(nodeOf("BUCHANAN-230:LMP")).toBe("BUCHANAN");
    expect(resourceBase("BRUCEB-G5")).toBe("BRUCEB");
    expect(resourceBase("BECK2 PGS")).toBe("BECK2PGS");
    expect(resourceBase("SANDUSK-LT.AG_T1")).toBe("SANDUSK");
  });

  it("links facilities by exact name, node, and manual override", () => {
    const locs = ["BRUCE-LT.G1", "BRUCE-LT.SG1", "BRUCE-LT.VOLTUS_DRA", "BRUCEB-LT.G5", "HALTONHILLS-LT.G1", "ADELAIDE-LT.AG_T1", "ZZZ-LT.AG"];
    const m = matchLocations(
      [
        { id: "bruce-a", resources: [{ ieso: "BRUCEA-G1" }] },
        { id: "bruce-b", resources: [{ ieso: "BRUCEB-G5" }] },
        { id: "halton", resources: [{ ieso: "HALTONHILLS-LT.G1" }] },
        { id: "adelaide", resources: [{ ieso: "ADELAIDE" }] },
        { id: "nothing", resources: [{ ieso: "NOWHERE" }] },
      ],
      locs,
      { "bruce-a": ["BRUCE"] },
    );
    expect(m.get("bruce-a")).toEqual(["BRUCE-LT.G1", "BRUCE-LT.SG1"]);
    expect(m.get("bruce-b")).toEqual(["BRUCEB-LT.G5"]);
    expect(m.get("halton")).toEqual(["HALTONHILLS-LT.G1"]);
    expect(m.get("adelaide")).toEqual(["ADELAIDE-LT.AG_T1"]);
    expect(m.has("nothing")).toBe(false);
  });
});

const csv = (date: string, hour: number, rows: [string, number, number][]) =>
  `CREATED AT ${date.replaceAll("-", "/")} 00:00:00 FOR ${date.replaceAll("-", "/")}\nDelivery Hour,Interval,Pricing Location,LMP,Energy Loss Price,Energy Congestion Price\n` +
  rows.flatMap(([loc, lmp, cong]) => Array.from({ length: 12 }, (_, i) => `${hour},${i + 1},${loc},${lmp},0.5,${cong}`)).join("\n");

describe("congestion end to end (PGlite in-memory)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createMemoryDb();
    await seedFacilities(db, [
      normaliseFacility({ id: "kenora", name: "Abitibi Kenora", technology: "hydro", lat: 49.77, lon: -94.48, geocodeConfidence: "high", sourceUrls: [], resources: [{ ieso: "ABKENORA" }] }),
      normaliseFacility({ id: "adelaide", name: "Adelaide", technology: "wind", lat: 43, lon: -81.7, geocodeConfidence: "high", sourceUrls: [], resources: [{ ieso: "ADELAIDE" }] }),
    ]);
    for (const h of [1, 2]) {
      const p = parseRealtimeLmpCsv(csv("2026-10-16", h, [["ABKENORA-LT.AG", 20, h === 2 ? -45 : -5], ["ADELAIDE-LT.AG_T1", 60, 0], ["TORONTO-LT.LFBY", 90, 12], ["MYSTERY-LT.AG", 30, -8]]));
      await storeLmp(db, p, "test", `sha${h}`);
    }
    const xml = `<Document><DocBody><DELIVERYDATE>2026-10-15</DELIVERYDATE>${[20, 21, 22]
      .map((h) => `<HourlyPrice><ConstraintName> BASE CASE   0 NWL-KEN.ALL_I/S.KAO-dso</ConstraintName><DeliveryHour>${h}</DeliveryHour><IntervalShadowPrices><Interval>1</Interval><ShadowPrice>-30</ShadowPrice><Interval>2</Interval><ShadowPrice>0</ShadowPrice></IntervalShadowPrices></HourlyPrice>`)
      .join("")}<HourlyPrice><ConstraintName>X 0 IDLE</ConstraintName><DeliveryHour>24</DeliveryHour><IntervalShadowPrices><Interval>1</Interval><ShadowPrice>0</ShadowPrice></IntervalShadowPrices></HourlyPrice></DocBody></Document>`;
    await storeConstraints(db, parseConstraintShadowPrices(xml), "test", "c1");
  }, 60_000);

  it("reports the latest hour with per-facility congestion", async () => {
    const c = await getCongestion(db);
    expect(c.hourTsUtc).toBe("2026-10-16T07:00:00.000Z");
    const k = c.facilities.find((f) => f.facilityId === "kenora")!;
    expect(k.congestion).toBe(-45);
    expect(k.congestion24h).toBe(-25);
    expect(k.congestedHours24h).toBe(2);
    expect(c.mostNegative.map((p) => p.location)).toEqual(["ABKENORA-LT.AG", "MYSTERY-LT.AG"]);
    expect(c.mostPositive.map((p) => p.location)).toEqual(["TORONTO-LT.LFBY"]);
    expect(c.coverage.unmatchedGeneratorNodes).toEqual(["MYSTERY"]);
  });

  it("honours a historical hour", async () => {
    const c = await getCongestion(db, "2026-10-16T06:30:00Z");
    expect(c.hourTsUtc).toBe("2026-10-16T06:00:00.000Z");
    expect(c.facilities.find((f) => f.facilityId === "kenora")!.congestion).toBe(-5);
  });

  it("summarises binding constraints from the lagged daily report", async () => {
    const c = await getCongestion(db);
    expect(c.constraintDataThroughUtc).toBe("2026-10-16T05:00:00.000Z");
    expect(c.constraints).toHaveLength(1);
    expect(c.constraints[0]).toMatchObject({ name: "BASE CASE 0 NWL-KEN.ALL_I/S.KAO-dso", interfaceCode: "KAO", hoursBinding: 3, avgShadowPrice: -30, peakShadowPrice: -30 });
  });

  it("knows which hours and days are still missing", async () => {
    const hours = await missingLmpHours(db, 4, new Date("2026-10-16T07:30:00Z"));
    // 07:30Z is inside HE3 EST, so the last four completed hours are HE2, HE1 (both stored), HE24 and HE23.
    expect(hours).toEqual([
      { date: "2026-10-15", hour: 24 },
      { date: "2026-10-15", hour: 23 },
    ]);
    const days = await missingConstraintDays(db, 3, new Date("2026-10-17T12:00:00Z"));
    expect(days).toEqual(["2026-10-16", "2026-10-14"]);
  });
});
