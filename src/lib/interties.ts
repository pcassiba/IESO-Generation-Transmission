import fs from "node:fs";
import path from "node:path";

/**
 * Intertie prices on the map. IESO publishes one real-time LMP per intertie pricing location
 * (RealTimeIntertieLMP). Each location is placed at an approximate Ontario-side tie point from
 * data/transmission/intertie-locations.json; several locations can share a point (the Michigan
 * and New York interfaces also carry linked-wheeling proxies), in which case the first priced
 * one listed is the headline price and the rest appear in the tooltip.
 */

export interface IntertiePointDef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  locations: string[];
  /** The system on the other side of the tie, e.g. "NYISO (New York)". */
  neighbour?: string;
  /** Degrees clockwise from north, from Ontario toward the neighbour. */
  bearing?: number;
}

export interface IntertieLocationsFile {
  points: IntertiePointDef[];
  suffixes: Record<string, string>;
}

export interface IntertieLocationPrice {
  location: string;
  lmp: number | null;
  loss: number | null;
  congestion: number | null;
  externalCongestion: number | null;
  nisl: number | null;
}

export interface IntertiePoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  neighbour: string;
  bearing: number;
  /** Headline price drawn on the map ($/MWh). */
  lmp: number;
  location: string;
  prices: IntertieLocationPrice[];
}

export function intertieLocationsPath(): string {
  return path.join(process.cwd(), "data", "transmission", "intertie-locations.json");
}

export function loadIntertieLocations(file = intertieLocationsPath()): IntertieLocationsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<IntertieLocationsFile>;
    return { points: raw.points ?? [], suffixes: raw.suffixes ?? {} };
  } catch {
    return { points: [], suffixes: {} };
  }
}

/** Point id for a pricing location: listed explicitly, else by its interface suffix ("…_MISI"). */
export function pointFor(location: string, defs: IntertieLocationsFile): string | null {
  const loc = location.toUpperCase();
  const listed = defs.points.find((p) => p.locations.some((l) => l.toUpperCase() === loc));
  if (listed) return listed.id;
  const suffix = /_([A-Z]+)$/.exec(loc)?.[1];
  const id = suffix ? defs.suffixes[suffix] : undefined;
  return id && defs.points.some((p) => p.id === id) ? id : null;
}

/** Group one hour's intertie prices onto map points. Locations with no point are returned separately. */
export function groupIntertiePrices(prices: IntertieLocationPrice[], defs: IntertieLocationsFile): { points: IntertiePoint[]; unplaced: string[] } {
  const byPoint = new Map<string, IntertieLocationPrice[]>();
  const unplaced: string[] = [];
  for (const p of prices) {
    const id = pointFor(p.location, defs);
    if (!id) {
      unplaced.push(p.location);
      continue;
    }
    byPoint.set(id, [...(byPoint.get(id) ?? []), p]);
  }
  const points: IntertiePoint[] = [];
  for (const def of defs.points) {
    const here = byPoint.get(def.id);
    if (!here) continue;
    const order = (l: string) => {
      const i = def.locations.findIndex((x) => x.toUpperCase() === l.toUpperCase());
      return i < 0 ? def.locations.length : i;
    };
    here.sort((a, b) => order(a.location) - order(b.location) || a.location.localeCompare(b.location));
    const head = here.find((p) => p.lmp !== null);
    if (!head) continue;
    points.push({ id: def.id, name: def.name, lat: def.lat, lon: def.lon, neighbour: def.neighbour ?? "", bearing: def.bearing ?? 0, lmp: head.lmp!, location: head.location, prices: here });
  }
  return { points, unplaced: unplaced.sort() };
}
