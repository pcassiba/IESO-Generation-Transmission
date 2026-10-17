/**
 * Builds public/geo/transmission.geojson (lines) and public/geo/substations.geojson from
 * OpenStreetMap via the Overpass API. Run once, and again whenever you want fresher lines:
 *
 *   npm run build:transmission            → lines ≥ 100 kV plus lines with no voltage tag
 *   npm run build:transmission -- --all   → also include lines below 100 kV (much larger file)
 *
 * Data © OpenStreetMap contributors, ODbL. Every feature keeps its OSM way/node id.
 */
import fs from "node:fs";
import path from "node:path";
import { classifyKv, lineProps, parseVoltageKv } from "../src/lib/transmission";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const AREA = `area["ISO3166-2"="CA-ON"][admin_level=4]->.on;`;
const LINES_QUERY = `[out:json][timeout:600];${AREA}way["power"~"^(line|cable)$"](area.on);out tags geom;`;
const SUBS_QUERY = `[out:json][timeout:300];${AREA}(node["power"="substation"](area.on);way["power"="substation"](area.on););out tags center;`;

/** Douglas–Peucker tolerance in degrees (~15 m). Keeps files small without visible change. */
const TOLERANCE = 0.00015;

interface OverpassEl {
  type: "node" | "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}

async function overpass(query: string): Promise<OverpassEl[]> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      console.log(`Querying ${url}…`);
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        headers: { "User-Agent": "OntarioGenerationExplorer/1.0 (+local)" },
        signal: AbortSignal.timeout(900_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { elements: OverpassEl[] }).elements;
    } catch (e) {
      lastErr = e;
      console.warn(`  failed: ${(e as Error).message}`);
    }
  }
  throw lastErr;
}

type Pt = [number, number];

export function simplify(pts: Pt[], tol = TOLERANCE): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [x1, y1] = pts[a];
    const [x2, y2] = pts[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

async function main() {
  const includeAll = process.argv.includes("--all");
  const dir = path.join(process.cwd(), "public", "geo");
  fs.mkdirSync(dir, { recursive: true });

  const ways = await overpass(LINES_QUERY);
  const counts: Record<string, number> = {};
  const features = [];
  for (const w of ways) {
    if (w.type !== "way" || !w.geometry || w.geometry.length < 2) continue;
    const props = lineProps(w.id, w.tags ?? {});
    if (props.vclass === "sub" && !includeAll) continue;
    const coords = simplify(w.geometry.map((g) => [r5(g.lon), r5(g.lat)] as Pt));
    counts[props.vclass] = (counts[props.vclass] ?? 0) + 1;
    features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
  }
  const lines = {
    type: "FeatureCollection",
    properties: { source: "OpenStreetMap contributors (ODbL), via Overpass API", builtAt: new Date().toISOString() },
    features,
  };
  fs.writeFileSync(path.join(dir, "transmission.geojson"), JSON.stringify(lines));
  console.log(`Wrote public/geo/transmission.geojson: ${features.length} lines`, counts);

  const subsRaw = await overpass(SUBS_QUERY);
  const subs = [];
  for (const s of subsRaw) {
    const lat = s.lat ?? s.center?.lat;
    const lon = s.lon ?? s.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const kvs = parseVoltageKv(s.tags?.voltage);
    if ((kvs[0] ?? 0) < 100) continue;
    subs.push({
      type: "Feature",
      properties: { osmId: s.id, osmType: s.type, name: s.tags?.name ?? null, operator: s.tags?.operator ?? null, kv: kvs[0], vclass: classifyKv(kvs[0]), voltages: kvs.map((k) => `${k} kV`).join(" / ") },
      geometry: { type: "Point", coordinates: [r5(lon), r5(lat)] },
    });
  }
  fs.writeFileSync(path.join(dir, "substations.geojson"), JSON.stringify({ type: "FeatureCollection", features: subs }));
  console.log(`Wrote public/geo/substations.geojson: ${subs.length} substations ≥ 100 kV`);
}

if (process.argv[1]?.includes("build-transmission")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
