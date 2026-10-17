"use client";

import { X } from "lucide-react";
import type { CongestionResponse, LocationPrice } from "@/lib/congestion";
import { hourEndingLabel } from "@/lib/time";
import type { FacilityState } from "@/lib/types";
import { CONGESTION_NEG, CONGESTION_POS } from "@/lib/ui";

interface Props {
  data: CongestionResponse | null;
  error: string | null;
  facilities: FacilityState[];
  onPick: (id: string) => void;
  onClose: () => void;
}

const price = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);

function LocationRow({ p, name, onPick }: { p: LocationPrice; name: string | null; onPick: (id: string) => void }) {
  const color = p.congestion! < 0 ? CONGESTION_NEG : CONGESTION_POS;
  return (
    <button
      disabled={!p.facilityId}
      onClick={() => p.facilityId && onPick(p.facilityId)}
      className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left enabled:hover:bg-[var(--hover)]"
      title={p.location}
    >
      <span className="min-w-0 truncate">
        {name ?? <span className="font-mono text-[10px]">{p.location}</span>}
        {!p.generator && <span className="ml-1 text-[10px] text-[var(--muted)]">(load)</span>}
      </span>
      <span className="font-mono" style={{ color }}>
        {price(p.congestion)}
      </span>
    </button>
  );
}

export default function CongestionPanel({ data, error, facilities, onPick, onClose }: Props) {
  const nameOf = (id: string | null) => (id ? (facilities.find((f) => f.id === id)?.name ?? null) : null);
  return (
    <div className="absolute right-12 top-3 z-10 flex max-h-[calc(100%-5rem)] w-80 flex-col rounded border border-[var(--border)] bg-[var(--panel)]/95 text-[11px] shadow-xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-2 py-1.5">
        <div>
          <div className="font-semibold">Transmission congestion</div>
          <div className="text-[10px] text-[var(--muted)]">{data?.hourTsUtc ? `Nodal prices for ${hourEndingLabel(data.hourTsUtc)}` : "IESO real-time nodal prices"}</div>
        </div>
        <button onClick={onClose} title="Close" className="rounded p-1 hover:bg-[var(--hover)]">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {error && <div className="text-red-400">Could not load congestion: {error}</div>}
        {!error && !data && <div className="text-[var(--muted)]">Loading…</div>}
        {data && !data.hourTsUtc && (
          <div className="text-[var(--muted)]">
            No IESO price data stored yet. The server downloads it in the background after start-up (or run <span className="font-mono">npm run ingest -- congestion</span>).
          </div>
        )}
        {data?.hourTsUtc && (
          <>
            <p className="text-[var(--muted)]">
              The congestion part of each location&apos;s price shows where the grid is limiting flow. <span style={{ color: CONGESTION_NEG }}>Negative</span> means power there
              can&apos;t get out (generation is held back). <span style={{ color: CONGESTION_POS }}>Positive</span> means the area can&apos;t import enough. Halos on the map mark plants
              at ±{data.thresholdPerMWh} $/MWh or more. Median price this hour: {data.medianLmp?.toFixed(2) ?? "—"} $/MWh.
            </p>
            <section>
              <div className="mb-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Held back (most negative, $/MWh)</div>
              {data.mostNegative.length ? (
                data.mostNegative.map((p) => <LocationRow key={p.location} p={p} name={nameOf(p.facilityId)} onPick={onPick} />)
              ) : (
                <div className="text-[var(--muted)]">No export-constrained locations this hour.</div>
              )}
            </section>
            <section>
              <div className="mb-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Import-constrained (most positive, $/MWh)</div>
              {data.mostPositive.length ? (
                data.mostPositive.map((p) => <LocationRow key={p.location} p={p} name={nameOf(p.facilityId)} onPick={onPick} />)
              ) : (
                <div className="text-[var(--muted)]">No import-constrained locations this hour.</div>
              )}
            </section>
          </>
        )}
        {data && (
          <section>
            <div className="mb-1 font-semibold uppercase tracking-wide text-[var(--muted)]">Most frequently binding constraints</div>
            {data.constraintWindow ? (
              <div className="mb-1 text-[10px] text-[var(--muted)]">
                Last 7 days of IESO data, through {hourEndingLabel(data.constraintWindow.toUtc)}. IESO publishes these a few days late.
              </div>
            ) : (
              <div className="text-[var(--muted)]">No constraint reports stored yet.</div>
            )}
            {data.constraints.map((c) => (
              <div key={c.name} className="border-b border-[var(--border)]/50 py-1 last:border-0">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{c.interfaceName ? `${c.interfaceName} (${c.interfaceCode})` : (c.area ?? "Unnamed constraint")}</span>
                  <span className="whitespace-nowrap text-[var(--muted)]">{c.hoursBinding} h</span>
                </div>
                <div className="flex justify-between gap-2 text-[10px] text-[var(--muted)]">
                  <span className="truncate font-mono" title={c.name}>
                    {c.name}
                  </span>
                  <span className="whitespace-nowrap">avg {price(c.avgShadowPrice)}</span>
                </div>
              </div>
            ))}
            {data.constraintWindow && !data.constraints.length && <div className="text-[var(--muted)]">No constraints were binding in that window.</div>}
          </section>
        )}
        {data && data.coverage.unmatchedGeneratorNodes.length > 0 && (
          <details className="text-[10px] text-[var(--muted)]">
            <summary className="cursor-pointer">
              {data.coverage.matchedGeneratorLocations} of {data.coverage.generatorLocations} generator price locations linked to a mapped plant
            </summary>
            <p className="mt-1">
              Not yet linked (add to <span className="font-mono">data/transmission/pricing-locations.json</span>): {data.coverage.unmatchedGeneratorNodes.join(", ")}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
