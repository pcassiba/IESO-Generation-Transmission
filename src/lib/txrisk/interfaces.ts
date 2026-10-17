import fs from "node:fs";
import path from "node:path";
import type { LimitRecord } from "./types";

/**
 * Interface identity and all-in-service baselines.
 *
 * TxLimits names look like "Kenora Area Outflow [KAO]", "Ontario-New York Import" (outage
 * reports) and "Ontario-New York Import Summer" / "… Winter or Summer" (all-in-service report).
 * Two records are compared only when they name the same interface: the same bracketed code, or
 * the same name once the season suffix is removed. Nothing is compared across differently named
 * interfaces (e.g. "Ontario-Manitoba Import" vs "Ontario-Manitoba Transfer West [OMTW]").
 */

export interface InterfaceDef {
  code: string;
  names: string[];
  zones?: string;
  stations: string[];
  circuits: string[];
  basis: string;
}

export function loadInterfaces(file = path.join(process.cwd(), "data", "transmission", "interfaces.json")): InterfaceDef[] {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")).interfaces ?? []) as InterfaceDef[];
  } catch {
    return [];
  }
}

const SEASON = /\s+(winter or summer|summer or winter|winter|summer)\s*$/i;

/** Bracketed code, upper case: "Kenora Area Outflow [KAO]" → "KAO". */
export const bracketCode = (name: string) => /\[([^\]]+)\]/.exec(name)?.[1].trim().toUpperCase() ?? null;

export const seasonOf = (name: string): "winter" | "summer" | "both" | null => {
  const m = SEASON.exec(name.trim());
  if (!m) return null;
  const s = m[1].toLowerCase();
  return s.includes(" or ") ? "both" : (s as "winter" | "summer");
};

const plain = (s: string) => s.toUpperCase().replace(/\[[^\]]*\]/g, "").replace(/[^A-Z0-9]+/g, " ").trim();

/** Key identifying an interface across reports. */
export function interfaceKey(name: string): string {
  const code = bracketCode(name);
  if (code) return `[${code}]`;
  return plain(name.replace(SEASON, ""));
}

export function findInterface(defs: InterfaceDef[], name: string): InterfaceDef | null {
  const code = bracketCode(name);
  if (code) {
    const hit = defs.find((d) => d.code.toUpperCase() === code);
    if (hit) return hit;
  }
  const p = plain(name.replace(SEASON, ""));
  return defs.find((d) => d.names.some((n) => plain(n) === p)) ?? null;
}

export interface Baseline {
  values: number[];
  records: LimitRecord[];
  note: string;
}

/**
 * All-in-service limits comparable with `rec` at instant t. When IESO lists separate summer and
 * winter values (and the report does not say which season applies), both are returned and the
 * reduction is shown as a range rather than picking a season.
 */
export function findBaseline(rec: LimitRecord, allInService: LimitRecord[], t: number): Baseline | null {
  const key = interfaceKey(rec.interfaceName);
  const cands = allInService.filter(
    (b) =>
      interfaceKey(b.interfaceName) === key &&
      (b.facilityType ?? "") === (rec.facilityType ?? "") &&
      b.operatingLimitMW !== null &&
      (!b.startUtc || Date.parse(b.startUtc) <= t) &&
      (!b.endUtc || t < Date.parse(b.endUtc)),
  );
  if (!cands.length) return null;
  const values = [...new Set(cands.map((c) => c.operatingLimitMW!))].sort((a, b) => a - b);
  const seasons = [...new Set(cands.map((c) => seasonOf(c.interfaceName)).filter(Boolean))];
  let note: string;
  if (values.length === 1) note = `All-in-service limit ${values[0]} MW ("${cands[0].interfaceName}"${cands[0].comments ? `, ${cands[0].comments}` : ""})`;
  else if (seasons.includes("summer") && seasons.includes("winter"))
    note = `IESO lists separate all-in-service limits (${cands.map((c) => `${c.interfaceName.replace(/.*\s(\S+)$/, "$1")} ${c.operatingLimitMW} MW`).join(", ")}); the report does not say which season applies, so the reduction is a range`;
  else note = `IESO lists ${values.length} all-in-service limits for this interface (${values.join(" / ")} MW); the reduction is a range`;
  return { values, records: cands, note };
}

export function reduction(limit: number | null, base: Baseline | null): { mw: [number, number]; pct: [number, number] } | null {
  if (limit === null || !base || !base.values.length) return null;
  const mws = base.values.map((v) => v - limit);
  const pcts = base.values.map((v) => (v > 0 ? ((v - limit) / v) * 100 : 0));
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { mw: [Math.min(...mws), Math.max(...mws)], pct: [r1(Math.min(...pcts)), r1(Math.max(...pcts))] };
}
