"use client";

import type { Map as MLMap } from "maplibre-gl";
import dynamic from "next/dynamic";
import { AlertTriangle, Download, Expand, FileSpreadsheet, Home, Image as ImageIcon, Layers, Scaling } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FacilityState, StateResponse } from "@/lib/types";
import { STATUSES, STATUS_LABEL, STORAGE_MODE_LABEL, TECHNOLOGIES, TECHNOLOGY_LABEL } from "@/lib/types";
import { toCsv } from "@/lib/csv";
import { hourEndingLabel } from "@/lib/time";
import ComparePanel from "./ComparePanel";
import Dashboard from "./Dashboard";
import DetailPanel from "./DetailPanel";
import Header from "./Header";
import { StatusDot, TechIcon } from "./Icons";
import type { MapCommand } from "./MapView";
import { CoverageModal, MethodologyModal } from "./Modals";
import Sidebar, { applyFilters, defaultFilters, type Filters } from "./Sidebar";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted)]">Loading map…</div> });

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
  const [modal, setModal] = useState<"methodology" | "coverage" | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const mapRef = useRef<MLMap | null>(null);

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

  const all = useMemo(() => state?.facilities ?? [], [state]);
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
      />
      {meta?.mode === "historical" && (
        <div className="bg-fuchsia-600/20 px-3 py-1 text-center text-xs text-fuchsia-200">
          HISTORICAL MODE — showing IESO-reported values for {hourEndingLabel(meta.selectedTsUtc)}. Map, statuses and totals reflect that hour.{" "}
          <button className="underline" onClick={() => setSelectedTs(null)}>
            Return to latest
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
      {state && <Dashboard filtered={filtered} state={state} refreshKey={meta?.selectedTsUtc} />}

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
          />

          {/* Map toolbar */}
          <div className="absolute left-3 top-3 z-10 flex flex-col gap-1">
            {[
              { icon: <Home size={15} />, title: "Reset to full province", on: () => setCommand({ kind: "reset", nonce: Date.now() }) },
              { icon: <Expand size={15} />, title: "Fit all plotted facilities", on: () => setCommand({ kind: "fitAll", nonce: Date.now() }) },
              { icon: <Scaling size={15} />, title: `Marker size by installed capacity: ${scaleByCapacity ? "on" : "off"}`, on: () => setScaleByCapacity((s) => !s), active: scaleByCapacity },
              { icon: <Layers size={15} />, title: "Toggle legend", on: () => setLegendOpen((s) => !s), active: legendOpen },
              { icon: <Download size={15} />, title: "Export", on: () => setExportOpen((s) => !s), active: exportOpen },
            ].map((b) => (
              <button key={b.title} title={b.title} onClick={b.on} className={`rounded border border-[var(--border)] bg-[var(--panel)] p-1.5 shadow hover:bg-[var(--hover)] ${b.active ? "text-sky-400" : ""}`}>
                {b.icon}
              </button>
            ))}
          </div>
          {exportOpen && (
            <div className="absolute left-12 top-[132px] z-20 w-60 rounded border border-[var(--border)] bg-[var(--panel)] p-1 text-xs shadow-xl">
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
              {unplottedFiltered > 0 && (
                <button className="mt-2 text-amber-400 hover:underline" onClick={() => setModal("coverage")}>
                  {unplottedFiltered} matching facilit{unplottedFiltered === 1 ? "y" : "ies"} not plotted (unverified location)
                </button>
              )}
            </div>
          )}
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
