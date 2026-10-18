import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, type ClassifyInput, type GenSite } from "../src/lib/txrisk/classify";
import { bracketCode, findBaseline, findInterface, interfaceKey, reduction, type InterfaceDef } from "../src/lib/txrisk/interfaces";
import { buildNetworkIndex, equipmentInComment, findStation, matchEquipment, normCircuit, normStation, parseEquipmentName } from "../src/lib/txrisk/network";
import { parseKv, parseTxLimits, parseTxOutages } from "../src/lib/txrisk/parse";
import { occurrenceAt, windowsBetween } from "../src/lib/txrisk/recurrence";
import { REPORTS, refreshReport, reportStatus } from "../src/lib/txrisk/store";
import { ReportParseError } from "../src/lib/ieso/parser";

const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures", "txrisk", f), "utf8");
const outages = () => parseTxOutages(fx("PUB_TxOutagesTodayAll_20261017_excerpt.xml"));
const l02 = () => parseTxLimits(fx("PUB_TxLimitsOutage0to2Days_20261017_excerpt.xml"), "TxLimitsOutage0to2Days");
const l334 = () => parseTxLimits(fx("PUB_TxLimitsOutage3to34Days_20261009_excerpt.xml"), "TxLimitsOutage3to34Days");
const ais = () => parseTxLimits(fx("PUB_TxLimitsAllInService0to34Days_20261017_excerpt.xml"), "TxLimitsAllInService0to34Days");

// 2026-10-17 11:00 EST.
const T = Date.parse("2026-10-17T16:00:00Z");

/** Small synthetic network in the shape of public/geo/*.geojson. */
const line = (osmId: number, ref: string | null, kv: number, coords: [number, number][]) => ({ properties: { osmId, ref, kv }, geometry: { type: "LineString", coordinates: coords } });
const sub = (osmId: number, name: string, lon: number, lat: number) => ({ properties: { osmId, name, kv: 230 }, geometry: { coordinates: [lon, lat] as [number, number] } });
const NET = buildNetworkIndex(
  {
    features: [
      line(1, "K-21-W", 230, [[-94.5, 49.8], [-95.1, 49.9]]),
      line(2, "M30A;X523A", 230, [[-79.0, 43.9], [-79.2, 43.95]]),
      line(3, "M30A", 230, [[-79.2, 43.95], [-79.3, 44.0]]),
      line(4, "Q28A", 230, [[-79.1, 43.1], [-79.2, 43.15]]),
      line(5, null, 500, [[-80, 44], [-80.1, 44.1]]),
    ],
  },
  {
    features: [
      sub(10, "Nanticoke TS", -80.06, 42.8),
      sub(11, "Claireville TS", -79.63, 43.76),
      sub(12, "Marathon TS", -86.4, 48.72),
      sub(13, "Wawa TS", -84.77, 47.99),
      sub(14, "Mackenzie TS", -93.1, 48.7),
      sub(15, "Dobbin TS", -78.3, 44.3),
      sub(16, "St. Lawrence Transformer Station", -74.8, 45.0),
      sub(17, "K2 Substation", -76.0, 45.0),
      sub(18, "K2 Substation", -80.0, 43.0),
      sub(19, "Lauzon Transformer Station", -82.94, 42.31),
    ],
  },
  { "WINDSOR LAUZON TS": "Lauzon Transformer Station" },
);

const DEFS: InterfaceDef[] = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "transmission", "interfaces.json"), "utf8")).interfaces;
const GEN: GenSite[] = [{ id: "wawa-hydro", name: "Wawa hydro", lat: 48.0, lon: -84.8, mw: 600, region: "Northeast" }];

const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  t: T,
  now: T,
  outages: outages(),
  limits0to2: l02(),
  limits3to34: l334(),
  allInService: ais(),
  network: NET,
  interfaces: DEFS,
  generation: GEN,
  binding: [],
  bindingDataThroughUtc: null,
  ...over,
});

describe("XML parsing (real report structure)", () => {
  it("parses TxOutagesTodayAll header, requests and equipment", () => {
    const p = outages();
    expect(p.header.docId).toBe("TxOutagesTodayAll");
    expect(p.header.createdAtRaw).toBe("2026-10-17T11:03:33");
    expect(p.header.createdAtUtc).toBe("2026-10-17T16:03:33.000Z");
    expect(p.rangeStartRaw).toBe("2026-10-17T00:00:00");
    expect(p.outages).toHaveLength(9);
    const k21w = p.outages.find((o) => o.outageId === "1-00254393")!;
    expect(k21w).toMatchObject({ priority: "F", recurrence: "C", status: "IMPL", recallTime: "Non-recallable", plannedEndRaw: "2027-12-30T16:00:00" });
    expect(k21w.equipment[0]).toMatchObject({ name: "K21W.WHXKE", type: "LineSection", voltageKv: 230, constraintType: "OOS" });
    expect(p.outages.find((o) => o.outageId === "1-00290050")!.equipment).toHaveLength(2);
  });

  it("parses the limits reports, trims names and keeps raw timestamps", () => {
    const p = l02();
    expect(p.header.createdAtRaw).toBe("2026-10-17T11:45:01");
    expect(p.dateRangeEnd).toBe("2026-10-19");
    expect(p.limits).toHaveLength(5);
    const ny = p.limits.find((l) => l.interfaceName.startsWith("Ontario-New York"))!;
    expect(ny.interfaceName).toBe("Ontario-New York Import");
    expect(ny).toMatchObject({ facilityType: "Intertie", operatingLimitMW: 1250, comments: "PA27 O/S", startRaw: "2026-09-15T04:00:00", startUtc: "2026-09-15T09:00:00.000Z" });
    expect(l334().limits).toHaveLength(4);
    expect(ais().limits).toHaveLength(8);
  });

  it("rejects the wrong report, HTML pages and broken XML instead of returning records", () => {
    expect(() => parseTxLimits(fx("PUB_TxLimitsOutage0to2Days_20261017_excerpt.xml"), "TxLimitsOutage3to34Days")).toThrow(ReportParseError);
    expect(() => parseTxOutages("<html><body>Maintenance</body></html>")).toThrow(ReportParseError);
    expect(() => parseTxOutages("")).toThrow(ReportParseError);
    expect(() => parseTxOutages("<Document><DocHeader/></Document>")).toThrow(/DocBody/);
  });

  it("validates units and timestamps", () => {
    expect(parseKv("230 kV")).toBe(230);
    expect(parseKv("NULL")).toBeNull();
    expect(parseKv("LT")).toBeNull();
    const bad = fx("PUB_TxLimitsOutage0to2Days_20261017_excerpt.xml").replace("<OperatingLimit>475</OperatingLimit>", "<OperatingLimit>n/a</OperatingLimit>").replace("2026-10-09T06:45:00", "09/10/2026");
    const p = parseTxLimits(bad, "TxLimitsOutage0to2Days");
    expect(p.limits.find((l) => l.interfaceName.includes("EWTE"))!.operatingLimitMW).toBeNull();
    expect(p.limits.find((l) => l.interfaceName.includes("KAO"))!.startUtc).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/invalid OperatingLimit/);
    expect(p.warnings.join(" ")).toMatch(/unrecognised timestamp/);
  });
});

describe("duplicate records", () => {
  it("merges a repeated OutageID and keeps the union of its equipment", () => {
    const body = fx("PUB_TxOutagesTodayAll_20261017_excerpt.xml").replace(
      "</DocBody>",
      `<OutageRequest><OutageID>1-00269611</OutageID><PlannedStart>2024-10-27T08:00:00</PlannedStart><PlannedEnd>2026-12-31T16:00:00</PlannedEnd><Priority>F</Priority><Recurrence>C</Recurrence>
       <EquipmentRequested><EquipmentName>NANTICOKE TS T13</EquipmentName><EquipmentType>PowerTransformer</EquipmentType><EquipmentVoltage>500 kV</EquipmentVoltage><ConstraintType>OOS</ConstraintType></EquipmentRequested>
       <EquipmentRequested><EquipmentName>NANTICOKE TS HT13_BUS</EquipmentName><EquipmentType>Bus</EquipmentType><EquipmentVoltage>500 kV</EquipmentVoltage><ConstraintType>OOS</ConstraintType></EquipmentRequested>
       <EquipmentRecallTime>Non-recallable</EquipmentRecallTime><OutageRequestStatus>AA</OutageRequestStatus></OutageRequest></DocBody>`,
    );
    const p = parseTxOutages(body);
    const recs = p.outages.filter((o) => o.outageId === "1-00269611");
    expect(recs).toHaveLength(1);
    expect(recs[0].equipment.map((e) => e.name)).toEqual(["NANTICOKE TS T13", "NANTICOKE TS HT13_BUS"]);
    expect(recs[0].status).toBe("IMPL");
    expect(p.warnings.join(" ")).toMatch(/different status/);
  });

  it("deduplicates identical limit records within and across the 0–2 and 3–34 day reports", () => {
    const body = fx("PUB_TxLimitsOutage0to2Days_20261017_excerpt.xml");
    const dup = body.replace(/(<InterfaceData><InterfaceName>Kenora[^\n]*\n)/, "$1$1");
    expect(parseTxLimits(dup, "TxLimitsOutage0to2Days").limits).toHaveLength(5);
    const ewte02 = l02().limits.find((l) => l.interfaceName.includes("EWTE"))!;
    const ewte334 = l334().limits.find((l) => l.interfaceName.includes("EWTE"))!;
    expect(ewte02.id).toBe(ewte334.id);
    const items = classify(input()).filter((i) => i.kind === "limit" && i.interfaceName?.includes("EWTE"));
    expect(items).toHaveLength(1);
    expect(items[0].sourceReport).toBe("limits0to2");
  });
});

describe("time interpretation", () => {
  it("reads IESO timestamps as EST all year (no daylight shift)", () => {
    const p = l02();
    const kao = p.limits.find((l) => l.interfaceName.includes("KAO"))!;
    // October is daylight time in Toronto, but IESO reports stay on EST: 06:45 EST = 11:45 UTC.
    expect(kao.startUtc).toBe("2026-10-09T11:45:00.000Z");
    const ewtw = l334().limits.find((l) => l.interfaceName.includes("EWTW"))!;
    expect(ewtw.endUtc).toBe("2027-12-30T21:00:00.000Z");
  });
});

describe("outage recurrence", () => {
  const base = { plannedStartUtc: "2026-10-19T13:00:00.000Z", plannedEndUtc: "2026-10-24T21:00:00.000Z" }; // Mon 08:00 EST → Sat 16:00 EST
  it("continuous outages are in effect for the whole window only", () => {
    expect(occurrenceAt({ ...base, recurrence: "C" }, Date.parse("2026-10-20T08:00:00Z")).active).toBe(true);
    expect(occurrenceAt({ ...base, recurrence: "C" }, Date.parse("2026-10-24T21:00:00Z")).active).toBe(false);
    expect(occurrenceAt({ ...base, recurrence: "C" }, Date.parse("2026-10-19T12:59:00Z")).active).toBe(false);
  });
  it("return-evenings outages are in effect only between the daily start and end times (EST)", () => {
    const o = { ...base, recurrence: "RE" };
    expect(occurrenceAt(o, Date.parse("2026-10-20T15:00:00Z")).active).toBe(true); // Tue 10:00 EST
    expect(occurrenceAt(o, Date.parse("2026-10-20T23:00:00Z")).active).toBe(false); // Tue 18:00 EST
    expect(occurrenceAt(o, Date.parse("2026-10-21T12:30:00Z")).active).toBe(false); // Wed 07:30 EST
    const w = windowsBetween(o, Date.parse(base.plannedStartUtc), Date.parse(base.plannedEndUtc));
    expect(w.active).toHaveLength(6);
    expect(new Date(w.active[1][0]).toISOString()).toBe("2026-10-20T13:00:00.000Z");
    expect(new Date(w.active[1][1]).toISOString()).toBe("2026-10-20T21:00:00.000Z");
  });
  it("REW also returns at weekends; RSS returns Saturday and Sunday", () => {
    expect(occurrenceAt({ ...base, recurrence: "REW" }, Date.parse("2026-10-24T15:00:00Z")).active).toBe(false); // Sat
    expect(occurrenceAt({ ...base, recurrence: "REW" }, Date.parse("2026-10-23T15:00:00Z")).active).toBe(true); // Fri
    expect(occurrenceAt({ ...base, recurrence: "RSS" }, Date.parse("2026-10-24T15:00:00Z")).active).toBe(false);
    expect(occurrenceAt({ ...base, recurrence: "RSS" }, Date.parse("2026-10-22T04:00:00Z")).active).toBe(true); // Wed 23:00 EST
  });
  it("does not assume a schedule for non-continuous or unknown codes", () => {
    expect(occurrenceAt({ ...base, recurrence: "NC" }, Date.parse("2026-10-20T15:00:00Z")).active).toBe("unknown");
    expect(occurrenceAt({ ...base, recurrence: "ZZ" }, Date.parse("2026-10-20T15:00:00Z")).active).toBe("unknown");
    expect(occurrenceAt({ ...base, recurrence: "RE", plannedEndUtc: "2026-10-24T12:00:00.000Z" }, Date.parse("2026-10-20T15:00:00Z")).active).toBe("unknown");
  });
});

describe("equipment and interface matching", () => {
  it("parses IESO equipment naming conventions", () => {
    expect(parseEquipmentName("C20R: CHERRYWOOD TS x RICHVIEW TS", "Line")).toMatchObject({ circuit: "C20R", terminals: ["CHERRYWOOD TS", "RICHVIEW TS"] });
    expect(parseEquipmentName("K21W.WHXKE", "LineSection")).toMatchObject({ circuit: "K21W", section: "WHXKE" });
    expect(parseEquipmentName("BOWMANVILLE SS H2_BUS", "Bus")).toMatchObject({ station: "BOWMANVILLE SS", device: "H2_BUS" });
    expect(parseEquipmentName("FORT FRANCES TS SC1.2-1", "Disconnect")).toMatchObject({ station: "FORT FRANCES TS" });
    expect(parseEquipmentName("MISO WAVE E0MCPH-110.BK8_BKR", "Breaker")).toMatchObject({ circuit: null, station: null });
    expect(normCircuit("K-21-W")).toBe("K21W");
    expect(normStation("St. Lawrence Transformer Station")).toBe("ST LAWRENCE TS");
  });

  it("matches circuits by OSM ref, including double-circuit ways", () => {
    const m = matchEquipment(NET, "M30A.AJXEJ", "LineSection");
    expect(m.match).toBe("circuit-section");
    expect(m.lineIds.sort()).toEqual([2, 3]);
    expect(m.note).toMatch(/approximate/);
    expect(matchEquipment(NET, "K21W: KENORA TS x WHITESHELL", "Line")).toMatchObject({ match: "circuit", lineIds: [1] });
  });

  it("matches stations by normalised name or alias, and refuses ambiguous names", () => {
    expect(matchEquipment(NET, "NANTICOKE TS T13", "PowerTransformer")).toMatchObject({ match: "station", stationIds: [10] });
    expect(matchEquipment(NET, "ST. LAWRENCE TS L33_BUS", "Bus")).toMatchObject({ match: "station", stationIds: [16] });
    expect(matchEquipment(NET, "WINDSOR LAUZON TS T12", "PowerTransformer")).toMatchObject({ match: "station", stationIds: [19] });
    expect(findStation(NET, "K2 SUBSTATION").ids).toEqual([]);
  });

  it("leaves unknown equipment unmapped rather than guessing", () => {
    const m = matchEquipment(NET, "C20R: CHERRYWOOD TS x RICHVIEW TS", "Line");
    expect(m.match).toBe("none");
    expect(m.lineIds).toEqual([]);
    expect(matchEquipment(NET, "MAJESTIC CTS T1B", "Breaker").match).toBe("none");
    const noNet = buildNetworkIndex(null, null);
    expect(matchEquipment(noNet, "K21W.WHXKE", "LineSection")).toMatchObject({ match: "none", note: expect.stringMatching(/not built/) });
  });

  it("finds equipment named in limit comments", () => {
    expect(equipmentInComment(NET, "K21W O/S")).toMatchObject({ circuits: ["K21W"], lineIds: [1] });
    const mk = equipmentInComment(NET, "Mackenzie PL30 O/S");
    expect(mk.stationIds).toEqual([14]);
    expect(mk.unmatched).toEqual(["PL30"]);
    expect(equipmentInComment(NET, "NYISO - MSU1 O/S").lineIds).toEqual([]);
  });

  it("identifies interfaces by bracket code or season-free name", () => {
    expect(bracketCode("Kenora Area Outflow [KAO]")).toBe("KAO");
    expect(interfaceKey("Ontario-New York Import Summer")).toBe(interfaceKey("Ontario-New York Import "));
    expect(interfaceKey("Ontario-Quebec Bryson 115 kV Import Winter or Summer ")).toBe(interfaceKey("Ontario-Quebec Bryson 115 kV Import"));
    expect(findInterface(DEFS, "East-West Transfer East [EWTE]")?.code).toBe("EWTE");
    expect(findInterface(DEFS, "Manitoba X Ontario Import")?.code).toBe("ON-MB");
    expect(findInterface(DEFS, "Ontario-Michigan Import Summer")).toBeNull();
  });
});

describe("limit comparison with all-in-service baselines", () => {
  const get = (name: string) => l02().limits.find((l) => l.interfaceName.includes(name))!;
  it("computes the reduction for a single comparable baseline", () => {
    const b = findBaseline(get("EWTE"), ais().limits, T)!;
    expect(b.values).toEqual([500]);
    expect(reduction(475, b)).toEqual({ mw: [25, 25], pct: [5, 5] });
    expect(reduction(1120, findBaseline(get("SLW"), ais().limits, T))).toEqual({ mw: [230, 230], pct: [17, 17] });
  });
  it("gives a range when IESO lists separate summer and winter limits", () => {
    const b = findBaseline(get("New York"), ais().limits, T)!;
    expect(b.values).toEqual([1250, 1550]);
    expect(b.note).toMatch(/season/);
    expect(reduction(1250, b)).toEqual({ mw: [0, 300], pct: [0, 19.4] });
  });
  it("does not compare different interfaces or expired baselines", () => {
    const mb = l334().limits.find((l) => l.interfaceName.startsWith("Manitoba"))!;
    expect(findBaseline(mb, ais().limits, T)).toBeNull();
    expect(findBaseline(get("EWTE"), ais().limits, Date.parse("2027-02-01T00:00:00Z"))).toBeNull();
  });
});

describe("classification", () => {
  const byId = (items: ReturnType<typeof classify>, id: string) => items.find((i) => i.id === id)!;

  it("marks only implemented, in-effect OOS outages as confirmed (red)", () => {
    const items = classify(input());
    const k21w = byId(items, "outage:1-00254393");
    expect(k21w).toMatchObject({ category: "outage", animate: "flash", match: "circuit-section", lineIds: [1] });
    expect(byId(items, "outage:1-00269611")).toMatchObject({ category: "outage", match: "station", stationIds: [10] });
    // Advance approved, not implemented → scheduled, not confirmed.
    expect(byId(items, "outage:1-00289214").category).toBe("future");
    // Protection-only work: line still in service, nothing drawn.
    expect(byId(items, "outage:1-00225094")).toMatchObject({ category: "info", lineIds: [] });
    // Under study with HOLDOFF constraint.
    expect(byId(items, "outage:1-00275116").category).toBe("info");
    // INFO equipment, and the outage is listed though unmapped.
    expect(byId(items, "outage:1-00103070")).toMatchObject({ category: "info", match: "none" });
  });

  it("keeps a published limit orange and never turns interface lines red", () => {
    const items = classify(input());
    const kao = items.find((i) => i.interfaceName?.includes("KAO"))!;
    expect(kao.category === "restriction" || kao.category === "potential").toBe(true);
    expect(kao.stationIds).toEqual([14]); // Mackenzie, named in the comment
    const ny = items.find((i) => i.interfaceName === "Ontario-New York Import")!;
    expect(ny.reductionMW).toEqual([0, 300]);
    expect(ny.match).toBe("interface-stations");
    expect(items.filter((i) => i.kind === "limit").every((i) => i.category !== "outage")).toBe(true);
  });

  it("scores potential congestion transparently and needs two kinds of evidence", () => {
    const items = classify(input());
    const ewte = items.find((i) => i.interfaceName?.includes("EWTE"))!;
    // 5 % reduction (+1), K21W confirmed out and named in the comment (+1), 600 MW near Wawa ≥ 475 MW (+1).
    expect(ewte.score!.points).toBe(3);
    expect(ewte.score!.factors.map((f) => f.points)).toEqual([1, 1, 1]);
    expect(ewte.category).toBe("potential");
    expect(ewte.evidence.some((e) => e.source === "app" && /Score/.test(e.text))).toBe(true);
    const slw = items.find((i) => i.interfaceName?.includes("SLW"))!;
    expect(slw.score!.points).toBe(2); // 17 % reduction only: one kind of evidence
    expect(slw.category).toBe("restriction");
  });

  it("shows only scheduled (purple) items for a future time and never confirmed outages", () => {
    const t = Date.parse("2026-10-25T15:00:00Z");
    const items = classify(input({ t }));
    expect(items.some((i) => i.category === "outage")).toBe(false);
    expect(byId(items, "outage:1-00254393").category).toBe("future");
    expect(byId(items, "outage:1-00295577").category).toBe("info"); // ended 2026-10-17
    const mb = items.find((i) => i.interfaceName === "Manitoba X Ontario Import")!;
    expect(mb.category === "restriction" || mb.category === "potential").toBe(true); // already in effect now
  });

  it("classifies binding only from shadow price data covering the selected hour", () => {
    const binding = [{ constraintName: "NWL-WAW.EWTE-test", interfaceCode: "EWTE", tsUtc: "2026-10-12T16:00:00.000Z", avgShadowPrice: -45 }];
    const now = classify(input({ binding, bindingDataThroughUtc: "2026-10-13T05:00:00.000Z" }));
    expect(now.some((i) => i.category === "binding")).toBe(false);
    expect(now.find((i) => i.interfaceName?.includes("EWTE"))!.score!.factors.some((f) => /binding/.test(f.label))).toBe(true);
    const past = classify(input({ t: Date.parse("2026-10-12T15:30:00Z"), binding, bindingDataThroughUtc: "2026-10-13T05:00:00.000Z" }));
    const b = past.find((i) => i.category === "binding")!;
    expect(b).toMatchObject({ interfaceCode: "EWTE", stationIds: [12, 13] });
  });

  it("lists everything without verified geometry instead of drawing it", () => {
    const items = classify(input({ network: buildNetworkIndex(null, null) }));
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((i) => i.match === "none" && i.lineIds.length === 0 && i.stationIds.length === 0)).toBe(true);
  });
});

describe("report freshness", () => {
  const def = REPORTS.find((d) => d.kind === "outages")!;
  const parsed = outages();
  it("flags a report published longer ago than its threshold", () => {
    const fresh = reportStatus(def, { parsed, etag: null, lastModified: null, lastAttemptUtc: null, lastSuccessUtc: null, lastError: null }, Date.parse("2026-10-17T17:00:00Z"));
    expect(fresh.stale).toBe(false);
    const old = reportStatus(def, { parsed, etag: null, lastModified: null, lastAttemptUtc: null, lastSuccessUtc: null, lastError: null }, Date.parse("2026-10-17T21:00:00Z"));
    expect(old).toMatchObject({ stale: true, staleReason: expect.stringMatching(/more than 3 h/) });
  });
  it("reports an unavailable report rather than inventing records", () => {
    const st = reportStatus(def, { parsed: null, etag: null, lastModified: null, lastAttemptUtc: "x", lastSuccessUtc: null, lastError: "IESO server returned HTTP 503" }, Date.now());
    expect(st).toMatchObject({ stale: true, records: 0, staleReason: expect.stringMatching(/503/) });
  });
  it("keeps the last good copy when a later download fails to parse", async () => {
    process.env.IESO_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "txrisk-"));
    const ok = async () => ({ kind: "ok" as const, url: "u", body: fx("PUB_TxOutagesTodayAll_20261017_excerpt.xml"), etag: "a", lastModified: null });
    const broken = async () => ({ kind: "ok" as const, url: "u", body: "<html>error</html>", etag: "b", lastModified: null });
    await refreshReport(def, true, ok);
    await refreshReport(def, true, broken);
    const g = (globalThis as unknown as { __ogeTxRisk: { slots: Map<string, { parsed: { outages: unknown[] } | null; lastError: string | null }> } }).__ogeTxRisk;
    const s = g.slots.get("outages")!;
    expect(s.parsed!.outages).toHaveLength(9);
    expect(s.lastError).toMatch(/HTML/);
  });
});

describe("overlay toggles and table helpers", async () => {
  const ui = await import("../src/lib/txrisk/ui");
  const items = classify(input());
  const lineGeom = new Map([...NET.lines.keys()].map((id) => [id, { type: "LineString" as const, coordinates: [[0, 0], [1, 1]] as [number, number][] }]));
  const stationGeom = new Map([...NET.stations.values()].map((s) => [s.osmId, [s.lon, s.lat] as [number, number]]));

  it("draws nothing when the layer is off and only affected assets when on", () => {
    const off = ui.overlayFeatures(items, lineGeom, stationGeom, { enabled: false, flashing: true, reducedMotion: false });
    expect(off.lines.features).toHaveLength(0);
    expect(off.stations.features).toHaveLength(0);
    const on = ui.overlayFeatures(items, lineGeom, stationGeom, { enabled: true, flashing: true, reducedMotion: false });
    const drawnLines = new Set(on.lines.features.map((f) => f.properties!.osmId));
    expect(drawnLines.has(5)).toBe(false); // unaffected 500 kV line stays untouched
    expect(drawnLines.has(1)).toBe(true); // K21W
    expect(on.lines.features.find((f) => f.properties!.itemId === "outage:1-00254393")!.properties).toMatchObject({ anim: "flash", approx: 1 });
  });

  it("uses static highlights when flashing is off or reduced motion is requested", () => {
    for (const o of [
      { enabled: true, flashing: false, reducedMotion: false },
      { enabled: true, flashing: true, reducedMotion: true },
    ]) {
      const fc = ui.overlayFeatures(items, lineGeom, stationGeom, o);
      expect(fc.lines.features.length).toBeGreaterThan(0);
      expect([...fc.lines.features, ...fc.stations.features].every((f) => f.properties!.anim === "none")).toBe(true);
    }
    expect(ui.animOpacity("flash", 100)).toBeGreaterThan(ui.animOpacity("flash", 1000));
  });

  it("filters, searches and sorts the table; unmapped records stay listed", () => {
    const f = ui.defaultTableFilters();
    const visible = items.filter((i) => ui.matchesFilters(i, f));
    expect(visible.some((i) => i.category === "info")).toBe(false);
    expect(items.filter((i) => ui.matchesFilters(i, { ...f, includeInactive: true }))).toHaveLength(items.length);
    expect(items.filter((i) => ui.matchesFilters(i, { ...f, query: "k21w" })).map((i) => i.id)).toContain("outage:1-00254393");
    const forced = items.filter((i) => ui.matchesFilters(i, { ...f, kinds: new Set(["forced"]) }));
    expect(forced.every((i) => ["F", "FE"].includes(i.priority ?? ""))).toBe(true);
    const unmappedLimit = items.find((i) => i.interfaceName === "Manitoba X Ontario Import" && i.category !== "info");
    expect(unmappedLimit).toBeDefined();
    const sorted = ui.sortItems(visible, "category", 1);
    expect(sorted[0].category).toBe("outage");
  });

  it("converts Toronto wall-clock input across daylight time", () => {
    expect(ui.torontoLocalToUtc("2026-10-17T12:00")).toBe("2026-10-17T16:00:00.000Z"); // EDT
    expect(ui.torontoLocalToUtc("2026-12-01T12:00")).toBe("2026-12-01T17:00:00.000Z"); // EST
    expect(ui.utcToTorontoLocal("2026-10-17T16:00:00.000Z")).toBe("2026-10-17T12:00");
    expect(ui.reportForOffsetHours(80)).toMatch(/3–34/);
  });
});
