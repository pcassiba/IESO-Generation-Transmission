import { XMLParser } from "fast-xml-parser";
import { hourEndingToUtc } from "../time";
import { parseNumber, ReportParseError } from "./parser";

/**
 * Parsers for the IESO market reports used to show transmission congestion
 * (renewed market, May 2025 onward).
 *
 *  - RealtimeEnergyLMP (CSV, one file per delivery hour, 12 five-minute intervals):
 *      CREATED AT 2026/10/17 00:18:08 FOR 2026/10/17
 *      Delivery Hour,Interval,Pricing Location,LMP,Energy Loss Price,Energy Congestion Price
 *    LMP = reference price + loss + congestion. A congestion component well below zero at a
 *    generator means its output is held back by a transmission constraint ("trapped" supply);
 *    well above zero means the location is import-constrained.
 *
 *  - RealtimeConstrShadowPrices (XML, one file per delivery day):
 *      Document > DocBody > DELIVERYDATE, HourlyPrice* { ConstraintName, DeliveryHour,
 *      IntervalShadowPrices { Interval, ShadowPrice, Interval, ShadowPrice, … } }
 *    A non-zero shadow price means the constraint was binding in that interval.
 *
 * Both are reduced to hourly rows on ingest; times are hour-ending EST like the rest of the app.
 */

export interface LmpHourRow {
  location: string;
  tsUtc: string;
  deliveryDate: string;
  hour: number;
  intervals: number;
  lmp: number | null;
  loss: number | null;
  congestion: number | null;
  /** Most negative 5-minute congestion component within the hour. */
  congestionMin: number | null;
  /** Most positive 5-minute congestion component within the hour. */
  congestionMax: number | null;
}

export interface ParsedLmp {
  createdAt: string | null;
  deliveryDate: string;
  rows: LmpHourRow[];
  warnings: string[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** `fallbackDate` (YYYY-MM-DD) is used when the header line is missing, e.g. from the file name. */
export function parseRealtimeLmpCsv(csv: string, fallbackDate?: string): ParsedLmp {
  if (!csv || typeof csv !== "string") throw new ReportParseError("Empty LMP report body");
  const lines = csv.split(/\r?\n/);
  const warnings: string[] = [];
  let createdAt: string | null = null;
  let deliveryDate = fallbackDate ?? null;
  const head = /^CREATED AT (\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) FOR (\d{4})\/(\d{2})\/(\d{2})/i.exec(lines[0]?.trim() ?? "");
  if (head) {
    createdAt = `${head[1]}-${head[2]}-${head[3]}T${head[4]}`;
    deliveryDate = `${head[5]}-${head[6]}-${head[7]}`;
  }
  if (!deliveryDate) throw new ReportParseError("LMP report has no delivery date");

  const headerIdx = lines.findIndex((l) => /pricing location/i.test(l));
  if (headerIdx < 0) throw new ReportParseError("LMP report header row not found");
  const cols = lines[headerIdx].split(",").map((c) => c.trim().toLowerCase());
  const ix = {
    hour: cols.indexOf("delivery hour"),
    interval: cols.indexOf("interval"),
    loc: cols.indexOf("pricing location"),
    lmp: cols.indexOf("lmp"),
    loss: cols.findIndex((c) => c.includes("loss")),
    cong: cols.findIndex((c) => c.includes("congestion")),
  };
  if (Object.values(ix).some((i) => i < 0)) throw new ReportParseError(`LMP report columns not recognised: ${cols.join(",")}`);

  type Acc = { hour: number; ints: Set<number>; lmp: number[]; loss: number[]; cong: number[] };
  const acc = new Map<string, Acc>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = line.split(",");
    const hour = parseNumber(f[ix.hour]);
    const interval = parseNumber(f[ix.interval]);
    const loc = f[ix.loc]?.trim();
    if (!loc || hour === null || hour < 1 || hour > 24 || !Number.isInteger(hour) || interval === null) {
      if (warnings.length < 50) warnings.push(`Line ${i + 1} skipped: "${line.slice(0, 80)}"`);
      continue;
    }
    const key = `${loc}|${hour}`;
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { hour, ints: new Set(), lmp: [], loss: [], cong: [] }));
    if (a.ints.has(interval)) continue;
    a.ints.add(interval);
    const lmp = parseNumber(f[ix.lmp]);
    const loss = parseNumber(f[ix.loss]);
    const cong = parseNumber(f[ix.cong]);
    if (lmp !== null) a.lmp.push(lmp);
    if (loss !== null) a.loss.push(loss);
    if (cong !== null) a.cong.push(cong);
  }

  const rows: LmpHourRow[] = [];
  for (const [key, a] of acc) {
    const location = key.slice(0, key.lastIndexOf("|"));
    rows.push({
      location,
      tsUtc: hourEndingToUtc(deliveryDate, a.hour),
      deliveryDate,
      hour: a.hour,
      intervals: a.ints.size,
      lmp: round2(avg(a.lmp)),
      loss: round2(avg(a.loss)),
      congestion: round2(avg(a.cong)),
      congestionMin: a.cong.length ? Math.min(...a.cong) : null,
      congestionMax: a.cong.length ? Math.max(...a.cong) : null,
    });
  }
  return { createdAt, deliveryDate, rows, warnings };
}

export interface ConstraintHourRow {
  constraint: string;
  tsUtc: string;
  deliveryDate: string;
  hour: number;
  /** Intervals (of 12) with a non-zero shadow price. */
  bindingIntervals: number;
  /** Mean shadow price over the binding intervals ($/MWh). */
  avgShadowPrice: number | null;
  /** Largest-magnitude shadow price in the hour. */
  peakShadowPrice: number | null;
}

export interface ParsedConstraints {
  createdAt: string | null;
  deliveryDate: string;
  rows: ConstraintHourRow[];
  constraintCount: number;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "HourlyPrice" || name === "Interval" || name === "ShadowPrice",
});

/** "BASE CASE      0 NW.O.T6A_4C.V2N_D" → "BASE CASE 0 NW.O.T6A_4C.V2N_D" */
export const normaliseConstraintName = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseConstraintShadowPrices(body: string): ParsedConstraints {
  let doc: Record<string, unknown>;
  try {
    doc = xml.parse(body);
  } catch (e) {
    throw new ReportParseError(`XML parse failure: ${(e as Error).message}`);
  }
  const root = doc.Document as Record<string, unknown> | undefined;
  const docBody = root?.DocBody as Record<string, unknown> | undefined;
  if (!docBody) throw new ReportParseError("Missing Document/DocBody");
  const deliveryDate = String(docBody.DELIVERYDATE ?? docBody.DeliveryDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) throw new ReportParseError(`Invalid delivery date "${deliveryDate}"`);
  const header = (root?.DocHeader ?? {}) as Record<string, unknown>;

  const names = new Set<string>();
  const rows: ConstraintHourRow[] = [];
  for (const hp of (docBody.HourlyPrice as Record<string, unknown>[] | undefined) ?? []) {
    const constraint = normaliseConstraintName(String(hp.ConstraintName ?? ""));
    const hour = parseNumber(hp.DeliveryHour);
    if (!constraint || hour === null || hour < 1 || hour > 24) continue;
    names.add(constraint);
    const isp = (hp.IntervalShadowPrices ?? {}) as { ShadowPrice?: unknown[] };
    const prices = (isp.ShadowPrice ?? []).map(parseNumber).filter((v): v is number => v !== null);
    const binding = prices.filter((p) => p !== 0);
    const peak = binding.reduce<number | null>((m, p) => (m === null || Math.abs(p) > Math.abs(m) ? p : m), null);
    rows.push({
      constraint,
      tsUtc: hourEndingToUtc(deliveryDate, hour),
      deliveryDate,
      hour,
      bindingIntervals: binding.length,
      avgShadowPrice: round2(avg(binding)),
      peakShadowPrice: peak,
    });
  }
  return { createdAt: header.CreatedAt ? String(header.CreatedAt) : null, deliveryDate, rows, constraintCount: names.size };
}

export interface IntertieHourRow {
  /** Intertie pricing location without the ":LMP" suffix, e.g. "MI.LUDINGTON_MISI". */
  location: string;
  tsUtc: string;
  deliveryDate: string;
  hour: number;
  intervals: number;
  lmp: number | null;
  loss: number | null;
  congestion: number | null;
  /** Congestion on the neighbouring system's side of the tie. */
  externalCongestion: number | null;
  /** Net Interchange Scheduling Limit price: what the limit on total imports/exports added. */
  nisl: number | null;
}

export interface ParsedIntertieLmp {
  createdAt: string | null;
  deliveryDate: string;
  hour: number;
  rows: IntertieHourRow[];
}

const intertieXml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "IntertieLMPrice" || name === "Components" || name === "IntervalLMP",
});

/** Every object under `key` at any depth (IESO sometimes wraps price lists in an extra element). */
function findAll(node: unknown, key: string): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, key));
  const out: Record<string, unknown>[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(...(Array.isArray(v) ? v : [v]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object"));
    else out.push(...findAll(v, key));
  }
  return out;
}

const INTERTIE_COMPONENTS: Record<string, "lmp" | "loss" | "congestion" | "externalCongestion" | "nisl"> = {
  "intertie lmp": "lmp",
  "energy loss price": "loss",
  "energy congestion price": "congestion",
  "external congestion price": "externalCongestion",
  "net interchange scheduling limit (nisl) price": "nisl",
};

/**
 * RealTimeIntertieLMP (XML, one file per delivery hour, 12 five-minute intervals):
 *   Document > DocBody > DeliveryDate, DeliveryHour, IntertieLMPrice* { IntertiePLName,
 *   Components* { LMPComponent, IntervalLMP* { Interval, LMP } } }
 * The intertie LMP = Ontario energy price + loss + congestion + external congestion + NISL.
 */
export function parseRealtimeIntertieLmp(body: string): ParsedIntertieLmp {
  let doc: Record<string, unknown>;
  try {
    doc = intertieXml.parse(body);
  } catch (e) {
    throw new ReportParseError(`XML parse failure: ${(e as Error).message}`);
  }
  const root = doc.Document as Record<string, unknown> | undefined;
  const docBody = root?.DocBody as Record<string, unknown> | undefined;
  if (!docBody) throw new ReportParseError("Missing Document/DocBody");
  const header = (root?.DocHeader ?? {}) as Record<string, unknown>;
  // The date and hour sit in DocBody in the published samples; DocHeader is a fallback.
  const field = (k: string) => docBody[k] ?? header[k];
  const deliveryDate = String(field("DeliveryDate") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) throw new ReportParseError(`Invalid delivery date "${deliveryDate}"`);
  const hour = parseNumber(field("DeliveryHour"));
  if (hour === null || hour < 1 || hour > 24) throw new ReportParseError(`Invalid delivery hour "${String(field("DeliveryHour"))}"`);
  const tsUtc = hourEndingToUtc(deliveryDate, hour);

  const rows: IntertieHourRow[] = [];
  for (const p of findAll(docBody, "IntertieLMPrice")) {
    const location = String(p.IntertiePLName ?? "")
      .trim()
      .replace(/:LMP$/i, "");
    if (!location) continue;
    const vals: Record<string, number[]> = { lmp: [], loss: [], congestion: [], externalCongestion: [], nisl: [] };
    const ints = new Set<number>();
    for (const c of (p.Components as Record<string, unknown>[] | undefined) ?? []) {
      const key = INTERTIE_COMPONENTS[String(c.LMPComponent ?? "").trim().toLowerCase()];
      if (!key) continue;
      for (const iv of (c.IntervalLMP as Record<string, unknown>[] | undefined) ?? []) {
        const v = parseNumber(iv.LMP);
        if (v === null) continue;
        vals[key].push(v);
        if (key === "lmp") {
          const n = parseNumber(iv.Interval);
          if (n !== null) ints.add(n);
        }
      }
    }
    rows.push({
      location,
      tsUtc,
      deliveryDate,
      hour,
      intervals: ints.size,
      lmp: round2(avg(vals.lmp)),
      loss: round2(avg(vals.loss)),
      congestion: round2(avg(vals.congestion)),
      externalCongestion: round2(avg(vals.externalCongestion)),
      nisl: round2(avg(vals.nisl)),
    });
  }
  const createdAt = field("CreatedAt");
  return { createdAt: createdAt ? String(createdAt) : null, deliveryDate, hour, rows };
}

/**
 * Ontario's named transmission interfaces (from the IESO TxLimits reports). Constraint names
 * often embed one of these codes, e.g. "S-FETT.TAB6…" or "NWL-KEN.ALL_I/S.KAO-dso".
 */
export const INTERFACES: { code: string; name: string }[] = [
  { code: "NBLIP", name: "Negative Buchanan Longwood Input" },
  { code: "BLIP", name: "Buchanan Longwood Input" },
  { code: "FABCW", name: "Flow Away From Bruce Complex and Wind" },
  { code: "FABC", name: "Flow Away From Bruce Complex" },
  { code: "FETT", name: "Flow East To Toronto" },
  { code: "CLAN", name: "Claireville North" },
  { code: "QFW", name: "Queenston Flow West" },
  { code: "CHIP", name: "Chatham Input" },
  { code: "FIO", name: "Flow Into Ottawa" },
  { code: "FID", name: "Flow Into Dobbin" },
  { code: "EWTE", name: "East-West Transfer East" },
  { code: "EWTW", name: "East-West Transfer West" },
  { code: "WMFE", name: "Wawa MacKay Flow East" },
  { code: "MISSE", name: "Transfer East of Mississagi" },
  { code: "MISSW", name: "Transfer West of Mississagi" },
  { code: "TEK", name: "Transfer East of Kenora" },
  { code: "TEM", name: "Transfer East of Mackenzie" },
  { code: "KAO", name: "Kenora Area Outflow" },
  { code: "DAI", name: "Dryden Area Inflow" },
  { code: "FAI", name: "Fort Frances Area Inflow" },
  { code: "SLW", name: "St. Lawrence West" },
  { code: "FN", name: "Flow North" },
  { code: "FS", name: "Flow South" },
];

/** Area prefixes seen in constraint names. */
const AREAS: [RegExp, string][] = [
  [/^NWL-KEN\b/, "Kenora area"],
  [/^NWL-LKHD\b/, "Lakehead (Thunder Bay) area"],
  [/^NWL?\b/, "Northwest"],
  [/^NE\b/, "Northeast"],
  [/^S-/, "Southern Ontario"],
];

/** Best-effort human hint for a constraint name; null when nothing is recognised. */
export function describeConstraint(name: string): { interfaceCode: string | null; interfaceName: string | null; area: string | null } {
  const body = normaliseConstraintName(name).replace(/^(BASE CASE \d+|[A-Z0-9_]+ \d+)\s+/, "");
  const upper = body.toUpperCase();
  const tokens = upper.split(/[^A-Z0-9]+/);
  const hit = INTERFACES.find((i) => tokens.includes(i.code));
  const area = AREAS.find(([re]) => re.test(upper))?.[1] ?? null;
  return { interfaceCode: hit?.code ?? null, interfaceName: hit?.name ?? null, area };
}
