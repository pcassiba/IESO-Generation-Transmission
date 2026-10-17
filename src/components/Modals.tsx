"use client";

import { X } from "lucide-react";
import type { StateResponse } from "@/lib/types";
import { STATUSES, STATUS_LABEL, TECHNOLOGIES, TECHNOLOGY_LABEL } from "@/lib/types";
import { fmtMW } from "@/lib/ui";
import { StatusDot, TechIcon } from "./Icons";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-3xl flex-col rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-[var(--muted)] hover:bg-white/10">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 text-xs leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export function MethodologyModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Methodology & data definitions" onClose={onClose}>
      <div className="space-y-3">
        <section>
          <h3 className="mb-1 font-semibold">Data source</h3>
          <p>
            Operational values come exclusively from the IESO{" "}
            <a className="text-sky-400 hover:underline" href="https://reports-public.ieso.ca/public/GenOutputCapability/" target="_blank" rel="noreferrer">
              Generator Output and Capability Report
            </a>
            . The server polls the latest report every 10 minutes using conditional HTTP requests (ETag / Last-Modified) and stores each new version; daily archive files backfill
            history. Values are <b>hourly averages</b> for the hour ending at the stated time, in <b>Eastern Standard Time</b> (the IESO market clock does not observe daylight saving).
            They are displayed with the equivalent Ontario local time (EDT in summer). They are not instantaneous SCADA readings.
          </p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">Report fields</h3>
          <ul className="list-disc space-y-0.5 pl-5">
            <li><b>Output</b> — energy delivered in the hour (average MW).</li>
            <li><b>Capability</b> (nuclear, gas, hydro, biofuel, storage) — maximum potential output accounting for derates and outages.</li>
            <li><b>Forecast</b> (wind, solar) — the IESO publishes wind/solar &quot;Capability&quot; as a forecast that accounts for expected fuel (wind, irradiance).</li>
            <li><b>Available capacity</b> (wind, solar) — maximum output less outages/derates, <i>ignoring</i> fuel availability (hardware availability).</li>
          </ul>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">Status classification</h3>
          <ul className="space-y-1">
            {STATUSES.map((s) => (
              <li key={s} className="flex gap-2">
                <StatusDot status={s} size={12} />
                <span>
                  <b>{STATUS_LABEL[s]}</b> —{" "}
                  {
                    {
                      generating: "reported output ≥ 1 MW (configurable).",
                      available: "output below threshold while capability (or available capacity) is positive — e.g. not dispatched, low wind/sun. Never treated as an outage.",
                      derated:
                        "reported capability (available capacity for wind/solar) is ≥10% and ≥5 MW below the reference capability, or some but not all resources at a facility report zero capability. Reference = highest capability the IESO reported for that resource in the trailing 30 days (seasonal, not nameplate). Derate MW = reference − reported; Derate % = Derate MW ÷ reference × 100. Labelled 'potential' — it is capability-based, not an official derate notice.",
                      potential_oos: "reported capability (available capacity for wind/solar) is zero. The cause is not published (planned/forced outage, refurbishment, layup or market reasons), so it is not confirmed. Shown as a hollow red ring.",
                      confirmed_oos: "only when an authoritative published outage source is linked to the specific facility/resource (outage_evidence table with source URL). No public IESO unit-level outage feed is currently integrated, so this status is used only for curated, cited evidence.",
                      unknown: "no data, or insufficient data for this hour.",
                    }[s]
                  }
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            Wind and solar output below nameplate is expected and is never classified as a derate. Battery storage: the report publishes injections only — positive output is shown as
            <i> discharging</i>; zero output with positive capability is <i>idle / not discharging</i> (charging is not published and is never shown as an outage). Data older than 3
            hours is flagged <b>stale</b>.
          </p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">Facilities, units and IESO resources</h3>
          <p>
            A <b>facility</b> (one map marker) is a physical station. It may have several <b>IESO resources</b> (report rows), which may correspond to individual units, unit groups or
            the whole station. Values are shown exactly as published per resource; nothing is allocated across physical units. Facility metadata (coordinates, operator, capacity) is
            curated from OpenStreetMap, operator publications, Wikipedia and IESO pages with source links and a geocoding confidence level; facilities whose location could not be
            verified are listed but not plotted.
          </p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">Legend</h3>
          <div className="grid grid-cols-4 gap-1">
            {TECHNOLOGIES.map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <TechIcon tech={t} size={13} boxed /> {TECHNOLOGY_LABEL[t]}
              </span>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}

export function CoverageModal({ state, onClose, onPick }: { state: StateResponse; onClose: () => void; onPick: (id: string) => void }) {
  const c = state.coverage;
  const unplotted = state.facilities.filter((f) => f.lat === null);
  const flagged = state.facilities.filter((f) => f.reviewFlag);
  return (
    <Modal title="Data coverage & facility mapping" onClose={onClose}>
      <div className="mb-3 grid grid-cols-4 gap-2">
        {[
          ["Resources in report hour", c.reportResources],
          ["Matched to facilities", c.matchedResources],
          ["Unmatched resources", c.unmatchedResources.length],
          ["Mapped but absent", c.mappedButMissing.length],
          ["Facilities", c.facilitiesTotal],
          ["Plotted on map", c.facilitiesPlotted],
          ["Not plotted (unverified location)", unplotted.length],
          ["Flagged for review", flagged.length],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded border border-[var(--border)] p-2">
            <div className="text-[10px] uppercase text-[var(--muted)]">{k}</div>
            <div className="font-mono text-lg">{v}</div>
          </div>
        ))}
      </div>
      {c.duplicateMappings.length > 0 && <p className="mb-2 text-red-400">Duplicate resource mappings detected: {c.duplicateMappings.join(", ")}</p>}
      <h3 className="mb-1 font-semibold">Unmatched IESO resources (in report, not mapped to any facility)</h3>
      {state.unmatched.length === 0 ? (
        <p className="mb-3 text-green-400">None — every resource in this report hour is mapped.</p>
      ) : (
        <table className="mb-3 w-full">
          <tbody>
            {state.unmatched.map((u) => (
              <tr key={u.iesoName} className="border-t border-[var(--border)]">
                <td className="py-0.5 font-mono">{u.iesoName}</td>
                <td>{u.iesoFuel}</td>
                <td className="text-right font-mono">{fmtMW(u.outputMW)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.mappedButMissing.length > 0 && (
        <>
          <h3 className="mb-1 font-semibold">Mapped resources absent from this report hour</h3>
          <p className="mb-3 font-mono text-[var(--muted)]">{c.mappedButMissing.join(", ")}</p>
        </>
      )}
      <h3 className="mb-1 font-semibold">Facilities not plotted / flagged for review</h3>
      <table className="w-full">
        <tbody>
          {[...new Map([...unplotted, ...flagged].map((f) => [f.id, f])).values()].map((f) => (
            <tr key={f.id} className="border-t border-[var(--border)] align-top">
              <td className="py-1 pr-2">
                <button className="text-sky-400 hover:underline" onClick={() => onPick(f.id)}>
                  {f.name}
                </button>
                <div className="font-mono text-[10px] text-[var(--muted)]">{f.resources.map((r) => r.ieso).join(", ")}</div>
              </td>
              <td className="py-1 pr-2 whitespace-nowrap">{f.lat === null ? <span className="text-amber-400">not plotted</span> : f.geocodeConfidence}</td>
              <td className="py-1 text-[var(--muted)]">{f.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
