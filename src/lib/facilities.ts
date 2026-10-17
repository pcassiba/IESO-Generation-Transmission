import fs from "node:fs";
import path from "node:path";
import type { FacilityMeta, GeocodeConfidence, Technology } from "./types";
import { TECHNOLOGIES } from "./types";
import type { Db } from "./db";

/**
 * Facility metadata is curated in reviewable JSON files under data/facilities/*.json
 * (one array of FacilityMeta per file). Those files are the single source of truth for
 * the facility ↔ IESO-resource mapping; on startup they are validated and upserted into
 * the database.
 */

export interface MetadataIssue {
  level: "error" | "warning";
  facilityId?: string;
  message: string;
}

const ONTARIO_BBOX = { minLat: 41.6, maxLat: 57.0, minLon: -95.2, maxLon: -74.3 };
const CONFIDENCE: GeocodeConfidence[] = ["high", "medium", "low", "unverified"];

export function facilitiesDir(): string {
  return process.env.FACILITIES_DIR ?? path.join(process.cwd(), "data", "facilities");
}

export function loadFacilityFiles(dir = facilitiesDir()): FacilityMeta[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const all: FacilityMeta[] = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!Array.isArray(raw)) throw new Error(`${f}: expected a JSON array of facilities`);
    for (const r of raw) all.push(normaliseFacility(r));
  }
  return all;
}

export function normaliseFacility(r: Record<string, unknown>): FacilityMeta {
  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    id: String(r.id),
    name: String(r.name),
    technology: String(r.technology) as Technology,
    subtype: (r.subtype as string) ?? null,
    operator: (r.operator as string) ?? null,
    owner: (r.owner as string) ?? null,
    municipality: (r.municipality as string) ?? null,
    region: (r.region as string) ?? null,
    lat: numOrNull(r.lat),
    lon: numOrNull(r.lon),
    geocodeConfidence: (r.geocodeConfidence as GeocodeConfidence) ?? "unverified",
    geocodeSource: (r.geocodeSource as string) ?? null,
    installedCapacityMW: numOrNull(r.installedCapacityMW),
    capacitySource: (r.capacitySource as string) ?? null,
    commissioningYear: numOrNull(r.commissioningYear),
    sourceUrls: Array.isArray(r.sourceUrls) ? (r.sourceUrls as string[]) : [],
    resources: Array.isArray(r.resources)
      ? (r.resources as { ieso: string; units?: string }[]).map((x) => ({ ieso: String(x.ieso), units: x.units ?? undefined }))
      : [],
    notes: (r.notes as string) ?? null,
    reviewFlag: Boolean(r.reviewFlag),
  };
}

/** Validate metadata. Errors indicate data that must not be used as-is. */
export function validateFacilities(list: FacilityMeta[]): { issues: MetadataIssue[]; duplicateResources: string[] } {
  const issues: MetadataIssue[] = [];
  const ids = new Set<string>();
  const resOwner = new Map<string, string>();
  const duplicateResources: string[] = [];
  const nameKeys = new Map<string, string>();

  for (const f of list) {
    if (!f.id || ids.has(f.id)) issues.push({ level: "error", facilityId: f.id, message: `Duplicate or empty facility id "${f.id}"` });
    ids.add(f.id);
    if (!TECHNOLOGIES.includes(f.technology)) issues.push({ level: "error", facilityId: f.id, message: `Unknown technology "${f.technology}"` });
    if (!CONFIDENCE.includes(f.geocodeConfidence)) issues.push({ level: "warning", facilityId: f.id, message: `Unknown geocode confidence "${f.geocodeConfidence}"` });
    const key = f.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (nameKeys.has(key)) issues.push({ level: "warning", facilityId: f.id, message: `Facility name duplicates "${nameKeys.get(key)}" — not merged; review.` });
    nameKeys.set(key, f.id);

    const hasCoords = f.lat !== null && f.lon !== null;
    if (hasCoords) {
      const inBox = f.lat! >= ONTARIO_BBOX.minLat && f.lat! <= ONTARIO_BBOX.maxLat && f.lon! >= ONTARIO_BBOX.minLon && f.lon! <= ONTARIO_BBOX.maxLon;
      if (!inBox) issues.push({ level: "error", facilityId: f.id, message: `Coordinates ${f.lat},${f.lon} outside Ontario bounds` });
    }
    if (!hasCoords && f.geocodeConfidence !== "unverified") {
      issues.push({ level: "warning", facilityId: f.id, message: "Missing coordinates but confidence is not 'unverified'" });
    }
    if (f.resources.length === 0) issues.push({ level: "warning", facilityId: f.id, message: "Facility has no IESO resources mapped" });
    for (const r of f.resources) {
      if (resOwner.has(r.ieso)) {
        duplicateResources.push(r.ieso);
        issues.push({ level: "error", facilityId: f.id, message: `IESO resource "${r.ieso}" also mapped to "${resOwner.get(r.ieso)}"` });
      } else resOwner.set(r.ieso, f.id);
    }
  }
  return { issues, duplicateResources };
}

/** Upsert validated metadata into the DB (removing facilities/mappings no longer in the files). */
export async function seedFacilities(db: Db, list: FacilityMeta[]): Promise<{ facilities: number; resources: number }> {
  const { duplicateResources } = validateFacilities(list);
  const dupSet = new Set(duplicateResources);
  await db.transaction(async (tx) => {
    await tx.exec("DELETE FROM resource_map");
    const ids = list.map((f) => f.id);
    if (ids.length) await tx.query(`DELETE FROM facilities WHERE NOT (id = ANY($1::text[]))`, [ids]);
    else await tx.exec("DELETE FROM facilities");
    for (const f of list) {
      await tx.query(
        `INSERT INTO facilities (id,name,technology,subtype,operator,owner,municipality,region,lat,lon,geocode_confidence,geocode_source,
           installed_capacity_mw,capacity_source,commissioning_year,source_urls,notes,review_flag,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, technology=EXCLUDED.technology, subtype=EXCLUDED.subtype,
           operator=EXCLUDED.operator, owner=EXCLUDED.owner, municipality=EXCLUDED.municipality, region=EXCLUDED.region,
           lat=EXCLUDED.lat, lon=EXCLUDED.lon, geocode_confidence=EXCLUDED.geocode_confidence, geocode_source=EXCLUDED.geocode_source,
           installed_capacity_mw=EXCLUDED.installed_capacity_mw, capacity_source=EXCLUDED.capacity_source,
           commissioning_year=EXCLUDED.commissioning_year, source_urls=EXCLUDED.source_urls, notes=EXCLUDED.notes,
           review_flag=EXCLUDED.review_flag, updated_at=now()`,
        [
          f.id, f.name, f.technology, f.subtype, f.operator, f.owner, f.municipality, f.region, f.lat, f.lon,
          f.geocodeConfidence, f.geocodeSource, f.installedCapacityMW, f.capacitySource, f.commissioningYear,
          JSON.stringify(f.sourceUrls), f.notes, Boolean(f.reviewFlag),
        ],
      );
      for (const r of f.resources) {
        // Never silently assign a resource to two facilities: first mapping wins, duplicates are reported.
        if (dupSet.has(r.ieso)) {
          const first = list.find((x) => x.resources.some((y) => y.ieso === r.ieso));
          if (first && first.id !== f.id) continue;
        }
        await tx.query(
          `INSERT INTO resource_map (ieso_name, facility_id, units) VALUES ($1,$2,$3) ON CONFLICT (ieso_name) DO NOTHING`,
          [r.ieso, f.id, r.units ?? null],
        );
      }
    }
  });
  const res = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM resource_map");
  return { facilities: list.length, resources: res[0]?.n ?? 0 };
}

interface FacilityRow {
  id: string;
  name: string;
  technology: Technology;
  subtype: string | null;
  operator: string | null;
  owner: string | null;
  municipality: string | null;
  region: string | null;
  lat: number | null;
  lon: number | null;
  geocode_confidence: GeocodeConfidence;
  geocode_source: string | null;
  installed_capacity_mw: number | null;
  capacity_source: string | null;
  commissioning_year: number | null;
  source_urls: string[] | string;
  notes: string | null;
  review_flag: boolean;
}

export async function readFacilitiesFromDb(db: Db): Promise<FacilityMeta[]> {
  const rows = await db.query<FacilityRow>("SELECT * FROM facilities ORDER BY name");
  const maps = await db.query<{ ieso_name: string; facility_id: string; units: string | null }>(
    "SELECT ieso_name, facility_id, units FROM resource_map ORDER BY ieso_name",
  );
  const byFac = new Map<string, { ieso: string; units?: string }[]>();
  for (const m of maps) {
    const arr = byFac.get(m.facility_id) ?? [];
    arr.push({ ieso: m.ieso_name, units: m.units ?? undefined });
    byFac.set(m.facility_id, arr);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    technology: r.technology,
    subtype: r.subtype,
    operator: r.operator,
    owner: r.owner,
    municipality: r.municipality,
    region: r.region,
    lat: r.lat,
    lon: r.lon,
    geocodeConfidence: r.geocode_confidence,
    geocodeSource: r.geocode_source,
    installedCapacityMW: r.installed_capacity_mw,
    capacitySource: r.capacity_source,
    commissioningYear: r.commissioning_year,
    sourceUrls: typeof r.source_urls === "string" ? JSON.parse(r.source_urls) : r.source_urls,
    resources: byFac.get(r.id) ?? [],
    notes: r.notes,
    reviewFlag: r.review_flag,
  }));
}
