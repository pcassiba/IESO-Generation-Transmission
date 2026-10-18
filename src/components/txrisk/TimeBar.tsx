"use client";

import { formatOntario, hourEndingLabel } from "@/lib/time";
import type { TxRiskItem } from "@/lib/txrisk/types";
import { HORIZONS, RISK_COLOR, reportForOffsetHours, torontoLocalToUtc, utcToTorontoLocal, type HorizonPreset } from "@/lib/txrisk/ui";

interface Props {
  preset: HorizonPreset;
  setPreset: (p: HorizonPreset) => void;
  /** Selected instant (UTC ISO); null = now. */
  tUtc: string | null;
  setT: (t: string | null) => void;
  nowUtc: string;
  items: TxRiskItem[];
}

const HOUR = 3_600_000;

/** Time selector above the map: horizon presets, a slider across the horizon, and a custom date/time. */
export default function TimeBar({ preset, setPreset, tUtc, setT, nowUtc, items }: Props) {
  const now = Date.parse(nowUtc);
  const hours = HORIZONS.find((h) => h.key === preset)?.hours ?? 0;
  const t = tUtc ? Date.parse(tUtc) : now;
  const offsetH = Math.round((t - now) / HOUR);
  // Start/end markers of outages and limits inside the horizon, so the slider shows when things change.
  const marks =
    hours > 0
      ? items
          .flatMap((i) => [i.startUtc, i.endUtc].map((x) => ({ x, i })))
          .filter(({ x, i }) => x && i.category !== "info" && Date.parse(x) > now && Date.parse(x) < now + hours * HOUR)
          .map(({ x, i }) => ({ pct: ((Date.parse(x!) - now) / (hours * HOUR)) * 100, color: RISK_COLOR[i.category === "future" ? "future" : i.category], title: `${i.title}: ${formatOntario(x)}` }))
      : [];

  return (
    <div className="pointer-events-auto rounded border border-[var(--border)] bg-[var(--panel)]/95 px-2 py-1.5 text-[11px] shadow-lg">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Time</span>
        {HORIZONS.map((h) => (
          <button
            key={h.key}
            onClick={() => {
              setPreset(h.key);
              if (h.key === "current") setT(null);
              else if (h.key !== "custom" && t > now + h.hours * HOUR) setT(null);
            }}
            className={`rounded px-1.5 py-0.5 ${preset === h.key ? "bg-sky-500/25 text-sky-300" : "hover:bg-[var(--hover)]"}`}
          >
            {h.label}
          </button>
        ))}
        {preset === "custom" && (
          <input
            type="datetime-local"
            className="ml-1 rounded border border-[var(--border)] bg-transparent px-1 py-0.5"
            value={utcToTorontoLocal(new Date(t).toISOString())}
            min={utcToTorontoLocal(new Date(now - 14 * 24 * HOUR).toISOString())}
            max={utcToTorontoLocal(new Date(now + 34 * 24 * HOUR).toISOString())}
            onChange={(e) => {
              const u = torontoLocalToUtc(e.target.value);
              if (u) setT(u);
            }}
            title="Toronto local time"
          />
        )}
      </div>
      {hours > 0 && (
        <div className="relative mt-1">
          <input type="range" min={0} max={hours} step={1} value={Math.max(0, Math.min(hours, offsetH))} onChange={(e) => setT(Number(e.target.value) === 0 ? null : new Date(now + Number(e.target.value) * HOUR).toISOString())} className="w-full" aria-label="Selected time" />
          <div className="pointer-events-none relative h-1.5">
            {marks.map((m, k) => (
              <span key={k} title={m.title} className="absolute top-0 h-1.5 w-[2px]" style={{ left: `${m.pct}%`, background: m.color }} />
            ))}
          </div>
        </div>
      )}
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">
        {offsetH === 0 ? "Now" : `${offsetH > 0 ? "+" : ""}${offsetH} h`}: <b className="text-[var(--fg,inherit)]">{formatOntario(new Date(t).toISOString())}</b> ({hourEndingLabel(new Date(Math.ceil(t / HOUR) * HOUR).toISOString())}) · Source: {offsetH < 0 ? "today's reports + IESO shadow prices" : reportForOffsetHours(offsetH)}
        {offsetH > 1 && " · planned restrictions only, not forecast congestion"}
      </div>
    </div>
  );
}
