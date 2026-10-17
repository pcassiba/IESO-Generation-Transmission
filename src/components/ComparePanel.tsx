"use client";

import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DataMeta, FacilityState } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/types";
import { fmtMW, fmtPct } from "@/lib/ui";
import { formatOntario } from "@/lib/time";
import { RangeTabs, useHistory, type Range } from "./Charts";
import { StatusDot, TechIcon } from "./Icons";

const PALETTE = ["#38bdf8", "#f97316", "#a855f7", "#22c55e", "#eab308", "#ec4899", "#14b8a6", "#ef4444"];

export default function ComparePanel({
  facilities,
  meta,
  onRemove,
  onClear,
  onPick,
  refreshKey,
}: {
  facilities: FacilityState[];
  meta: DataMeta;
  onRemove: (id: string) => void;
  onClear: () => void;
  onPick: (id: string) => void;
  refreshKey: unknown;
}) {
  const [range, setRange] = useState<Range>("24h");
  const [metric, setMetric] = useState<"output" | "capability" | "util">("output");
  const endTs = meta.mode === "historical" ? meta.selectedTsUtc : null;
  const { data } = useHistory(
    facilities.map((f) => f.id),
    range,
    endTs,
    refreshKey,
  );

  const merged = useMemo(() => {
    const byTs = new Map<string, Record<string, number | string | null>>();
    for (const h of data) {
      const fac = facilities.find((f) => f.id === h.facilityId);
      for (const p of h.points) {
        const rec = byTs.get(p.ts) ?? { ts: p.ts };
        const v =
          metric === "output"
            ? p.outputMW
            : metric === "capability"
              ? p.capabilityMW
              : fac?.installedCapacityMW && p.outputMW !== null
                ? (Math.max(0, p.outputMW) / fac.installedCapacityMW) * 100
                : null;
        rec[h.facilityId] = v;
        byTs.set(p.ts, rec);
      }
    }
    return [...byTs.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }, [data, facilities, metric]);

  return (
    <div className="flex h-[300px] shrink-0 border-t border-[var(--border)] bg-[var(--panel)] text-xs">
      <div className="w-[520px] shrink-0 overflow-y-auto border-r border-[var(--border)]">
        <div className="flex items-center justify-between px-3 py-2">
          <h3 className="font-semibold uppercase tracking-wide text-[var(--muted)]">Facility comparison ({facilities.length})</h3>
          <button onClick={onClear} className="text-sky-400 hover:underline">
            Clear
          </button>
        </div>
        <table className="w-full">
          <thead>
            <tr className="text-left text-[10px] uppercase text-[var(--muted)]">
              <th className="px-3 py-1 font-medium">Facility</th>
              <th className="py-1 text-right font-medium">Output</th>
              <th className="py-1 text-right font-medium">Capability</th>
              <th className="py-1 text-right font-medium">Installed</th>
              <th className="py-1 text-right font-medium">Util.</th>
              <th className="py-1 pl-2 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {facilities.map((f, i) => (
              <tr key={f.id} className="border-t border-[var(--border)] hover:bg-white/5">
                <td className="px-3 py-1">
                  <button onClick={() => onPick(f.id)} className="flex items-center gap-1.5 text-left hover:underline">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                    <TechIcon tech={f.technology} size={12} />
                    <span className="max-w-[150px] truncate">{f.name}</span>
                  </button>
                </td>
                <td className="py-1 text-right font-mono tabular-nums">{fmtMW(f.outputMW)}</td>
                <td className="py-1 text-right font-mono tabular-nums">{fmtMW(f.capabilityMW)}</td>
                <td className="py-1 text-right font-mono tabular-nums">{fmtMW(f.installedCapacityMW ?? null)}</td>
                <td className="py-1 text-right font-mono tabular-nums">{fmtPct(f.utilizationPct)}</td>
                <td className="py-1 pl-2" title={STATUS_LABEL[f.status]}>
                  <StatusDot status={f.status} size={10} />
                </td>
                <td className="pr-2">
                  <button onClick={() => onRemove(f.id)} className="rounded p-0.5 text-[var(--muted)] hover:bg-white/10">
                    <X size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex min-w-0 flex-1 flex-col px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <div className="inline-flex overflow-hidden rounded border border-[var(--border)]">
            {(
              [
                ["output", "Generation"],
                ["capability", "Capability"],
                ["util", "Utilization %"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setMetric(k)} className={`px-2 py-0.5 ${metric === k ? "bg-sky-500/20 text-sky-300" : "text-[var(--muted)] hover:bg-white/5"}`}>
                {l}
              </button>
            ))}
          </div>
          <RangeTabs value={range} onChange={setRange} />
        </div>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={merged} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 10, fill: "var(--muted)" }}
                minTickGap={30}
                tickFormatter={(ts) =>
                  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", ...(range === "24h" ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }) }).format(new Date(ts))
                }
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} width={48} />
              <Tooltip
                contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", fontSize: 11 }}
                labelFormatter={(ts) => formatOntario(String(ts))}
                formatter={(v, n) => [v === null || v === undefined ? "—" : metric === "util" ? `${Number(v).toFixed(1)}%` : `${Math.round(Number(v)).toLocaleString()} MW`, facilities.find((f) => f.id === n)?.name ?? n]}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => facilities.find((f) => f.id === v)?.name ?? v} />
              {facilities.map((f, i) => (
                <Line key={f.id} type="stepAfter" dataKey={f.id} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
