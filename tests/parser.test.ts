import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGenOutputCapability, ReportParseError } from "../src/lib/ieso/parser";

const REAL = fs.readFileSync(path.join(__dirname, "fixtures", "PUB_GenOutputCapability_20261014_HE20.xml"), "utf8");

const doc = (generators: string, date = "2026-03-08", created = "2026-03-08T05:16:00") => `<?xml version="1.0" encoding="UTF-8"?>
<IMODocument docID="GenOutputCapability" xmlns="http://www.theIMO.com/schema">
<IMODocHeader><DocTitle>Generators Output and Capability Report</DocTitle><CreatedAt>${created}</CreatedAt></IMODocHeader>
<IMODocBody><Date>${date}</Date><Generators>${generators}</Generators></IMODocBody></IMODocument>`;

describe("parseGenOutputCapability — real IESO report", () => {
  const r = parseGenOutputCapability(REAL);

  it("reads header and market date", () => {
    expect(r.reportDate).toBe("2026-10-14");
    expect(r.createdAtEst).toBe("2026-10-14T20:16:16");
    expect(r.createdAtUtc).toBe("2026-10-15T01:16:16.000Z");
  });

  it("parses all 188 resources with fuel types", () => {
    expect(r.resourceCount).toBe(188);
    const fuels = new Set(r.resources.map((x) => x.fuel));
    expect([...fuels].sort()).toEqual(["BIOFUEL", "GAS", "HYDRO", "NUCLEAR", "OTHER", "SOLAR", "WIND"]);
    expect(r.duplicateResources).toEqual([]);
  });

  it("finds the latest reported hour", () => {
    expect(r.maxHour).toBe(20);
  });

  it("maps conventional capability vs wind/solar forecast correctly", () => {
    const portlands = r.observations.find((o) => o.iesoName === "PORTLANDS-G1" && o.hour === 9)!;
    expect(portlands.outputMW).toBe(191);
    expect(portlands.capabilityMW).toBe(61);
    expect(portlands.forecastMW).toBeNull();
    expect(portlands.availCapacityMW).not.toBeNull();

    const k2 = r.observations.find((o) => o.iesoName === "K2WIND" && o.hour === 15)!;
    expect(k2.outputMW).toBe(170);
    expect(k2.capabilityMW).toBeNull(); // wind <Capability> is the IESO forecast
    expect(k2.forecastMW).toBe(165);
    expect(k2.availCapacityMW).toBe(270);
  });

  it("produces a UTC hour-ending timestamp (EST based)", () => {
    const o = r.observations.find((x) => x.iesoName === "BRUCEB-G6" && x.hour === 20)!;
    expect(o.tsUtc).toBe("2026-10-15T01:00:00.000Z");
  });
});

describe("parseGenOutputCapability — schema variations & validation", () => {
  it("handles a single Generator / single Output (non-array) and missing Capacities", () => {
    const r = parseGenOutputCapability(
      doc(`<Generator><GeneratorName>TEST-G1</GeneratorName><FuelType>GAS</FuelType>
        <Outputs><Output><Hour>1</Hour><EnergyMW>12</EnergyMW></Output></Outputs>
        <Capabilities><Capability><Hour>1</Hour><EnergyMW>50</EnergyMW></Capability></Capabilities></Generator>`),
    );
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]).toMatchObject({ outputMW: 12, capabilityMW: 50, availCapacityMW: null });
  });

  it("accepts namespace prefixes", () => {
    const xml = `<?xml version="1.0"?><ns:IMODocument xmlns:ns="http://www.theIMO.com/schema"><ns:IMODocHeader><ns:CreatedAt>2026-01-01T01:00:00</ns:CreatedAt></ns:IMODocHeader>
      <ns:IMODocBody><ns:Date>2026-01-01</ns:Date><ns:Generators><ns:Generator><ns:GeneratorName>A</ns:GeneratorName><ns:FuelType>HYDRO</ns:FuelType>
      <ns:Outputs><ns:Output><ns:Hour>1</ns:Hour><ns:EnergyMW>3</ns:EnergyMW></ns:Output></ns:Outputs></ns:Generator></ns:Generators></ns:IMODocBody></ns:IMODocument>`;
    const r = parseGenOutputCapability(xml);
    expect(r.observations[0].outputMW).toBe(3);
  });

  it("treats empty / non-numeric / implausible values as missing and warns", () => {
    const r = parseGenOutputCapability(
      doc(`<Generator><GeneratorName>X</GeneratorName><FuelType>GAS</FuelType>
        <Outputs><Output><Hour>1</Hour><EnergyMW></EnergyMW></Output><Output><Hour>2</Hour><EnergyMW>abc</EnergyMW></Output>
        <Output><Hour>3</Hour><EnergyMW>99999</EnergyMW></Output><Output><Hour>4</Hour><EnergyMW>-5</EnergyMW></Output>
        <Output><Hour>5</Hour><EnergyMW>7</EnergyMW></Output></Outputs>
        <Capabilities><Capability><Hour>1</Hour><EnergyMW>10</EnergyMW></Capability></Capabilities></Generator>`),
    );
    const byHour = new Map(r.observations.map((o) => [o.hour, o]));
    expect(byHour.get(1)!.outputMW).toBeNull();
    expect(byHour.get(1)!.capabilityMW).toBe(10);
    expect(byHour.has(2)).toBe(false); // nothing valid at all for HE2
    expect(byHour.has(3)).toBe(false);
    expect(byHour.has(4)).toBe(false);
    expect(byHour.get(5)!.outputMW).toBe(7);
    expect(r.warnings.some((w) => w.includes("non-numeric"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("implausible"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("negative"))).toBe(true);
  });

  it("allows negative output for OTHER (storage withdrawals)", () => {
    const r = parseGenOutputCapability(
      doc(`<Generator><GeneratorName>BESS</GeneratorName><FuelType>OTHER</FuelType>
        <Outputs><Output><Hour>1</Hour><EnergyMW>-40</EnergyMW></Output></Outputs></Generator>`),
    );
    expect(r.observations[0].outputMW).toBe(-40);
  });

  it("skips invalid hours and flags duplicate resources", () => {
    const g = `<Generator><GeneratorName>D</GeneratorName><FuelType>HYDRO</FuelType><Outputs><Output><Hour>25</Hour><EnergyMW>1</EnergyMW></Output><Output><Hour>2</Hour><EnergyMW>1</EnergyMW></Output></Outputs></Generator>`;
    const r = parseGenOutputCapability(doc(g + g));
    expect(r.duplicateResources).toEqual(["D"]);
    expect(r.observations).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("invalid hour"))).toBe(true);
  });

  it("supports a separate Forecasts element (older schema)", () => {
    const r = parseGenOutputCapability(
      doc(`<Generator><GeneratorName>W</GeneratorName><FuelType>WIND</FuelType>
        <Outputs><Output><Hour>1</Hour><EnergyMW>5</EnergyMW></Output></Outputs>
        <Forecasts><Forecast><Hour>1</Hour><EnergyMW>6</EnergyMW></Forecast></Forecasts>
        <Capacities><AvailCapacity><Hour>1</Hour><EnergyMW>100</EnergyMW></AvailCapacity></Capacities></Generator>`),
    );
    expect(r.observations[0]).toMatchObject({ outputMW: 5, forecastMW: 6, availCapacityMW: 100, capabilityMW: null });
  });

  it("throws useful errors for broken documents", () => {
    expect(() => parseGenOutputCapability("")).toThrow(ReportParseError);
    expect(() => parseGenOutputCapability("<html><body>Service unavailable</body></html>")).toThrow(/IMODocument/);
    expect(() => parseGenOutputCapability(doc("", "bad-date"))).toThrow(/Date/);
    expect(() => parseGenOutputCapability(doc(""))).toThrow(/no <Generator>/);
  });
});
