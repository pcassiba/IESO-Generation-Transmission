import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent } from "maplibre-gl";
import type { TxRiskItem } from "@/lib/txrisk/types";
import { animOpacity, overlayFeatures, type OverlayOptions } from "@/lib/txrisk/ui";

/**
 * MapLibre layers for the outages & congestion risk overlay.
 *
 * A wide translucent halo is drawn *under* the existing transmission lines, so each line keeps
 * its voltage colour, plus a thin dashed line in the risk colour on top. Stations get a ring.
 * Only features listed on an item are added; no other line is touched.
 */

const empty = { type: "FeatureCollection" as const, features: [] };
export const TXR_CLICK_LAYERS = ["txr-dash", "txr-dash-approx", "txr-halo", "txr-halo-anim", "txr-st", "txr-st-anim"];

type LineGeom = { type: "LineString"; coordinates: [number, number][] };

export interface OverlayHandle {
  lineGeom: Map<number, LineGeom>;
  stationGeom: Map<number, [number, number]>;
}

export function addOverlayLayers(map: MLMap, lines: GeoJSON.FeatureCollection, subs: GeoJSON.FeatureCollection | null): OverlayHandle {
  const lineGeom = new Map<number, LineGeom>();
  for (const f of lines.features) lineGeom.set(Number(f.properties?.osmId), f.geometry as LineGeom);
  const stationGeom = new Map<number, [number, number]>();
  for (const f of subs?.features ?? []) stationGeom.set(Number(f.properties?.osmId), (f.geometry as GeoJSON.Point).coordinates as [number, number]);
  if (map.getSource("txr-lines")) return { lineGeom, stationGeom };

  map.addSource("txr-lines", { type: "geojson", data: empty });
  map.addSource("txr-stations", { type: "geojson", data: empty });
  map.addSource("txr-selected", { type: "geojson", data: empty });
  const before = map.getLayer("tx-casing") ? "tx-casing" : undefined;
  const haloWidth = ["interpolate", ["linear"], ["zoom"], 4, 9, 10, 16] as unknown as number;
  map.addLayer({ id: "txr-selected-line", type: "line", source: "txr-selected", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 11, 10, 22], "line-opacity": 0.55, "line-blur": 2 } }, before);
  map.addLayer({ id: "txr-halo", type: "line", source: "txr-lines", filter: ["==", ["get", "anim"], "none"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": haloWidth, "line-opacity": 0.5, "line-blur": 3 } }, before);
  map.addLayer({ id: "txr-halo-anim", type: "line", source: "txr-lines", filter: ["!=", ["get", "anim"], "none"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": haloWidth, "line-opacity": 0.6, "line-blur": 3 } }, before);
  // Thin dashes on top of the voltage-coloured line. Approximate (section-level) matches use sparse dots.
  // Narrower than the voltage-coloured line underneath, so its colour stays visible along both edges.
  const dashWidth = ["interpolate", ["linear"], ["zoom"], 4, 0.8, 10, 1.4] as unknown as number;
  map.addLayer({ id: "txr-dash", type: "line", source: "txr-lines", filter: ["==", ["get", "approx"], 0], paint: { "line-color": ["get", "color"], "line-width": dashWidth, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "txr-dash-approx", type: "line", source: "txr-lines", filter: ["==", ["get", "approx"], 1], paint: { "line-color": ["get", "color"], "line-width": dashWidth, "line-dasharray": [0.6, 3] } });
  const ring = (id: string, filter: unknown) =>
    map.addLayer({
      id,
      type: "circle",
      source: "txr-stations",
      filter: filter as never,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 6, 10, 14], "circle-color": ["get", "color"], "circle-opacity": 0.18, "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5, "circle-stroke-opacity": 0.9 },
    });
  ring("txr-st", ["==", ["get", "anim"], "none"]);
  ring("txr-st-anim", ["!=", ["get", "anim"], "none"]);
  map.addLayer({ id: "txr-selected-st", type: "circle", source: "txr-selected", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 9, 10, 18], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  return { lineGeom, stationGeom };
}

export function updateOverlay(map: MLMap, h: OverlayHandle | null, items: TxRiskItem[], o: OverlayOptions, selectedId: string | null) {
  if (!h || !map.getSource("txr-lines")) return;
  const fc = overlayFeatures(items, h.lineGeom, h.stationGeom, o);
  (map.getSource("txr-lines") as GeoJSONSource).setData(fc.lines);
  (map.getSource("txr-stations") as GeoJSONSource).setData(fc.stations);
  const sel = selectedId ? items.find((i) => i.id === selectedId) : null;
  const selFeatures: GeoJSON.Feature[] = sel && o.enabled
    ? [
        ...sel.lineIds.map((id) => h.lineGeom.get(id)).filter(Boolean).map((g) => ({ type: "Feature" as const, geometry: g!, properties: {} })),
        ...sel.stationIds.map((id) => h.stationGeom.get(id)).filter(Boolean).map((c) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: c! }, properties: {} })),
      ]
    : [];
  (map.getSource("txr-selected") as GeoJSONSource).setData({ type: "FeatureCollection", features: selFeatures });
}

/** Drives the animated layers; returns a stop function. Does nothing if no animated layers exist. */
export function startAnimation(map: MLMap): () => void {
  let raf = 0;
  let last = 0;
  const tick = (ms: number) => {
    raf = requestAnimationFrame(tick);
    if (ms - last < 60) return; // ~16 fps is enough for a gentle pulse
    last = ms;
    const op = ["match", ["get", "anim"], "flash", animOpacity("flash", ms), "pulse", animOpacity("pulse", ms), 0.6];
    if (map.getLayer("txr-halo-anim")) map.setPaintProperty("txr-halo-anim", "line-opacity", op as never);
    if (map.getLayer("txr-st-anim")) map.setPaintProperty("txr-st-anim", "circle-stroke-opacity", op as never);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    if (map.getLayer("txr-halo-anim")) map.setPaintProperty("txr-halo-anim", "line-opacity", 0.6);
    if (map.getLayer("txr-st-anim")) map.setPaintProperty("txr-st-anim", "circle-stroke-opacity", 0.9);
  };
}

export function overlayItemAt(e: MapLayerMouseEvent): string | null {
  return (e.features?.[0]?.properties?.itemId as string | undefined) ?? null;
}
