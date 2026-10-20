import type { FacilityCongestion } from "./congestion";
import type { IntertiePoint } from "./interties";

/**
 * LMP heat view: one real-time price per facility, coloured from white (low) to deep red (high).
 *
 * A facility usually has one pricing location per unit (BRUCEB-LT.G5 … G8). The map shows the
 * plain average of its units' hourly LMPs; the tooltip lists each unit. The colour scale is
 * relative to the hour shown: the 5th percentile of facility prices is white and the 95th is full
 * red, so a single extreme price does not wash out the rest. Prices beyond either end are clamped.
 */

export interface LmpScale {
  low: number;
  high: number;
}

export const LMP_HEAT_STOPS: [number, string][] = [
  [0, "#ffffff"],
  [0.25, "#fee2e2"],
  [0.5, "#fca5a5"],
  [0.75, "#ef4444"],
  [1, "#991b1b"],
];

export const LMP_GRADIENT_CSS = `linear-gradient(90deg, ${LMP_HEAT_STOPS.map(([t, c]) => `${c} ${t * 100}%`).join(", ")})`;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Colour scale for one hour, from the facility prices on the map. Null when there are none. */
export function lmpScale(values: (number | null | undefined)[]): LmpScale | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const low = quantile(v, 0.05);
  let high = quantile(v, 0.95);
  // A flat hour (no spread) would divide by zero; give it a $1 band so everything reads as low.
  if (high - low < 1) high = low + 1;
  return { low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100 };
}

/** 0 (at or below the low end) … 1 (at or above the high end). */
export function lmpHeat(value: number, scale: LmpScale): number {
  const t = (value - scale.low) / (scale.high - scale.low);
  return Math.min(1, Math.max(0, t));
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** White → red colour for a heat value, interpolated between LMP_HEAT_STOPS (or other stops). */
export function heatColor(t: number, stops: [number, string][] = LMP_HEAT_STOPS): string {
  const x = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < x) i++;
  const [t0, c0] = stops[i - 1];
  const [t1, c1] = stops[i];
  const f = (x - t0) / (t1 - t0);
  const a = hex(c0);
  const b = hex(c1);
  return `#${a
    .map((v, k) =>
      Math.round(v + (b[k] - v) * f)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Short label drawn on the map: "$42", "−$8". */
export function formatLmpShort(v: number): string {
  const r = Math.round(Math.abs(v));
  return `${v < 0 && r > 0 ? "−" : ""}$${r.toLocaleString("en-CA")}`;
}

export interface FacilityLmp {
  lmp: number;
  heat: number;
  color: string;
  label: string;
  /** Dark text on pale fills, white text on strong reds. */
  textColor: string;
  detail: FacilityCongestion;
}

/** facility id → what the LMP layer draws. Facilities without a price are left out. */
export function facilityLmps(facilities: FacilityCongestion[], scale: LmpScale | null): Map<string, FacilityLmp> {
  const out = new Map<string, FacilityLmp>();
  if (!scale) return out;
  for (const f of facilities) {
    if (f.lmp === null) continue;
    const heat = lmpHeat(f.lmp, scale);
    out.set(f.facilityId, { lmp: f.lmp, heat, color: heatColor(heat), label: formatLmpShort(f.lmp), textColor: heat > 0.62 ? "#ffffff" : "#111827", detail: f });
  }
  return out;
}

/**
 * Interties are drawn as yellow circles so they never read as a facility. Their intensity uses the
 * same scale as the facility LMPs for that hour: at or below the facilities' 5th percentile the
 * circle is pale, at or above the 95th it is a deep, saturated yellow.
 */
export const INTERTIE_HEAT_STOPS: [number, string][] = [
  [0, "#fefce8"],
  [0.35, "#fef08a"],
  [0.65, "#facc15"],
  [1, "#ca8a04"],
];

export const INTERTIE_GRADIENT_CSS = `linear-gradient(90deg, ${INTERTIE_HEAT_STOPS.map(([t, c]) => `${c} ${t * 100}%`).join(", ")})`;

export interface IntertieMarker {
  point: IntertiePoint;
  heat: number;
  color: string;
  label: string;
}

export function intertieMarkers(points: IntertiePoint[], scale: LmpScale | null): IntertieMarker[] {
  if (!scale) return [];
  return points.map((point) => {
    const heat = lmpHeat(point.lmp, scale);
    return { point, heat, color: heatColor(heat, INTERTIE_HEAT_STOPS), label: formatLmpShort(point.lmp) };
  });
}
