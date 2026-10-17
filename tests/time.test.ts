import { describe, expect, it } from "vitest";
import { addDays, formatOntario, hourEndingToUtc, marketDateNow, parseIesoEst, utcToMarketHour } from "../src/lib/time";

describe("IESO time handling (EST market hours)", () => {
  it("hour ending N EST → UTC (+5h), winter", () => {
    expect(hourEndingToUtc("2026-01-15", 1)).toBe("2026-01-15T06:00:00.000Z");
  });
  it("same fixed offset in summer (market stays on EST)", () => {
    expect(hourEndingToUtc("2026-07-01", 20)).toBe("2026-07-02T01:00:00.000Z");
  });
  it("HE24 is midnight at the end of the market day", () => {
    expect(hourEndingToUtc("2026-10-14", 24)).toBe("2026-10-15T05:00:00.000Z");
    expect(utcToMarketHour("2026-10-15T05:00:00.000Z")).toEqual({ reportDate: "2026-10-14", hour: 24 });
  });
  it("round-trips every hour across DST transition days", () => {
    for (const day of ["2026-03-08", "2026-11-01"]) {
      for (let h = 1; h <= 24; h++) {
        expect(utcToMarketHour(hourEndingToUtc(day, h))).toEqual({ reportDate: day, hour: h });
      }
    }
  });
  it("DST-transition market days still have 24 distinct hours", () => {
    const s = new Set(Array.from({ length: 24 }, (_, i) => hourEndingToUtc("2026-03-08", i + 1)));
    expect(s.size).toBe(24);
  });
  it("displays local Ontario time with correct EDT/EST abbreviation", () => {
    // HE20 EST on Oct 14 = 21:00 EDT
    expect(formatOntario(hourEndingToUtc("2026-10-14", 20))).toMatch(/21:00 EDT/);
    // HE20 EST on Jan 14 = 20:00 EST
    expect(formatOntario(hourEndingToUtc("2026-01-14", 20))).toMatch(/20:00 EST/);
  });
  it("parses report CreatedAt (EST)", () => {
    expect(parseIesoEst("2026-10-14T20:16:16")).toBe("2026-10-15T01:16:16.000Z");
    expect(parseIesoEst("garbage")).toBeNull();
    expect(parseIesoEst(null)).toBeNull();
  });
  it("rejects invalid inputs", () => {
    expect(() => hourEndingToUtc("2026-10-14", 0)).toThrow();
    expect(() => hourEndingToUtc("2026-10-14", 25)).toThrow();
    expect(() => hourEndingToUtc("14/10/2026", 1)).toThrow();
  });
  it("market date uses EST, not local wall clock", () => {
    // 00:30 EDT Oct 15 = 23:30 EST Oct 14 → still market day Oct 14
    expect(marketDateNow(new Date("2026-10-15T04:30:00Z"))).toBe("2026-10-14");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
