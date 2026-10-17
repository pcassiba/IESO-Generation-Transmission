"use client";

import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { FacilityState, OperationalStatus, Technology } from "@/lib/types";
import { STATUSES, STATUS_LABEL, TECHNOLOGIES, TECHNOLOGY_LABEL, STORAGE_MODE_LABEL } from "@/lib/types";
import { MAP_STYLES, ONTARIO_BOUNDS, TECH_COLOR, fmtMW, markerSvg } from "@/lib/ui";

export interface MapCommand {
  kind: "reset" | "fitAll" | "flyTo";
  id?: string;
  nonce: number;
}

interface Props {
  facilities: FacilityState[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  theme: "dark" | "light";
  scaleByCapacity: boolean;
  command: MapCommand | null;
  onMapReady?: (map: MLMap) => void;
}

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

function tooltipHtml(f: FacilityState): string {
  const vg = f.technology === "wind" || f.technology === "solar";
  const rows = [
    ["Type", `${TECHNOLOGY_LABEL[f.technology]}${f.subtype ? ` · ${f.subtype}` : ""}`],
    ["Reported output", fmtMW(f.outputMW)],
    [vg ? "Available capacity" : "Reported capability", fmtMW(f.capabilityMW)],
    ...(vg ? [["IESO forecast", fmtMW(f.forecastMW)]] : []),
    ["Status", f.storageMode ? `${STATUS_LABEL[f.status]} (${STORAGE_MODE_LABEL[f.storageMode]})` : STATUS_LABEL[f.status]],
  ];
  return `<div class="oge-tip"><div class="oge-tip-title">${f.name}</div>${rows
    .map(([k, v]) => `<div class="oge-tip-row"><span>${k}</span><b>${v}</b></div>`)
    .join("")}</div>`;
}

export default function MapView({ facilities, selectedId, onSelect, theme, scaleByCapacity, command, onMapReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const facRef = useRef<FacilityState[]>(facilities);
  const selRef = useRef<string | null>(selectedId);
  const scaleRef = useRef(scaleByCapacity);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const themeRef = useRef(theme);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

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
    const sel = located.find((f) => f.id === selRef.current);
    const selPt = sel ? spread.points.features.find((p) => p.properties.id === sel.id) : null;
    (map.getSource("fac-selected") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: selPt ? [selPt] : [],
    });
  };

  const iconSizeExpr = (): maplibregl.ExpressionSpecification | number =>
    scaleRef.current
      ? ["case", ["<", ["get", "cap"], 0], 0.62, ["interpolate", ["linear"], ["sqrt", ["get", "cap"]], 0, 0.5, 10, 0.68, 30, 0.9, 60, 1.2]]
      : 0.72;

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

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 18, className: "oge-popup", maxWidth: "300px" });
    popupRef.current = popup;
    const hover = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const f = facRef.current.find((x) => x.id === id);
      if (!f) return;
      popup.setLngLat((e.features![0].geometry as GeoJSON.Point).coordinates as [number, number]).setHTML(tooltipHtml(f)).addTo(map);
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };
    for (const l of ["unclustered", "points"]) {
      map.on("mousemove", l, hover);
      map.on("mouseleave", l, leave);
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
    if (command.kind === "flyTo" && command.id) {
      const f = facRef.current.find((x) => x.id === command.id);
      if (f && f.lat !== null && f.lon !== null) map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.6 });
    }
  }, [command]);

  return <div ref={containerRef} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />;
}
