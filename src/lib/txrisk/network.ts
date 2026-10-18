import fs from "node:fs";
import path from "node:path";
import type { MatchLevel } from "./types";

/**
 * Matching IESO equipment names to the map's network (OpenStreetMap lines and substations in
 * public/geo, built by `npm run build:transmission`).
 *
 * IESO equipment naming seen in TxOutagesTodayAll:
 *   Line          "C20R: CHERRYWOOD TS x RICHVIEW TS"    circuit C20R between two stations
 *   LineSection   "K21W.WHXKE", "M30A.AJXEJ"              circuit + section code (two-letter station codes)
 *   station kit   "NANTICOKE TS T13", "BOWMANVILLE SS H2_BUS", "FORT FRANCES TS SC1.2"
 *
 * OSM tags circuits in `ref` ("B560V", "K-21-W", "A41T;A42T" for double-circuit towers).
 * Matching order, strongest first:
 *   1. circuit id == OSM ref (after normalisation)                → "circuit"
 *   2. line section → the whole circuit's OSM ways, flagged approximate → "circuit-section"
 *   3. station name == OSM substation name (normalised, or via data/transmission/station-aliases.json) → "station"
 * Nothing else is drawn. The section codes (WH, KE …) are not decoded, because IESO does not
 * publish the code list.
 */

export interface NetLine {
  osmId: number;
  refs: string[];
  kv: number | null;
  bbox: [number, number, number, number];
  /** Up to ~20 vertices, for distance checks. */
  pts: [number, number][];
}

export interface NetStation {
  osmId: number;
  name: string;
  key: string;
  core: string;
  kv: number | null;
  lon: number;
  lat: number;
}

export interface NetworkIndex {
  loaded: boolean;
  lines: Map<number, NetLine>;
  byCircuit: Map<string, number[]>;
  stations: Map<number, NetStation>;
  byStationKey: Map<string, number[]>;
  byStationCore: Map<string, number[]>;
  aliases: Record<string, string>;
}

/** "K-21-W" → "K21W", "b560v" → "B560V". */
export const normCircuit = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

const TYPE_WORDS: [RegExp, string][] = [
  [/\bTRANSFORMER STATION\b|\bTRANSMISSION STATION\b|\bTRANSFER STATION\b/g, "TS"],
  [/\bSWITCHING STATION\b/g, "SS"],
  [/\bGENERATING STATION\b/g, "GS"],
  [/\bDISTRIBUTION STATION\b/g, "DS"],
  [/\bJUNCTION\b|\bJCT\b/g, "JCT"],
  [/\bSWITCHYARD\b/g, "SS"],
];
const STATION_TYPES = ["TS", "SS", "GS", "CTS", "MTS", "DS", "JCT", "CSS", "CGS", "PGS", "SUBSTATION"];

/** Normalised station key: upper case, type words abbreviated, punctuation removed. */
export function normStation(name: string): string {
  let s = name.toUpperCase().replace(/[.'’,#()]/g, " ");
  for (const [re, abbr] of TYPE_WORDS) s = s.replace(re, abbr);
  return s.replace(/\bSUBSTATION\b/g, "SUBSTATION").replace(/\s+/g, " ").trim();
}

/** Station name without its type word ("CHERRYWOOD TS" → "CHERRYWOOD"). */
export function stationCore(key: string): string {
  return key
    .split(" ")
    .filter((w) => !STATION_TYPES.includes(w))
    .join(" ")
    .trim();
}

export interface ParsedEquipment {
  circuit: string | null;
  section: string | null;
  terminals: string[];
  station: string | null;
  device: string | null;
}

const STATION_RE = new RegExp(`^(.+?\\b(?:${STATION_TYPES.join("|")}))\\b\\s*(.*)$`);

export function parseEquipmentName(name: string, type: string | null): ParsedEquipment {
  const n = name.trim().toUpperCase().replace(/\s+/g, " ");
  const t = (type ?? "").toLowerCase();
  const line = /^([A-Z0-9-]{2,8})\s*:\s*(.+?)\s+X\s+(.+)$/.exec(n);
  if (line) return { circuit: normCircuit(line[1]), section: null, terminals: [line[2].trim(), line[3].trim()], station: null, device: null };
  const sec = /^([A-Z0-9]{2,8})\.([A-Z0-9]+)$/.exec(n);
  if (sec && (t === "linesection" || t === "line" || t === "")) return { circuit: normCircuit(sec[1]), section: sec[2], terminals: [], station: null, device: null };
  if (t === "line" && /^[A-Z0-9]{2,8}$/.test(n)) return { circuit: normCircuit(n), section: null, terminals: [], station: null, device: null };
  const st = STATION_RE.exec(n);
  if (st) return { circuit: null, section: null, terminals: [], station: st[1].trim(), device: st[2].trim() || null };
  return { circuit: null, section: null, terminals: [], station: null, device: null };
}

type LineFeature = { properties: { osmId: number; ref: string | null; kv: number | null }; geometry: { type: string; coordinates: [number, number][] } };
type SubFeature = { properties: { osmId: number; name: string | null; kv: number | null }; geometry: { coordinates: [number, number] } };

export function buildNetworkIndex(lines: { features: LineFeature[] } | null, subs: { features: SubFeature[] } | null, aliases: Record<string, string> = {}): NetworkIndex {
  const idx: NetworkIndex = { loaded: !!lines, lines: new Map(), byCircuit: new Map(), stations: new Map(), byStationKey: new Map(), byStationCore: new Map(), aliases: {} };
  for (const [k, v] of Object.entries(aliases)) if (!k.startsWith("_")) idx.aliases[normStation(k)] = normStation(v);
  for (const f of lines?.features ?? []) {
    const p = f.properties;
    const refs = (p.ref ?? "")
      .split(/[;/,]/)
      .map(normCircuit)
      .filter((r) => /^[A-Z]{1,3}\d{1,4}[A-Z]{0,3}$/.test(r));
    const cs = f.geometry.coordinates;
    let bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of cs) bbox = [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)];
    const step = Math.max(1, Math.ceil(cs.length / 20));
    const pts = cs.filter((_, i) => i % step === 0 || i === cs.length - 1);
    idx.lines.set(p.osmId, { osmId: p.osmId, refs, kv: p.kv, bbox, pts });
    for (const r of refs) idx.byCircuit.set(r, [...(idx.byCircuit.get(r) ?? []), p.osmId]);
  }
  for (const f of subs?.features ?? []) {
    const p = f.properties;
    if (!p.name) continue;
    const key = normStation(p.name);
    const st: NetStation = { osmId: p.osmId, name: p.name, key, core: stationCore(key), kv: p.kv, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    idx.stations.set(p.osmId, st);
    idx.byStationKey.set(key, [...(idx.byStationKey.get(key) ?? []), p.osmId]);
    if (st.core.length >= 3) idx.byStationCore.set(st.core, [...(idx.byStationCore.get(st.core) ?? []), p.osmId]);
  }
  return idx;
}

export function loadNetworkIndex(root = process.cwd()): NetworkIndex {
  const read = (p: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
    } catch {
      return null;
    }
  };
  return buildNetworkIndex(read("public/geo/transmission.geojson"), read("public/geo/substations.geojson"), read("data/transmission/station-aliases.json") ?? {});
}

export function kmBetween(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Find one station. Several OSM features with the same name count as one station only when they
 * sit within 3 km of each other (e.g. a node and a site outline); otherwise the name is ambiguous.
 */
export function findStation(idx: NetworkIndex, ieso: string): { ids: number[]; note: string | null } {
  const key0 = normStation(ieso);
  const key = idx.aliases[key0] ?? key0;
  const viaAlias = key !== key0 ? ` (alias ${key0} → ${key})` : "";
  const check = (ids: number[] | undefined, how: string) => {
    if (!ids?.length) return null;
    const pts = ids.map((i) => idx.stations.get(i)!);
    const spread = Math.max(...pts.map((p) => kmBetween([p.lon, p.lat], [pts[0].lon, pts[0].lat])));
    if (spread > 3) return { ids: [], note: `Station name "${ieso}" matches ${ids.length} map stations ${Math.round(spread)} km apart; not drawn` };
    return { ids: [ids[0]], note: `${how}${viaAlias}` };
  };
  return (
    check(idx.byStationKey.get(key), "Station matched by name") ??
    check(idx.byStationCore.get(stationCore(key)), `Station matched by name only (type differs: "${ieso}" vs "${idx.stations.get(idx.byStationCore.get(stationCore(key))?.[0] ?? -1)?.name}")`) ?? {
      ids: [],
      note: `Station "${ieso}" not found among map substations`,
    }
  );
}

export interface EquipmentMatch {
  match: MatchLevel;
  lineIds: number[];
  stationIds: number[];
  note: string;
  parsed: ParsedEquipment;
}

export function matchEquipment(idx: NetworkIndex, name: string, type: string | null): EquipmentMatch {
  const parsed = parseEquipmentName(name, type);
  if (!idx.loaded) return { match: "none", lineIds: [], stationIds: [], note: "Map line data not built (npm run build:transmission)", parsed };
  if (parsed.circuit) {
    const ids = idx.byCircuit.get(parsed.circuit) ?? [];
    if (ids.length && !parsed.section) return { match: "circuit", lineIds: ids, stationIds: [], note: `Circuit ${parsed.circuit} matched to ${ids.length} OSM line segment(s) by circuit reference`, parsed };
    if (ids.length)
      return {
        match: "circuit-section",
        lineIds: ids,
        stationIds: [],
        note: `Only section ${parsed.section} of circuit ${parsed.circuit} is named. The whole circuit is highlighted (approximate): the exact section is not located`,
        parsed,
      };
    const term = parsed.terminals.map((t) => findStation(idx, t)).flatMap((r) => r.ids);
    const note = `Circuit ${parsed.circuit} has no matching OSM circuit reference${term.length ? "; route not drawn" : ""}`;
    return { match: "none", lineIds: [], stationIds: [], note, parsed };
  }
  if (parsed.station) {
    const st = findStation(idx, parsed.station);
    if (st.ids.length) return { match: "station", lineIds: [], stationIds: st.ids, note: st.note ?? "", parsed };
    return { match: "none", lineIds: [], stationIds: [], note: st.note ?? "", parsed };
  }
  return { match: "none", lineIds: [], stationIds: [], note: `Equipment name "${name}" does not follow a recognised IESO naming pattern`, parsed };
}

const COMMENT_STOP = new Set(["LINE", "BUS", "EAST", "WEST", "NORTH", "SOUTH", "AREA", "FLOW", "LOAD", "IMPORT", "EXPORT", "SERVICE", "THIRD LINE", "HYDRO ONE"]);

/**
 * Equipment named in a TxLimits Comments field ("K21W O/S", "Mackenzie PL30 O/S",
 * "Dobbin A Bus O/S"): circuit ids that exist as OSM refs, and station names that match a
 * map substation. Ids not on the map are returned in `unmatched`.
 */
export function equipmentInComment(idx: NetworkIndex, comment: string | null): { circuits: string[]; lineIds: number[]; stationIds: number[]; unmatched: string[] } {
  const out = { circuits: [] as string[], lineIds: [] as number[], stationIds: [] as number[], unmatched: [] as string[] };
  if (!comment) return out;
  const up = comment.toUpperCase();
  for (const tok of up.match(/\b[A-Z]{1,3}\d{1,4}[A-Z]{0,3}\b/g) ?? []) {
    if (/^(T|SC|SVC|HT|H|L|B)\d{1,2}$/.test(tok) && !idx.byCircuit.has(tok)) {
      out.unmatched.push(tok);
      continue;
    }
    const ids = idx.byCircuit.get(normCircuit(tok));
    if (ids?.length) {
      out.circuits.push(tok);
      out.lineIds.push(...ids);
    } else out.unmatched.push(tok);
  }
  for (const [core, ids] of idx.byStationCore) {
    if (core.length < 5 || COMMENT_STOP.has(core)) continue;
    if (new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(up)) {
      const r = findStation(idx, idx.stations.get(ids[0])!.name);
      out.stationIds.push(...r.ids);
    }
  }
  out.lineIds = [...new Set(out.lineIds)];
  out.stationIds = [...new Set(out.stationIds)];
  return out;
}
