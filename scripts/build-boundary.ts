/**
 * Builds public/geo/ontario.geojson from Natural Earth 1:10m admin-1 boundaries
 * (public domain). Run once: `npm run build:boundary`.
 */
import fs from "node:fs";
import path from "node:path";

const URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";

async function main() {
  console.log("Downloading Natural Earth admin-1 (10m)…");
  const res = await fetch(URL, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const gj = (await res.json()) as { features: { properties: Record<string, unknown>; geometry: unknown }[] };
  const on = gj.features.find((f) => f.properties.iso_3166_2 === "CA-ON");
  if (!on) throw new Error("Ontario feature not found");
  const round = (c: unknown): unknown => (Array.isArray(c) ? (typeof c[0] === "number" ? [+(+c[0]).toFixed(4), +(+c[1]).toFixed(4)] : c.map(round)) : c);
  const geom = on.geometry as { type: string; coordinates: unknown };
  const out = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Ontario", source: "Natural Earth 1:10m admin-1 (public domain)" },
        geometry: { type: geom.type, coordinates: round(geom.coordinates) },
      },
    ],
  };
  const dir = path.join(process.cwd(), "public", "geo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ontario.geojson"), JSON.stringify(out));
  console.log("Wrote public/geo/ontario.geojson");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
