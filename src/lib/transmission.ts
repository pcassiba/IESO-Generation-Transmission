/**
 * Transmission line metadata (geometry comes from OpenStreetMap, see scripts/build-transmission.ts).
 *
 * OSM `voltage` is in volts and may list several circuits on one way ("230000;115000"). The
 * line is classed by its highest voltage; all voltages are kept for the tooltip.
 */

export type VoltageClass = "500" | "230" | "115" | "sub" | "unknown";

export const VOLTAGE_CLASSES: VoltageClass[] = ["500", "230", "115", "sub", "unknown"];

export const VOLTAGE_LABEL: Record<VoltageClass, string> = {
  "500": "500 kV",
  "230": "230 kV",
  "115": "115 kV",
  sub: "Below 100 kV",
  unknown: "Voltage not tagged",
};

export const VOLTAGE_COLOR: Record<VoltageClass, string> = {
  "500": "#ef4444",
  "230": "#f59e0b",
  "115": "#3b82f6",
  sub: "#94a3b8",
  unknown: "#64748b",
};

/** Classes shown when the app first loads (distribution-level lines are hidden). */
export const DEFAULT_VISIBLE: Record<VoltageClass, boolean> = { "500": true, "230": true, "115": true, sub: false, unknown: false };

/** Parse an OSM voltage tag into kV values, highest first. Ignores non-numeric parts. */
export function parseVoltageKv(tag: string | null | undefined): number[] {
  if (!tag) return [];
  const out = new Set<number>();
  for (const part of tag.split(/[;,]/)) {
    const v = Number(part.trim());
    if (Number.isFinite(v) && v > 0) out.add(Math.round(v / 1000));
  }
  return [...out].sort((a, b) => b - a);
}

/**
 * Ontario's bulk system uses 500, 230 and 115 kV. Odd values (e.g. 220 or 120 on interties
 * and a few legacy circuits) go to the nearest class.
 */
export function classifyKv(kv: number | null | undefined): VoltageClass {
  if (kv === null || kv === undefined || !Number.isFinite(kv) || kv <= 0) return "unknown";
  if (kv >= 345) return "500";
  if (kv >= 150) return "230";
  if (kv >= 100) return "115";
  return "sub";
}

export interface LineProps {
  osmId: number;
  vclass: VoltageClass;
  kv: number | null;
  voltages: string;
  ref: string | null;
  name: string | null;
  operator: string | null;
  circuits: string | null;
  cable: boolean;
}

/** Normalise one OSM way's tags into the properties stored in transmission.geojson. */
export function lineProps(osmId: number, tags: Record<string, string | undefined>): LineProps {
  const kvs = parseVoltageKv(tags.voltage);
  return {
    osmId,
    vclass: classifyKv(kvs[0]),
    kv: kvs[0] ?? null,
    voltages: kvs.length ? kvs.map((k) => `${k} kV`).join(" / ") : "not tagged",
    ref: tags.ref ?? null,
    name: tags.name ?? null,
    operator: tags.operator ?? null,
    circuits: tags.circuits ?? tags.cables ?? null,
    cable: tags.power === "cable",
  };
}
