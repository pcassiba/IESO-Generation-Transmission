"use client";

import type { Map as MLMap } from "maplibre-gl";
import dynamic from "next/dynamic";
import { Activity, AlertTriangle, ArrowLeftRight, Cable, DollarSign, Download, Expand, FileSpreadsheet, Home, Image as ImageIcon, Layers, Scaling, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CongestionResponse, PriceBasis } from "@/lib/congestion";
import { DEFAULT_VISIBLE, VOLTAGE_CLASSES, VOLTAGE_COLOR, VOLTAGE_LABEL, type VoltageClass } from "@/lib/transmission";
import type { FacilityState, StateResponse } from "@/lib/types";
import { STATUSES, STATUS_LABEL, STORAGE_MODE_LABEL, TECHNOLOGIES, TECHNOLOGY_LABEL } from "@/lib/types";
import { toCsv } from "@/lib/csv";
import { INTERTIE_GRADIENT_CSS, LMP_GRADIENT_CSS, facilityLmps, formatLmpShort, intertieMarkers, lmpScale } from "@/lib/lmp";
import { hourEndingLabel } from "@/lib/time";
import { CONGESTION_NEG, CONGESTION_POS } from "@/lib/ui";
import { LEGEND as TXR_LEGEND, RISK_COLOR } from "@/lib/txrisk/ui";
import ComparePanel from "./ComparePanel";
import CongestionPanel from "./CongestionPanel";
import Dashboard from "./Dashboard";
import DetailPanel from "./DetailPanel";
import Header from "./Header";
import { StatusDot, TechIcon } from "./Icons";
import type { IntertieOverlay, LmpOverlay, MapCommand } from "./MapView";
import { CoverageModal, MethodologyModal } from "./Modals";
import { SourcesModal } from "./SourcesModal";
import Sidebar, { applyFilters, defaultFilters, type Filters } from "./Sidebar";
import TimeBar from "./txrisk/TimeBar";
import TxRiskPanel from "./txrisk/TxRiskPanel";
import { useTxRisk } from "./txrisk/useTxRisk";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted)]">Loading map…</div> });

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** "hourly average", "average of 7 of 12 intervals so far" or "5-min price, interval 7 (ends 14:35 EST)". */
function priceBasisLabel(c: CongestionResponse): string {
  if (c.priceBasis === "5min" && c.latestInterval) {
    const end = new Date(new Date(c.latestInterval.endUtc).getTime() - 5 * 3_600_000).toISOString().slice(11, 16);
    return `5-min price, interval ${c.latestInterval.interval} of 12 (ends ${end} EST)`;
  }
  if (c.hourIntervals !== null && c.hourIntervals < 12) return `average of ${c.hourIntervals} of 12 intervals so far`;
  return "hourly average";
}

export default function Explorer() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTs, setSelectedTs] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [scaleByCapacity, setScaleByCapacity] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [command, setCommand] = useState<MapCommand | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [modal, setModal] = useState<"methodology" | "coverage" | "sources" | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [showLines, setShowLines] = useState(true);
  const [lineClasses, setLineClasses] = useState<Record<VoltageClass, boolean>>(DEFAULT_VISIBLE);
  const [txStatus, setTxStatus] = useState<"ok" | "missing" | null>(null);
  const [showCongestion, setShowCongestion] = useState(false);
  const [congestion, setCongestion] = useState<CongestionResponse | null>(null);
  const [congestionError, setCongestionError] = useState<string | null>(null);
  /** The hour the stored congestion response was asked for (null = latest), to tell loading apart from a gap. */
  const [congestionFor, setCongestionFor] = useState<string | null | undefined>(undefined);
  const [showLmp, setShowLmp] = useState(false);
  const [showInterties, setShowInterties] = useState(false);
  /** Current hour only: average of the five-minute prices so far, or the newest five-minute price. */
  const [priceBasis, setPriceBasis] = useState<PriceBasis>("hourly");
  const mapRef = useRef<MLMap | null>(null);
  const tx = useTxRisk();
  const txOverlay = useMemo(
    () => ({ items: tx.data?.items ?? [], options: { enabled: tx.enabled, flashing: tx.flashing, reducedMotion: tx.reducedMotion }, selectedId: tx.selectedId }),
    [tx.data, tx.enabled, tx.flashing, tx.reducedMotion, tx.selectedId],
  );
  const pickTx = (id: string | null) => {
    tx.setSelectedId(id);
    const bbox = id ? tx.data?.items.find((i) => i.id === id)?.bbox : null;
    if (bbox) setCommand({ kind: "fitBounds", bbox, nonce: Date.now() });
  };

  const load = useCallback(async (ts: string | null) => {
    try {
      const res = await fetch(`/api/state${ts ? `?ts=${encodeURIComponent(ts)}` : ""}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      setState(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(selectedTs);
    if (selectedTs) return;
    const t = setInterval(() => void load(null), 60_000); // server polls IESO; client re-reads DB state
    return () => clearInterval(t);
  }, [selectedTs, load]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  // Congestion follows the selected hour (or the latest hour, refreshed with the rest of the state).
  const congestionTs = state?.meta.mode === "historical" ? state.meta.selectedTsUtc : null;
  const stateKey = state?.meta.latestTsUtc;
  useEffect(() => {
    if (!showCongestion && !showLmp && !showInterties) return;
    let cancelled = false;
    (async () => {
      try {
        const query = congestionTs ? `?ts=${encodeURIComponent(congestionTs)}` : priceBasis === "5min" ? "?price=5min" : "";
        const res = await fetch(`/api/congestion${query}`, { cache: "no-store" });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setCongestion(j);
          setCongestionFor(congestionTs);
          setCongestionError(null);
        }
      } catch (e) {
        if (!cancelled) setCongestionError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showCongestion, showLmp, showInterties, congestionTs, stateKey, priceBasis]);

  const lineVisibility = useMemo(
    () => Object.fromEntries(VOLTAGE_CLASSES.map((c) => [c, showLines && lineClasses[c]])) as Record<VoltageClass, boolean>,
    [showLines, lineClasses],
  );

  const all = useMemo(() => state?.facilities ?? [], [state]);

  // This hour's spread of facility prices; both the LMP view and the intertie circles are coloured against it.
  const priceScale = useMemo(() => {
    if (!congestion) return null;
    const mapped = new Set(all.filter((f) => f.lat !== null && f.lon !== null).map((f) => f.id));
    const priced = congestion.facilities.filter((f) => mapped.has(f.facilityId));
    return { priced, scale: lmpScale(priced.map((f) => f.lmp)) };
  }, [congestion, all]);

  // LMP view: one averaged price per mapped facility, coloured relative to this hour's spread.
  const lmpView = useMemo(() => {
    if (!showLmp || !priceScale) return null;
    const { priced, scale } = priceScale;
    return { scale, overlay: { byFacility: facilityLmps(priced, scale), hourTsUtc: congestion!.hourTsUtc, basisLabel: priceBasisLabel(congestion!) } satisfies LmpOverlay };
  }, [showLmp, priceScale, congestion]);

  // Interties: yellow circles, more intense the higher the intertie price sits against the facility prices.
  const intertieView = useMemo(() => {
    const tie = congestion?.interties;
    if (!showInterties || !tie || !priceScale) return null;
    return { overlay: { markers: intertieMarkers(tie.points, priceScale.scale), hourTsUtc: tie.hourTsUtc, medianLmp: congestion.medianLmp } satisfies IntertieOverlay };
  }, [showInterties, congestion, priceScale]);
  const filtered = useMemo(() => applyFilters(all, filters), [all, filters]);
  const selected = all.find((f) => f.id === selectedId) ?? null;
  const compareFacilities = compare.map((id) => all.find((f) => f.id === id)).filter((f): f is FacilityState => !!f);

  const pick = (id: string) => {
    setSelectedId(id);
    setFilters((f) => (f.query ? { ...f, query: "" } : f));
    setCommand({ kind: "flyTo", id, nonce: Date.now() });
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/refresh", { method: "POST" });
      const j = await r.json();
      setRefreshMsg(j.message);
      await load(selectedTs);
    } catch (e) {
      setRefreshMsg(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const exportFacilities = () => {
    const rows = filtered.map((f) => ({
      facility_id: f.id,
      name: f.name,
      technology: TECHNOLOGY_LABEL[f.technology],
      subtype: f.subtype,
      operator: f.operator,
      owner: f.owner,
      municipality: f.municipality,
      region: f.region,
      lat: f.lat,
      lon: f.lon,
      geocode_confidence: f.geocodeConfidence,
      installed_capacity_mw: f.installedCapacityMW,
      ieso_resources: f.resources.map((r) => r.ieso).join(";"),
      reporting_hour: hourEndingLabel(state?.meta.selectedTsUtc),
      reporting_ts_utc: state?.meta.selectedTsUtc,
      output_mw: f.outputMW,
      capability_mw: f.capabilityMW,
      forecast_mw: f.forecastMW,
      utilization_pct: f.utilizationPct?.toFixed(1),
      status: STATUS_LABEL[f.status],
      storage_mode: f.storageMode ? STORAGE_MODE_LABEL[f.storageMode] : "",
      derate_mw: f.derateMW?.toFixed(1),
      review_flag: f.reviewFlag,
      sources: f.sourceUrls.join(" "),
    }));
    download(`ontario_facilities_${(state?.meta.selectedTsUtc ?? "").slice(0, 13)}.csv`, new Blob([toCsv(rows, Object.keys(rows[0] ?? { facility_id: "" }))], { type: "text/csv" }));
    setExportOpen(false);
  };

  const exportGeneration = (range: string) => {
    const qs = new URLSearchParams({ ids: filtered.map((f) => f.id).join(","), range });
    if (state?.meta.mode === "historical" && state.meta.selectedTsUtc) qs.set("end", state.meta.selectedTsUtc);
    window.location.href = `/api/export?${qs}`;
    setExportOpen(false);
  };

  const exportPng = () => {
    const map = mapRef.current;
    if (!map) return;
    map.once("render", () => {
      map.getCanvas().toBlob((b) => b && download(`ontario_generation_map_${Date.now()}.png`, b), "image/png");
    });
    map.triggerRepaint();
    setExportOpen(false);
  };

  const meta = state?.meta ?? null;
  const unplottedFiltered = filtered.filter((f) => f.lat === null).length;

  return (
    <div className={`flex h-screen flex-col ${theme}`}>
      <Header
        meta={meta}
        theme={theme}
        setTheme={setTheme}
        onRefresh={refresh}
        refreshing={refreshing}
        refreshMsg={refreshMsg}
        onSelectTs={(ts) => setSelectedTs(ts)}
        onOpenMethodology={() => setModal("methodology")}
        onOpenCoverage={() => setModal("coverage")}
        onOpenSources={() => setModal("sources")}
      />
      {meta?.mode === "historical" && (
        <div className="bg-fuchsia-600/20 px-3 py-1 text-center text-xs text-fuchsia-200">
          HISTORICAL MODE — showing IESO-reported values for {hourEndingLabel(meta.selectedTsUtc)}. Map, LMP prices, statuses and totals reflect that hour.{" "}
          <button className="ml-1 rounded bg-green-500/25 px-2 py-0.5 font-semibold text-green-200 hover:bg-green-500/40" onClick={() => setSelectedTs(null)}>
            Back to live
          </button>
        </div>
      )}
      {meta && meta.mode === "latest" && (meta.stale || meta.lastError) && (
        <div className="flex items-center justify-center gap-2 bg-amber-500/15 px-3 py-1 text-xs text-amber-200">
          <AlertTriangle size={13} />
          {meta.latestTsUtc ? `STALE DATA — showing last successful IESO report (${hourEndingLabel(meta.latestTsUtc)}). ` : ""}
          {meta.staleReason}
        </div>
      )}
      {error && <div className="bg-red-600/20 px-3 py-1 text-center text-xs text-red-200">Could not load data from the server: {error}</div>}
      {refreshMsg && (
        <div className="bg-sky-500/10 px-3 py-0.5 text-center text-[11px] text-sky-200">
          {refreshMsg}{" "}
          <button className="underline" onClick={() => setRefreshMsg(null)}>
            dismiss
          </button>
        </div>
      )}
      {state && <Dashboard filtered={filtered} state={state} refreshKey={meta?.latestTsUtc} onSelectTs={setSelectedTs} />}

      <div className="flex min-h-0 flex-1">
        <Sidebar all={all} filtered={filtered} filters={filters} setFilters={setFilters} onPick={pick} collapsed={collapsed} setCollapsed={setCollapsed} />

        <main className="relative min-w-0 flex-1">
          <MapView
            facilities={filtered}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            theme={theme}
            scaleByCapacity={scaleByCapacity}
            command={command}
            onMapReady={(m) => (mapRef.current = m)}
            lineVisibility={lineVisibility}
            congestion={showCongestion ? congestion : null}
            onTransmissionStatus={setTxStatus}
            txRisk={txOverlay}
            onTxRiskPick={(id) => tx.setSelectedId(id)}
            lmp={lmpView?.overlay ?? null}
            interties={intertieView?.overlay ?? null}
          />

          {/* Outages & congestion risk: prominent toggle, flashing toggle and time selector */}
          <div className="pointer-events-none absolute left-14 right-14 top-3 z-10 flex flex-col items-start gap-1">
            <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel)]/95 px-2 py-1 text-[11px] shadow">
              <button
                onClick={() => setShowLmp((v) => !v)}
                aria-pressed={showLmp}
                title="Replace facility icons with each facility's real-time LMP (average of its units)"
                className={`flex items-center gap-1 rounded px-2 py-0.5 font-semibold ${showLmp ? "bg-red-500/25 text-red-200" : "hover:bg-[var(--hover)]"}`}
              >
                <DollarSign size={13} /> LMP: {showLmp ? "ON" : "OFF"}
              </button>
              {showLmp && !congestionTs && (
                <span className="flex items-center overflow-hidden rounded border border-[var(--border)]" title="Current hour only: IESO publishes a price every 5 minutes">
                  {(
                    [
                      ["hourly", "Hour average so far"],
                      ["5min", "Latest 5-min"],
                    ] as const
                  ).map(([b, label]) => (
                    <button
                      key={b}
                      onClick={() => setPriceBasis(b)}
                      aria-pressed={priceBasis === b}
                      className={`px-1.5 py-0.5 ${priceBasis === b ? "bg-sky-500/25 text-sky-200" : "hover:bg-[var(--hover)]"}`}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              )}
              <button
                onClick={() => setShowInterties((v) => !v)}
                aria-pressed={showInterties}
                title="Show IESO real-time intertie prices as yellow circles at each intertie; deeper yellow = pricier than Ontario's generators this hour"
                className={`flex items-center gap-1 rounded px-2 py-0.5 font-semibold ${showInterties ? "bg-yellow-400/25 text-yellow-200" : "hover:bg-[var(--hover)]"}`}
              >
                <ArrowLeftRight size={13} /> Interties: {showInterties ? "ON" : "OFF"}
              </button>
              <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
              <button
                onClick={() => tx.setEnabled((v) => !v)}
                aria-pressed={tx.enabled}
                className={`flex items-center gap-1 rounded px-2 py-0.5 font-semibold ${tx.enabled ? "bg-red-500/25 text-red-200" : "hover:bg-[var(--hover)]"}`}
              >
                <Zap size={13} /> Show Outages & Congestion Risk: {tx.enabled ? "ON" : "OFF"}
              </button>
              {tx.enabled && (
                <button
                  onClick={() => tx.setFlashing((v) => !v)}
                  aria-pressed={tx.flashing}
                  disabled={tx.reducedMotion}
                  title={tx.reducedMotion ? "Your system asks for reduced motion, so highlights stay static" : undefined}
                  className={`rounded px-2 py-0.5 disabled:opacity-50 ${tx.flashing && !tx.reducedMotion ? "bg-sky-500/20 text-sky-200" : "hover:bg-[var(--hover)]"}`}
                >
                  Enable Flashing Animations: {tx.flashing && !tx.reducedMotion ? "ON" : "OFF"}
                </button>
              )}
            </div>
            {showLmp && (
              <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)]/95 px-2 py-1 text-[11px] shadow">
                {congestionError ? (
                  <span className="text-red-300">Could not load prices: {congestionError}</span>
                ) : !congestion || congestionFor !== congestionTs ? (
                  <span className="text-[var(--muted)]">Loading prices{congestionTs ? ` for ${hourEndingLabel(congestionTs)}` : ""}… (older hours are fetched from IESO the first time)</span>
                ) : !lmpView?.scale ? (
                  <span className="text-amber-300">
                    {congestionTs ? "IESO has no real-time prices for this hour." : "No IESO real-time prices stored yet for this hour. They load with the next data refresh."}
                  </span>
                ) : (
                  <>
                    <span className="font-semibold">Real-time LMP</span>
                    <span className="text-[var(--muted)]">{hourEndingLabel(congestion.hourTsUtc)}</span>
                    <span className={congestion.priceBasis === "5min" ? "text-sky-300" : "text-[var(--muted)]"}>{priceBasisLabel(congestion)}</span>
                    {!congestionTs && priceBasis === "5min" && congestion.priceBasis !== "5min" && (
                      <span className="text-amber-300">5-min prices for this hour aren&apos;t downloaded yet, showing the average</span>
                    )}
                    {congestionTs && congestion.hourTsUtc !== congestionTs && (
                      <span className="text-amber-300">IESO prices for {hourEndingLabel(congestionTs)} aren&apos;t available, showing the nearest earlier hour</span>
                    )}
                    <span className="flex items-center gap-1 font-mono">
                      ≤ {formatLmpShort(lmpView.scale.low)}
                      <span className="inline-block h-2.5 w-28 rounded-sm border border-[var(--border)]" style={{ background: LMP_GRADIENT_CSS }} />≥ {formatLmpShort(lmpView.scale.high)}
                    </span>
                    {congestion.medianLmp !== null && <span className="text-[var(--muted)]">Ontario median ${congestion.medianLmp.toFixed(2)}/MWh</span>}
                    <span className="text-[var(--muted)]">· {lmpView.overlay.byFacility.size} facilities priced, grey = no pricing link</span>
                  </>
                )}
              </div>
            )}
            {showInterties && (
              <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)]/95 px-2 py-1 text-[11px] shadow">
                {congestionError ? (
                  <span className="text-red-300">Could not load intertie prices: {congestionError}</span>
                ) : !congestion || congestionFor !== congestionTs ? (
                  <span className="text-[var(--muted)]">Loading intertie prices{congestionTs ? ` for ${hourEndingLabel(congestionTs)}` : ""}…</span>
                ) : !congestion.interties?.points.length ? (
                  <span className="text-amber-300">
                    {congestion.interties?.fetchError
                      ? `Could not load the IESO intertie price report: ${congestion.interties.fetchError}`
                      : congestionTs
                        ? "IESO has no intertie prices for this hour."
                        : "No IESO intertie prices stored yet. They load with the next data refresh."}
                  </span>
                ) : !priceScale?.scale ? (
                  <span className="text-amber-300">No Ontario facility prices for this hour to compare the interties against.</span>
                ) : (
                  <>
                    <span className="font-semibold">Intertie LMP</span>
                    <span className="text-[var(--muted)]">{hourEndingLabel(congestion.interties.hourTsUtc)}</span>
                    {congestion.interties.hourTsUtc !== congestion.hourTsUtc && (
                      <span className="text-amber-300">intertie prices for {hourEndingLabel(congestion.hourTsUtc)} aren&apos;t available, showing the nearest earlier hour</span>
                    )}
                    <span className="flex items-center gap-1 font-mono">
                      ≤ {formatLmpShort(priceScale.scale.low)}
                      <span className="inline-block h-2.5 w-28 rounded-sm border-2 border-yellow-500" style={{ background: INTERTIE_GRADIENT_CSS }} />≥ {formatLmpShort(priceScale.scale.high)}
                    </span>
                    <span className="text-[var(--muted)]">· scale = Ontario facility prices this hour · {congestion.interties.points.length} interties · positions approximate</span>
                  </>
                )}
              </div>
            )}
            {tx.enabled && (
              <div className="w-full max-w-2xl">
                <TimeBar preset={tx.preset} setPreset={tx.setPreset} tUtc={tx.tUtc} setT={tx.setT} nowUtc={tx.data?.nowUtc ?? new Date().toISOString()} items={tx.data?.items ?? []} />
              </div>
            )}
          </div>

          {/* Map toolbar */}
          <div className="absolute left-3 top-3 z-10 flex flex-col gap-1">
            {[
              { icon: <Home size={15} />, title: "Reset to full province", on: () => setCommand({ kind: "reset", nonce: Date.now() }) },
              { icon: <Expand size={15} />, title: "Fit all plotted facilities", on: () => setCommand({ kind: "fitAll", nonce: Date.now() }) },
              { icon: <Scaling size={15} />, title: `Marker size by installed capacity: ${scaleByCapacity ? "on" : "off"}`, on: () => setScaleByCapacity((s) => !s), active: scaleByCapacity },
              { icon: <Cable size={15} />, title: `Transmission lines: ${showLines ? "on" : "off"}`, on: () => setShowLines((s) => !s), active: showLines },
              { icon: <Activity size={15} />, title: `Congestion (IESO nodal prices): ${showCongestion ? "on" : "off"}`, on: () => setShowCongestion((s) => !s), active: showCongestion },
              { icon: <Zap size={15} />, title: `Outages & congestion risk: ${tx.enabled ? "on" : "off"}`, on: () => tx.setEnabled((v) => !v), active: tx.enabled },
              { icon: <Layers size={15} />, title: "Toggle legend", on: () => setLegendOpen((s) => !s), active: legendOpen },
              { icon: <Download size={15} />, title: "Export", on: () => setExportOpen((s) => !s), active: exportOpen },
            ].map((b) => (
              <button key={b.title} title={b.title} onClick={b.on} className={`rounded border border-[var(--border)] bg-[var(--panel)] p-1.5 shadow hover:bg-[var(--hover)] ${b.active ? "text-sky-400" : ""}`}>
                {b.icon}
              </button>
            ))}
          </div>
          {exportOpen && (
            <div className="absolute left-12 top-[196px] z-20 w-60 rounded border border-[var(--border)] bg-[var(--panel)] p-1 text-xs shadow-xl">
              <button onClick={exportFacilities} className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hover)]">
                <FileSpreadsheet size={13} /> Filtered facilities (CSV)
              </button>
              {(["24h", "7d", "30d"] as const).map((r) => (
                <button key={r} onClick={() => exportGeneration(r)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hover)]">
                  <FileSpreadsheet size={13} /> Hourly generation, {r} (CSV)
                </button>
              ))}
              <button onClick={exportPng} className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--hover)]">
                <ImageIcon size={13} /> Current map view (PNG)
              </button>
            </div>
          )}

          {legendOpen && (
            <div className="absolute bottom-8 left-3 z-10 rounded border border-[var(--border)] bg-[var(--panel)]/95 p-2 text-[11px] shadow">
              {!showLmp && (
                <>
                  <div className="mb-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Technology</div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    {TECHNOLOGIES.map((t) => (
                      <span key={t} className="flex items-center gap-1.5">
                        <TechIcon tech={t} size={10} boxed /> {TECHNOLOGY_LABEL[t]}
                      </span>
                    ))}
                  </div>
                  <div className="mb-1 mt-2 font-semibold uppercase tracking-wide text-[var(--muted)]">Status (marker corner)</div>
                  <div className="grid grid-cols-1 gap-0.5">
                    {STATUSES.map((s) => (
                      <span key={s} className="flex items-center gap-1.5">
                        <StatusDot status={s} size={11} /> {STATUS_LABEL[s]}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {showLines && (
                <>
                  <div className="mb-1 mt-2 font-semibold uppercase tracking-wide text-[var(--muted)]">Transmission</div>
                  {txStatus === "missing" ? (
                    <div className="max-w-56 text-amber-400">
                      Line data not built yet. Run <span className="font-mono">npm run build:transmission</span> once, then reload.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-0.5">
                      {VOLTAGE_CLASSES.map((c) => (
                        <label key={c} className="flex cursor-pointer items-center gap-1.5">
                          <input type="checkbox" className="h-3 w-3" checked={lineClasses[c]} onChange={() => setLineClasses((v) => ({ ...v, [c]: !v[c] }))} />
                          <span className="inline-block h-[3px] w-5 rounded" style={{ background: VOLTAGE_COLOR[c], opacity: c === "unknown" ? 0.6 : 1 }} />
                          {VOLTAGE_LABEL[c]}
                        </label>
                      ))}
                      <span className="text-[10px] text-[var(--muted)]">Lines © OpenStreetMap contributors</span>
                    </div>
                  )}
                </>
              )}
              {tx.enabled && (
                <>
                  <div className="mb-1 mt-2 font-semibold uppercase tracking-wide text-[var(--muted)]">Outages & congestion risk</div>
                  <div className="grid grid-cols-1 gap-0.5">
                    {TXR_LEGEND.map((l) => (
                      <span key={l.cat} className="flex items-center gap-1.5" title={l.hint}>
                        {l.cat === "normal" ? (
                          <span className="inline-block h-[3px] w-5 rounded" style={{ background: "linear-gradient(90deg,#ef4444,#f59e0b,#3b82f6)" }} />
                        ) : (
                          <span className="inline-block h-[7px] w-5 rounded" style={{ background: `${RISK_COLOR[l.cat]}88`, boxShadow: `inset 0 0 0 1px ${RISK_COLOR[l.cat]}` }} />
                        )}
                        {l.label}
                      </span>
                    ))}
                    <span className="text-[10px] text-[var(--muted)]">Rings mark stations; dotted = section of a circuit (approximate)</span>
                  </div>
                </>
              )}
              {showCongestion && (
                <>
                  <div className="mb-1 mt-2 font-semibold uppercase tracking-wide text-[var(--muted)]">Congestion (halo)</div>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: CONGESTION_NEG, background: `${CONGESTION_NEG}55` }} /> Output held back (negative)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: CONGESTION_POS, background: `${CONGESTION_POS}55` }} /> Import-constrained (positive)
                  </span>
                </>
              )}
              {unplottedFiltered > 0 && (
                <button className="mt-2 text-amber-400 hover:underline" onClick={() => setModal("coverage")}>
                  {unplottedFiltered} matching facilit{unplottedFiltered === 1 ? "y" : "ies"} not plotted (unverified location)
                </button>
              )}
            </div>
          )}
          {tx.enabled && (
            <TxRiskPanel
              data={tx.data}
              error={tx.error}
              loading={tx.loading}
              selectedId={tx.selectedId}
              onSelect={pickTx}
              onRefresh={tx.refresh}
              refreshing={tx.refreshing}
              refreshMsg={tx.refreshMsg}
              onClose={() => tx.setEnabled(false)}
            />
          )}
          {showCongestion && <CongestionPanel data={congestion} error={congestionError} facilities={all} onPick={pick} onClose={() => setShowCongestion(false)} />}
        </main>

        {selected && meta && (
          <DetailPanel
            facility={selected}
            meta={meta}
            onClose={() => setSelectedId(null)}
            inCompare={compare.includes(selected.id)}
            onToggleCompare={() => setCompare((c) => (c.includes(selected.id) ? c.filter((x) => x !== selected.id) : [...c, selected.id].slice(-8)))}
            refreshKey={meta.selectedTsUtc}
          />
        )}
      </div>

      {compareFacilities.length > 0 && meta && (
        <ComparePanel
          facilities={compareFacilities}
          meta={meta}
          onRemove={(id) => setCompare((c) => c.filter((x) => x !== id))}
          onClear={() => setCompare([])}
          onPick={pick}
          refreshKey={meta.selectedTsUtc}
        />
      )}

      {modal === "methodology" && <MethodologyModal onClose={() => setModal(null)} />}
      {modal === "sources" && <SourcesModal ts={meta?.mode === "historical" ? meta.selectedTsUtc : null} onClose={() => setModal(null)} />}
      {modal === "coverage" && state && (
        <CoverageModal
          state={state}
          onClose={() => setModal(null)}
          onPick={(id) => {
            setModal(null);
            pick(id);
          }}
        />
      )}
    </div>
  );
}
