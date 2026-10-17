"use client";

import { useEffect, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Technology } from "@/lib/types";
import { formatOntario } from "@/lib/time";

export interface HistoryPoint {
  ts: string;
  outputMW: number | null;
  capabilityMW: number | null;
  forecastMW: number | null;
  availCapacityMW: number | null;
}

export type Range = "24h" | "7d" | "30d";

export function RangeTabs({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-[var(--border)] text-xs">
      {(["24h", "7d", "30d"] as Range[]).map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2 py-0.5 ${value === r ? "bg-sky-500/20 text-sky-300" : "text-[var(--muted)] hover:bg-white/5"}`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

const tickFmt = (range: Range) => (ts: string) => {
  const d = new Date(ts);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    ...(range === "24h" ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }),
  }).format(d);
};

export function GenerationChart({
  points,
  technology,
  range,
  markerTs,
  height = 190,
}: {
  points: HistoryPoint[];
  technology: Technology;
  range: Range;
  markerTs?: string | null;
  height?: number;
}) {
  const vg = technology === "wind" || technology === "solar";
  if (!points.length) {
    return <div className="flex h-[120px] items-center justify-center text-xs text-[var(--muted)]">No stored history for this period.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" />
        <XAxis dataKey="ts" tickFormatter={tickFmt(range)} tick={{ fontSize: 10, fill: "var(--muted)" }} minTickGap={28} />
        <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} width={48} />
        <Tooltip
          contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", fontSize: 11 }}
          labelFormatter={(ts) => formatOntario(String(ts))}
          formatter={(v, name) => [v === null || v === undefined ? "—" : `${Math.round(Number(v)).toLocaleString()} MW`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 10 }} />
        <Area type="stepAfter" dataKey="outputMW" name="Actual output" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.18} strokeWidth={1.6} connectNulls={false} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="capabilityMW" name={vg ? "Available capacity" : "Reported capability"} stroke="#f59e0b" strokeWidth={1.4} dot={false} connectNulls={false} isAnimationActive={false} />
        {vg && <Line type="monotone" dataKey="forecastMW" name="IESO forecast" stroke="#a3a3a3" strokeDasharray="4 3" strokeWidth={1.2} dot={false} isAnimationActive={false} />}
        {markerTs && <ReferenceLine x={markerTs} stroke="#e879f9" strokeDasharray="2 2" />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Fetch hourly history for facilities. */
export function useHistory(ids: string[], range: Range, endTs: string | null, refreshKey: unknown) {
  const [data, setData] = useState<{ facilityId: string; technology: Technology; points: HistoryPoint[]; resources: Record<string, HistoryPoint[]> }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    if (!key) {
      setData([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ ids: key, range });
    if (endTs) qs.set("end", endTs);
    fetch(`/api/history?${qs}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        else {
          setError(null);
          setData(j.facilities);
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, range, endTs, refreshKey]);
  return { data, loading, error };
}
