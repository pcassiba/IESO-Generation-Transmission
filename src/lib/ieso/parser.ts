import { XMLParser } from "fast-xml-parser";
import type { IesoFuel, Observation } from "../types";
import { hourEndingToUtc, parseIesoEst } from "../time";

/**
 * Parser for the IESO "Generators Output and Capability Report"
 * (docID GenOutputCapability, schema GenOutputCapability_r3.xsd).
 *
 * Structure (r3):
 *   IMODocument > IMODocHeader > CreatedAt (EST)
 *   IMODocument > IMODocBody > Date (market day)
 *   IMODocBody > Generators > Generator* {
 *     GeneratorName, FuelType,
 *     Outputs > Output* { Hour, EnergyMW }
 *     Capabilities > Capability* { Hour, EnergyMW }
 *     Capacities > AvailCapacity* { Hour, EnergyMW }
 *   }
 *
 * Semantics (IESO report definitions):
 *   - Output: average MW actually delivered during the hour.
 *   - Capability (non-variable): maximum potential output accounting for derates/outages.
 *   - Capability (WIND / SOLAR): the IESO's *Forecast* (accounts for forecast fuel).
 *   - AvailCapacity: maximum output less outages/derates. For wind/solar this ignores
 *     fuel availability (i.e. hardware availability).
 *
 * The parser is defensive: namespace prefixes are stripped, single elements are
 * normalised to arrays, alternative element names (Forecasts/Forecast, Capacity) are
 * accepted, and non-numeric / implausible values become null with a warning rather
 * than being guessed.
 */

export interface ParsedReport {
  docId: string | null;
  docTitle: string | null;
  createdAtEst: string | null;
  createdAtUtc: string | null;
  reportDate: string;
  resourceCount: number;
  maxHour: number | null;
  observations: Observation[];
  resources: { name: string; fuel: IesoFuel }[];
  warnings: string[];
  duplicateResources: string[];
}

export class ReportParseError extends Error {}

const VARIABLE_FUELS = new Set(["WIND", "SOLAR"]);
/** Larger than any single Ontario resource (Bruce units are ~830–880 MW). */
const MAX_PLAUSIBLE_MW = 2000;

const ARRAY_TAGS = new Set([
  "Generator",
  "Output",
  "Capability",
  "AvailCapacity",
  "Capacity",
  "Forecast",
]);

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type HourVal = { Hour?: unknown; EnergyMW?: unknown };

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    return t === undefined ? null : String(t).trim();
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function parseNumber(v: unknown): number | null {
  const s = text(v);
  if (s === null) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function collectHourly(
  entries: HourVal[],
  label: string,
  resource: string,
  warnings: string[],
  allowNegative: boolean,
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const e of entries) {
    const hour = parseNumber(e?.Hour);
    if (hour === null || !Number.isInteger(hour) || hour < 1 || hour > 24) {
      warnings.push(`${resource}: ${label} entry with invalid hour "${text(e?.Hour)}" skipped`);
      continue;
    }
    const raw = text(e?.EnergyMW);
    let val = parseNumber(e?.EnergyMW);
    if (raw !== null && val === null) {
      warnings.push(`${resource}: ${label} HE${hour} non-numeric value "${raw}" treated as missing`);
    }
    if (val !== null && Math.abs(val) > MAX_PLAUSIBLE_MW) {
      warnings.push(`${resource}: ${label} HE${hour} implausible value ${val} MW treated as missing`);
      val = null;
    }
    if (val !== null && val < 0 && !allowNegative) {
      warnings.push(`${resource}: ${label} HE${hour} negative value ${val} MW treated as missing`);
      val = null;
    }
    if (out.has(hour)) {
      warnings.push(`${resource}: duplicate ${label} for HE${hour}; last value kept`);
    }
    out.set(hour, val);
  }
  return out;
}

export function parseGenOutputCapability(xml: string): ParsedReport {
  if (!xml || typeof xml !== "string") throw new ReportParseError("Empty report body");
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new ReportParseError(`XML parse failure: ${(e as Error).message}`);
  }
  const root = (doc.IMODocument ?? doc.Document) as Record<string, unknown> | undefined;
  if (!root) throw new ReportParseError("Missing IMODocument root element");

  const header = (root.IMODocHeader ?? {}) as Record<string, unknown>;
  const body = root.IMODocBody as Record<string, unknown> | undefined;
  if (!body) throw new ReportParseError("Missing IMODocBody element");

  const reportDate = text(body.Date);
  if (!reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new ReportParseError(`Missing or invalid report <Date>: ${reportDate}`);
  }

  const warnings: string[] = [];
  const generatorsNode = body.Generators as Record<string, unknown> | undefined;
  const generators = toArray(generatorsNode?.Generator as Record<string, unknown>[] | undefined);
  if (generators.length === 0) throw new ReportParseError("Report contains no <Generator> elements");

  const observations: Observation[] = [];
  const resources: { name: string; fuel: IesoFuel }[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let maxHour: number | null = null;

  for (const g of generators) {
    const name = text(g.GeneratorName);
    if (!name) {
      warnings.push("Generator without <GeneratorName> skipped");
      continue;
    }
    if (seen.has(name)) {
      duplicates.push(name);
      warnings.push(`Duplicate resource "${name}" in report; later entry ignored`);
      continue;
    }
    seen.add(name);
    const fuel = (text(g.FuelType) ?? "UNKNOWN").toUpperCase();
    if (!text(g.FuelType)) warnings.push(`${name}: missing <FuelType>`);
    resources.push({ name, fuel });

    const isVariable = VARIABLE_FUELS.has(fuel);
    const allowNegative = fuel === "OTHER"; // storage may report withdrawals as negative

    const outputs = collectHourly(
      toArray((g.Outputs as Record<string, unknown> | undefined)?.Output as HourVal[]),
      "Output",
      name,
      warnings,
      allowNegative,
    );
    const capabilities = collectHourly(
      toArray((g.Capabilities as Record<string, unknown> | undefined)?.Capability as HourVal[]),
      "Capability",
      name,
      warnings,
      false,
    );
    const capNode = g.Capacities as Record<string, unknown> | undefined;
    const availCaps = collectHourly(
      [...toArray(capNode?.AvailCapacity as HourVal[]), ...toArray(capNode?.Capacity as HourVal[])],
      "AvailCapacity",
      name,
      warnings,
      false,
    );
    // Some historical schema revisions published forecasts as a separate element.
    const forecasts = collectHourly(
      toArray((g.Forecasts as Record<string, unknown> | undefined)?.Forecast as HourVal[]),
      "Forecast",
      name,
      warnings,
      false,
    );

    const hours = new Set<number>([...outputs.keys(), ...capabilities.keys(), ...availCaps.keys(), ...forecasts.keys()]);
    for (const hour of [...hours].sort((a, b) => a - b)) {
      const output = outputs.has(hour) ? outputs.get(hour)! : null;
      const cap = capabilities.has(hour) ? capabilities.get(hour)! : null;
      const fc = forecasts.has(hour) ? forecasts.get(hour)! : null;
      const avail = availCaps.has(hour) ? availCaps.get(hour)! : null;
      if (output === null && cap === null && avail === null && fc === null) continue;
      if (output !== null && (maxHour === null || hour > maxHour)) maxHour = hour;
      observations.push({
        iesoName: name,
        tsUtc: hourEndingToUtc(reportDate, hour),
        reportDate,
        hour,
        outputMW: output,
        capabilityMW: isVariable ? null : cap,
        forecastMW: isVariable ? (cap ?? fc) : fc,
        availCapacityMW: avail,
        iesoFuel: fuel,
      });
    }
  }

  const createdAtEst = text(header.CreatedAt);
  return {
    docId: null,
    docTitle: text(header.DocTitle),
    createdAtEst,
    createdAtUtc: parseIesoEst(createdAtEst),
    reportDate,
    resourceCount: resources.length,
    maxHour,
    observations,
    resources,
    warnings,
    duplicateResources: duplicates,
  };
}
