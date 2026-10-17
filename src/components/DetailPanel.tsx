"use client";

import { ExternalLink, GitCompare, Info, MapPin, X, AlertTriangle } from "lucide-react";
import { Fragment, useState } from "react";
import type { DataMeta, FacilityState } from "@/lib/types";
import { STORAGE_MODE_LABEL, TECHNOLOGY_LABEL } from "@/lib/types";
import { fmtMW, fmtPct } from "@/lib/ui";
import { formatOntario, hourEndingLabel } from "@/lib/time";
import { GenerationChart, RangeTabs, useHistory, type Range } from "./Charts";
import { StatusBadge, StatusDot, TechIcon } from "./Icons";

const CONF_TONE: Record<string, string> = {
  high: "text-green-400",
  medium: "text-sky-400",
  low: "text-amber-400",
  unverified: "text-red-400",
};

function Row({ k, v, sub }: { k: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <tr className="border-b border-[var(--border)] last:border-0">
      <td className="py-1 pr-2 text-[var(--muted)]">{k}</td>
      <td className="py-1 text-right font-mono tabular-nums">
        {v}
        {sub ? <div className="text-[10px] font-sans text-[var(--muted)]">{sub}</div> : null}
      </td>
    </tr>
  );
}

export default function DetailPanel({
  facility,
  meta,
  onClose,
  inCompare,
  onToggleCompare,
  refreshKey,
}: {
  facility: FacilityState;
  meta: DataMeta;
  onClose: () => void;
  inCompare: boolean;
  onToggleCompare: () => void;
  refreshKey: unknown;
}) {
  const [range, setRange] = useState<Range>("24h");
  const [showWhy, setShowWhy] = useState(false);
  const [openRes, setOpenRes] = useState<string | null>(null);
  const endTs = meta.mode === "historical" ? meta.selectedTsUtc : null;
  const { data, loading, error } = useHistory([facility.id], range, endTs, refreshKey);
  const hist = data[0];
  const f = facility;
  const vg = f.technology === "wind" || f.technology === "solar";
  const singleResource = f.resourceStates.length === 1;

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-start gap-3 border-b border-[var(--border)] p-3">
        <TechIcon tech={f.technology} size={18} boxed />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold leading-tight" title={f.name}>
            {f.name}
          </h2>
          <div className="text-xs text-[var(--muted)]">
            {TECHNOLOGY_LABEL[f.technology]}
            {f.subtype ? ` — ${f.subtype}` : ""}
          </div>
        </div>
        <button onClick={onToggleCompare} title={inCompare ? "Remove from comparison" : "Add to comparison"} className={`rounded p-1 hover:bg-white/10 ${inCompare ? "text-sky-400" : "text-[var(--muted)]"}`}>
          <GitCompare size={16} />
        </button>
        <button onClick={onClose} className="rounded p-1 text-[var(--muted)] hover:bg-white/10" title="Close">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {meta.mode === "historical" && (
          <div className="rounded border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-1 text-fuchsia-300">Historical view — {hourEndingLabel(meta.selectedTsUtc)}</div>
        )}
        <section className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <span className="text-[var(--muted)]">Location</span>
          <span className="flex items-center gap-1">
            <MapPin size={11} />
            {[f.municipality, "Ontario"].filter(Boolean).join(", ")}
            {f.region ? <span className="text-[var(--muted)]"> · {f.region} zone</span> : null}
          </span>
          <span className="text-[var(--muted)]">Coordinates</span>
          <span>
            {f.lat !== null && f.lon !== null ? `${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}` : "Not verified — not plotted"}{" "}
            <span className={CONF_TONE[f.geocodeConfidence]}>({f.geocodeConfidence} confidence)</span>
          </span>
          {f.geocodeSource && (
            <>
              <span className="text-[var(--muted)]">Geocode source</span>
              <span className="text-[var(--muted)]">{f.geocodeSource}</span>
            </>
          )}
          <span className="text-[var(--muted)]">Operator</span>
          <span>{f.operator ?? <i className="text-[var(--muted)]">Not verified</i>}</span>
          <span className="text-[var(--muted)]">Owner</span>
          <span>{f.owner ?? <i className="text-[var(--muted)]">Not verified</i>}</span>
          <span className="text-[var(--muted)]">Installed capacity</span>
          <span>
            {f.installedCapacityMW !== null && f.installedCapacityMW !== undefined ? fmtMW(f.installedCapacityMW) : <i className="text-[var(--muted)]">Not verified</i>}
            {f.capacitySource && /^https?:/.test(f.capacitySource) ? (
              <a href={f.capacitySource} target="_blank" rel="noreferrer" className="ml-1 text-sky-400 hover:underline">
                source
              </a>
            ) : f.capacitySource ? (
              <span className="ml-1 text-[var(--muted)]">({f.capacitySource})</span>
            ) : null}
          </span>
          {f.commissioningYear ? (
            <>
              <span className="text-[var(--muted)]">Commissioned</span>
              <span>{f.commissioningYear}</span>
            </>
          ) : null}
          <span className="text-[var(--muted)]">Reporting hour</span>
          <span>
            {hourEndingLabel(meta.selectedTsUtc)} <span className="text-[var(--muted)]">({formatOntario(meta.selectedTsUtc)})</span>
          </span>
        </section>

        {f.reviewFlag && (
          <div className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>Metadata flagged for review. {f.notes}</span>
          </div>
        )}

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-semibold uppercase tracking-wide text-[var(--muted)]">Generation summary</h3>
            <StatusBadge status={f.status} extra={f.storageMode ? STORAGE_MODE_LABEL[f.storageMode] : undefined} />
          </div>
          <table className="w-full">
            <tbody>
              <Row k="Actual generation (IESO)" v={fmtMW(f.outputMW)} />
              <Row k={vg ? "Available capacity (IESO)" : "Available capability (IESO)"} v={fmtMW(f.capabilityMW)} />
              {vg && <Row k="IESO forecast" v={fmtMW(f.forecastMW)} />}
              <Row k="Installed capacity" v={fmtMW(f.installedCapacityMW ?? null)} />
              <Row k="Capacity utilization" v={fmtPct(f.utilizationPct, 1)} sub={f.installedCapacityMW ? "output ÷ installed capacity" : "requires verified installed capacity"} />
              <Row k="Reference capability" v={fmtMW(f.referenceMW)} sub="max IESO-reported, trailing 30 days" />
              {f.derateMW !== null && f.derateMW > 0 && f.status !== "potential_oos" && (
                <Row k="Capability below reference" v={`${fmtMW(f.derateMW)} (${fmtPct(f.deratePct, 1)})`} sub="capability-based; not an official derate" />
              )}
            </tbody>
          </table>
          <button onClick={() => setShowWhy((s) => !s)} className="mt-1 flex items-center gap-1 text-sky-400 hover:underline">
            <Info size={12} /> {showWhy ? "Hide" : "How was this status determined?"}
          </button>
          {showWhy && (
            <ul className="mt-1 list-disc space-y-0.5 rounded bg-black/20 p-2 pl-5 text-[var(--muted)]">
              {f.explanation.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Reported IESO resources ({f.resourceStates.length})</h3>
          <table className="w-full">
            <thead>
              <tr className="text-left text-[10px] uppercase text-[var(--muted)]">
                <th className="py-1 font-medium">Resource</th>
                <th className="py-1 text-right font-medium">Output</th>
                <th className="py-1 text-right font-medium">{vg ? "Avail." : "Capab."}</th>
                <th className="py-1 pl-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {f.resourceStates.map((r) => (
                <Fragment key={r.iesoName}>
                  <tr className="cursor-pointer border-t border-[var(--border)] hover:bg-white/5" onClick={() => setOpenRes(openRes === r.iesoName ? null : r.iesoName)}>
                    <td className="py-1 font-mono text-[11px]" title={r.units ?? undefined}>
                      {r.iesoName}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums">{fmtMW(r.outputMW)}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{fmtMW(vg ? r.availCapacityMW : (r.capabilityMW ?? r.availCapacityMW))}</td>
                    <td className="py-1 pl-2">
                      <span className="flex items-center gap-1">
                        <StatusDot status={r.status} size={10} />
                        <span className="truncate text-[10px] text-[var(--muted)]">{r.storageMode ? STORAGE_MODE_LABEL[r.storageMode] : r.status.replace("_", " ")}</span>
                      </span>
                    </td>
                  </tr>
                  {openRes === r.iesoName && (
                    <tr key={r.iesoName + "-x"}>
                      <td colSpan={4} className="bg-black/20 p-2 text-[var(--muted)]">
                        {r.units && <div className="mb-1">Units: {r.units}</div>}
                        <div>IESO fuel: {r.iesoFuel} · Reference: {fmtMW(r.referenceMW)} {r.referenceBasis ? `(${r.referenceBasis})` : ""}</div>
                        {vg && <div>IESO forecast: {fmtMW(r.forecastMW)}</div>}
                        <ul className="mt-1 list-disc pl-4">
                          {r.explanation.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-[var(--muted)]">
            {singleResource ? (
              <>
                <b className="text-amber-300">Unit-Level Data Unavailable</b> — the IESO report publishes this facility as a single aggregate resource. Values are not split across physical units.
              </>
            ) : (
              <>Values are exactly as published per IESO resource. Correspondence between IESO resources and physical units is inferred from IESO naming unless stated; no values are allocated or estimated.</>
            )}
          </p>
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-semibold uppercase tracking-wide text-[var(--muted)]">Hourly history</h3>
            <RangeTabs value={range} onChange={setRange} />
          </div>
          {error ? (
            <div className="text-red-400">{error}</div>
          ) : (
            <div className={loading ? "opacity-50" : ""}>
              <GenerationChart points={hist?.points ?? []} technology={f.technology} range={range} markerTs={endTs} />
            </div>
          )}
          <p className="text-[10px] text-[var(--muted)]">Hourly averages as published by the IESO (hour-ending, EST). Not instantaneous values.</p>
        </section>

        {(f.sourceUrls.length > 0 || f.notes) && (
          <section>
            <h3 className="mb-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Sources & notes</h3>
            {f.notes && !f.reviewFlag && <p className="mb-1 text-[var(--muted)]">{f.notes}</p>}
            <ul className="space-y-0.5">
              {f.sourceUrls.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-sky-400 hover:underline">
                    <ExternalLink size={10} className="shrink-0" />
                    {u}
                  </a>
                </li>
              ))}
              <li className="text-[var(--muted)]">
                Operational data:{" "}
                <a href={meta.source} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                  IESO Generator Output and Capability Report
                </a>
              </li>
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
