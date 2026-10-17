"use client";

import { ChevronDown, Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FacilityState, StateResponse, Technology } from "@/lib/types";
import { TECHNOLOGIES, TECHNOLOGY_LABEL } from "@/lib/types";
import { TECH_COLOR, fmtMW, fmtNum } from "@/lib/ui";
import { formatOntario, hourEndingLabel } from "@/lib/time";
import { RangeTabs, type Range } from "./Charts";
import { TechIcon } from "./Icons";

const FUEL_COLORS: Record<string, string> = {
  NUCLEAR: TECH_COLOR.nuclear,
  HYDRO: TECH_COLOR.hydro,
  GAS: TECH_COLOR.gas,
  WIND: TECH_COLOR.wind,
  SOLAR: TECH_COLOR.solar,
  BIOFUEL: TECH_COLOR.bioenergy,
  OTHER: TECH_COLOR.storage,
};

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-[96px] border-r border-[var(--border)] px-3 py-1.5 last:border-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`font-mono text-base font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub ? <div className="text-[10px] text-[var(--muted)]">{sub}</div> : null}
    </div>
  );
}

export default function Dashboard({ filtered, state, refreshKey }: { filtered: FacilityState[]; state: StateResponse; refreshKey: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [range, setRange] = useState<Range>("24h");
  const [fuelHist, setFuelHist] = useState<Record<string, number | string>[]>([]);
  const meta = state.meta;

  const stats = useMemo(() => {
    const byTech = new Map<Technology, number>();
    let total = 0;
    let resources = 0;
    let generating = 0;
    let derated = 0;
    let potOos = 0;
    let confirmed = 0;
    for (const f of filtered) {
      resources += f.resourceStates.filter((r) => r.hasData).length;
      const out = f.outputMW !== null ? Math.max(0, f.outputMW) : 0;
      total += out;
      byTech.set(f.technology, (byTech.get(f.technology) ?? 0) + out);
      if (f.isGenerating) generating++;
      if (f.status === "derated") derated++;
      if (f.status === "potential_oos") potOos++;
      if (f.status === "confirmed_oos") confirmed++;
    }
    return { byTech, total, resources, generating, derated, potOos, confirmed };
  }, [filtered]);

  const allReported = useMemo(() => {
    const mapped = state.facilities.reduce((a, f) => a + Math.max(0, f.outputMW ?? 0), 0);
    const unmatched = state.unmatched.reduce((a, u) => a + Math.max(0, u.outputMW ?? 0), 0);
    return { mapped, unmatched, total: mapped + unmatched };
  }, [state]);

  useEffect(() => {
    if (!expanded) return;
    const qs = new URLSearchParams({ fuel: "1", range });
    if (meta.mode === "historical" && meta.selectedTsUtc) qs.set("end", meta.selectedTsUtc);
    fetch(`/api/history?${qs}`)
      .then((r) => r.json())
      .then((j) => setFuelHist(j.points ?? []))
      .catch(() => setFuelHist([]));
  }, [expanded, range, meta.mode, meta.selectedTsUtc, refreshKey]);

  const maxTech = Math.max(1, ...stats.byTech.values());
  const plotted = filtered.filter((f) => f.lat !== null).length;

  return (
    <div className="border-b border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-stretch overflow-x-auto">
        <Kpi
          label="Reported generation"
          value={fmtMW(stats.total)}
          sub={
            <button className="inline-flex items-center gap-0.5 text-sky-400 hover:underline" onClick={() => setShowDisclosure((s) => !s)}>
              <Info size={10} /> what&apos;s included
            </button>
          }
        />
        <Kpi label="Facilities shown" value={fmtNum(filtered.length)} sub={`${plotted} plotted · ${stats.resources} resources`} />
        <Kpi label="Generating" value={fmtNum(stats.generating)} tone="text-green-400" />
        <Kpi label="Pot. derated" value={fmtNum(stats.derated)} tone="text-amber-400" />
        <Kpi label="Pot. out of service" value={fmtNum(stats.potOos)} tone="text-red-400" sub="not confirmed" />
        <Kpi label="Confirmed outages" value={fmtNum(stats.confirmed)} sub="with cited evidence" />
        <div className="flex min-w-[360px] flex-1 items-center gap-3 px-3 py-1">
          <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-0.5">
            {TECHNOLOGIES.filter((t) => t !== "other" || stats.byTech.has("other")).map((t) => {
              const v = stats.byTech.get(t) ?? 0;
              return (
                <div key={t} className="flex items-center gap-1.5 text-[11px]">
                  <TechIcon tech={t} size={11} />
                  <span className="w-[92px] truncate text-[var(--muted)]">{t === "storage" ? "Battery discharge" : TECHNOLOGY_LABEL[t]}</span>
                  <div className="h-1.5 flex-1 rounded bg-white/5">
                    <div className="h-1.5 rounded" style={{ width: `${(v / maxTech) * 100}%`, background: TECH_COLOR[t] }} />
                  </div>
                  <span className="w-[68px] text-right font-mono tabular-nums">{fmtMW(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
        <button onClick={() => setExpanded((e) => !e)} className="flex items-center gap-1 border-l border-[var(--border)] px-3 text-[11px] text-[var(--muted)] hover:bg-white/5" title="Province-wide trend by IESO fuel category">
          Trend <ChevronDown size={12} className={expanded ? "rotate-180" : ""} />
        </button>
      </div>

      {showDisclosure && (
        <div className="border-t border-[var(--border)] bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
          <b className="text-[var(--fg)]">Dashboard totals</b> are the sum of IESO-reported hourly output ({hourEndingLabel(meta.selectedTsUtc)}) for the{" "}
          {stats.resources} IESO resources mapped to the {filtered.length} facilities matching the current filters. They are <b>not</b> Ontario demand or total provincial
          production: they exclude embedded/distribution-connected generation, imports, and any market-participant resources not published in this report. Battery values are
          injections only. Report-wide: mapped resources {fmtMW(allReported.mapped)} + unmatched resources {fmtMW(allReported.unmatched)} (
          {state.coverage.unmatchedResources.length}) = {fmtMW(allReported.total)} total published in this report hour. Source: IESO Generator Output and Capability Report.
        </div>
      )}

      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--muted)]">
            <span>All resources in the IESO report, by IESO fuel category (incl. unmatched) — hourly, MW</span>
            <RangeTabs value={range} onChange={setRange} />
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <AreaChart data={fuelHist} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 10, fill: "var(--muted)" }}
                minTickGap={30}
                tickFormatter={(ts) =>
                  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", ...(range === "24h" ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }) }).format(new Date(ts))
                }
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} width={52} />
              <Tooltip
                contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", fontSize: 11 }}
                labelFormatter={(ts) => formatOntario(String(ts))}
                formatter={(v, n) => [`${Math.round(Number(v)).toLocaleString()} MW`, n]}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {Object.keys(FUEL_COLORS).map((k) => (
                <Area key={k} type="stepAfter" dataKey={k} stackId="1" stroke={FUEL_COLORS[k]} fill={FUEL_COLORS[k]} fillOpacity={0.55} isAnimationActive={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
