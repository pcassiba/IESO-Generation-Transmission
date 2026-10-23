"use client";

import { BookOpen, FileSearch, ChevronLeft, ChevronRight, Clock, Database, History, Moon, RefreshCw, Sun, Zap } from "lucide-react";
import type { DataMeta } from "@/lib/types";
import { formatOntario, hourEndingLabel, utcToMarketHour } from "@/lib/time";

const HOUR = 3_600_000;

function toLocalInput(tsUtc: string | null): string {
  if (!tsUtc) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(tsUtc));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** Interpret a datetime-local value as America/Toronto wall-clock time. */
function fromLocalInput(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  for (const off of [4, 5]) {
    const t = guess + off * HOUR;
    if (toLocalInput(new Date(t).toISOString()) === v) return new Date(t).toISOString();
  }
  return new Date(guess + 5 * HOUR).toISOString();
}

export default function Header({
  meta,
  theme,
  setTheme,
  onRefresh,
  refreshing,
  refreshMsg,
  onSelectTs,
  onOpenMethodology,
  onOpenCoverage,
  onOpenSources,
}: {
  meta: DataMeta | null;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshMsg: string | null;
  onSelectTs: (ts: string | null) => void;
  onOpenMethodology: () => void;
  onOpenCoverage: () => void;
  onOpenSources: () => void;
}) {
  const fresh = meta && !meta.stale && !meta.lastError;
  const freshness = !meta ? "Loading" : meta.lastError ? "Fetch error" : meta.stale ? "Stale" : "Current";
  const freshTone = !meta ? "bg-slate-500" : meta.lastError ? "bg-red-500" : meta.stale ? "bg-amber-500" : "bg-green-500";
  const he = meta?.latestTsUtc ? utcToMarketHour(meta.latestTsUtc) : null;
  const step = (dir: number) => {
    if (!meta?.selectedTsUtc) return;
    const t = new Date(new Date(meta.selectedTsUtc).getTime() + dir * HOUR).toISOString();
    if (meta.latestTsUtc && t >= meta.latestTsUtc) onSelectTs(null);
    else onSelectTs(t);
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-3">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-sky-500/20 text-sky-400">
          <Zap size={18} />
        </div>
        <div className="leading-tight">
          <h1 className="text-sm font-semibold">Ontario Generation Explorer</h1>
          <p className="text-[11px] text-[var(--muted)]">IESO Generation &amp; Availability Monitor</p>
        </div>
      </div>

      <div className="mx-2 flex items-center gap-1 rounded border border-[var(--border)] px-1 py-0.5 text-[11px]">
        <History size={13} className={meta?.mode === "historical" ? "text-fuchsia-400" : "text-[var(--muted)]"} />
        <button className="rounded p-0.5 hover:bg-white/10 disabled:opacity-30" onClick={() => step(-1)} disabled={!meta?.selectedTsUtc || meta.selectedTsUtc === meta.earliestTsUtc} title="Previous hour">
          <ChevronLeft size={14} />
        </button>
        <input
          type="datetime-local"
          className="bg-transparent text-[11px] outline-none [color-scheme:dark]"
          value={toLocalInput(meta?.selectedTsUtc ?? null)}
          min={toLocalInput(meta?.earliestTsUtc ?? null)}
          max={toLocalInput(meta?.latestTsUtc ?? null)}
          onChange={(e) => {
            const ts = fromLocalInput(e.target.value);
            if (!ts) return;
            onSelectTs(meta?.latestTsUtc && ts >= meta.latestTsUtc ? null : ts);
          }}
          title="Choose a historical reporting hour (Ontario local time)"
        />
        <button className="rounded p-0.5 hover:bg-white/10 disabled:opacity-30" onClick={() => step(1)} disabled={meta?.mode !== "historical"} title="Next hour">
          <ChevronRight size={14} />
        </button>
        {meta?.mode === "historical" ? (
          <button onClick={() => onSelectTs(null)} className="ml-1 rounded bg-fuchsia-500/20 px-1.5 py-0.5 font-medium text-fuchsia-300 hover:bg-fuchsia-500/30">
            Historical · back to latest
          </button>
        ) : (
          <span className="ml-1 rounded bg-green-500/15 px-1.5 py-0.5 text-green-400">Latest</span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-4 text-[11px]">
        <div className="text-right leading-tight">
          <div className="text-[var(--muted)]">Latest Reported Generation</div>
          <div className="font-mono font-semibold">
            {he ? `Hour Ending ${String(he.hour).padStart(2, "0")}:00 EST` : "—"} <span className="font-sans font-normal text-[var(--muted)]">({formatOntario(meta?.latestTsUtc)})</span>
          </div>
        </div>
        <div className="text-right leading-tight" title={meta?.staleReason ?? meta?.lastError ?? undefined}>
          <div className="flex items-center justify-end gap-1 text-[var(--muted)]">
            <Clock size={11} /> Last successful refresh
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${freshTone} ${fresh ? "animate-pulse" : ""}`} />
            <span className="font-medium">{freshness}</span>
            <span className="text-[var(--muted)]">{formatOntario(meta?.lastSuccessfulFetch, { seconds: false })}</span>
          </div>
        </div>
        <button onClick={onRefresh} disabled={refreshing} className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 hover:bg-white/5 disabled:opacity-50" title={refreshMsg ?? "Check IESO for a new report"}>
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> Refresh
        </button>
        <button onClick={onOpenSources} className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 hover:bg-white/5" title="Which IESO report, file and hour each dataset comes from">
          <FileSearch size={13} /> Sources
        </button>
        <button onClick={onOpenCoverage} className="rounded p-1.5 text-[var(--muted)] hover:bg-white/10" title="Data coverage & mapping">
          <Database size={15} />
        </button>
        <button onClick={onOpenMethodology} className="rounded p-1.5 text-[var(--muted)] hover:bg-white/10" title="Methodology & data definitions">
          <BookOpen size={15} />
        </button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="rounded p-1.5 text-[var(--muted)] hover:bg-white/10" title="Toggle light/dark">
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
      {meta?.mode === "historical" && <span className="sr-only">Historical mode: {hourEndingLabel(meta.selectedTsUtc)}</span>}
    </header>
  );
}
