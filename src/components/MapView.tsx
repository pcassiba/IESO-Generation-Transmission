"use client";

import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { CongestionResponse } from "@/lib/congestion";
import type { FacilityLmp, IntertieMarker } from "@/lib/lmp";
import { VOLTAGE_CLASSES, VOLTAGE_COLOR, type VoltageClass } from "@/lib/transmission";
import type { FacilityState, OperationalStatus, Technology } from "@/lib/types";
import { STATUSES, STATUS_LABEL, TECHNOLOGIES, TECHNOLOGY_LABEL, STORAGE_MODE_LABEL } from "@/lib/types";
import { hourEndingLabel } from "@/lib/time";
import { CONGESTION_NEG, CONGESTION_POS, MAP_STYLES, ONTARIO_BOUNDS, TECH_COLOR, fmtMW, markerSvg } from "@/lib/ui";
import type { TxRiskItem } from "@/lib/txrisk/types";
import type { OverlayOptions } from "@/lib/txrisk/ui";
import { TXR_CLICK_LAYERS, addOverlayLayers, overlayItemAt, startAnimation, updateOverlay, type OverlayHandle } from "./txrisk/overlay";

export interface MapCommand {
  kind: "reset" | "fitAll" | "flyTo" | "fitBounds";
  id?: string;
  bbox?: [number, number, number, number];
  nonce: number;
}

export interface TxRiskOverlay {
  items: TxRiskItem[];
  options: OverlayOptions;
  selectedId: string | null;
}

interface Props {
  facilities: FacilityState[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  theme: "dark" | "light";
  scaleByCapacity: boolean;
  command: MapCommand | null;
  onMapReady?: (map: MLMap) => void;
  /** Voltage classes to draw; all false hides the transmission layer. */
  lineVisibility: Record<VoltageClass, boolean>;
  /** Congestion for the selected hour; null hides the congestion halos. */
  congestion: CongestionResponse | null;
  onTransmissionStatus?: (s: "ok" | "missing") => void;
  /** Outages & congestion risk overlay; null or options.enabled=false hides it. */
  txRisk?: TxRiskOverlay | null;
  onTxRiskPick?: (itemId: string) => void;
  /** LMP heat view: when set, each facility icon is replaced by its price. */
  lmp?: LmpOverlay | null;
  /** Intertie prices as yellow circles; null hides them. */
  interties?: IntertieOverlay | null;
}

export interface IntertieOverlay {
  markers: IntertieMarker[];
  hourTsUtc: string | null;
  /** Ontario median LMP for the hour, quoted in the tooltip for comparison. */
  medianLmp: number | null;
}

export interface LmpOverlay {
  byFacility: Map<string, FacilityLmp>;
  hourTsUtc: string | null;
  /** What the prices are, for the tooltip, e.g. "hourly average" or "5-min price, interval 7". */
  basisLabel: string;
}

/** Icon layers hidden while the LMP view is on. */
const ICON_LAYERS = ["clusters", "cluster-count", "unclustered", "points"];
const LMP_LAYERS = ["lmp-glow", "lmp-dots", "lmp-labels"];
/** Intertie layers, kept above everything else. */
const INTERTIE_LAYERS = ["intertie-glow", "intertie-arrows", "intertie-dots", "intertie-labels"];

const CLUSTER_MAX_ZOOM = 8;
const SPREAD_PX = 30;

// MapLibre v6 locates its ES-module worker via import.meta.url, which webpack does not bundle.
// The worker is copied to /public by scripts/copy-worker.js (runs before dev/build).
if (typeof window !== "undefined") maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

function iconId(t: Technology, s: OperationalStatus) {
  return `fac-${t}-${s}`;
}

async function loadIcons(map: MLMap) {
  const jobs: Promise<void>[] = [];
  for (const t of TECHNOLOGIES) {
    for (const s of STATUSES) {
      const id = iconId(t, s);
      if (map.hasImage(id)) continue;
      jobs.push(
        new Promise<void>((resolve) => {
          const img = new Image(80, 80);
          img.onload = () => {
            if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
            resolve();
          };
          img.onerror = () => resolve();
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markerSvg(t, s));
        }),
      );
    }
  }
  await Promise.all(jobs);
}

function toFeature(f: FacilityState, coords: [number, number]) {
  return {
    type: "Feature" as const,
    id: undefined,
    geometry: { type: "Point" as const, coordinates: coords },
    properties: {
      id: f.id,
      name: f.name,
      tech: f.technology,
      status: f.status,
      icon: iconId(f.technology, f.status),
      cap: f.installedCapacityMW ?? -1,
      output: f.outputMW ?? 0,
    },
  };
}

/**
 * Display-only separation of overlapping markers at close zoom ("spiderfy"): groups of
 * facilities that would overlap on screen are fanned out around their centroid, with a
 * leader line to the true location (marked with a small dot). True coordinates are never
 * modified.
 */
function spreadFeatures(map: MLMap, facilities: FacilityState[]) {
  const pts = facilities
    .filter((f) => f.lat !== null && f.lon !== null)
    .map((f) => ({ f, p: map.project([f.lon!, f.lat!]) }));
  const used = new Set<number>();
  const points: ReturnType<typeof toFeature>[] = [];
  const lines: GeoJSON.Feature[] = [];
  const anchors: GeoJSON.Feature[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    used.add(i);
    for (let j = i + 1; j < pts.length; j++) {
      if (used.has(j)) continue;
      if (group.some((g) => Math.hypot(pts[g].p.x - pts[j].p.x, pts[g].p.y - pts[j].p.y) < SPREAD_PX)) {
        group.push(j);
        used.add(j);
      }
    }
    if (group.length === 1) {
      const { f } = pts[i];
      points.push(toFeature(f, [f.lon!, f.lat!]));
      continue;
    }
    const cx = group.reduce((a, g) => a + pts[g].p.x, 0) / group.length;
    const cy = group.reduce((a, g) => a + pts[g].p.y, 0) / group.length;
    const radius = Math.max(SPREAD_PX, (group.length * SPREAD_PX) / (2 * Math.PI)) + 6;
    group.forEach((g, k) => {
      const ang = (2 * Math.PI * k) / group.length - Math.PI / 2;
      const ll = map.unproject([cx + radius * Math.cos(ang), cy + radius * Math.sin(ang)]);
      const { f } = pts[g];
      points.push(toFeature(f, [ll.lng, ll.lat]));
      lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[f.lon!, f.lat!], [ll.lng, ll.lat]] }, properties: {} });
      anchors.push({ type: "Feature", geometry: { type: "Point", coordinates: [f.lon!, f.lat!] }, properties: { tech: f.technology } });
    });
  }
  return {
    points: { type: "FeatureCollection" as const, features: points },
    lines: { type: "FeatureCollection" as const, features: lines },
    anchors: { type: "FeatureCollection" as const, features: anchors },
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function lineTooltipHtml(p: Record<string, unknown>): string {
  const rows = [
    ["Voltage", p.voltages],
    ...(p.ref ? [["Circuit", p.ref]] : []),
    ...(p.operator ? [["Operator", p.operator]] : []),
    ...(p.circuits ? [["Circuits", p.circuits]] : []),
    ["Source", `OSM way ${p.osmId}`],
  ];
  return `<div class="oge-tip"><div class="oge-tip-title">${esc(p.name ?? (p.cable === true || p.cable === "true" ? "Transmission cable" : "Transmission line"))}</div>${rows
    .map(([k, v]) => `<div class="oge-tip-row"><span>${k}</span><b>${esc(v)}</b></div>`)
    .join("")}</div>`;
}

/** Filter for one transmission layer: visible voltage classes, plus the layer's own condition. */
function txFilter(vis: Record<VoltageClass, boolean>, part: "known" | "unknown" | "subs" | "labels"): maplibregl.FilterSpecification {
  const visible = ["in", ["get", "vclass"], ["literal", VOLTAGE_CLASSES.filter((c) => vis[c])]];
  const extra =
    part === "known" ? ["!=", ["get", "vclass"], "unknown"] : part === "unknown" ? ["==", ["get", "vclass"], "unknown"] : part === "labels" ? ["has", "name"] : null;
  return (extra ? ["all", visible, extra] : visible) as unknown as maplibregl.FilterSpecification;
}

const TX_LAYERS: [string, Parameters<typeof txFilter>[1]][] = [
  ["tx-casing", "known"],
  ["tx-lines", "known"],
  ["tx-unknown", "unknown"],
  ["tx-subs", "subs"],
  ["tx-subs-label", "labels"],
];

function congestionFeatures(facilities: FacilityState[], c: CongestionResponse | null) {
  const features: GeoJSON.Feature[] = [];
  if (c) {
    const byId = new Map(facilities.map((f) => [f.id, f]));
    for (const fc of c.facilities) {
      const f = byId.get(fc.facilityId);
      if (!f || f.lat === null || f.lon === null || fc.congestion === null || Math.abs(fc.congestion) < c.thresholdPerMWh) continue;
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [f.lon, f.lat] }, properties: { id: f.id, cong: fc.congestion, mag: Math.abs(fc.congestion) } });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

/** One LMP marker per facility; spread positions are used once markers fan out at close zoom. */
function lmpFeatures(map: MLMap, located: FacilityState[], spreadPoints: ReturnType<typeof toFeature>[], lmp: LmpOverlay | null) {
  const features: GeoJSON.Feature[] = [];
  if (lmp) {
    const spreadAt = new Map(spreadPoints.map((p) => [p.properties.id, p.geometry.coordinates]));
    const useSpread = map.getZoom() >= CLUSTER_MAX_ZOOM + 1;
    for (const f of located) {
      const p = lmp.byFacility.get(f.id);
      const coordinates = (useSpread && spreadAt.get(f.id)) || [f.lon!, f.lat!];
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates },
        properties: p
          ? { id: f.id, priced: true, heat: p.heat, color: p.color, label: p.label, textColor: p.textColor }
          : { id: f.id, priced: false, heat: -1, color: "#94a3b8", label: "", textColor: "#111827" },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function intertieFeatures(o: IntertieOverlay | null) {
  return {
    type: "FeatureCollection" as const,
    features: (o?.markers ?? []).map((m) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [m.point.lon, m.point.lat] },
      properties: { id: m.point.id, heat: m.heat, color: m.color, label: m.label, bearing: m.point.bearing },
    })),
  };
}

function intertieTooltipHtml(m: IntertieMarker, o: IntertieOverlay): string {
  const p = m.point;
  const head = p.prices.find((x) => x.location === p.location)!;
  const diff = o.medianLmp === null ? null : p.lmp - o.medianLmp;
  const rows: [string, string][] = [
    ["Intertie LMP", money(p.lmp)],
    ...(diff === null ? [] : ([["vs Ontario median", `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)} $/MWh`]] as [string, string][])),
    ["Congestion part", money(head.congestion)],
    ["External congestion", money(head.externalCongestion)],
    ["Intertie limit (NISL) part", money(head.nisl)],
    ["Loss part", money(head.loss)],
  ];
  const others =
    p.prices.length > 1
      ? `<div class="oge-tip-row" style="margin-top:4px"><span>Pricing locations here</span></div>${p.prices.map((x) => `<div class="oge-tip-row"><span>${esc(x.location)}</span><b>${money(x.lmp)}</b></div>`).join("")}`
      : `<div class="oge-tip-row"><span>Pricing location</span><b>${esc(p.location)}</b></div>`;
  const flow = p.neighbour ? `<div class="oge-tip-row"><span>Ontario ⇄ ${esc(p.neighbour)}</span></div>` : "";
  return `<div class="oge-tip"><div class="oge-tip-title">${esc(p.name)}</div>${flow}${rows
    .map(([k, v]) => `<div class="oge-tip-row"><span>${k}</span><b>${v}</b></div>`)
    .join("")}${others}<div class="oge-tip-row" style="margin-top:4px"><span>${esc(hourEndingLabel(o.hourTsUtc))} · IESO real-time · position approximate</span></div></div>`;
}

/**
 * Two-way arrow drawn behind each intertie circle: one head points toward Ontario, the other
 * toward the neighbouring system. Drawn pointing east and rotated by the tie's bearing.
 */
function intertieArrowImage(): ImageData {
  const w = 150;
  const h = 26;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const y = h / 2;
  const head = 11;
  g.beginPath();
  g.moveTo(2, y);
  g.lineTo(2 + head, y - 8);
  g.lineTo(2 + head, y - 2.5);
  g.lineTo(w - 2 - head, y - 2.5);
  g.lineTo(w - 2 - head, y - 8);
  g.lineTo(w - 2, y);
  g.lineTo(w - 2 - head, y + 8);
  g.lineTo(w - 2 - head, y + 2.5);
  g.lineTo(2 + head, y + 2.5);
  g.lineTo(2 + head, y + 8);
  g.closePath();
  g.fillStyle = "#eab308";
  g.strokeStyle = "#422006";
  g.lineWidth = 1.5;
  g.lineJoin = "round";
  g.fill();
  g.stroke();
  return g.getImageData(0, 0, w, h);
}

const money = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)} $/MWh`);

function lmpTooltipHtml(f: FacilityState, p: FacilityLmp | undefined, hourTsUtc: string | null, basisLabel: string): string {
  if (!p) {
    return `<div class="oge-tip"><div class="oge-tip-title">${esc(f.name)}</div><div class="oge-tip-row"><span>No IESO pricing location linked to this facility</span></div></div>`;
  }
  const d = p.detail;
  const rows: [string, string][] = [
    [d.units.length > 1 ? `LMP (average of ${d.units.length} units)` : "LMP", money(p.lmp)],
    ["Congestion part", money(d.congestion)],
    ["Loss part", money(d.loss)],
  ];
  const units =
    d.units.length > 1
      ? `<div class="oge-tip-row" style="margin-top:4px"><span>Units</span></div>${d.units.map((u) => `<div class="oge-tip-row"><span>${esc(u.location)}</span><b>${money(u.lmp)}</b></div>`).join("")}`
      : `<div class="oge-tip-row"><span>Pricing location</span><b>${esc(d.units[0]?.location ?? "")}</b></div>`;
  return `<div class="oge-tip"><div class="oge-tip-title">${esc(f.name)}</div>${rows
    .map(([k, v]) => `<div class="oge-tip-row"><span>${k}</span><b>${v}</b></div>`)
    .join("")}${units}<div class="oge-tip-row" style="margin-top:4px"><span>${esc(hourEndingLabel(hourTsUtc))} · IESO real-time · ${esc(basisLabel)}</span></div></div>`;
}

function tooltipHtml(f: FacilityState, cong?: { congestion: number | null; lmp: number | null }): string {
  const vg = f.technology === "wind" || f.technology === "solar";
  const rows = [
    ["Type", `${TECHNOLOGY_LABEL[f.technology]}${f.subtype ? ` · ${f.subtype}` : ""}`],
    ["Reported output", fmtMW(f.outputMW)],
    [vg ? "Available capacity" : "Reported capability", fmtMW(f.capabilityMW)],
    ...(vg ? [["IESO forecast", fmtMW(f.forecastMW)]] : []),
    ["Status", f.storageMode ? `${STATUS_LABEL[f.status]} (${STORAGE_MODE_LABEL[f.storageMode]})` : STATUS_LABEL[f.status]],
    ...(cong && cong.congestion !== null ? [["Congestion price", `${cong.congestion.toFixed(2)} $/MWh`], ["Nodal price (LMP)", cong.lmp === null ? "—" : `${cong.lmp.toFixed(2)} $/MWh`]] : []),
  ];
  return `<div class="oge-tip"><div class="oge-tip-title">${f.name}</div>${rows
    .map(([k, v]) => `<div class="oge-tip-row"><span>${k}</span><b>${v}</b></div>`)
    .join("")}</div>`;
}

export default function MapView({ facilities, selectedId, onSelect, theme, scaleByCapacity, command, onMapReady, lineVisibility, congestion, onTransmissionStatus, txRisk, onTxRiskPick, lmp, interties }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const facRef = useRef<FacilityState[]>(facilities);
  const selRef = useRef<string | null>(selectedId);
  const scaleRef = useRef(scaleByCapacity);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const themeRef = useRef(theme);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const lineVisRef = useRef(lineVisibility);
  const congRef = useRef(congestion);
  const lmpRef = useRef(lmp ?? null);
  const tieRef = useRef(interties ?? null);
  const txStatusRef = useRef(onTransmissionStatus);
  txStatusRef.current = onTransmissionStatus;
  const txrRef = useRef(txRisk ?? null);
  txrRef.current = txRisk ?? null;
  const txrPickRef = useRef(onTxRiskPick);
  txrPickRef.current = onTxRiskPick;
  const overlayRef = useRef<OverlayHandle | null>(null);
  const applyOverlay = () => {
    const map = mapRef.current;
    const o = txrRef.current;
    if (!map) return;
    updateOverlay(map, overlayRef.current, o?.items ?? [], o?.options ?? { enabled: false, flashing: false, reducedMotion: true }, o?.selectedId ?? null);
  };

  const refreshData = () => {
    const map = mapRef.current;
    if (!map || !map.getSource("fac-cluster")) return;
    const located = facRef.current.filter((f) => f.lat !== null && f.lon !== null);
    (map.getSource("fac-cluster") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: located.map((f) => toFeature(f, [f.lon!, f.lat!])),
    });
    const spread = spreadFeatures(map, located);
    (map.getSource("fac-points") as GeoJSONSource).setData(spread.points);
    (map.getSource("fac-lines") as GeoJSONSource).setData(spread.lines);
    (map.getSource("fac-anchors") as GeoJSONSource).setData(spread.anchors);
    (map.getSource("cong") as GeoJSONSource | undefined)?.setData(congestionFeatures(located, congRef.current));
    (map.getSource("lmp") as GeoJSONSource | undefined)?.setData(lmpFeatures(map, located, spread.points.features, lmpRef.current));
    (map.getSource("interties") as GeoJSONSource | undefined)?.setData(intertieFeatures(tieRef.current));
    // Layers added later (transmission, outage overlay) would otherwise cover the intertie circles.
    if (tieRef.current) for (const l of INTERTIE_LAYERS) if (map.getLayer(l)) map.moveLayer(l);
    const sel = located.find((f) => f.id === selRef.current);
    const selPt = sel ? spread.points.features.find((p) => p.properties.id === sel.id) : null;
    (map.getSource("fac-selected") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: selPt ? [selPt] : [],
    });
  };

  /** Swap facility icons for LMP markers (or back). */
  const applyLmpVisibility = () => {
    const map = mapRef.current;
    if (!map) return;
    const on = !!lmpRef.current;
    for (const l of ICON_LAYERS) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", on ? "none" : "visible");
    for (const l of LMP_LAYERS) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", on ? "visible" : "none");
  };

  const iconSizeExpr = (): maplibregl.ExpressionSpecification | number =>
    scaleRef.current
      ? ["case", ["<", ["get", "cap"], 0], 0.62, ["interpolate", ["linear"], ["sqrt", ["get", "cap"]], 0, 0.5, 10, 0.68, 30, 0.9, 60, 1.2]]
      : 0.72;

  const addTransmission = async (map: MLMap) => {
    if (map.getSource("tx")) return;
    let lines: GeoJSON.FeatureCollection | null = null;
    let subs: GeoJSON.FeatureCollection | null = null;
    try {
      const [l, s] = await Promise.all([fetch("/geo/transmission.geojson"), fetch("/geo/substations.geojson")]);
      if (l.ok) lines = await l.json();
      if (s.ok) subs = await s.json();
    } catch {
      /* handled below */
    }
    txStatusRef.current?.(lines ? "ok" : "missing");
    if (!lines || map.getSource("tx")) return;
    const dark = themeRef.current === "dark";
    const vis = lineVisRef.current;
    map.addSource("tx", { type: "geojson", data: lines });
    const color = ["match", ["get", "vclass"], ...VOLTAGE_CLASSES.flatMap((c) => [c, VOLTAGE_COLOR[c]]), "#64748b"] as unknown as maplibregl.ExpressionSpecification;
    const width = (k: number): maplibregl.ExpressionSpecification =>
      ["interpolate", ["linear"], ["zoom"], 4, ["*", k, ["match", ["get", "vclass"], "500", 1.6, "230", 0.9, "115", 0.55, 0.4]], 10, ["*", k, ["match", ["get", "vclass"], "500", 4, "230", 2.6, "115", 1.7, 1.1]]];
    map.addLayer({ id: "tx-casing", type: "line", source: "tx", filter: txFilter(vis, "known"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#020617" : "#ffffff", "line-width": width(1.9), "line-opacity": 0.55 } });
    map.addLayer({ id: "tx-lines", type: "line", source: "tx", filter: txFilter(vis, "known"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": color, "line-width": width(1), "line-opacity": 0.9 } });
    map.addLayer({ id: "tx-unknown", type: "line", source: "tx", filter: txFilter(vis, "unknown"), paint: { "line-color": color, "line-width": width(1), "line-dasharray": [2, 2], "line-opacity": 0.8 } });
    if (subs) {
      map.addSource("tx-subs", { type: "geojson", data: subs });
      map.addLayer({
        id: "tx-subs",
        type: "circle",
        source: "tx-subs",
        minzoom: 7,
        filter: txFilter(vis, "subs"),
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2, 11, 5], "circle-color": dark ? "#0f172a" : "#ffffff", "circle-stroke-color": color, "circle-stroke-width": 1.5 },
      });
      map.addLayer({
        id: "tx-subs-label",
        type: "symbol",
        source: "tx-subs",
        minzoom: 9.5,
        filter: txFilter(vis, "labels"),
        layout: { "text-field": ["get", "name"], "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true, "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"] },
        paint: { "text-color": dark ? "#94a3b8" : "#475569", "text-halo-color": dark ? "#0b1220" : "#ffffff", "text-halo-width": 1.2 },
      });
    }
    overlayRef.current = addOverlayLayers(map, lines, subs);
    applyOverlay();
  };

  const addLayers = async (map: MLMap) => {
    const theme = themeRef.current;
    await loadIcons(map);
    if (map.getSource("fac-cluster")) return;
    try {
      const res = await fetch("/geo/ontario.geojson");
      if (res.ok && !map.getSource("ontario")) {
        map.addSource("ontario", { type: "geojson", data: await res.json() });
        map.addLayer({ id: "ontario-fill", type: "fill", source: "ontario", paint: { "fill-color": theme === "dark" ? "#38bdf8" : "#0369a1", "fill-opacity": 0.035 } });
        map.addLayer({ id: "ontario-line", type: "line", source: "ontario", paint: { "line-color": theme === "dark" ? "#38bdf8" : "#0369a1", "line-width": 1.6, "line-opacity": 0.75 } });
      }
    } catch {
      /* boundary overlay is optional; basemap already shows provincial borders */
    }
    const empty = { type: "FeatureCollection" as const, features: [] };
    await addTransmission(map);
    map.addSource("cong", { type: "geojson", data: empty });
    map.addLayer({
      id: "cong-halo",
      type: "circle",
      source: "cong",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2, 12, 20, 22, 100, 36],
        "circle-color": ["case", ["<", ["get", "cong"], 0], CONGESTION_NEG, CONGESTION_POS],
        "circle-opacity": 0.28,
        "circle-stroke-color": ["case", ["<", ["get", "cong"], 0], CONGESTION_NEG, CONGESTION_POS],
        "circle-stroke-width": 2,
        "circle-blur": 0.15,
      },
    });
    map.addSource("fac-cluster", {
      type: "geojson",
      data: empty,
      cluster: true,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      clusterRadius: 34,
      clusterProperties: { output: ["+", ["get", "output"]] },
    });
    map.addSource("fac-points", { type: "geojson", data: empty });
    map.addSource("fac-lines", { type: "geojson", data: empty });
    map.addSource("fac-anchors", { type: "geojson", data: empty });
    map.addSource("fac-selected", { type: "geojson", data: empty });

    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "fac-cluster",
      maxzoom: CLUSTER_MAX_ZOOM + 1,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": theme === "dark" ? "#1e293b" : "#ffffff",
        "circle-stroke-color": "#38bdf8",
        "circle-stroke-width": 2,
        "circle-radius": ["step", ["get", "point_count"], 15, 5, 18, 15, 22, 40, 27],
      },
    });
    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "fac-cluster",
      maxzoom: CLUSTER_MAX_ZOOM + 1,
      filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"], "text-allow-overlap": true },
      paint: { "text-color": theme === "dark" ? "#e2e8f0" : "#0f172a" },
    });
    map.addLayer({
      id: "unclustered",
      type: "symbol",
      source: "fac-cluster",
      maxzoom: CLUSTER_MAX_ZOOM + 1,
      filter: ["!", ["has", "point_count"]],
      layout: { "icon-image": ["get", "icon"], "icon-size": iconSizeExpr(), "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["-", 0, ["get", "cap"]] },
    });
    map.addLayer({
      id: "spread-lines",
      type: "line",
      source: "fac-lines",
      minzoom: CLUSTER_MAX_ZOOM + 1,
      paint: { "line-color": theme === "dark" ? "#94a3b8" : "#475569", "line-width": 1.2, "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: "spread-anchors",
      type: "circle",
      source: "fac-anchors",
      minzoom: CLUSTER_MAX_ZOOM + 1,
      paint: { "circle-radius": 3, "circle-color": ["match", ["get", "tech"], ...TECHNOLOGIES.flatMap((t) => [t, TECH_COLOR[t]]), "#999"] as unknown as maplibregl.ExpressionSpecification, "circle-stroke-color": "#0b1220", "circle-stroke-width": 1 },
    });
    map.addLayer({
      id: "selected-halo",
      type: "circle",
      source: "fac-selected",
      paint: { "circle-radius": 22, "circle-color": "rgba(56,189,248,0.18)", "circle-stroke-color": "#38bdf8", "circle-stroke-width": 2.5 },
    });
    map.addLayer({
      id: "points",
      type: "symbol",
      source: "fac-points",
      minzoom: CLUSTER_MAX_ZOOM + 1,
      layout: {
        "icon-image": ["get", "icon"],
        "icon-size": iconSizeExpr(),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["-", 0, ["get", "cap"]],
        "text-field": ["step", ["zoom"], "", 10, ["get", "name"]],
        "text-size": 11,
        "text-offset": [0, 1.9],
        "text-anchor": "top",
        "text-optional": true,
        "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
      },
      paint: {
        "text-color": theme === "dark" ? "#e2e8f0" : "#0f172a",
        "text-halo-color": theme === "dark" ? "#0b1220" : "#ffffff",
        "text-halo-width": 1.4,
      },
    });

    // LMP heat view: a soft red glow that grows with price, a coloured disc, and the price on top.
    map.addSource("lmp", { type: "geojson", data: empty });
    const hidden = { visibility: "none" as const };
    map.addLayer({
      id: "lmp-glow",
      type: "circle",
      source: "lmp",
      filter: ["==", ["get", "priced"], true],
      layout: { ...hidden, "circle-sort-key": ["get", "heat"] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, ["+", 10, ["*", 14, ["get", "heat"]]], 9, ["+", 22, ["*", 22, ["get", "heat"]]]],
        "circle-color": ["get", "color"],
        "circle-opacity": ["*", 0.55, ["get", "heat"]],
        "circle-blur": 1,
      },
    });
    map.addLayer({
      id: "lmp-dots",
      type: "circle",
      source: "lmp",
      layout: { ...hidden, "circle-sort-key": ["get", "heat"] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, ["case", ["get", "priced"], 9, 3], 6, ["case", ["get", "priced"], 13, 4], 9, ["case", ["get", "priced"], 17, 5]],
        "circle-color": ["get", "color"],
        "circle-opacity": ["case", ["get", "priced"], 1, 0.6],
        "circle-stroke-color": theme === "dark" ? "#0b1220" : "#475569",
        "circle-stroke-width": 1,
      },
    });
    map.addLayer({
      id: "lmp-labels",
      type: "symbol",
      source: "lmp",
      filter: ["==", ["get", "priced"], true],
      layout: {
        ...hidden,
        "text-field": ["get", "label"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9, 9, 11],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "symbol-sort-key": ["-", 0, ["get", "heat"]],
        "text-padding": 1,
      },
      paint: { "text-color": ["get", "textColor"] },
    });
    applyLmpVisibility();

    // Interties: yellow circles with a yellow ring, deeper yellow and a wider glow when pricier than Ontario's generators.
    map.addSource("interties", { type: "geojson", data: empty });
    if (!map.hasImage("intertie-arrow")) map.addImage("intertie-arrow", intertieArrowImage(), { pixelRatio: 2 });
    map.addLayer({
      id: "intertie-arrows",
      type: "symbol",
      source: "interties",
      layout: {
        "icon-image": "intertie-arrow",
        // The image points east; rotate it onto the tie's bearing so it spans the border.
        "icon-rotate": ["-", ["get", "bearing"], 90],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.9, 9, 1.3],
      },
    });
    map.addLayer({
      id: "intertie-glow",
      type: "circle",
      source: "interties",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, ["+", 12, ["*", 16, ["get", "heat"]]], 9, ["+", 24, ["*", 24, ["get", "heat"]]]],
        "circle-color": "#facc15",
        "circle-opacity": ["+", 0.08, ["*", 0.5, ["get", "heat"]]],
        "circle-blur": 1,
      },
    });
    map.addLayer({
      id: "intertie-dots",
      type: "circle",
      source: "interties",
      layout: { "circle-sort-key": ["get", "heat"] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 11, 6, 15, 9, 19],
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#eab308",
        "circle-stroke-width": 2.5,
      },
    });
    map.addLayer({
      id: "intertie-labels",
      type: "symbol",
      source: "interties",
      layout: {
        "text-field": ["get", "label"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9, 9, 11],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#422006" },
    });
    refreshData();
  };

  // Initialise map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLES[theme],
      bounds: ONTARIO_BOUNDS,
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true },
      maxBounds: [
        [-110, 35],
        [-60, 64],
      ],
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    map.on("style.load", () => void addLayers(map));
    map.on("moveend", () => refreshData());

    map.on("click", "clusters", async (e: MapLayerMouseEvent) => {
      const feat = e.features?.[0];
      if (!feat) return;
      const src = map.getSource("fac-cluster") as GeoJSONSource;
      const zoom = await src.getClusterExpansionZoom(feat.properties.cluster_id as number);
      map.easeTo({ center: (feat.geometry as GeoJSON.Point).coordinates as [number, number], zoom: Math.max(zoom, map.getZoom() + 1) });
    });
    const clickFac = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) onSelectRef.current(id);
    };
    map.on("click", "unclustered", clickFac);
    map.on("click", "points", clickFac);
    map.on("click", "lmp-dots", clickFac);

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 18, className: "oge-popup", maxWidth: "300px" });
    popupRef.current = popup;
    const hover = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const f = facRef.current.find((x) => x.id === id);
      if (!f) return;
      const cong = congRef.current?.facilities.find((c) => c.facilityId === id);
      popup.setLngLat((e.features![0].geometry as GeoJSON.Point).coordinates as [number, number]).setHTML(tooltipHtml(f, cong)).addTo(map);
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };
    for (const l of ["unclustered", "points"]) {
      map.on("mousemove", l, hover);
      map.on("mouseleave", l, leave);
    }
    map.on("mousemove", "lmp-dots", (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const f = facRef.current.find((x) => x.id === id);
      if (!f) return;
      popup
        .setLngLat((e.features![0].geometry as GeoJSON.Point).coordinates as [number, number])
        .setHTML(lmpTooltipHtml(f, lmpRef.current?.byFacility.get(f.id), lmpRef.current?.hourTsUtc ?? null, lmpRef.current?.basisLabel ?? "hourly average"))
        .addTo(map);
    });
    map.on("mouseleave", "lmp-dots", leave);
    map.on("mousemove", "intertie-dots", (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const o = tieRef.current;
      const m = o?.markers.find((x) => x.point.id === id);
      if (!o || !m) return;
      popup.setLngLat([m.point.lon, m.point.lat]).setHTML(intertieTooltipHtml(m, o)).addTo(map);
    });
    map.on("mouseleave", "intertie-dots", () => popup.remove());
    const lineHover = (e: MapLayerMouseEvent) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["unclustered", "points", "clusters", "lmp-dots", "intertie-dots"].filter((l) => map.getLayer(l)) }).length) return;
      const p = e.features?.[0]?.properties;
      if (!p) return;
      popup.setLngLat(e.lngLat).setHTML(lineTooltipHtml(p)).addTo(map);
    };
    for (const l of ["tx-lines", "tx-unknown"]) {
      map.on("mousemove", l, lineHover);
      map.on("mouseleave", l, () => popup.remove());
    }
    const txrHover = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features?.[0]?.properties;
      const item = txrRef.current?.items.find((i) => i.id === p?.itemId);
      if (!item) return;
      popup
        .setLngLat(e.lngLat)
        .setHTML(`<div class="oge-tip"><div class="oge-tip-title">${esc(item.title)}</div><div class="oge-tip-row"><span>${esc(item.categoryLabel)}</span></div><div class="oge-tip-row"><span>Click for IESO details</span></div></div>`)
        .addTo(map);
    };
    for (const l of TXR_CLICK_LAYERS) {
      map.on("click", l, (e) => {
        const id = overlayItemAt(e);
        if (id) txrPickRef.current?.(id);
      });
      map.on("mousemove", l, txrHover);
      map.on("mouseleave", l, () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });
    }
    map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
    onMapReady?.(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch → reload style; layers are re-added on style.load.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || themeRef.current === theme) return;
    themeRef.current = theme;
    map.setStyle(MAP_STYLES[theme]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    facRef.current = facilities;
    refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilities]);

  useEffect(() => {
    selRef.current = selectedId;
    refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    lineVisRef.current = lineVisibility;
    const map = mapRef.current;
    if (!map) return;
    for (const [id, part] of TX_LAYERS) if (map.getLayer(id)) map.setFilter(id, txFilter(lineVisibility, part));
  }, [lineVisibility]);

  useEffect(() => {
    congRef.current = congestion;
    refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [congestion]);

  useEffect(() => {
    lmpRef.current = lmp ?? null;
    applyLmpVisibility();
    refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lmp]);

  useEffect(() => {
    tieRef.current = interties ?? null;
    refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interties]);

  useEffect(() => {
    applyOverlay();
    const map = mapRef.current;
    const o = txRisk?.options;
    if (!map || !o?.enabled || !o.flashing || o.reducedMotion || !txRisk?.items.some((i) => i.animate)) return;
    return startAnimation(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txRisk]);

  useEffect(() => {
    scaleRef.current = scaleByCapacity;
    const map = mapRef.current;
    if (!map) return;
    for (const l of ["unclustered", "points"]) if (map.getLayer(l)) map.setLayoutProperty(l, "icon-size", iconSizeExpr());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleByCapacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !command) return;
    if (command.kind === "reset") map.fitBounds(ONTARIO_BOUNDS, { padding: 20 });
    if (command.kind === "fitAll") {
      const located = facRef.current.filter((f) => f.lat !== null && f.lon !== null);
      if (located.length) {
        const b = new maplibregl.LngLatBounds();
        located.forEach((f) => b.extend([f.lon!, f.lat!]));
        map.fitBounds(b, { padding: 60, maxZoom: 11 });
      }
    }
    if (command.kind === "fitBounds" && command.bbox) {
      const [x0, y0, x1, y1] = command.bbox;
      map.fitBounds([[x0, y0], [x1, y1]], { padding: 80, maxZoom: 10, duration: 900 });
    }
    if (command.kind === "flyTo" && command.id) {
      const f = facRef.current.find((x) => x.id === command.id);
      if (f && f.lat !== null && f.lon !== null) map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.6 });
    }
  }, [command]);

  return <div ref={containerRef} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />;
}
