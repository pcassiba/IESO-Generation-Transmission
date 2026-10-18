"use client";

import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, ExternalLink, MapPinOff, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatOntario } from "@/lib/time";
import type { TxRiskItem, TxRiskResponse } from "@/lib/txrisk/types";
import { RISK_COLOR, defaultTableFilters, matchesFilters, sortItems, type SortKey, type TableFilters } from "@/lib/txrisk/ui";

interface Props {
  data: TxRiskResponse | null;
  error: string | null;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshMsg: string | null;
  onClose: () => void;
}

const KIND_CHIPS: { key: TableFilters["kinds"] extends Set<infer K> ? K : never; label: string }[] = [
  { key: "activeOutages", label: "Active outages" },
  { key: "forced", label: "Forced" },
  { key: "planned", label: "Planned" },
  { key: "restrictions", label: "Published restrictions" },
  { key: "potential", label: "Potential congestion" },
  { key: "binding", label: "Binding constraints" },
];

const COLS: { key: SortKey; label: string; w: string }[] = [
  { key: "title", label: "Equipment / Interface", w: "min-w-40" },
  { key: "region", label: "Region", w: "" },
  { key: "voltage", label: "kV", w: "" },
  { key: "status", label: "Outage status", w: "min-w-28" },
  { key: "limit", label: "Limit MW", w: "" },
  { key: "reduction", label: "Reduction MW", w: "" },
  { key: "category", label: "Classification", w: "min-w-28" },
  { key: "start", label: "Start", w: "" },
  { key: "end", label: "End", w: "" },
];

const range = (r: [number, number] | null | undefined, unit = "") => (!r ? "—" : r[0] === r[1] ? `${r[0]}${unit}` : `${r[0]}–${r[1]}${unit}`);
const when = (iso: string | null) => (iso ? formatOntario(iso) : "—");

function Badge({ item }: { item: TxRiskItem }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: RISK_COLOR[item.category] }} />
      {item.categoryLabel}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-[var(--border)] pt-1.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[var(--muted)]">{k}</span>
      <span className="text-right">{v ?? "—"}</span>
    </div>
  );
}

/** Popup content for one outage, limit or binding constraint. */
function Detail({ item, onBack }: { item: TxRiskItem; onBack: () => void }) {
  const ieso = item.evidence.filter((e) => e.source === "ieso");
  const app = item.evidence.filter((e) => e.source === "app");
  return (
    <div className="space-y-2 p-2">
      <button onClick={onBack} className="flex items-center gap-1 text-sky-400 hover:underline">
        <ArrowLeft size={12} /> Back to list
      </button>
      <div>
        <div className="text-[13px] font-semibold">{item.title}</div>
        {item.subtitle && <div className="text-[var(--muted)]">{item.subtitle}</div>}
        <div className="mt-1">
          <Badge item={item} />
        </div>
      </div>
      <Section title="Transmission asset">
        {item.kind === "outage" &&
          item.equipment?.map((e) => (
            <div key={e.name} className="mb-1">
              <div className="font-mono">{e.name}</div>
              <div className="text-[var(--muted)]">
                {e.type ?? "type not stated"} · {e.rawVoltage ?? "voltage not stated"}
                {e.circuit ? ` · circuit ${e.circuit}` : ""}
                {e.terminals?.length ? ` · terminals ${e.terminals.join(" – ")}` : ""}
                {e.station ? ` · station ${e.station}` : ""}
                {` · ${e.match === "none" ? "not on map" : e.match === "circuit-section" ? "section of mapped circuit (approximate)" : `mapped by ${e.match}`}`}
              </div>
            </div>
          ))}
        {item.kind !== "outage" && (
          <>
            <Row k={item.kind === "binding" ? "Constraint" : "Interface"} v={item.interfaceName ?? item.constraintName} />
            <Row k="Interface code" v={item.interfaceCode} />
            {item.facilityType && <Row k="Type" v={item.facilityType} />}
            <Row k="Voltage (mapped lines)" v={item.voltageKv ? `${item.voltageKv} kV` : "—"} />
          </>
        )}
        <Row k="Region (approx.)" v={item.region} />
        <div className="mt-1 text-[10px] text-[var(--muted)]">{item.matchNote}</div>
      </Section>
      {item.kind === "outage" && (
        <Section title="Outage information (IESO)">
          <Row k="Outage ID" v={<span className="font-mono">{item.outageId}</span>} />
          <Row k="Priority" v={item.priorityLabel ? `${item.priorityLabel} (${item.priority})` : item.priority} />
          <Row k="Request status" v={item.requestStatusLabel ? `${item.requestStatusLabel} (${item.requestStatus})` : item.requestStatus} />
          <Row k="Recurrence" v={item.recurrenceLabel ? `${item.recurrenceLabel} (${item.recurrence})` : item.recurrence} />
          <Row k="Planned start" v={`${item.startRaw ?? "—"} EST`} />
          <Row k="Planned end" v={`${item.endRaw ?? "—"} EST`} />
          <Row k="At selected time" v={item.statusText} />
        </Section>
      )}
      {item.kind === "limit" && (
        <Section title="Transmission limits">
          <Row k="Published operating limit" v={item.operatingLimitMW !== null ? `${item.operatingLimitMW} MW` : "not stated"} />
          <Row k="All-in-service limit" v={item.baselineMW?.length ? `${item.baselineMW.join(" / ")} MW` : "no comparable record"} />
          <Row k="Reduction" v={item.reductionMW ? `${range(item.reductionMW, " MW")} (${range(item.reductionPct, " %")})` : "—"} />
          <Row k="Effective" v={`${item.startRaw ?? "?"} → ${item.endRaw ?? "?"} EST`} />
          <Row k="Issued" v={item.issueDateRaw ? `${item.issueDateRaw} EST` : "—"} />
          <Row k="IESO comment" v={item.comments} />
          {item.baselineNote && <div className="mt-1 text-[10px] text-[var(--muted)]">{item.baselineNote}</div>}
        </Section>
      )}
      <Section title="Congestion assessment">
        <Row k="Classification" v={<Badge item={item} />} />
        {item.score && <Row k="Evidence score" v={`${item.score.points} (threshold 3; not a probability)`} />}
        <div className="mt-1 font-semibold">Verified IESO information</div>
        <ul className="ml-3 list-disc">{ieso.map((e, k) => <li key={k}>{e.text}</li>)}</ul>
        {app.length > 0 && (
          <>
            <div className="mt-1 font-semibold">Application analysis</div>
            <ul className="ml-3 list-disc text-[var(--muted)]">{app.map((e, k) => <li key={k}>{e.text}</li>)}</ul>
          </>
        )}
        {item.implications.length > 0 && (
          <>
            <div className="mt-1 font-semibold">Possible implications (analysis)</div>
            <ul className="ml-3 list-disc text-[var(--muted)]">{item.implications.map((t, k) => <li key={k}>{t}</li>)}</ul>
          </>
        )}
        {item.nearbyGeneration.length > 0 && (
          <div className="mt-1 text-[var(--muted)]">
            Nearby generation: {item.nearbyGeneration.map((g) => `${g.name}${g.mw ? ` (${Math.round(g.mw)} MW)` : ""}, ${g.km} km`).join("; ")}
          </div>
        )}
        <div className="mt-1 font-semibold">Data limitations</div>
        <ul className="ml-3 list-disc text-[var(--muted)]">{item.limitations.map((t, k) => <li key={k}>{t}</li>)}</ul>
      </Section>
      <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sky-400 hover:underline">
        <ExternalLink size={12} /> IESO source report
      </a>
    </div>
  );
}

export default function TxRiskPanel({ data, error, loading, selectedId, onSelect, onRefresh, refreshing, refreshMsg, onClose }: Props) {
  const [filters, setFilters] = useState<TableFilters>(defaultTableFilters);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "category", dir: 1 });
  // Starts collapsed so turning the layer on leaves the map clear; picking an item on the map opens it.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    if (selectedId) setCollapsed(false);
  }, [selectedId]);
  const [showStatus, setShowStatus] = useState(false);
  const [showUnmapped, setShowUnmapped] = useState(false);
  const items = useMemo(() => data?.items ?? [], [data]);
  const regions = useMemo(() => [...new Set(items.map((i) => i.region ?? "Unknown"))].sort(), [items]);
  const rows = useMemo(() => sortItems(items.filter((i) => matchesFilters(i, filters)), sort.key, sort.dir), [items, filters, sort]);
  const unmapped = items.filter((i) => i.match === "none" && i.category !== "info");
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const staleReports = data?.reports.filter((r) => r.stale) ?? [];
  const failedReports = data?.reports.filter((r) => !r.stale && r.lastError) ?? [];
  const toggleKind = (k: (typeof KIND_CHIPS)[number]["key"]) =>
    setFilters((f) => {
      const kinds = new Set(f.kinds);
      if (kinds.has(k)) kinds.delete(k);
      else kinds.add(k);
      return { ...f, kinds };
    });

  if (collapsed)
    return (
      <button onClick={() => setCollapsed(false)} className="absolute right-12 top-28 z-10 flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] shadow">
        <ChevronDown size={12} /> Show outages & congestion list ({rows.length})
      </button>
    );

  return (
    <div className="absolute bottom-8 right-12 top-28 z-10 flex w-[min(680px,calc(100%-4rem))] flex-col rounded border border-[var(--border)] bg-[var(--panel)]/97 text-[11px] shadow-xl">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-2 py-1.5">
        <div className="min-w-0">
          <div className="font-semibold">Transmission outages & congestion risk</div>
          <div className="truncate text-[10px] text-[var(--muted)]">
            {data ? `Evaluated for ${formatOntario(data.tUtc)} · ${data.mode === "current" ? "current" : data.mode === "future" ? "future (scheduled only)" : "past"}` : "IESO public reports"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={onRefresh} disabled={refreshing} className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 hover:bg-[var(--hover)] disabled:opacity-50" title="Re-check all four IESO reports now">
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> Refresh IESO data
          </button>
          <button
            onClick={() => {
              setCollapsed(true);
              onSelect(null); // so clicking the same line again reopens the panel
            }}
            title="Hide the list (the map layer stays on)" className="rounded p-1 hover:bg-[var(--hover)]">
            <ChevronRight size={13} />
          </button>
          <button onClick={onClose} title="Turn off the layer" className="rounded p-1 hover:bg-[var(--hover)]">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Report freshness */}
      <div className="border-b border-[var(--border)] px-2 py-1">
        <button className="flex w-full items-center gap-1 text-left" onClick={() => setShowStatus((s) => !s)}>
          {showStatus ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {staleReports.length ? (
            <span className="flex items-center gap-1 text-amber-400">
              <AlertTriangle size={11} /> {staleReports.length} report{staleReports.length > 1 ? "s" : ""} stale or unavailable
            </span>
          ) : failedReports.length ? (
            <span className="flex items-center gap-1 text-amber-300">
              <AlertTriangle size={11} /> Latest download failed for {failedReports.length} report{failedReports.length > 1 ? "s" : ""}; showing the last good copies
            </span>
          ) : (
            <span className="text-[var(--muted)]">Report status{data ? `: outages published ${when(data.reports.find((r) => r.kind === "outages")?.publishedUtc ?? null)}` : ""}</span>
          )}
        </button>
        {showStatus && data && (
          <table className="mt-1 w-full">
            <tbody>
              {data.reports.map((r) => (
                <tr key={r.kind} className={r.stale ? "text-amber-400" : ""}>
                  <td className="pr-2">
                    <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {r.label}
                    </a>
                  </td>
                  <td className="pr-2">published {when(r.publishedUtc)}</td>
                  <td className="pr-2">checked {when(r.lastSuccessUtc)}</td>
                  <td>{r.staleReason ?? `${r.records} records`}</td>
                </tr>
              ))}
              <tr>
                <td className="pr-2">Binding constraints</td>
                <td colSpan={3}>IESO shadow prices through {when(data.bindingDataThroughUtc)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {refreshMsg && <div className="text-sky-300">{refreshMsg}</div>}
        {data?.notes.map((n) => (
          <div key={n} className="text-amber-300">
            {n}
          </div>
        ))}
      </div>

      {error && <div className="px-2 py-1 text-red-400">Could not load: {error}</div>}
      {!data && !error && <div className="px-2 py-1 text-[var(--muted)]">{loading ? "Loading IESO reports…" : "No data"}</div>}

      {selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Detail item={selected} onBack={() => onSelect(null)} />
        </div>
      ) : (
        data && (
          <>
            <div className="space-y-1 border-b border-[var(--border)] px-2 py-1.5">
              <div className="flex flex-wrap gap-1">
                <input
                  value={filters.query}
                  onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
                  placeholder="Search equipment, interface, outage ID…"
                  className="min-w-40 flex-1 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5"
                />
                <select value={filters.voltage} onChange={(e) => setFilters((f) => ({ ...f, voltage: e.target.value as TableFilters["voltage"] }))} className="rounded border border-[var(--border)] bg-[var(--panel)] px-1">
                  <option value="all">All voltages</option>
                  <option value="500">500 kV</option>
                  <option value="230">230 kV</option>
                  <option value="115">115 kV</option>
                  <option value="other">Other / unknown</option>
                </select>
                <select value={filters.region} onChange={(e) => setFilters((f) => ({ ...f, region: e.target.value }))} className="rounded border border-[var(--border)] bg-[var(--panel)] px-1">
                  <option value="all">All regions</option>
                  {regions.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {KIND_CHIPS.map((c) => (
                  <button key={c.key} onClick={() => toggleKind(c.key)} className={`rounded-full border px-1.5 py-0.5 ${filters.kinds.has(c.key) ? "border-sky-400 bg-sky-500/20 text-sky-200" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}>
                    {c.label}
                  </button>
                ))}
                <label className="ml-1 flex items-center gap-1 text-[var(--muted)]">
                  <input type="checkbox" className="h-3 w-3" checked={filters.includeInactive} onChange={(e) => setFilters((f) => ({ ...f, includeInactive: e.target.checked }))} />
                  Include not in effect / informational
                </label>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[900px] border-collapse whitespace-nowrap">
                <thead className="sticky top-0 bg-[var(--panel)]">
                  <tr>
                    {COLS.map((c) => (
                      <th key={c.key} className={`cursor-pointer whitespace-nowrap border-b border-[var(--border)] px-1 py-1 text-left font-semibold ${c.w}`} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : 1 }))}>
                        {c.label}
                        {sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id} onClick={() => onSelect(i.id)} className="cursor-pointer border-b border-[var(--border)]/50 hover:bg-[var(--hover)]">
                      <td className="max-w-56 px-1 py-0.5">
                        <div className="flex items-center gap-1">
                          {i.match === "none" && <MapPinOff size={11} className="shrink-0 text-[var(--muted)]" aria-label="No verified map geometry" />}
                          <span className="truncate" title={i.subtitle ?? undefined}>
                            {i.title}
                          </span>
                        </div>
                      </td>
                      <td className="px-1">{i.region ?? "—"}</td>
                      <td className="px-1">{i.voltageKv ?? "—"}</td>
                      <td className="max-w-44 truncate px-1" title={i.statusText}>
                        {i.kind === "outage" ? i.statusText : "—"}
                      </td>
                      <td className="px-1 text-right">{i.operatingLimitMW ?? "—"}</td>
                      <td className="px-1 text-right">{range(i.reductionMW)}</td>
                      <td className="px-1">
                        <Badge item={i} />
                      </td>
                      <td className="whitespace-nowrap px-1">{when(i.startUtc)}</td>
                      <td className="whitespace-nowrap px-1">{when(i.endUtc)}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={COLS.length} className="p-2 text-center text-[var(--muted)]">
                        Nothing matches these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[var(--border)] px-2 py-1">
              <button className="flex items-center gap-1" onClick={() => setShowUnmapped((s) => !s)}>
                {showUnmapped ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <MapPinOff size={11} /> Unmapped outages & constraints ({unmapped.length})
              </button>
              {showUnmapped && (
                <div className="mt-1 max-h-40 overflow-y-auto">
                  <div className="mb-1 text-[10px] text-[var(--muted)]">In effect or upcoming, but with no verified map geometry, so not drawn.</div>
                  {unmapped.map((i) => (
                    <button key={i.id} onClick={() => onSelect(i.id)} className="flex w-full justify-between gap-2 rounded px-1 text-left hover:bg-[var(--hover)]">
                      <span className="truncate">{i.title}</span>
                      <span className="shrink-0 text-[var(--muted)]">{i.categoryLabel}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}
