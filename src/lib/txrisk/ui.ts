import type { RiskCategory, TxRiskItem } from "./types";

/** Client-side helpers for the outages & congestion risk layer (no Node imports). */

export const RISK_COLOR: Record<RiskCategory, string> = {
  outage: "#ff1f4b",
  restriction: "#ff8c1a",
  potential: "#facc15",
  binding: "#e879f9",
  future: "#a78bfa",
  info: "#94a3b8",
};

export const LEGEND: { cat: RiskCategory | "normal"; label: string; hint: string }[] = [
  { cat: "outage", label: "Equipment outage", hint: "IESO: out of service now (flashing)" },
  { cat: "restriction", label: "Published transmission restriction", hint: "Outage-related interface limit (pulsing)" },
  { cat: "potential", label: "Potential congestion", hint: "Evidence score, not a probability" },
  { cat: "future", label: "Future scheduled outage / restriction", hint: "Not confirmed congestion" },
  { cat: "binding", label: "Confirmed binding constraint", hint: "IESO shadow price ≠ 0 in that hour" },
  { cat: "normal", label: "Normal operation", hint: "Voltage colours, no overlay" },
];

/** Draw order: later wins when an asset belongs to several items. */
export const DRAW_PRIORITY: RiskCategory[] = ["info", "future", "restriction", "potential", "outage", "binding"];

export type HorizonPreset = "current" | "24h" | "48h" | "7d" | "14d" | "34d" | "custom";
export const HORIZONS: { key: HorizonPreset; label: string; hours: number }[] = [
  { key: "current", label: "Current", hours: 0 },
  { key: "24h", label: "Next 24 h", hours: 24 },
  { key: "48h", label: "Next 48 h", hours: 48 },
  { key: "7d", label: "Next 7 days", hours: 7 * 24 },
  { key: "14d", label: "Next 14 days", hours: 14 * 24 },
  { key: "34d", label: "Next 34 days", hours: 34 * 24 },
  { key: "custom", label: "Custom", hours: 0 },
];

/** Which IESO limits report covers a time offset from now (the 0–2 day report covers today + 2). */
export function reportForOffsetHours(h: number): "Days 0–2 limits + today's outages" | "Days 3–34 limits" {
  return h < 72 ? "Days 0–2 limits + today's outages" : "Days 3–34 limits";
}

/** Items drawn on the map at the selected time. */
export function drawableItems(items: TxRiskItem[]): TxRiskItem[] {
  return items
    .filter((i) => i.category !== "info" && (i.lineIds.length || i.stationIds.length))
    .sort((a, b) => DRAW_PRIORITY.indexOf(a.category) - DRAW_PRIORITY.indexOf(b.category));
}

export interface OverlayOptions {
  enabled: boolean;
  flashing: boolean;
  reducedMotion: boolean;
}

/** Animation actually used for an item: none when the layer is off, flashing is off, or reduced motion is requested. */
export function effectiveAnimation(item: Pick<TxRiskItem, "animate">, o: OverlayOptions): "flash" | "pulse" | null {
  if (!o.enabled || !o.flashing || o.reducedMotion) return null;
  return item.animate;
}

type LineGeom = { type: "LineString"; coordinates: [number, number][] } | { type: "MultiLineString"; coordinates: [number, number][][] };

/** GeoJSON for the overlay layers. Line geometry is copied from the map's own lines, never created. */
export function overlayFeatures(items: TxRiskItem[], lineGeom: Map<number, LineGeom>, stationGeom: Map<number, [number, number]>, o: OverlayOptions) {
  const lines: GeoJSON.Feature[] = [];
  const stations: GeoJSON.Feature[] = [];
  if (!o.enabled) return { lines: { type: "FeatureCollection" as const, features: lines }, stations: { type: "FeatureCollection" as const, features: stations } };
  for (const it of drawableItems(items)) {
    const props = { itemId: it.id, cat: it.category, color: RISK_COLOR[it.category], anim: effectiveAnimation(it, o) ?? "none", approx: it.match === "circuit-section" ? 1 : 0, title: it.title };
    for (const id of it.lineIds) {
      const g = lineGeom.get(id);
      if (g) lines.push({ type: "Feature", geometry: g, properties: { ...props, osmId: id } });
    }
    for (const id of it.stationIds) {
      const c = stationGeom.get(id);
      if (c) stations.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { ...props, osmId: id } });
    }
  }
  return { lines: { type: "FeatureCollection" as const, features: lines }, stations: { type: "FeatureCollection" as const, features: stations } };
}

/** Opacity for animated halos at time ms: red flashes (sharp on/off), orange pulses (smooth). */
export function animOpacity(kind: "flash" | "pulse", ms: number): number {
  if (kind === "flash") return (ms % 1400) < 800 ? 0.85 : 0.2;
  return 0.35 + 0.35 * (0.5 + 0.5 * Math.sin((ms / 2600) * 2 * Math.PI));
}

export interface TableFilters {
  query: string;
  kinds: Set<"activeOutages" | "forced" | "planned" | "restrictions" | "potential" | "binding">;
  voltage: "all" | "500" | "230" | "115" | "other";
  region: string;
  includeInactive: boolean;
}

export const defaultTableFilters = (): TableFilters => ({ query: "", kinds: new Set(), voltage: "all", region: "all", includeInactive: false });

export function matchesFilters(i: TxRiskItem, f: TableFilters): boolean {
  if (!f.includeInactive && i.category === "info") return false;
  if (f.kinds.size) {
    const pr = (i.priority ?? "").toUpperCase();
    const hit =
      (f.kinds.has("activeOutages") && i.kind === "outage" && i.activeAtT && (i.category === "outage" || i.category === "future")) ||
      (f.kinds.has("forced") && i.kind === "outage" && (pr === "F" || pr === "FE")) ||
      (f.kinds.has("planned") && i.kind === "outage" && ["P", "O", "U"].includes(pr)) ||
      (f.kinds.has("restrictions") && i.kind === "limit" && (i.category === "restriction" || i.category === "future")) ||
      (f.kinds.has("potential") && i.category === "potential") ||
      (f.kinds.has("binding") && i.category === "binding");
    if (!hit) return false;
  }
  if (f.voltage !== "all") {
    const kv = i.voltageKv;
    const cls = kv === null ? "other" : kv >= 345 ? "500" : kv >= 150 ? "230" : kv >= 100 ? "115" : "other";
    if (cls !== f.voltage) return false;
  }
  if (f.region !== "all" && (i.region ?? "Unknown") !== f.region) return false;
  if (f.query) {
    const q = f.query.toLowerCase();
    const hay = [i.title, i.subtitle, i.outageId, i.interfaceName, i.comments, i.region, ...(i.equipment ?? []).map((e) => e.name)].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export type SortKey = "title" | "region" | "voltage" | "status" | "limit" | "reduction" | "category" | "start" | "end";

const CAT_RANK: Record<RiskCategory, number> = { binding: 0, outage: 1, potential: 2, restriction: 3, future: 4, info: 5 };

export function sortItems(items: TxRiskItem[], key: SortKey, dir: 1 | -1): TxRiskItem[] {
  const val = (i: TxRiskItem): string | number => {
    switch (key) {
      case "title":
        return i.title.toLowerCase();
      case "region":
        return i.region ?? "~";
      case "voltage":
        return i.voltageKv ?? -1;
      case "status":
        return i.statusText;
      case "limit":
        return i.operatingLimitMW ?? -1;
      case "reduction":
        return i.reductionMW ? i.reductionMW[1] : -1;
      case "category":
        return CAT_RANK[i.category];
      case "start":
        return i.startUtc ?? "";
      case "end":
        return i.endUtc ?? "";
    }
  };
  return [...items].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || CAT_RANK[a.category] - CAT_RANK[b.category];
  });
}

/** "2026-10-17T14:30" entered as Toronto wall-clock time → UTC ISO (handles EDT/EST). */
export function torontoLocalToUtc(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Offset of Toronto at that instant (iterate once to settle across a DST change).
  let guess = asUtc;
  for (let k = 0; k < 2; k++) guess = asUtc - torontoOffsetMs(guess);
  return new Date(guess).toISOString();
}

function torontoOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs));
  const p = (t: string) => Number(parts.find((x) => x.type === t)!.value);
  return Date.UTC(p("year"), p("month") - 1, p("day"), p("hour"), p("minute")) - Math.floor(utcMs / 60_000) * 60_000;
}

/** UTC ISO → "YYYY-MM-DDTHH:mm" in Toronto time (for datetime-local inputs). */
export function utcToTorontoLocal(iso: string): string {
  const ms = Date.parse(iso);
  return new Date(ms + torontoOffsetMs(ms)).toISOString().slice(0, 16);
}
